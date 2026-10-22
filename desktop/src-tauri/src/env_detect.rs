//! Skill 环境变量检测（#250）：只读扫描 Skill 目录，产出带置信度与证据的建议清单。
//!
//! 结果不直接写入 sidecar；调用方按置信度决定是否合并（导入时合并 declared /
//! high / medium，其中 declared / high 默认 required；low 只作提示）。本模块从不
//! 读取或返回变量值。

use crate::skill_document::EnvDeclaration;
use crate::EnvDepRaw;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use walkdir::WalkDir;

/// 单文件扫描上限；更大的文件跳过，避免大文件拖住扫描。
const MAX_SCAN_FILE_BYTES: u64 = 1024 * 1024;
/// 单次扫描最多读取的文件数，保证深目录扫描有界。
const MAX_SCAN_FILES: usize = 5_000;
const MAX_SCAN_DEPTH: usize = 8;
const MAX_EVIDENCE_PER_KEY: usize = 5;

pub(crate) const ORIGIN_DECLARED: &str = "declared";
pub(crate) const ORIGIN_DETECTED: &str = "detected";
pub(crate) const ORIGIN_MANUAL: &str = "manual";
const DETECTED_DESCRIPTION: &str = "由 SkillHub 静态分析检测";
/// 从本机 `.env` 文件捡到的名字也算自动检测（`commands::merge_profile_env_dependencies`）。
pub(crate) const LOCAL_ENV_DESCRIPTION: &str = "由 SkillHub 从本机 Skill 检测";
const MANUAL_DESCRIPTION: &str = "由用户手动添加";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvConfidence {
    // 顺序即强弱：越靠前越可信，合并时保留最强的一条。
    Declared,
    High,
    Medium,
    Low,
}

