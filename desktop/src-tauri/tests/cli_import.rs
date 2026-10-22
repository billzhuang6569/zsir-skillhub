use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[test]
fn packaged_cli_lifecycle_runs_before_release() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Command::new("node")
        .arg(root.join("scripts/verify-packaged-cli-lifecycle.mjs"))
        .arg("--binary")
        .arg(env!("CARGO_BIN_EXE_skillhub"))
        .arg("--expected-version")
        .arg(env!("CARGO_PKG_VERSION"))
        .arg("--fixture")
        .arg(root.join("qa-skills/skillhub-release-verifier"))
        .status()
        .expect("Node.js is required for the CLI lifecycle gate");
    assert!(status.success(), "CLI lifecycle gate failed: {status}");
}

struct TestHome(PathBuf);

impl TestHome {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "skillhub-cli-import-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).expect("create isolated CLI home");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run_cli(home: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_skillhub"))
        .args(args)
        .env("HOME", home)
        .env("USERPROFILE", home)
        .output()
        .expect("run packaged CLI entrypoint")
}

fn json_stdout(output: &Output) -> Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "parse CLI JSON ({error}); stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn server_show_prints_compiled_base_without_creating_runtime_state() {
    let home = TestHome::new();
    let config: Value = serde_json::from_str(skillhub_lib::official_channel::CHANNEL_JSON).unwrap();
    let output = run_cli(home.path(), &["server", "show"]);
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        config["serverOrigin"].as_str().unwrap()
    );
    assert!(output.stderr.is_empty());
    assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
    assert_eq!(
        run_cli(home.path(), &["server", "use"]).status.code(),
        Some(2)
    );
}

#[test]
fn server_use_is_guest_and_app_lock_refuses_the_cli_without_mutation() {
    let home = TestHome::new();
    assert!(run_cli(home.path(), &["server", "use", "local"])
        .status
        .success());
    let shown = json_stdout(&run_cli(home.path(), &["server", "show", "--json"]));
    assert_eq!(shown["profile"], "local");
    assert_eq!(shown["signedIn"], false);
    let root = home
        .path()
        .join(if skillhub_lib::official_channel::CHANNEL == "dev" {
            ".skillhub-dev"
        } else {
            ".skillhub"
        });
    let path = root.join("runtime/session.json");
    let before = std::fs::read(&path).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("runtime/app.lock"))
        .unwrap();
    lock.lock().unwrap();
    let busy = run_cli(home.path(), &["server", "use", "official"]);
    assert_eq!(busy.status.code(), Some(4));
    assert!(String::from_utf8_lossy(&busy.stderr).contains("请在 APP 设置页切换"));
    assert_eq!(std::fs::read(path).unwrap(), before);
    lock.unlock().unwrap();
}

#[test]
fn runtime_overrides_cannot_change_compiled_channel() {
    let home = TestHome::new();
    let output = Command::new(env!("CARGO_BIN_EXE_skillhub"))
        .args(["server", "show"])
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("SKILLHUB_CHANNEL", "dev")
        .env("VITE_SKILLHUB_SERVER_ORIGIN", "https://attacker.example")
        .env("SKILLHUB_SERVER_ORIGIN", "https://attacker.example")
        .env(
            "TAURI_CONFIG",
            r#"{"plugins":{"updater":{"pubkey":"attacker"}}}"#,
        )
        .current_dir(home.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().trim(),
        skillhub_lib::official_channel::COMPILED.server_origin
    );
    assert!(std::fs::read_dir(home.path()).unwrap().next().is_none());
}

