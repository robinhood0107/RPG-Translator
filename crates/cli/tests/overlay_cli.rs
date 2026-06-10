use std::fs;
use std::path::Path;
use std::process::Command;

use rpg_translator_core::OverlayConfig;
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, text).expect("write fixture");
}

fn make_game(root: &Path, plugins_js: &str) {
    write_text(
        &root.join("data/System.json"),
        r#"{"gameTitle":"Fixture","terms":{"basic":["Level","HP"]}}"#,
    );
    write_text(
        &root.join("data/Map001.json"),
        r#"{"events":[null,{"id":1,"pages":[{"list":[{"code":101,"indent":0,"parameters":["","","",0,"Emma"]},{"code":401,"indent":0,"parameters":["Emma looks at the locked gate."]},{"code":401,"indent":0,"parameters":["The city keeps its secrets."]},{"code":0,"indent":0,"parameters":[]}]}]}]}"#,
    );
    write_text(&root.join("js/plugins.js"), plugins_js);
}

fn make_export_bundle(root: &Path) {
    write_text(
        &root.join("manifest.json"),
        r#"{"schema_version":1,"project_id":1,"source_language":"ja","target_language":"ko","created_timestamp":"1","key_schema_version":"v1","cache_files":["cache.jsonl"],"record_count":1}"#,
    );
    write_text(
        &root.join("overlay-config.json"),
        &serde_json::to_string(&OverlayConfig::runtime_default()).expect("encode config"),
    );
    write_text(
        &root.join("cache.jsonl"),
        r#"{"cache_key":"ck:v1:0000000000000000000000000000000000000000000000000000000000000000","cache_aliases":["ck:v1:0000000000000000000000000000000000000000000000000000000000000000"],"source_text_id":1,"source_hash":"0000000000000000000000000000000000000000000000000000000000000000","source_language":"ja","target_language":"ko","normalized_text":"世界","visible_text":"世界","translation":"세계","control_code_signature":"","context_hash":null}"#,
    );
}

#[test]
fn cli_install_and_rollback_overlay_smoke() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_game(&game, original_plugins);
    make_export_bundle(&export);

    let install = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "install-overlay",
            "--game-root",
            game.to_str().expect("game path"),
            "--export-dir",
            export.to_str().expect("export path"),
            "--export-id",
            "7",
        ])
        .output()
        .expect("run install command");
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let manifest_path = game
        .join("js")
        .join("plugins")
        .join("rpg-translator")
        .join("install-manifest.json");
    assert!(manifest_path.is_file());
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    let rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            manifest_path.to_str().expect("manifest path"),
        ])
        .output()
        .expect("run rollback command");
    assert!(
        rollback.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
}

#[test]
fn cli_install_and_rollback_apply_without_local_allowance_flag() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("dontupload").join("game");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_game(&game, original_plugins);
    make_export_bundle(&export);

    let install = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "install-overlay",
            "--game-root",
            game.to_str().expect("game path"),
            "--export-dir",
            export.to_str().expect("export path"),
        ])
        .output()
        .expect("run install command");
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let manifest_path = game
        .join("js")
        .join("plugins")
        .join("rpg-translator")
        .join("install-manifest.json");
    let rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            manifest_path.to_str().expect("manifest path"),
        ])
        .output()
        .expect("run rollback command");
    assert!(
        rollback.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
}

#[test]
fn cli_scan_game_writes_project_db_and_reports_block_units() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let db = temp.path().join("workbench.sqlite");
    make_game(&game, "var $plugins = [];");

    let output = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "scan-game",
            "--game-root",
            game.to_str().expect("game path"),
            "--db",
            db.to_str().expect("db path"),
            "--source-language",
            "en",
        ])
        .output()
        .expect("run scan command");

    assert!(
        output.status.success(),
        "scan failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("scanned project_id="));
    assert!(stdout.contains("source_texts="));
    assert!(stdout.contains("occurrences="));
    assert!(db.is_file());
}

#[test]
fn cli_rejects_missing_required_install_args() {
    let output = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .arg("install-overlay")
        .output()
        .expect("run invalid install command");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--game-root"));
}