impl EnvConfidence {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Declared => "declared",
            Self::High => "high",
            Self::Medium => "medium",
            Self::Low => "low",
        }
    }

    /// declared / high 默认必填，其余只是建议。
    pub(crate) fn default_required(self) -> bool {
        matches!(self, Self::Declared | Self::High)
    }

    /// 导入时（桌面与 CLI 同一规则）自动写入 sidecar 的置信度；low 只作提示。
    pub(crate) fn merged_on_import(self) -> bool {
        !matches!(self, Self::Low)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvSuggestion {
    pub key: String,
    pub confidence: EnvConfidence,
    pub evidence: Vec<String>,
}

/// 检测规则表（SDK 目录、正则、扩展名、剪枝目录、排除名）与 Server 收包复检共用
/// 同一份 JSON（#251）；`server/src/lib/env-detect-rules.json` 必须与之逐字节一致。
const RULES_JSON: &str = include_str!("../env-detect-rules.json");

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Ecosystem {
    Python,
    Node,
}

/// 已知 SDK 目录：包名（Python 规范化为小写下划线）→ 该 SDK 隐式读取的 key。
#[derive(Deserialize)]
struct SdkRule {
    ecosystem: Ecosystem,
    /// Python：pip 包名或模块路径（规范化后比较）；Node：npm 包名。
    names: Vec<String>,
    label: String,
    keys: Vec<String>,
}

/// 同一服务的多个常见变量名（#288）：只用于提示「用已有的钥匙」，从不自动合并。
#[derive(Debug, Deserialize)]
pub(crate) struct ServiceKeyGroup {
    pub(crate) service: String,
    pub(crate) keys: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawExtensions {
    python: Vec<String>,
    script: Vec<String>,
    shell: Vec<String>,
    powershell: Vec<String>,
    batch: Vec<String>,
    markdown: Vec<String>,
    other: Vec<String>,
}

#[derive(Deserialize)]
struct ShebangRule {
    kind: String,
    contains: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPatterns {
    common: Vec<String>,
    destructuring: String,
    shell_bare: String,
    powershell: String,
    batch: String,
    markdown_inline: String,
    markdown_export: String,
    env_template_line: String,
    python_import: String,
    python_from: String,
    script_import: String,
    pyproject_quoted: String,
    pyproject_table_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRules {
    key_group: String,
    candidate_key: String,
    excluded_keys: Vec<String>,
    excluded_key_prefixes: Vec<String>,
    secret_key_tokens: Vec<String>,
    pruned_dirs: Vec<String>,
    env_template_names: Vec<String>,
    extensions: RawExtensions,
    shebang: Vec<ShebangRule>,
    sdk_catalog: Vec<SdkRule>,
    service_key_groups: Vec<ServiceKeyGroup>,
    patterns: RawPatterns,
}

struct Rules {
    candidate_key: Regex,
    excluded_keys: Vec<String>,
    excluded_key_prefixes: Vec<String>,
    secret_key_tokens: Vec<String>,
    pruned_dirs: Vec<String>,
    env_template_names: Vec<String>,
    extensions: Vec<(String, FileKind)>,
    shebang: Vec<(FileKind, Vec<String>)>,
    sdk_catalog: Vec<SdkRule>,
    service_key_groups: Vec<ServiceKeyGroup>,
    patterns: Patterns,
}

fn file_kind(name: &str) -> FileKind {
    match name {
        "python" => FileKind::Python,
        "script" => FileKind::Script,
        "shell" => FileKind::Shell,
        "powershell" => FileKind::PowerShell,
        "batch" => FileKind::Batch,
        "markdown" => FileKind::Markdown,
        _ => FileKind::Other,
    }
}

/// JSON 中的正则是 Rust 与 JavaScript 的公共子集；`\b` 按 ASCII 词边界解释，
/// 与 JavaScript 一致。
fn compile(pattern: &str, key_group: &str, multi_line: bool) -> Regex {
    let expanded = pattern
        .replace("{KEY}", key_group)
        .replace(r"\b", r"(?-u:\b)");
    let source = if multi_line {
        format!("(?m){expanded}")
    } else {
        expanded
    };
    Regex::new(&source).expect("env-detect-rules.json pattern")
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let raw: RawRules = serde_json::from_str(RULES_JSON).expect("env-detect-rules.json");
        let key = raw.key_group.as_str();
        let patterns = &raw.patterns;
        let extensions = [
            (raw.extensions.python, FileKind::Python),
            (raw.extensions.script, FileKind::Script),
            (raw.extensions.shell, FileKind::Shell),
            (raw.extensions.powershell, FileKind::PowerShell),
            (raw.extensions.batch, FileKind::Batch),
            (raw.extensions.markdown, FileKind::Markdown),
            (raw.extensions.other, FileKind::Other),
        ]
        .into_iter()
        .flat_map(|(names, kind)| names.into_iter().map(move |name| (name, kind)))
        .collect();
        Rules {
            candidate_key: Regex::new(&raw.candidate_key).expect("candidateKey"),
            excluded_keys: raw.excluded_keys,
            excluded_key_prefixes: raw.excluded_key_prefixes,
            secret_key_tokens: raw.secret_key_tokens,
            pruned_dirs: raw.pruned_dirs,
            env_template_names: raw.env_template_names,
            extensions,
            shebang: raw
                .shebang
                .into_iter()
                .map(|rule| (file_kind(&rule.kind), rule.contains))
                .collect(),
            patterns: Patterns {
                common: patterns
                    .common
                    .iter()
                    .map(|pattern| compile(pattern, key, false))
                    .collect(),
                destructuring: compile(&patterns.destructuring, key, false),
                shell_bare: compile(&patterns.shell_bare, key, false),
                powershell: compile(&patterns.powershell, key, false),
                batch: compile(&patterns.batch, key, false),
                markdown_inline: compile(&patterns.markdown_inline, key, false),
                markdown_export: compile(&patterns.markdown_export, key, false),
                env_template_line: compile(&patterns.env_template_line, key, false),
                python_import: compile(&patterns.python_import, key, true),
                python_from: compile(&patterns.python_from, key, true),
                script_import: compile(&patterns.script_import, key, false),
                pyproject_quoted: compile(&patterns.pyproject_quoted, key, false),
                pyproject_table_key: compile(&patterns.pyproject_table_key, key, false),
            },
            sdk_catalog: raw.sdk_catalog,
            service_key_groups: raw.service_key_groups,
        }
    })
}

/// `key` 所属的服务分组（同一服务的常见变量名），没有则为 `None`。
pub(crate) fn service_key_group(key: &str) -> Option<&'static ServiceKeyGroup> {
    rules()
        .service_key_groups
        .iter()
        .find(|group| group.keys.iter().any(|name| name == key))
}

/// 合法、且不是占位符的变量名：至少两个字符、大写开头，排除常见系统变量与 `LC_*`。
pub(crate) fn is_candidate_key(key: &str) -> bool {
    let rules = rules();
    rules.candidate_key.is_match(key)
        && !rules.excluded_keys.iter().any(|excluded| excluded == key)
        && !rules
            .excluded_key_prefixes
            .iter()
            .any(|prefix| key.starts_with(prefix.as_str()))
}

/// 名字像钥匙：按 `_` 分段后有一段是 KEY / TOKEN / SECRET / PASSWORD 等（规则表
/// `secretKeyTokens`）。不像的（`OUTPUT_DIR`、`BASE_URL`、`FAL_MODEL`）是 Skill 自己的
/// 配置，SkillHub 只管钥匙，不收录也不注入（#287）。拿不准的一律按配置处理，由作者声明兜底。
pub(crate) fn is_secret_key_name(key: &str) -> bool {
    let tokens = &rules().secret_key_tokens;
    key.split('_')
        .any(|segment| tokens.iter().any(|token| token == segment))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum FileKind {
    Python,
    Script, // js / ts 家族
    Shell,
    PowerShell,
    Batch,
    Markdown,
    Other,
}

fn kind_for_extension(ext: &str) -> Option<FileKind> {
    rules()
        .extensions
        .iter()
        .find(|(name, _)| name == ext)
        .map(|(_, kind)| *kind)
}

fn kind_for_shebang(first_line: &str) -> FileKind {
    rules()
        .shebang
        .iter()
        .find(|(_, needles)| {
            needles
                .iter()
                .any(|needle| first_line.contains(needle.as_str()))
        })
        .map_or(FileKind::Other, |(kind, _)| *kind)
}

struct Patterns {
    /// 所有被扫描文件通用的代码读取写法（medium）。
    common: Vec<Regex>,
    destructuring: Regex,
    shell_bare: Regex,
    powershell: Regex,
    batch: Regex,
    markdown_inline: Regex,
    markdown_export: Regex,
    env_template_line: Regex,
    python_import: Regex,
    python_from: Regex,
    script_import: Regex,
    pyproject_quoted: Regex,
    pyproject_table_key: Regex,
}

fn patterns() -> &'static Patterns {
    &rules().patterns
}
#[derive(Default)]
struct Collector {
    found: BTreeMap<String, (EnvConfidence, Vec<String>)>,
}

impl Collector {
    /// 代码、模板与文档里读到的名字：必须像钥匙，否则视为 Skill 自己的配置丢弃（#287）。
    fn add(&mut self, key: &str, confidence: EnvConfidence, evidence: String) {
        if !is_candidate_key(key) || !is_secret_key_name(key) {
            return;
        }
        self.insert(key, confidence, evidence);
    }

    /// 已知 SDK 目录给出的名字：目录本身就是钥匙证据，不再按名字判定。
    fn add_sdk(&mut self, rule: &SdkRule) {
        for key in &rule.keys {
            if !is_candidate_key(key) {
                continue;
            }
            self.insert(
                key,
                EnvConfidence::High,
                format!("依赖 {}（读取 {key}）", rule.label),
            );
        }
    }

    fn insert(&mut self, key: &str, confidence: EnvConfidence, evidence: String) {
        let entry = self
            .found
            .entry(key.to_string())
            .or_insert((confidence, Vec::new()));
        entry.0 = entry.0.min(confidence);
        if entry.1.len() < MAX_EVIDENCE_PER_KEY && !entry.1.contains(&evidence) {
            entry.1.push(evidence);
        }
    }

    fn into_suggestions(self) -> Vec<EnvSuggestion> {
        self.found
            .into_iter()
            .map(|(key, (confidence, evidence))| EnvSuggestion {
                key,
                confidence,
                evidence,
            })
            .collect()
    }
}

fn normalize_python_name(name: &str) -> String {
    name.trim().to_ascii_lowercase().replace('-', "_")
}

fn python_rule_matches(rule: &SdkRule, candidate: &str) -> bool {
    let candidate = normalize_python_name(candidate);
    rule.names.iter().any(|name| {
        candidate == *name
            || candidate
                .strip_prefix(name)
                .is_some_and(|rest| rest.starts_with('.'))
    })
}

fn add_python_package(collector: &mut Collector, package: &str) {
    for rule in rules()
        .sdk_catalog
        .iter()
        .filter(|rule| rule.ecosystem == Ecosystem::Python && python_rule_matches(rule, package))
    {
        collector.add_sdk(rule);
    }
}

fn add_node_package(collector: &mut Collector, specifier: &str) {
    let specifier = specifier.strip_prefix("npm:").unwrap_or(specifier);
    let mut segments = specifier.split('/');
    let package = match segments.next() {
        Some(scope) if scope.starts_with('@') => match segments.next() {
            Some(name) => format!("{scope}/{name}"),
            None => return,
        },
        Some(name) => name.to_string(),
        None => return,
    };
    for rule in rules()
        .sdk_catalog
        .iter()
        .filter(|rule| rule.ecosystem == Ecosystem::Node && rule.names.contains(&package))
    {
        collector.add_sdk(rule);
    }
}

/// `requirements*.txt`：每行取包名（去掉版本、extras、环境标记）。
fn scan_requirements(collector: &mut Collector, contents: &str) {
    for line in contents.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('-') {
            continue;
        }
        let name = line
            .split(|c: char| "[=<>!~;@ \t".contains(c))
            .next()
            .unwrap_or("");
        add_python_package(collector, name);
    }
}

/// `pyproject.toml`：PEP 621 依赖数组中的字符串与 Poetry 依赖表的键。
fn scan_pyproject(collector: &mut Collector, contents: &str) {
    let quoted = &patterns().pyproject_quoted;
    let table_key = &patterns().pyproject_table_key;
    for line in contents.lines() {
        for capture in quoted.captures_iter(line) {
            add_python_package(collector, &capture[1]);
        }
        if let Some(capture) = table_key.captures(line) {
            add_python_package(collector, &capture[1]);
        }
    }
}