#[test]
fn first_import_preflight_and_apply_work_from_an_empty_home() {
    let home = TestHome::new();
    let source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("qa-skills/skillhub-release-verifier")
        .canonicalize()
        .expect("resolve real Skill fixture");
    let source = source.to_str().expect("fixture path is UTF-8");
    let skill_id = "cli-packaged-e2e";

    let preflight = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "preflight",
            "--path",
            source,
            "--skill-id",
            skill_id,
            "--json",
        ],
    );
    assert!(
        preflight.status.success(),
        "preflight failed: {}",
        String::from_utf8_lossy(&preflight.stderr)
    );
    let preflight_json = json_stdout(&preflight);
    let digest = preflight_json["data"]["planDigest"]
        .as_str()
        .expect("preflight planDigest");

    let apply = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "apply",
            "--path",
            source,
            "--skill-id",
            skill_id,
            "--plan-digest",
            digest,
            "--json",
        ],
    );
    let apply_json = json_stdout(&apply);
    assert!(
        apply.status.success(),
        "apply failed: stdout={} stderr={}",
        String::from_utf8_lossy(&apply.stdout),
        String::from_utf8_lossy(&apply.stderr)
    );
    assert_eq!(apply_json["ok"], true);
    assert_eq!(apply_json["data"]["skill"]["id"], skill_id);
    assert!(
        home.path()
            .join(".skillhub/skills")
            .join(skill_id)
            .join("SKILL.md")
            .is_file(),
        "apply should create the managed Skill from a previously empty HOME"
    );
}

#[test]
fn installed_system_manager_source_is_rejected_without_trusting_skill_names() {
    let home = TestHome::new();
    let manager = home.path().join(".skillhub/skills/yitan-skillhub-manager");
    std::fs::create_dir_all(&manager).expect("create installed Manager fixture");
    std::fs::write(
        manager.join("SKILL.md"),
        "---\nname: SkillHub Manager\n---\n\n# SkillHub Manager\n",
    )
    .expect("write installed Manager fixture");

    let manager_path = manager.to_str().expect("Manager path is UTF-8");
    let preflight = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "preflight",
            "--path",
            manager_path,
            "--skill-id",
            "manager-acceptance-installed-copy",
            "--json",
        ],
    );
    let preflight_json = json_stdout(&preflight);
    assert!(!preflight.status.success());
    assert_eq!(preflight_json["error"]["code"], "VALIDATION_FAILED");

    let digest = "0".repeat(64);
    let apply = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "apply",
            "--path",
            manager_path,
            "--skill-id",
            "manager-acceptance-installed-copy",
            "--plan-digest",
            &digest,
            "--json",
        ],
    );
    let apply_json = json_stdout(&apply);
    assert!(!apply.status.success());
    assert_eq!(apply_json["error"]["code"], "VALIDATION_FAILED");
    assert!(!home
        .path()
        .join(".skillhub/skills/manager-acceptance-installed-copy")
        .exists());

    let ordinary = home.path().join("ordinary-manager-name");
    std::fs::create_dir(&ordinary).expect("create ordinary Skill fixture");
    std::fs::write(
        ordinary.join("SKILL.md"),
        "---\nname: yitan-skillhub-manager\ndescription: ordinary user Skill\n---\n",
    )
    .expect("write ordinary Skill fixture");
    std::fs::write(
        ordinary.join(".skillhub.json"),
        r#"{"version":"1.0","skillhub":{"name":"yitan-skillhub-manager","isSystem":true}}"#,
    )
    .expect("write spoofed sidecar fixture");
    let ordinary_preflight = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "preflight",
            "--path",
            ordinary.to_str().expect("ordinary path is UTF-8"),
            "--skill-id",
            "ordinary-manager-name",
            "--json",
        ],
    );
    assert!(
        ordinary_preflight.status.success(),
        "a user-controlled name/profile must not establish system identity: {}",
        String::from_utf8_lossy(&ordinary_preflight.stdout)
    );
}

