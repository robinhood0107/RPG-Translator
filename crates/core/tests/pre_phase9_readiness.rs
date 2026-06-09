use std::fs;
use std::path::{Path, PathBuf};

use rpg_translator_core::{
    BatchTranslator, BatchTranslatorConfig, ExportBuilder, ExportPolicy, InstallOptions, Installer,
    NewTranslation, Result, RollbackManager, RollbackOptions, ScanOptions, TranslationDb,
    WorkbenchService,
};
use serde_json::{Value, json};
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, text).expect("write fixture");
}

fn write_json(path: &Path, value: Value) {
    write_text(path, &format!("{value}\n"));
}

fn make_direct_game(root: &Path) {
    write_json(
        &root.join("data/System.json"),
        json!({ "gameTitle": "Phase 9 Fixture", "advanced": {}, "optAutosave": true }),
    );
    write_text(&root.join("js/plugins.js"), "var $plugins = [];");
    write_json(
        &root.join("data/Map001.json"),
        json!({
            "events": [
                null,
                {
                    "id": 1,
                    "pages": [
                        {
                            "list": [
                                { "code": 401, "parameters": ["こんにちは\\N[1]"] },
                                { "code": 102, "parameters": [["はい", "いいえ"], 0, 0, 2, 0] }
                            ]
                        }
                    ]
                }
            ]
        }),
    );
}

fn output(rows: &[(i64, &str)]) -> String {
    rows.iter()
        .map(|(id, translation)| format!(r#"{{"id":{id},"translation":"{translation}"}}"#))
        .collect::<Vec<_>>()
        .join("\n")
}

fn install_options(game_root: PathBuf, export_dir: PathBuf, export_id: i64) -> InstallOptions {
    InstallOptions {
        game_root,
        export_dir,
        runtime_dir: None,
        project_id: None,
        export_id: Some(export_id),
    }
}

#[test]
fn synthetic_full_flow_smoke_scans_translates_exports_installs_and_rolls_back() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    make_direct_game(&game);

    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let scan = WorkbenchService::scan_game(&mut db, &game, ScanOptions::default())?;
    assert_eq!(scan.source_text_count, 3);
    assert_eq!(scan.occurrence_count, 3);

    let mut provider = rpg_translator_core::FakeProvider::from_outputs(vec![
        output(&[(2, "예"), (3, "아니요")]),
        output(&[(1, "안녕하세요¤")]),
    ]);
    let batch = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 8,
            retry_attempts: 0,
            ..BatchTranslatorConfig::default()
        },
    )?;
    assert_eq!(batch.completed_source_text_ids.len(), 3);
    assert!(batch.failed_source_text_ids.is_empty());

    for source_text_id in &batch.completed_source_text_ids {
        let translation = db
            .get_translation(*source_text_id, "ko")?
            .expect("translation from fake provider");
        db.upsert_translation(&NewTranslation {
            source_text_id: *source_text_id,
            target_language: "ko".to_string(),
            translated_text: translation.translated_text,
            provider: translation.provider,
            model: translation.model,
            provider_run_id: translation.provider_run_id,
            review_state: "accepted".to_string(),
            qa_state: "passed".to_string(),
        })?;
    }

    let export_report = ExportBuilder::export_project(
        &mut db,
        scan.project_id,
        "ko",
        &export,
        ExportPolicy::accepted_and_reviewed(),
    )?;
    assert_eq!(export_report.included_count, 3);
    assert!(export.join("manifest.json").is_file());
    assert!(export.join("overlay-config.json").is_file());
    assert!(export.join("cache.jsonl").is_file());

    let original_plugins = fs::read_to_string(game.join("js/plugins.js")).expect("read plugins");
    let install_report = Installer::install(&install_options(
        game.clone(),
        export,
        export_report.export_id,
    ))?;
    assert!(game.join("js/plugins/RPGTranslator.js").is_file());
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read installed plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    let rollback = RollbackManager::rollback(&RollbackOptions {
        manifest_path: install_report.install_manifest_path,
    })?;
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read rolled back plugins"),
        original_plugins
    );
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(
        rollback
            .removed_files
            .iter()
            .any(|path| path.ends_with("RPGTranslator.js"))
    );

    Ok(())
}
