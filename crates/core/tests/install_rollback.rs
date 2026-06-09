use std::fs;
use std::path::{Path, PathBuf};

use rpg_translator_core::{InstallOptions, Installer, Result, RollbackManager, RollbackOptions};
use serde_json::Value;
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, text).expect("write fixture");
}

fn make_direct_game(root: &Path, plugins_js: &str) {
    write_text(&root.join("data/System.json"), r#"{"gameTitle":"Fixture"}"#);
    write_text(&root.join("js/plugins.js"), plugins_js);
}

fn make_www_game(root: &Path, plugins_js: &str) {
    write_text(
        &root.join("www/data/System.json"),
        r#"{"gameTitle":"Fixture","advanced":{},"optAutosave":true}"#,
    );
    write_text(&root.join("www/js/plugins.js"), plugins_js);
}

fn make_export_bundle(root: &Path) {
    write_text(
        &root.join("manifest.json"),
        r#"{"schema_version":1,"project_id":1,"source_language":"ja","target_language":"ko","created_timestamp":"1","key_schema_version":"v1","cache_files":["cache.jsonl"],"record_count":1}"#,
    );
    write_text(
        &root.join("overlay-config.json"),
        r#"{"schema_version":1,"diagnostics_enabled":false,"startup_toast_enabled":true,"startup_toast_text":"RPG-Translator 작동중"}"#,
    );
    write_text(
        &root.join("cache.jsonl"),
        r#"{"cache_key":"ck:v1:0000000000000000000000000000000000000000000000000000000000000000","cache_aliases":["ck:v1:0000000000000000000000000000000000000000000000000000000000000000"],"source_text_id":1,"source_hash":"0000000000000000000000000000000000000000000000000000000000000000","source_language":"ja","target_language":"ko","normalized_text":"世界","visible_text":"世界","translation":"세계","control_code_signature":"","context_hash":null}"#,
    );
}

fn install_options(game_root: PathBuf, export_dir: PathBuf) -> InstallOptions {
    InstallOptions {
        game_root,
        export_dir,
        runtime_dir: None,
        project_id: None,
        export_id: Some(42),
    }
}

#[test]
fn installer_installs_direct_layout_and_rollback_restores_original_plugins() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let original_plugins =
        r#"var $plugins = [{"name":"Existing","status":true,"description":"","parameters":{}}];"#;
    make_direct_game(&game, original_plugins);
    make_export_bundle(&export);

    let report = Installer::install(&install_options(game.clone(), export))?;

    assert!(game.join("js/plugins/RPGTranslator.js").is_file());
    assert!(game.join("js/plugins/rpg-translator/boot.js").is_file());
    assert!(
        game.join("js/plugins/rpg-translator/bitmap-text-adapter.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/sprite-text-adapter.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/pixi-text-adapter.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/manifest.json")
            .is_file()
    );
    assert!(report.install_manifest_path.is_file());
    assert_eq!(report.installed_files.len(), 16);

    let plugins = fs::read_to_string(game.join("js/plugins.js")).expect("read plugins");
    assert_eq!(plugins.matches("\"name\": \"RPGTranslator\"").count(), 1);
    assert!(plugins.contains("\"status\": true"));

    let manifest: Value = serde_json::from_str(
        &fs::read_to_string(&report.install_manifest_path).expect("read install manifest"),
    )
    .expect("parse install manifest");
    assert_eq!(manifest["export_id"], 42);
    assert_eq!(manifest["support_directory"], "rpg-translator");
    assert_eq!(manifest["plugin_entry_file"], "RPGTranslator.js");
    assert_eq!(manifest["plugin_entry_status"], true);
    assert_eq!(
        manifest["runtime_script_load_order"],
        serde_json::json!([
            "text-codec.js",
            "runtime-miss-logger.js",
            "lookup-index.js",
            "render-guard.js",
            "cache-loader.js",
            "message-adapter.js",
            "window-text-adapter.js",
            "bitmap-text-adapter.js",
            "sprite-text-adapter.js",
            "pixi-text-adapter.js",
            "startup-toast.js",
            "boot.js"
        ])
    );
    assert_eq!(
        manifest["required_asset_files"],
        serde_json::json!(["manifest.json", "overlay-config.json", "cache.jsonl"])
    );
    assert_eq!(
        manifest["plugins_backup_sha256"]
            .as_str()
            .expect("backup hash")
            .len(),
        64
    );
    assert!(
        manifest["installed_files"]
            .as_array()
            .expect("files")
            .iter()
            .all(|file| { file["sha256"].as_str().expect("hash").len() == 64 })
    );

    let second_report =
        Installer::install(&install_options(game.clone(), temp.path().join("export")))?;
    let plugins_after_second =
        fs::read_to_string(game.join("js/plugins.js")).expect("read plugins");
    assert_eq!(
        plugins_after_second
            .matches("\"name\": \"RPGTranslator\"")
            .count(),
        1
    );
    assert_eq!(
        second_report.plugins_backup_path,
        report.plugins_backup_path
    );

    let rollback = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })?;

    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(!game.join("js/plugins/rpg-translator/boot.js").exists());
    assert!(!game.join("js/plugins/rpg-translator").exists());
    assert!(
        rollback
            .removed_files
            .iter()
            .any(|path| path.ends_with("RPGTranslator.js"))
    );

    Ok(())
}