/// #250：CLI `skill import apply` 与桌面导入共用同一导入核心，导入后 sidecar
/// 自动写入 declared / high / medium 建议（SDK 隐式读取、`.env.example`、
/// `os.getenv`，medium 为非必填）；占位符、`node_modules` 噪声与 low 线索不会写入。
/// #287：`OUTPUT_DIR` 这类不像钥匙的名字是 Skill 自己的配置，同样不写入。
#[test]
fn import_apply_merges_non_low_env_suggestions() {
    let home = TestHome::new();
    let source = home.path().join("fal-imagegen");
    let write = |relative: &str, contents: &str| {
        let path = source.join(relative);
        std::fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture dir");
        std::fs::write(path, contents).expect("write fixture");
    };
    write(
        "SKILL.md",
        "---\nname: fal-imagegen\ndescription: env detection fixture\n---\n\n运行 `python ${CLAUDE_SKILL_DIR}/scripts/gen.py $ARGUMENTS`，可选 `EXTRA_HINT`。\n",
    );
    write(
        "scripts/gen.py",
        "import os\nimport fal_client\n\nout = os.getenv('OUTPUT_DIR', '.')\nmode = os.environ.get('NODE_ENV')\ntoken = os.getenv('HF_TOKEN')\n",
    );
    write(".env.example", "REPLICATE_API_TOKEN=put-your-token-here\n");
    write(
        "node_modules/openai/index.js",
        "process.env.OPENAI_API_KEY\n",
    );
    let source = source.to_str().expect("fixture path is UTF-8");
    let skill_id = "cli-env-detect";

    let preflight = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "preflight",
            "--path",
            source,
            "--skill-id",
            skill_id,
            "--json",
        ],
    );
    assert!(
        preflight.status.success(),
        "preflight failed: {}",
        String::from_utf8_lossy(&preflight.stdout)
    );
    let preflight_json = json_stdout(&preflight);
    let digest = preflight_json["data"]["planDigest"]
        .as_str()
        .expect("preflight planDigest")
        .to_string();
    let apply = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "apply",
            "--path",
            source,
            "--skill-id",
            skill_id,
            "--plan-digest",
            &digest,
            "--json",
        ],
    );
    assert!(
        apply.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&apply.stdout)
    );

    let sidecar: Value = serde_json::from_str(
        &std::fs::read_to_string(
            home.path()
                .join(".skillhub/skills")
                .join(skill_id)
                .join(".skillhub.json"),
        )
        .expect("read imported sidecar"),
    )
    .expect("parse imported sidecar");
    let dependencies = sidecar["skillhub"]["envDependencies"]
        .as_array()
        .expect("envDependencies array");
    let keys: Vec<&str> = dependencies
        .iter()
        .map(|dependency| dependency["key"].as_str().expect("key"))
        .collect();
    assert_eq!(keys, ["FAL_KEY", "HF_TOKEN", "REPLICATE_API_TOKEN"]);
    let expected = [("high", true), ("medium", false), ("high", true)];
    for (dependency, (confidence, required)) in dependencies.iter().zip(expected) {
        assert_eq!(dependency["origin"], "detected");
        assert_eq!(dependency["confidence"], confidence);
        assert_eq!(dependency["required"], required);
    }
    assert!(!sidecar.to_string().contains("put-your-token-here"));
}

fn import_folder(home: &Path, source: &Path, skill_id: &str) -> Output {
    let source = source.to_str().expect("fixture path is UTF-8");
    let preflight = run_cli(
        home,
        &[
            "skill",
            "import",
            "preflight",
            "--path",
            source,
            "--skill-id",
            skill_id,
            "--json",
        ],
    );
    assert!(
        preflight.status.success(),
        "preflight failed: {}",
        String::from_utf8_lossy(&preflight.stdout)
    );
    let digest = json_stdout(&preflight)["data"]["planDigest"]
        .as_str()
        .expect("preflight planDigest")
        .to_string();
    run_cli(
        home,
        &[
            "skill",
            "import",
            "apply",
            "--path",
            source,
            "--skill-id",
            skill_id,
            "--plan-digest",
            &digest,
            "--json",
        ],
    )
}