fn scan_package_json(collector: &mut Collector, contents: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(contents) else {
        return;
    };
    for section in [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
    ] {
        if let Some(dependencies) = value.get(section).and_then(|value| value.as_object()) {
            for name in dependencies.keys() {
                add_node_package(collector, name);
            }
        }
    }
}

fn scan_imports(collector: &mut Collector, kind: FileKind, contents: &str) {
    let patterns = patterns();
    match kind {
        FileKind::Python => {
            for capture in patterns.python_import.captures_iter(contents) {
                for module in capture[1].split(',') {
                    let module = module.split_whitespace().next().unwrap_or("");
                    add_python_package(collector, module);
                }
            }
            for capture in patterns.python_from.captures_iter(contents) {
                let module = &capture[1];
                add_python_package(collector, module);
                for name in capture[2].split(',') {
                    if let Some(name) = name.split_whitespace().next() {
                        add_python_package(collector, &format!("{module}.{name}"));
                    }
                }
            }
        }
        FileKind::Script => {
            for capture in patterns.script_import.captures_iter(contents) {
                add_node_package(collector, &capture[1]);
            }
        }
        _ => {}
    }
}

fn line_number(line_starts: &[usize], offset: usize) -> usize {
    line_starts.partition_point(|start| *start <= offset)
}

fn scan_code(collector: &mut Collector, kind: FileKind, relative: &str, contents: &str) {
    let patterns = patterns();
    let line_starts: Vec<usize> = std::iter::once(0)
        .chain(contents.match_indices('\n').map(|(index, _)| index + 1))
        .collect();
    let mut add = |key: &str, offset: usize, confidence: EnvConfidence| {
        let line = line_number(&line_starts, offset);
        collector.add(key, confidence, format!("{relative}:{line}"));
    };
    let mut medium: Vec<&Regex> = patterns.common.iter().collect();
    match kind {
        FileKind::Shell => medium.push(&patterns.shell_bare),
        FileKind::PowerShell => medium.push(&patterns.powershell),
        FileKind::Batch => medium.push(&patterns.batch),
        _ => {}
    }
    for pattern in medium {
        for capture in pattern.captures_iter(contents) {
            let group = capture.get(1).expect("key group");
            add(group.as_str(), group.start(), EnvConfidence::Medium);
        }
    }
    for capture in patterns.destructuring.captures_iter(contents) {
        let group = capture.get(1).expect("destructuring group");
        for name in group.as_str().split(',') {
            let name = name
                .split([':', '='])
                .next()
                .unwrap_or("")
                .trim()
                .trim_start_matches("...");
            add(name, group.start(), EnvConfidence::Medium);
        }
    }
    if kind == FileKind::Markdown {
        for pattern in [&patterns.markdown_inline, &patterns.markdown_export] {
            for capture in pattern.captures_iter(contents) {
                let group = capture.get(1).expect("key group");
                add(group.as_str(), group.start(), EnvConfidence::Low);
            }
        }
    }
}

fn scan_env_template(collector: &mut Collector, relative: &str, contents: &str) {
    let pattern = &patterns().env_template_line;
    for (index, line) in contents.lines().enumerate() {
        if let Some(capture) = pattern.captures(line) {
            // 只取 key，绝不读取等号右侧的值。
            collector.add(
                &capture[1],
                EnvConfidence::High,
                format!("{relative}:{}", index + 1),
            );
        }
    }
}

fn is_pruned_dir(name: &str) -> bool {
    rules().pruned_dirs.iter().any(|dir| dir == name)
}

/// 只读扫描 `root`，返回按 key 排序的建议清单。不跟随符号链接；跳过本机
/// `.env` 值文件、sidecar、超大文件与非 UTF-8 文件。
pub fn detect_env_suggestions(root: &Path) -> Vec<EnvSuggestion> {
    let mut collector = Collector::default();
    let mut scanned = 0usize;
    let walker = WalkDir::new(root)
        .min_depth(1)
        .max_depth(MAX_SCAN_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !(entry.file_type().is_dir() && entry.file_name().to_str().is_some_and(is_pruned_dir))
        });
    for entry in walker {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(relative_path) = entry.path().strip_prefix(root) else {
            continue;
        };
        if crate::commands::is_local_env_value_path(relative_path) {
            continue;
        }
        let Some(name) = entry.file_name().to_str() else {
            continue;
        };
        let lower_name = name.to_ascii_lowercase();
        if lower_name == ".skillhub.json" {
            continue;
        }
        let is_template = rules()
            .env_template_names
            .iter()
            .any(|template| template == &lower_name);
        let is_requirements =
            lower_name.starts_with("requirements") && lower_name.ends_with(".txt");
        let extension = entry
            .path()
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase);
        let extension_kind = extension.as_deref().and_then(kind_for_extension);
        let maybe_shebang = extension.is_none() && !name.starts_with('.');
        if !is_template && !is_requirements && extension_kind.is_none() && !maybe_shebang {
            continue;
        }
        if !entry
            .metadata()
            .is_ok_and(|metadata| metadata.len() <= MAX_SCAN_FILE_BYTES)
        {
            continue;
        }
        if scanned >= MAX_SCAN_FILES {
            break;
        }
        scanned += 1;
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(contents) = String::from_utf8(bytes) else {
            continue;
        };
        let relative = relative_path
            .components()
            .map(|component| component.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/");
        if is_template {
            scan_env_template(&mut collector, &relative, &contents);
            continue;
        }
        if is_requirements {
            scan_requirements(&mut collector, &contents);
            continue;
        }
        if lower_name == "pyproject.toml" {
            scan_pyproject(&mut collector, &contents);
        } else if lower_name == "package.json" {
            scan_package_json(&mut collector, &contents);
        }
        let kind = match extension_kind {
            Some(kind) => kind,
            None => match contents.lines().next() {
                Some(first) if first.starts_with("#!") => kind_for_shebang(first),
                _ => continue,
            },
        };
        scan_imports(&mut collector, kind, &contents);
        scan_code(&mut collector, kind, &relative, &contents);
    }
    collector.into_suggestions()
}

/// 由检测建议生成的 sidecar 条目；`description` 只放固定文案，证据不落盘。
pub(crate) fn detected_dependency(key: String, confidence: EnvConfidence) -> EnvDepRaw {
    EnvDepRaw {
        key,
        description: Some(DETECTED_DESCRIPTION.into()),
        required: confidence.default_required(),
        share_policy: "none".into(),
        shared_teams: vec![],
        origin: Some(ORIGIN_DETECTED.into()),
        confidence: Some(confidence.as_str().into()),
        obtain: None,
        pending: None,
    }
}

fn manual_dependency(key: String) -> EnvDepRaw {
    EnvDepRaw {
        key,
        description: Some(MANUAL_DESCRIPTION.into()),
        required: true,
        share_policy: "none".into(),
        shared_teams: vec![],
        origin: Some(ORIGIN_MANUAL.into()),
        confidence: None,
        obtain: None,
        pending: None,
    }
}