#[test]
fn rollback_rejects_modified_backup_before_mutating_game() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    make_direct_game(&game, "var $plugins = [];");
    make_export_bundle(&export);

    let report = Installer::install(&install_options(game.clone(), export))?;
    write_text(&report.plugins_backup_path, "tampered backup");

    let error = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })
    .expect_err("tampered backup fails rollback");

    assert!(error.to_string().contains("hash mismatch"));
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );
    assert!(game.join("js/plugins/RPGTranslator.js").exists());

    Ok(())
}

#[test]
fn rollback_rejects_modified_installed_files_before_mutating_game() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_direct_game(&game, original_plugins);
    make_export_bundle(&export);

    let report = Installer::install(&install_options(game.clone(), export))?;
    let installed_boot = game.join("js/plugins/rpg-translator/boot.js");
    write_text(&installed_boot, "tampered");

    let error = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })
    .expect_err("tampered install files fail rollback");

    assert!(error.to_string().contains("hash mismatch"));
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );
    assert!(installed_boot.exists());

    Ok(())
}

#[test]
fn rollback_rejects_manifest_paths_outside_game_root_before_mutating_game() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    make_direct_game(&game, "var $plugins = [];");
    make_export_bundle(&export);

    let report = Installer::install(&install_options(game.clone(), export))?;
    let mut manifest: Value = serde_json::from_str(
        &fs::read_to_string(&report.install_manifest_path).expect("read install manifest"),
    )
    .expect("parse install manifest");
    let outside = temp.path().join("outside.js");
    write_text(&outside, "outside");
    manifest["installed_files"][0]["path"] =
        Value::String(outside.to_string_lossy().replace('\\', "/"));
    write_text(
        &report.install_manifest_path,
        &serde_json::to_string_pretty(&manifest).expect("encode manifest"),
    );

    let error = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })
    .expect_err("outside install path fails rollback");

    assert!(error.to_string().contains("outside game root"));
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );
    assert!(outside.exists());

    Ok(())
}

#[test]
fn installer_uses_www_layout_plugins_directory() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    make_www_game(&game, "var $plugins = [];");
    make_export_bundle(&export);

    Installer::install(&install_options(game.clone(), export))?;

    assert!(game.join("www/js/plugins/RPGTranslator.js").is_file());
    assert!(
        game.join("www/js/plugins/rpg-translator/cache.jsonl")
            .is_file()
    );
    assert!(
        fs::read_to_string(game.join("www/js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    Ok(())
}

#[test]
fn installer_rejects_malformed_plugins_before_mutating_files() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    make_direct_game(&game, "var $plugins = [");
    make_export_bundle(&export);

    let error = Installer::install(&install_options(game.clone(), export))
        .expect_err("malformed plugins fails");

    assert!(error.to_string().contains("plugins.js"));
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(!game.join("js/plugins/rpg-translator").exists());
}

#[test]
fn installer_rejects_missing_runtime_support_file_before_mutating_game() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let runtime = temp.path().join("runtime");
    make_direct_game(&game, "var $plugins = [];");
    make_export_bundle(&export);
    for file in [
        "RPGTranslator.js",
        "text-codec.js",
        "runtime-miss-logger.js",
        "lookup-index.js",
        "render-guard.js",
        "cache-loader.js",
        "message-adapter.js",
        "window-text-adapter.js",
        "bitmap-text-adapter.js",
        "sprite-text-adapter.js",
        "startup-toast.js",
        "boot.js",
    ] {
        write_text(&runtime.join(file), "// fixture");
    }

    let mut options = install_options(game.clone(), export);
    options.runtime_dir = Some(runtime);
    let error = Installer::install(&options).expect_err("missing pixi adapter fails");

    assert!(error.to_string().contains("pixi-text-adapter.js"));
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(!game.join("js/plugins/rpg-translator").exists());
}

#[test]
fn installer_applies_without_local_test_allowance_flag() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("dontupload").join("game");
    let export = temp.path().join("export");
    make_direct_game(&game, "var $plugins = [];");
    make_export_bundle(&export);

    let report = Installer::install(&install_options(game.clone(), export))?;
    assert!(game.join("js/plugins/RPGTranslator.js").is_file());
    RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })?;
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());

    Ok(())
}