/// #251：frontmatter `metadata.skillhub.env` 声明优先于检测；导入目录自带
/// `.skillhub.json` 的 envDependencies 恢复读取（保留 origin），检测只补充新 key。
#[test]
fn import_apply_reads_frontmatter_declaration_and_source_sidecar() {
    let home = TestHome::new();
    let source = home.path().join("declared-imagegen");
    let write = |relative: &str, contents: &str| {
        let path = source.join(relative);
        std::fs::create_dir_all(path.parent().expect("fixture parent")).expect("fixture dir");
        std::fs::write(path, contents).expect("write fixture");
    };
    write(
        "SKILL.md",
        "---\nname: declared-imagegen\ndescription: declaration fixture\nmetadata:\n  author: demo\n  skillhub:\n    env:\n      - key: FAL_KEY\n        required: false\n        description: fal.ai API Key\n        obtain: https://fal.ai/dashboard/keys\n---\n\n# Declared\n",
    );
    write(
        "scripts/gen.py",
        "import fal_client\nimport os\nos.getenv('OPENAI_API_KEY')\n",
    );
    write(
        ".skillhub.json",
        r#"{"version":"1.0","skillhub":{"serverId":"spoofed","envDependencies":[{"key":"LEGACY_TOKEN","description":"旧 sidecar","required":true,"origin":"manual"},{"key":"bad key","required":true}]}}"#,
    );
    let skill_id = "cli-env-declared";
    let apply = import_folder(home.path(), &source, skill_id);
    assert!(
        apply.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&apply.stdout)
    );
    let sidecar: Value = serde_json::from_str(
        &std::fs::read_to_string(
            home.path()
                .join(".skillhub/skills")
                .join(skill_id)
                .join(".skillhub.json"),
        )
        .expect("read imported sidecar"),
    )
    .expect("parse imported sidecar");
    assert!(sidecar["skillhub"]["serverId"].is_null());
    let dependencies = sidecar["skillhub"]["envDependencies"]
        .as_array()
        .expect("envDependencies array");
    let summary: Vec<(String, String, bool)> = dependencies
        .iter()
        .map(|dependency| {
            (
                dependency["key"].as_str().unwrap().to_string(),
                dependency["origin"].as_str().unwrap_or("").to_string(),
                dependency["required"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        [
            ("FAL_KEY".to_string(), "declared".to_string(), false),
            ("LEGACY_TOKEN".to_string(), "manual".to_string(), true),
            ("OPENAI_API_KEY".to_string(), "detected".to_string(), false),
        ]
    );
    assert_eq!(dependencies[0]["confidence"], "declared");
    assert_eq!(dependencies[0]["obtain"], "https://fal.ai/dashboard/keys");
    assert_eq!(dependencies[0]["description"], "fal.ai API Key");
}

#[test]
fn import_apply_rejects_an_invalid_declaration() {
    let home = TestHome::new();
    let source = home.path().join("invalid-declaration");
    std::fs::create_dir_all(&source).expect("fixture dir");
    std::fs::write(
        source.join("SKILL.md"),
        "---\nname: invalid-declaration\nmetadata:\n  skillhub:\n    env:\n      - key: FAL_KEY\n        obtain: http://insecure.example.com\n---\n",
    )
    .expect("write fixture");
    let preflight = run_cli(
        home.path(),
        &[
            "skill",
            "import",
            "preflight",
            "--path",
            source.to_str().expect("fixture path is UTF-8"),
            "--skill-id",
            "cli-env-invalid",
            "--json",
        ],
    );
    assert!(!preflight.status.success());
    let output = json_stdout(&preflight);
    assert_eq!(output["error"]["code"], "VALIDATION_FAILED");
    let message = output["error"]["message"].as_str().expect("error message");
    assert!(message.contains("metadata.skillhub.env"), "{message}");
    assert!(message.contains("https://"), "{message}");
    assert!(!home
        .path()
        .join(".skillhub/skills/cli-env-invalid")
        .exists());
}
