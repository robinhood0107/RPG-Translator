use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..")
}

fn script_command(script: &Path) -> Command {
    if cfg!(windows) {
        let git_bash = Path::new(r"C:\Program Files\Git\bin\bash.exe");
        let mut command = if git_bash.exists() {
            Command::new(git_bash)
        } else {
            Command::new("bash")
        };
        command.arg(script);
        command
    } else {
        Command::new(script)
    }
}

fn run_local_only_guard(input: &str) -> std::process::Output {
    let script = repo_root().join("scripts/check-local-only.sh");
    let mut command = script_command(&script);
    let mut child = command
        .arg("--stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn local-only guard");
    child
        .stdin
        .as_mut()
        .expect("guard stdin")
        .write_all(input.as_bytes())
        .expect("write guard stdin");
    child.wait_with_output().expect("wait for guard")
}

#[test]
fn local_only_guard_accepts_regular_source_paths() {
    let output = run_local_only_guard(
        "crates/core/src/lib.rs\nruntime/overlay-plugin/boot.js\n.github/workflows/ci.yml\n",
    );

    assert!(
        output.status.success(),
        "guard unexpectedly failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn local_only_guard_rejects_local_docs_test_games_and_generated_outputs() {
    let output = run_local_only_guard(
        "SPEC.md\ndontupload/City_Of_Secrets/data/System.json\nlogs/run.log\nexports/cache.jsonl\n",
    );

    assert!(!output.status.success(), "guard unexpectedly passed");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("SPEC.md"));
    assert!(stderr.contains("dontupload/City_Of_Secrets/data/System.json"));
    assert!(stderr.contains("logs/run.log"));
    assert!(stderr.contains("exports/cache.jsonl"));
}

#[test]
fn release_archive_guard_accepts_current_committed_source_tree() {
    let script = repo_root().join("scripts/check-release-archive.sh");
    let output = script_command(&script)
        .current_dir(repo_root())
        .output()
        .expect("run release archive guard");

    assert!(
        output.status.success(),
        "archive guard failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run_production_hardcoding_guard(input: &str) -> std::process::Output {
    let script = repo_root().join("scripts/check-production-hardcoding.sh");
    let mut command = script_command(&script);
    let mut child = command
        .current_dir(repo_root())
        .arg("--stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn production hardcoding guard");
    child
        .stdin
        .as_mut()
        .expect("guard stdin")
        .write_all(input.as_bytes())
        .expect("write guard stdin");
    child.wait_with_output().expect("wait for guard")
}

#[test]
fn production_hardcoding_guard_blocks_mock_and_default_paths_in_app_sources() {
    let probe_rel = "apps/desktop/src/__guard_probe_for_production_hardcoding_test.ts";
    let probe_path = repo_root().join(probe_rel);
    fs::write(&probe_path, "export const label = 'Run fake provider';\n")
        .expect("write production hardcoding guard probe");

    let output = run_production_hardcoding_guard(probe_rel);
    fs::remove_file(&probe_path).expect("remove production hardcoding guard probe");

    assert!(
        !output.status.success(),
        "hardcoding guard should reject production mock surfaces"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("Run fake provider"));
}

#[test]
fn production_hardcoding_guard_lists_removed_local_test_write_copy_patterns() {
    let script = fs::read_to_string(repo_root().join("scripts/check-production-hardcoding.sh"))
        .expect("read production hardcoding guard");

    assert!(script.contains("allowLocalTestMutation"));
    assert!(script.contains("Allow local test game writes"));
    assert!(script.contains("로컬 테스트 게임 쓰기 허용"));
}

#[test]
fn production_hardcoding_guard_allows_test_fixtures() {
    let output = run_production_hardcoding_guard(
        "crates/core/tests/batch_translation.rs\ncrates/core/src/batch.rs\nruntime/overlay-plugin/tests/runtime-overlay.test.js\n",
    );

    assert!(
        output.status.success(),
        "hardcoding guard should allow test fixtures: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn windows_tauri_config_uses_nsis_with_offline_webview2_installer() {
    let config_path = repo_root().join("apps/desktop/src-tauri/tauri.windows.conf.json");
    let config_text = std::fs::read_to_string(config_path).expect("read windows tauri config");
    let config: serde_json::Value =
        serde_json::from_str(&config_text).expect("windows tauri config is valid JSON");

    let targets = config["bundle"]["targets"]
        .as_array()
        .expect("bundle.targets is an array");
    assert!(
        targets.iter().any(|target| target == "nsis"),
        "Windows bundle targets should include nsis"
    );

    let webview_mode = &config["bundle"]["windows"]["webviewInstallMode"];
    assert_eq!(
        webview_mode["type"].as_str(),
        Some("offlineInstaller"),
        "Windows installer should embed the offline WebView2 installer"
    );
    assert_eq!(
        webview_mode["silent"].as_bool(),
        Some(true),
        "Windows WebView2 installer should run silently"
    );

    let nsis = &config["bundle"]["windows"]["nsis"];
    assert_eq!(nsis["installMode"].as_str(), Some("currentUser"));
    assert_eq!(nsis["compression"].as_str(), Some("lzma"));
    assert_eq!(
        nsis["installerHooks"].as_str(),
        Some("installer-hooks.nsh"),
        "Windows NSIS installer should load uninstall cleanup hooks"
    );
}

#[test]
fn windows_nsis_uninstaller_removes_tauri_webview_app_data() {
    let hooks_path = repo_root().join("apps/desktop/src-tauri/installer-hooks.nsh");
    let hooks = std::fs::read_to_string(hooks_path).expect("read NSIS installer hooks");

    assert!(hooks.contains("NSIS_HOOK_POSTUNINSTALL"));
    assert!(hooks.contains("$LOCALAPPDATA\\com.rpgtranslator.workbench"));
    assert!(hooks.contains("RMDir /r"));
}

#[test]
fn desktop_tauri_release_uses_embedded_custom_protocol_assets() {
    let cargo_path = repo_root().join("apps/desktop/src-tauri/Cargo.toml");
    let cargo_text = std::fs::read_to_string(cargo_path).expect("read desktop Cargo.toml");
    assert!(
        cargo_text.contains("custom-protocol"),
        "desktop release builds must enable Tauri custom-protocol so bundled EXEs load embedded frontendDist assets instead of devUrl"
    );

    let vite_path = repo_root().join("apps/desktop/vite.config.ts");
    let vite_text = std::fs::read_to_string(vite_path).expect("read desktop vite config");
    assert!(
        vite_text.contains("base: \"./\""),
        "Vite release assets must use relative paths so embedded Tauri HTML can load JS/CSS without a localhost dev server"
    );
}