/// SKILL.md `metadata.skillhub.env` 中声明的一项（#251）；本机共享设置沿用
/// 已有同名条目。
pub(crate) fn declared_dependency(
    declaration: &EnvDeclaration,
    local: Option<&EnvDepRaw>,
) -> EnvDepRaw {
    EnvDepRaw {
        key: declaration.key.clone(),
        description: declaration.description.clone(),
        required: declaration.required,
        share_policy: local
            .map(|item| item.share_policy.clone())
            .filter(|policy| !policy.is_empty())
            .unwrap_or_else(|| "none".into()),
        shared_teams: local
            .map(|item| item.shared_teams.clone())
            .unwrap_or_default(),
        origin: Some(ORIGIN_DECLARED.into()),
        confidence: Some(EnvConfidence::Declared.as_str().into()),
        obtain: declaration.obtain.clone(),
        pending: None,
    }
}

/// 声明优先于检测：同名 key 以声明的 required / description / obtain 为准，
/// 其余条目原样保留（检测只能补充新 key），结果按 key 排序。没有声明时不改动。
pub(crate) fn apply_declared_dependencies(
    dependencies: &mut Vec<EnvDepRaw>,
    declarations: &[EnvDeclaration],
) {
    if declarations.is_empty() {
        return;
    }
    let mut merged = dependencies
        .drain(..)
        .map(|dependency| (dependency.key.clone(), dependency))
        .collect::<BTreeMap<_, _>>();
    for declaration in declarations {
        let dependency = declared_dependency(declaration, merged.get(&declaration.key));
        merged.insert(declaration.key.clone(), dependency);
    }
    *dependencies = merged.into_values().collect();
}

/// 账号同步落地时只为已存在的同名条目标注声明来源与获取地址；依赖清单本身
/// 以账号资料为准，避免同步来回改写。
pub(crate) fn annotate_declared_dependencies(
    dependencies: &mut [EnvDepRaw],
    declarations: &[EnvDeclaration],
) {
    for dependency in dependencies {
        if let Some(declaration) = declarations
            .iter()
            .find(|declaration| declaration.key == dependency.key)
        {
            dependency.origin = Some(ORIGIN_DECLARED.into());
            dependency.confidence = Some(EnvConfidence::Declared.as_str().into());
            dependency.obtain = declaration.obtain.clone();
        }
    }
}

/// 导入（桌面与 CLI 共用 `import_skill_blocking`）时合并 declared / high / medium 建议
/// （medium 记为非必填）；
/// 已存在的条目保持原样，结果按 key 排序。
pub(crate) fn merge_import_suggestions(
    dependencies: &mut Vec<EnvDepRaw>,
    suggestions: &[EnvSuggestion],
) {
    let mut merged = dependencies
        .drain(..)
        .map(|dependency| (dependency.key.clone(), dependency))
        .collect::<BTreeMap<_, _>>();
    for suggestion in suggestions
        .iter()
        .filter(|suggestion| suggestion.confidence.merged_on_import())
    {
        merged
            .entry(suggestion.key.clone())
            .or_insert_with(|| detected_dependency(suggestion.key.clone(), suggestion.confidence));
    }
    *dependencies = merged.into_values().collect();
}

/// `sync_env_dependencies` 的纯函数核心：按 `keys` 顺序重建依赖；已存在的条目
/// 原样保留，新 key 若来自检测建议则记为 detected，否则记为用户手动添加。
pub(crate) fn resolve_synced_dependencies(
    existing: Vec<EnvDepRaw>,
    keys: Vec<String>,
    suggestions: &[EnvSuggestion],
) -> Vec<EnvDepRaw> {
    static KEY: OnceLock<Regex> = OnceLock::new();
    let key_pattern = KEY.get_or_init(|| Regex::new(r"^[A-Z][A-Z0-9_]{0,99}$").unwrap());
    let existing: BTreeMap<String, EnvDepRaw> = existing
        .into_iter()
        .map(|dependency| (dependency.key.clone(), dependency))
        .collect();
    let mut seen = BTreeSet::new();
    keys.into_iter()
        .filter(|key| key_pattern.is_match(key) && seen.insert(key.clone()))
        .map(|key| {
            if let Some(dependency) = existing.get(&key) {
                return dependency.clone();
            }
            match suggestions.iter().find(|suggestion| suggestion.key == key) {
                Some(suggestion) => detected_dependency(key, suggestion.confidence),
                None => manual_dependency(key),
            }
        })
        .collect()
}

/// 自动检测加入、但按现行规则不是钥匙的条目（如 `OUTPUT_DIR`）在重新检测 / 导入时移除
/// （#287）；作者声明、手动添加与运行时登记的条目不动。旧 sidecar 没有 `origin` 时按
/// 固定检测文案识别来源。返回是否有改动。
pub(crate) fn prune_non_secret_detected(dependencies: &mut Vec<EnvDepRaw>) -> bool {
    let before = dependencies.len();
    dependencies.retain(|dependency| {
        !is_detected_origin(dependency) || is_secret_key_name(&dependency.key)
    });
    dependencies.len() != before
}

fn is_detected_origin(dependency: &EnvDepRaw) -> bool {
    match dependency.origin.as_deref() {
        Some(origin) => origin == ORIGIN_DETECTED,
        None => matches!(
            dependency.description.as_deref(),
            Some(DETECTED_DESCRIPTION) | Some(LOCAL_ENV_DESCRIPTION)
        ),
    }
}

