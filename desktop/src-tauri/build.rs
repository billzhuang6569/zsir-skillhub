fn main() {
    println!("cargo:rerun-if-env-changed=SKILLHUB_CHANNEL");
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=../scripts/build-channel.mjs");
    println!("cargo:rerun-if-changed=../official-channel.json");
    if std::env::var("SKILLHUB_CHANNEL").as_deref() == Ok("dev") {
        println!("cargo:rerun-if-changed=../skillhub.build.json");
    }
    let channel = std::process::Command::new("node")
        .arg("../scripts/build-channel.mjs")
        .output()
        .expect("Node.js is required to compile SkillHub channel constants");
    assert!(
        channel.status.success(),
        "{}",
        String::from_utf8_lossy(&channel.stderr)
    );
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("channel.rs"),
        channel.stdout,
    )
    .expect("write compiled channel constants");
    // The linker below supplies the same manifest for the app and test executables.
    // Suppress Tauri's binary-only manifest to avoid duplicate resource ID 1.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("build Tauri resources");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // Tauri's resource is embedded in the app, but not the library test executable.
        // Event publication links dialog code too, which requires Common Controls v6.
        let manifest = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap())
            .join("test-controls.manifest");
        std::fs::write(&manifest, r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls"
    version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*" />
  </dependentAssembly></dependency>
</assembly>"#).expect("write Windows controls manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
}
