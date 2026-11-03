use std::fs;
use std::path::{Path, PathBuf};

use rpg_translator_core::{
    ExportBuilder, InstallOptions, Installer, OverlayConfig, Result, RollbackManager,
    RollbackOptions,
};
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
        &serde_json::to_string(&OverlayConfig::runtime_default()).expect("encode config"),
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
    assert!(
        game.join("js/plugins/rpg-translator/runtime/boot.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/runtime/text-orchestrator/orchestrator.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/runtime/foresight-scanner.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/runtime/wrapping.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/adapters/bitmap-text/bitmap-text-adapter.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/adapters/sprite-text/sprite-text-adapter.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/adapters/pixi-text/pixi-text-adapter.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/runtime/text-orchestrator/adapter-contract.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/runtime/replay-state.js")
            .is_file()
    );
    assert!(
        game.join("js/plugins/rpg-translator/manifest.json")
            .is_file()
    );
    assert!(report.install_manifest_path.is_file());
    assert_eq!(report.installed_files.len(), 22);

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
            "runtime/text-codec.js",
            "runtime/runtime-miss-logger.js",
            "runtime/lookup-index.js",
            "runtime/render-guard.js",
            "runtime/wrapping.js",
            "runtime/runtime-diagnostics.js",
            "runtime/replay-state.js",
            "runtime/text-orchestrator/orchestrator.js",
            "runtime/text-orchestrator/adapter-contract.js",
            "runtime/foresight-scanner.js",
            "runtime/cache-loader.js",
            "adapters/game-message/message-adapter.js",
            "adapters/window-text/window-text-adapter.js",
            "adapters/bitmap-text/bitmap-text-adapter.js",
            "adapters/sprite-text/sprite-text-adapter.js",
            "adapters/pixi-text/pixi-text-adapter.js",
            "runtime/startup-toast.js",
            "runtime/boot.js"
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

    let rollback = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })?;

    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(
        !game
            .join("js/plugins/rpg-translator/runtime/boot.js")
            .exists()
    );
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
fn reinstall_rollback_restores_previous_overlay_state_byte_for_byte() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let export2 = temp.path().join("export2");
    let original_plugins =
        r#"var $plugins = [{"name":"Existing","status":true,"description":"","parameters":{}}];"#;
    make_direct_game(&game, original_plugins);
    make_export_bundle(&export);
    make_export_bundle(&export2);
    write_text(
        &export2.join("cache.jsonl"),
        r#"{"cache_key":"ck:v1:1111111111111111111111111111111111111111111111111111111111111111","cache_aliases":["ck:v1:1111111111111111111111111111111111111111111111111111111111111111"],"source_text_id":2,"source_hash":"1111111111111111111111111111111111111111111111111111111111111111","source_language":"ja","target_language":"ko","normalized_text":"再インストール","visible_text":"再インストール","translation":"재설치","control_code_signature":"","context_hash":null}"#,
    );

    Installer::install(&install_options(game.clone(), export.clone()))?;
    let plugins_before_reinstall =
        fs::read_to_string(game.join("js/plugins.js")).expect("read installed plugins");
    let cache_before_reinstall =
        fs::read_to_string(game.join("js/plugins/rpg-translator/cache.jsonl"))
            .expect("read installed cache");
    let boot_before_reinstall = fs::read(game.join("js/plugins/rpg-translator/runtime/boot.js"))
        .expect("read installed boot");

    let reinstall_report = Installer::install(&install_options(game.clone(), export2))?;
    let reinstall_manifest: Value = serde_json::from_str(
        &fs::read_to_string(&reinstall_report.install_manifest_path)
            .expect("read reinstall manifest"),
    )
    .expect("parse reinstall manifest");
    assert!(
        reinstall_manifest["installed_files"]
            .as_array()
            .expect("installed files")
            .iter()
            .any(|file| file["previous_path"].as_str().is_some())
    );

    RollbackManager::rollback(&RollbackOptions {
        manifest_path: reinstall_report.install_manifest_path,
    })?;

    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        plugins_before_reinstall
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins/rpg-translator/cache.jsonl"))
            .expect("read restored cache"),
        cache_before_reinstall
    );
    assert_eq!(
        fs::read(game.join("js/plugins/rpg-translator/runtime/boot.js"))
            .expect("read restored boot"),
        boot_before_reinstall
    );
    assert!(game.join("js/plugins/RPGTranslator.js").exists());
    assert!(
        game.join("js/plugins/rpg-translator/runtime/boot.js")
            .exists()
    );

    Ok(())
}