/// 商店 / 团队安装后的只读复查：检测到但 sidecar 未声明的 key（不含 low）。
pub(crate) fn undeclared_suggestion_keys(root: &Path, declared: &[String]) -> Vec<String> {
    detect_env_suggestions(root)
        .into_iter()
        .filter(|suggestion| suggestion.confidence != EnvConfidence::Low)
        .filter(|suggestion| !declared.contains(&suggestion.key))
        .map(|suggestion| suggestion.key)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("skillhub-env-detect-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn write(&self, relative: &str, contents: &str) -> &Self {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
            self
        }

        fn detect(&self) -> Vec<EnvSuggestion> {
            detect_env_suggestions(&self.0)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn summary(suggestions: &[EnvSuggestion]) -> Vec<(String, EnvConfidence)> {
        suggestions
            .iter()
            .map(|suggestion| (suggestion.key.clone(), suggestion.confidence))
            .collect()
    }

    fn pairs(items: &[(&str, EnvConfidence)]) -> Vec<(String, EnvConfidence)> {
        items
            .iter()
            .map(|(key, confidence)| (key.to_string(), *confidence))
            .collect()
    }

    const SKILL_MD: &str =
        "---\nname: demo\n---\n运行 `python ${CLAUDE_SKILL_DIR}/scripts/run.py $ARGUMENTS`\n";

    #[test]
    fn python_fal_client_is_detected_without_any_env_read() {
        let fixture = Fixture::new();
        fixture.write("SKILL.md", SKILL_MD).write(
            "scripts/gen.py",
            "import fal_client\n\nresult = fal_client.run('x')\n",
        );
        let suggestions = fixture.detect();
        assert_eq!(
            summary(&suggestions),
            pairs(&[("FAL_KEY", EnvConfidence::High)])
        );
        assert_eq!(
            suggestions[0].evidence,
            vec!["依赖 fal_client（读取 FAL_KEY）"]
        );
    }

    #[test]
    fn requirements_pyproject_and_package_json_map_to_catalog_keys() {
        let fixture = Fixture::new();
        fixture
            .write("requirements.txt", "boto3==1.34\nfal-client>=0.4 # images\nrequests\n")
            .write(
                "pyproject.toml",
                "[project]\nname = \"demo\"\ndependencies = [\"anthropic>=0.30\", \"google-genai\"]\n\n[tool.poetry.dependencies]\nhuggingface-hub = \"^0.20\"\n",
            )
            .write(
                "web/package.json",
                r#"{"dependencies":{"@fal-ai/client":"^1","openai":"^4"},"devDependencies":{"@mistralai/mistralai":"1"}}"#,
            );
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("ANTHROPIC_API_KEY", EnvConfidence::High),
                ("AWS_ACCESS_KEY_ID", EnvConfidence::High),
                ("AWS_SECRET_ACCESS_KEY", EnvConfidence::High),
                ("FAL_KEY", EnvConfidence::High),
                ("GEMINI_API_KEY", EnvConfidence::High),
                ("HF_TOKEN", EnvConfidence::High),
                ("MISTRAL_API_KEY", EnvConfidence::High),
                ("OPENAI_API_KEY", EnvConfidence::High),
            ])
        );
    }

    #[test]
    fn import_statements_map_every_catalog_entry() {
        let fixture = Fixture::new();
        fixture
            .write(
                "a.py",
                "from google import genai\nimport replicate, cohere as co\nfrom mistralai.client import Mistral\nfrom huggingface_hub import login\n",
            )
            .write(
                "b.ts",
                "import Anthropic from '@anthropic-ai/sdk'\nimport { GoogleGenAI } from \"@google/genai\"\nconst Replicate = require('replicate')\nconst c = await import('cohere-ai')\nimport fs from 'node:fs'\n",
            );
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("ANTHROPIC_API_KEY", EnvConfidence::High),
                ("CO_API_KEY", EnvConfidence::High),
                ("GEMINI_API_KEY", EnvConfidence::High),
                ("HF_TOKEN", EnvConfidence::High),
                ("MISTRAL_API_KEY", EnvConfidence::High),
                ("REPLICATE_API_TOKEN", EnvConfidence::High),
            ])
        );
    }

    #[test]
    fn python_getenv_variants_are_medium_with_line_evidence() {
        let fixture = Fixture::new();
        fixture.write(
            "scripts/run.py",
            "import os\nkey = os.getenv(\"FAL_KEY\")\nbase = os.environ.get( 'BASE_URL' , 'https://x')\ntoken = environ['TOKEN_A']\nother = getenv('TOKEN_B')\n",
        );
        let suggestions = fixture.detect();
        assert_eq!(
            summary(&suggestions),
            pairs(&[
                ("FAL_KEY", EnvConfidence::Medium),
                ("TOKEN_A", EnvConfidence::Medium),
                ("TOKEN_B", EnvConfidence::Medium),
            ])
        );
        assert_eq!(suggestions[0].evidence, vec!["scripts/run.py:2"]);
    }

    #[test]
    fn shell_bare_and_default_expansions_are_medium() {
        let fixture = Fixture::new();
        fixture
            .write(
                "scripts/run.sh",
                "#!/bin/sh\ncurl -H \"Authorization: Key $FAL_KEY\" \"${API_BASE:-https://fal.run}\"\n: \"${REGION:?missing}\"\necho $1 $HOME $NODE_ENV\n",
            )
            .write("bin/tool", "#!/usr/bin/env bash\necho $TOOL_TOKEN\n");
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("FAL_KEY", EnvConfidence::Medium),
                ("TOOL_TOKEN", EnvConfidence::Medium),
            ])
        );
    }

    #[test]
    fn typescript_destructuring_and_runtime_env_objects_are_medium() {
        let fixture = Fixture::new();
        fixture.write(
            "src/index.tsx",
            "const {\n  FAL_KEY,\n  OUTPUT_DIR: dir = '.',\n} = process.env\nconst a = process.env?.OPT_KEY\nconst b = import.meta.env.VITE_TOKEN\nconst c = Bun.env.BUN_TOKEN\nconst d = Deno.env.get('DENO_TOKEN')\nconst e = process.env.NODE_ENV\n",
        );
        let suggestions = fixture.detect();
        assert_eq!(
            summary(&suggestions),
            pairs(&[
                ("BUN_TOKEN", EnvConfidence::Medium),
                ("DENO_TOKEN", EnvConfidence::Medium),
                ("FAL_KEY", EnvConfidence::Medium),
                ("OPT_KEY", EnvConfidence::Medium),
                ("VITE_TOKEN", EnvConfidence::Medium),
            ])
        );
        let fal = suggestions
            .iter()
            .find(|item| item.key == "FAL_KEY")
            .unwrap();
        assert_eq!(fal.evidence, vec!["src/index.tsx:1"]);
    }

    #[test]
    fn rust_env_reads_are_medium() {
        let fixture = Fixture::new();
        fixture.write(
            "src/main.rs",
            "let a = std::env::var(\"RUST_TOKEN\");\nlet b = env::var_os(\"OS_TOKEN\");\nconst C: &str = env!(\"BUILD_TOKEN\");\nconst D: Option<&str> = option_env!(\"OPTIONAL_TOKEN\");\n",
        );
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("BUILD_TOKEN", EnvConfidence::Medium),
                ("OPTIONAL_TOKEN", EnvConfidence::Medium),
                ("OS_TOKEN", EnvConfidence::Medium),
                ("RUST_TOKEN", EnvConfidence::Medium),
            ])
        );
    }

    #[test]
    fn env_example_keys_are_high_and_values_are_never_read() {
        let fixture = Fixture::new();
        fixture
            .write(".env.example", "# fal\nFAL_KEY=your-key-here\nexport OUTPUT_DIR=./out\nlowercase=1\nNODE_ENV=production\n")
            .write("config/.env.sample", "REPLICATE_API_TOKEN=\n")
            .write(".env", "LOCAL_ONLY_SECRET=abc\n")
            .write(".env.local", "LOCAL_TOO=abc\n");
        let suggestions = fixture.detect();
        assert_eq!(
            summary(&suggestions),
            pairs(&[
                ("FAL_KEY", EnvConfidence::High),
                ("REPLICATE_API_TOKEN", EnvConfidence::High),
            ])
        );
        assert_eq!(suggestions[0].evidence, vec![".env.example:2"]);
        let serialized = serde_json::to_string(&suggestions).unwrap();
        assert!(!serialized.contains("your-key-here"));
    }

    #[test]
    fn pruned_directories_produce_no_suggestions() {
        let fixture = Fixture::new();
        fixture
            .write("SKILL.md", SKILL_MD)
            .write(
                "node_modules/openai/index.js",
                "process.env.OPENAI_API_KEY\n",
            )
            .write(
                "node_modules/x/package.json",
                r#"{"dependencies":{"openai":"1"}}"#,
            )
            .write(".venv/lib/site.py", "os.getenv('VENV_KEY')\n")
            .write("dist/out.js", "process.env.DIST_KEY\n")
            .write("build/out.js", "process.env.BUILD_KEY\n")
            .write("target/out.rs", "env!(\"TARGET_KEY\")\n")
            .write("__pycache__/x.py", "os.getenv('CACHE_KEY')\n")
            .write(".git/hooks/pre-commit", "#!/bin/sh\necho $GIT_KEY\n");
        assert!(fixture.detect().is_empty());
    }

    #[test]
    fn skill_md_placeholders_and_system_names_are_ignored() {
        let fixture = Fixture::new();
        fixture.write(
            "SKILL.md",
            "---\nname: demo\n---\n`${CLAUDE_SKILL_DIR}/run.sh` with ${CLAUDE_PLUGIN_ROOT} ${SKILL_DIR} $ARGUMENTS\nSet `NODE_ENV`, `LC_ALL`, ${DEBUG} ${CI} ${LANG} ${TZ} ${PATH} ${X}\n",
        );
        assert!(fixture.detect().is_empty());
    }

    #[test]
    fn markdown_prose_is_low_and_code_in_markdown_stays_medium() {
        let fixture = Fixture::new();
        fixture.write(
            "SKILL.md",
            "先设置 `FAL_KEY`：\n\n```bash\nexport OUTPUT_TOKEN=xxx\n```\n读取 ${SERVICE_SECRET}\n`README` 与 `API` 不是变量\n",
        );
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("FAL_KEY", EnvConfidence::Low),
                ("OUTPUT_TOKEN", EnvConfidence::Low),
                ("SERVICE_SECRET", EnvConfidence::Medium),
            ])
        );
    }

    #[test]
    fn strongest_confidence_wins_and_evidence_is_merged() {
        let fixture = Fixture::new();
        fixture.write("SKILL.md", "需要 `FAL_KEY`\n").write(
            "run.py",
            "import fal_client\nimport os\nos.environ['FAL_KEY']\n",
        );
        let suggestions = fixture.detect();
        assert_eq!(
            summary(&suggestions),
            pairs(&[("FAL_KEY", EnvConfidence::High)])
        );
        assert_eq!(suggestions[0].evidence.len(), 3);
        assert!(suggestions[0]
            .evidence
            .contains(&"依赖 fal_client（读取 FAL_KEY）".to_string()));
        assert!(suggestions[0].evidence.contains(&"run.py:3".to_string()));
        assert!(suggestions[0].evidence.contains(&"SKILL.md:1".to_string()));
    }

    #[test]
    fn new_extensions_are_scanned_and_unknown_or_oversized_files_are_skipped() {
        let fixture = Fixture::new();
        fixture
            .write("a.go", "os.Getenv(\"GO_TOKEN\")\n")
            .write("a.rb", "ENV['RUBY_TOKEN']; ENV.fetch(\"RUBY_PASSWORD\")\n")
            .write("a.php", "getenv('PHP_TOKEN');\n")
            .write("a.ps1", "$env:PS_TOKEN\n")
            .write("a.bat", "echo %BAT_TOKEN%\n")
            .write("a.yaml", "token: ${YAML_TOKEN}\n")
            .write("notes.txt", "process.env.TXT_TOKEN\n")
            .write("noshebang", "process.env.PLAIN_TOKEN\n")
            .write(".skillhub.json", "{\"x\": \"${SIDECAR_TOKEN}\"}\n");
        let big = format!(
            "process.env.BIG_TOKEN\n{}",
            "x".repeat(MAX_SCAN_FILE_BYTES as usize)
        );
        fixture.write("big.js", &big);
        fs::write(
            fixture.0.join("latin1.js"),
            b"process.env.LATIN_TOKEN \xff\n",
        )
        .unwrap();
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("BAT_TOKEN", EnvConfidence::Medium),
                ("GO_TOKEN", EnvConfidence::Medium),
                ("PHP_TOKEN", EnvConfidence::Medium),
                ("PS_TOKEN", EnvConfidence::Medium),
                ("RUBY_PASSWORD", EnvConfidence::Medium),
                ("RUBY_TOKEN", EnvConfidence::Medium),
                ("YAML_TOKEN", EnvConfidence::Medium),
            ])
        );
    }

    #[test]
    fn candidate_key_rules() {
        for accepted in ["FAL_KEY", "AB", "A1", "X_Y"] {
            assert!(is_candidate_key(accepted), "{accepted}");
        }
        for rejected in [
            "X", "fal_key", "Fal_Key", "NODE_ENV", "LC_ALL", "LC_CTYPE", "TZ", "CI", "1KEY",
        ] {
            assert!(!is_candidate_key(rejected), "{rejected}");
        }
    }

    #[test]
    fn secret_key_names_follow_the_shared_token_list() {
        for key in [
            "FAL_KEY",
            "OPENAI_API_KEY",
            "HF_TOKEN",
            "DB_PASSWORD",
            "CLIENT_SECRET",
            "GITHUB_PAT",
            "AWS_SECRET_ACCESS_KEY",
            "X_APIKEY",
            "BASIC_AUTH",
        ] {
            assert!(is_secret_key_name(key), "{key}");
        }
        for key in [
            "OUTPUT_DIR",
            "BASE_URL",
            "FAL_MODEL",
            "IMAGE_SIZE",
            "KEYWORD",
            "TOKENIZER",
            "REGION",
            "TIMEOUT_MS",
            "MONKEY",
        ] {
            assert!(!is_secret_key_name(key), "{key}");
        }
    }

    /// #287：只有像钥匙的名字进入建议；SDK 目录给出的名字不按名字判定。
    #[test]
    fn configuration_names_are_dropped_but_sdk_catalog_keys_are_kept() {
        let fixture = Fixture::new();
        fixture
            .write(
                "scripts/gen.py",
                "import os\nimport fal_client\nout = os.getenv('OUTPUT_DIR', '.')\nmodel = os.environ.get('FAL_MODEL')\nkey = os.getenv('REPLICATE_API_TOKEN')\n",
            )
            .write(".env.example", "BASE_URL=https://example.test\nIMAGE_SIZE=1024\nDB_PASSWORD=\n");
        assert_eq!(
            summary(&fixture.detect()),
            pairs(&[
                ("DB_PASSWORD", EnvConfidence::High),
                ("FAL_KEY", EnvConfidence::High),
                ("REPLICATE_API_TOKEN", EnvConfidence::Medium),
            ])
        );
    }

    /// #287：存量 sidecar 里由检测加入的配置名在下次检测 / 导入时移除；声明、手动、
    /// 运行时登记与旧格式的非检测条目保留。
    #[test]
    fn prune_drops_detected_configuration_names_only() {
        let mut deps = vec![
            detected_dependency("OUTPUT_DIR".into(), EnvConfidence::Medium),
            detected_dependency("FAL_KEY".into(), EnvConfidence::High),
            manual_dependency("IMAGE_SIZE".into()),
            EnvDepRaw {
                key: "FAL_MODEL".into(),
                description: Some(DETECTED_DESCRIPTION.into()),
                required: false,
                share_policy: "none".into(),
                shared_teams: vec![],
                origin: None,
                confidence: None,
                obtain: None,
                pending: None,
            },
            EnvDepRaw {
                key: "BASE_URL".into(),
                description: Some(LOCAL_ENV_DESCRIPTION.into()),
                required: true,
                share_policy: "none".into(),
                shared_teams: vec![],
                origin: None,
                confidence: None,
                obtain: None,
                pending: None,
            },
            EnvDepRaw {
                key: "API_HOST".into(),
                description: Some("作者说明".into()),
                required: true,
                share_policy: "none".into(),
                shared_teams: vec![],
                origin: None,
                confidence: None,
                obtain: None,
                pending: None,
            },
            EnvDepRaw {
                key: "REGION".into(),
                description: None,
                required: true,
                share_policy: "none".into(),
                shared_teams: vec![],
                origin: Some("runtime_request".into()),
                confidence: None,
                obtain: None,
                pending: Some(true),
            },
        ];
        assert!(prune_non_secret_detected(&mut deps));
        let keys: Vec<_> = deps.iter().map(|dep| dep.key.as_str()).collect();
        assert_eq!(keys, ["FAL_KEY", "IMAGE_SIZE", "API_HOST", "REGION"]);
        assert!(!prune_non_secret_detected(&mut deps));
    }

    #[test]
    fn required_and_import_merge_follow_confidence() {
        assert!(EnvConfidence::Declared.default_required());
        assert!(EnvConfidence::High.default_required());
        assert!(!EnvConfidence::Medium.default_required());
        assert!(!EnvConfidence::Low.default_required());
        let suggestion = |key: &str, confidence| EnvSuggestion {
            key: key.into(),
            confidence,
            evidence: vec![],
        };
        let mut deps = vec![EnvDepRaw {
            key: "EXISTING".into(),
            description: Some("作者说明".into()),
            required: false,
            share_policy: "team".into(),
            shared_teams: vec!["t".into()],
            origin: None,
            confidence: None,
            obtain: None,
            pending: None,
        }];
        merge_import_suggestions(
            &mut deps,
            &[
                suggestion("FAL_KEY", EnvConfidence::High),
                suggestion("EXISTING", EnvConfidence::High),
                suggestion("MAYBE", EnvConfidence::Medium),
                suggestion("HINT", EnvConfidence::Low),
            ],
        );
        let keys: Vec<_> = deps.iter().map(|dep| dep.key.as_str()).collect();
        assert_eq!(keys, ["EXISTING", "FAL_KEY", "MAYBE"]);
        assert_eq!(deps[0].origin, None);
        assert!(!deps[0].required);
        assert_eq!(deps[1].origin.as_deref(), Some("detected"));
        assert_eq!(deps[1].confidence.as_deref(), Some("high"));
        assert!(deps[1].required);
        assert_eq!(deps[2].origin.as_deref(), Some("detected"));
        assert_eq!(deps[2].confidence.as_deref(), Some("medium"));
        assert!(!deps[2].required);
        let deps: Vec<EnvDepRaw> = deps.into_iter().filter(|dep| dep.key != "MAYBE").collect();

        let synced = resolve_synced_dependencies(
            deps,
            vec![
                "FAL_KEY".into(),
                "MAYBE".into(),
                "MINE".into(),
                "bad".into(),
            ],
            &[suggestion("MAYBE", EnvConfidence::Medium)],
        );
        let keys: Vec<_> = synced.iter().map(|dep| dep.key.as_str()).collect();
        assert_eq!(keys, ["FAL_KEY", "MAYBE", "MINE"]);
        assert_eq!(synced[1].origin.as_deref(), Some("detected"));
        assert_eq!(synced[1].confidence.as_deref(), Some("medium"));
        assert!(!synced[1].required);
        assert_eq!(synced[2].origin.as_deref(), Some("manual"));
        assert_eq!(synced[2].description.as_deref(), Some("由用户手动添加"));
        assert!(synced[2].required);
    }

    /// CLI `skill import apply` 与桌面导入都经过 `import_skill_blocking`
    /// （合并 declared / high / medium）；桌面随后再用同一检测结果调用
    /// `sync_env_dependencies`。两条路径对同一目录必须得到相同依赖。
    #[test]
    fn cli_import_and_desktop_import_yield_identical_dependencies() {
        let fixture = Fixture::new();
        fixture
            .write("SKILL.md", SKILL_MD)
            .write(
                "scripts/gen.py",
                "import fal_client\nimport os\nos.getenv('OUTPUT_DIR')\n",
            )
            .write(".env.example", "REPLICATE_API_TOKEN=\n")
            .write(
                "node_modules/openai/index.js",
                "process.env.OPENAI_API_KEY\n",
            )
            .write("README.md", "可选 `EXTRA_HINT`\n");

        // 共享导入步骤（CLI 到此为止）。
        let import_scan = detect_env_suggestions(&fixture.0);
        let mut cli_deps = Vec::new();
        merge_import_suggestions(&mut cli_deps, &import_scan);

        // 桌面：导入后再检测，按同一规则（排除 low）合并后同步。
        let desktop_scan = detect_env_suggestions(&fixture.0);
        let mut keys: Vec<String> = cli_deps.iter().map(|dep| dep.key.clone()).collect();
        for suggestion in &desktop_scan {
            if suggestion.confidence.merged_on_import() && !keys.contains(&suggestion.key) {
                keys.push(suggestion.key.clone());
            }
        }
        let desktop_deps = resolve_synced_dependencies(cli_deps.clone(), keys, &desktop_scan);

        let as_json = |deps: &[EnvDepRaw]| serde_json::to_value(deps).unwrap();
        assert_eq!(as_json(&cli_deps), as_json(&desktop_deps));
        let keys: Vec<_> = cli_deps.iter().map(|dep| dep.key.as_str()).collect();
        // `OUTPUT_DIR` 不像钥匙，是 Skill 自己的配置，不写入（#287）；low 的 EXTRA_HINT 与噪声不写入。
        assert_eq!(keys, ["FAL_KEY", "REPLICATE_API_TOKEN"]);
        let summary: Vec<_> = cli_deps
            .iter()
            .map(|dep| (dep.confidence.as_deref().unwrap(), dep.required))
            .collect();
        assert_eq!(summary, [("high", true), ("high", true)]);
        assert!(cli_deps
            .iter()
            .all(|dep| dep.origin.as_deref() == Some("detected")));
    }

    #[test]
    fn old_sidecar_dependencies_round_trip_unchanged() {
        let old = serde_json::json!([
            {"key": "API_KEY", "description": "旧说明", "required": true, "sharePolicy": "team", "sharedTeams": ["t1"]},
            {"key": "OTHER", "description": null, "required": false, "sharePolicy": "none", "sharedTeams": []}
        ]);
        let parsed: Vec<EnvDepRaw> = serde_json::from_value(old.clone()).unwrap();
        assert!(parsed
            .iter()
            .all(|dep| dep.origin.is_none() && dep.confidence.is_none()));
        assert_eq!(serde_json::to_value(&parsed).unwrap(), old);

        let new = serde_json::json!({"key": "FAL_KEY", "description": "由 SkillHub 静态分析检测", "required": true, "sharePolicy": "none", "sharedTeams": [], "origin": "detected", "confidence": "high"});
        let parsed: EnvDepRaw = serde_json::from_value(new.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), new);
        assert_eq!(
            serde_json::to_value(detected_dependency("FAL_KEY".into(), EnvConfidence::High))
                .unwrap(),
            new
        );
    }

    #[test]
    fn suggestions_serialize_with_lowercase_confidence() {
        let value = serde_json::to_value(EnvSuggestion {
            key: "FAL_KEY".into(),
            confidence: EnvConfidence::Declared,
            evidence: vec!["x".into()],
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"key": "FAL_KEY", "confidence": "declared", "evidence": ["x"]})
        );
    }

    #[test]
    fn undeclared_keys_skip_declared_and_low() {
        let fixture = Fixture::new();
        fixture
            .write("run.py", "import openai\nimport os\nos.getenv('FAL_KEY')\n")
            .write("SKILL.md", "`HINT_ONLY`\n");
        assert_eq!(
            undeclared_suggestion_keys(&fixture.0, &["FAL_KEY".to_string()]),
            vec!["OPENAI_API_KEY".to_string()]
        );
    }

    /// The Server's package re-check (`server/src/lib/env-detect.ts`) runs the
    /// same cases over in-memory package files (#251).
    const DETECT_CASES: &str = include_str!("../tests/fixtures/env-detect-cases.json");

    #[derive(Deserialize)]
    struct DetectCase {
        name: String,
        files: BTreeMap<String, String>,
        expected: Vec<EnvSuggestion>,
    }

    #[test]
    fn shared_detection_cases_match() {
        let cases: Vec<DetectCase> = serde_json::from_str(DETECT_CASES).expect("parse cases");
        assert!(cases.len() >= 5);
        for case in cases {
            let fixture = Fixture::new();
            for (path, contents) in &case.files {
                fixture.write(path, contents);
            }
            let mut actual = fixture.detect();
            for suggestion in &mut actual {
                suggestion.evidence.sort();
            }
            assert_eq!(actual, case.expected, "{}", case.name);
        }
    }

    #[test]
    fn rules_json_is_shared_with_the_server_byte_for_byte() {
        let server = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../server/src/lib/env-detect-rules.json"),
        )
        .expect("read server copy of env-detect-rules.json");
        assert_eq!(server, RULES_JSON);
    }

    #[test]
    fn service_key_groups_find_names_of_the_same_service() {
        let fal = service_key_group("FAL_API_KEY").expect("fal.ai group");
        assert_eq!(fal.service, "fal.ai");
        assert!(fal.keys.iter().any(|key| key == "FAL_KEY"));
        assert_eq!(
            service_key_group("HF_TOKEN").map(|group| group.service.as_str()),
            Some("Hugging Face")
        );
        assert!(service_key_group("OUTPUT_DIR").is_none());
        assert!(service_key_group("fal_key").is_none());
        // 一个变量名只属于一个服务分组。
        let mut seen = std::collections::BTreeSet::new();
        for group in &rules().service_key_groups {
            for key in &group.keys {
                assert!(seen.insert(key.clone()), "{key} 出现在多个服务分组");
            }
        }
    }

    fn declared(key: &str, required: bool, obtain: Option<&str>) -> EnvDeclaration {
        EnvDeclaration {
            key: key.into(),
            required,
            description: Some(format!("{key} 声明")),
            obtain: obtain.map(str::to_string),
        }
    }

    #[test]
    fn declaration_wins_over_detection_and_detection_only_adds_keys() {
        let mut deps = vec![
            EnvDepRaw {
                share_policy: "team".into(),
                shared_teams: vec!["t1".into()],
                ..detected_dependency("FAL_KEY".into(), EnvConfidence::High)
            },
            detected_dependency("OUTPUT_DIR".into(), EnvConfidence::Medium),
        ];
        apply_declared_dependencies(
            &mut deps,
            &[
                declared("FAL_KEY", false, Some("https://fal.ai/dashboard/keys")),
                declared("REPLICATE_API_TOKEN", true, None),
            ],
        );
        merge_import_suggestions(
            &mut deps,
            &[
                EnvSuggestion {
                    key: "FAL_KEY".into(),
                    confidence: EnvConfidence::High,
                    evidence: vec![],
                },
                EnvSuggestion {
                    key: "OPENAI_API_KEY".into(),
                    confidence: EnvConfidence::High,
                    evidence: vec![],
                },
            ],
        );
        let summary: Vec<_> = deps
            .iter()
            .map(|dep| {
                (
                    dep.key.as_str(),
                    dep.origin.as_deref(),
                    dep.confidence.as_deref(),
                    dep.required,
                    dep.obtain.as_deref(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            vec![
                (
                    "FAL_KEY",
                    Some("declared"),
                    Some("declared"),
                    false,
                    Some("https://fal.ai/dashboard/keys")
                ),
                ("OPENAI_API_KEY", Some("detected"), Some("high"), true, None),
                ("OUTPUT_DIR", Some("detected"), Some("medium"), false, None),
                (
                    "REPLICATE_API_TOKEN",
                    Some("declared"),
                    Some("declared"),
                    true,
                    None
                ),
            ]
        );
        // Local share settings of an existing key survive the declaration.
        assert_eq!(deps[0].share_policy, "team");
        assert_eq!(deps[0].shared_teams, vec!["t1".to_string()]);
        assert_eq!(deps[0].description.as_deref(), Some("FAL_KEY 声明"));

        let mut synced = vec![detected_dependency("FAL_KEY".into(), EnvConfidence::High)];
        annotate_declared_dependencies(
            &mut synced,
            &[
                declared("FAL_KEY", false, Some("https://fal.ai/dashboard/keys")),
                declared("NEW_KEY", true, None),
            ],
        );
        assert_eq!(synced.len(), 1, "account sync never adds keys");
        assert_eq!(synced[0].origin.as_deref(), Some("declared"));
        assert!(
            synced[0].required,
            "account profile keeps its own required flag"
        );
        assert_eq!(
            synced[0].obtain.as_deref(),
            Some("https://fal.ai/dashboard/keys")
        );

        let mut untouched = vec![
            detected_dependency("B".into(), EnvConfidence::Medium),
            detected_dependency("A".into(), EnvConfidence::Medium),
        ];
        apply_declared_dependencies(&mut untouched, &[]);
        assert_eq!(
            untouched[0].key, "B",
            "no declaration leaves order unchanged"
        );
    }

    #[test]
    fn declared_dependency_with_obtain_round_trips_through_the_sidecar() {
        let dependency = declared_dependency(
            &declared("FAL_KEY", true, Some("https://fal.ai/dashboard/keys")),
            None,
        );
        let value = serde_json::to_value(&dependency).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"key": "FAL_KEY", "description": "FAL_KEY 声明", "required": true, "sharePolicy": "none", "sharedTeams": [], "origin": "declared", "confidence": "declared", "obtain": "https://fal.ai/dashboard/keys"})
        );
        let parsed: EnvDepRaw = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), value);
    }
}