#[test]
fn phase_6_7_completion_matrix_locks_export_install_and_rollback_evidence() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let original_plugins =
        r#"var $plugins = [{"name":"Existing","status":true,"description":"","parameters":{}}];"#;
    make_direct_game(&game, original_plugins);
    make_export_bundle(&export);

    let export_report = ExportBuilder::verify_bundle(&export)?;
    assert_eq!(export_report.included_count, 1);
    assert_eq!(export_report.skipped_count, 0);
    assert_eq!(export_report.manifest_hash.len(), 64);

    let report = Installer::install(&install_options(game.clone(), export.clone()))?;
    let manifest_text =
        fs::read_to_string(&report.install_manifest_path).expect("read install manifest");
    let manifest: Value = serde_json::from_str(&manifest_text).expect("parse install manifest");
    let installed = manifest["installed_files"]
        .as_array()
        .expect("installed files");

    assert_eq!(manifest["export_id"], 42);
    assert_eq!(
        manifest["plugins_backup_sha256"]
            .as_str()
            .expect("plugins backup hash")
            .len(),
        64
    );
    assert_eq!(
        manifest["required_asset_files"]
            .as_array()
            .expect("required asset files")
            .len(),
        3
    );
    assert_eq!(installed.len(), 22);
    assert!(
        installed[0]["path"]
            .as_str()
            .expect("runtime entry path")
            .ends_with("RPGTranslator.js")
    );
    assert!(
        installed[1]["path"]
            .as_str()
            .expect("text codec path")
            .ends_with("runtime/text-codec.js")
    );
    assert!(
        installed[19]["path"]
            .as_str()
            .expect("manifest path")
            .ends_with("manifest.json")
    );
    assert!(
        installed[20]["path"]
            .as_str()
            .expect("overlay config path")
            .ends_with("overlay-config.json")
    );
    assert!(
        installed[21]["path"]
            .as_str()
            .expect("cache jsonl path")
            .ends_with("cache.jsonl")
    );
    assert!(
        installed
            .iter()
            .all(|file| file["sha256"].as_str().expect("installed file hash").len() == 64)
    );
    assert_eq!(
        fs::read_to_string(&report.plugins_backup_path).expect("read plugins backup"),
        original_plugins
    );
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read installed plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    write_text(
        &game.join("js/plugins/rpg-translator/cache.jsonl"),
        "tampered",
    );
    let tamper_error = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path.clone(),
    })
    .expect_err("tampered installed cache fails rollback");
    assert!(tamper_error.to_string().contains("hash mismatch"));
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins after failed rollback")
            .contains("\"name\": \"RPGTranslator\"")
    );

    fs::copy(
        export.join("cache.jsonl"),
        game.join("js/plugins/rpg-translator/cache.jsonl"),
    )
    .expect("restore installed cache");
    let rollback = RollbackManager::rollback(&RollbackOptions {
        manifest_path: report.install_manifest_path,
    })?;
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(!game.join("js/plugins/rpg-translator").exists());
    assert!(
        rollback
            .removed_files
            .iter()
            .any(|path| path.ends_with("plugins.js.backup"))
    );

    Ok(())
}

#[test]
fn installer_rejects_runtime_contract_mismatch_before_mutating_game() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let original_plugins =
        r#"var $plugins = [{"name":"Existing","status":true,"description":"","parameters":{}}];"#;
    make_direct_game(&game, original_plugins);
    make_export_bundle(&export);

    let mut config = OverlayConfig::runtime_default();
    config.runtime_load_contract.plugin_entry_file = "WrongTranslator.js".to_string();
    write_text(
        &export.join("overlay-config.json"),
        &serde_json::to_string(&config).expect("encode broken config"),
    );

    let error = Installer::install(&install_options(game.clone(), export))
        .expect_err("runtime contract mismatch should stop install");

    assert!(
        error
            .to_string()
            .contains("runtime load contract plugin_entry_file"),
        "unexpected error: {error}"
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read plugins"),
        original_plugins
    );
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(!game.join("js/plugins/rpg-translator").exists());

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
    let installed_boot = game.join("js/plugins/rpg-translator/runtime/boot.js");
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
        "runtime/text-codec.js",
        "runtime/runtime-miss-logger.js",
        "runtime/lookup-index.js",
        "runtime/render-guard.js",
        "runtime/wrapping.js",
        "runtime/runtime-diagnostics.js",
        "runtime/replay-state.js",
        "runtime/text-orchestrator/orchestrator.js",
        "runtime/text-orchestrator/adapter-contract.js",
        "runtime/foresight-scanner.js",
        "runtime/cache-loader.js",
        "adapters/game-message/message-adapter.js",
        "adapters/window-text/window-text-adapter.js",
        "adapters/bitmap-text/bitmap-text-adapter.js",
        "adapters/sprite-text/sprite-text-adapter.js",
        "runtime/startup-toast.js",
        "runtime/boot.js",
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
