use std::fs;
use std::path::Path;

use rpg_translator_core::{
    ExportBuilder, ExportPolicy, InstallOptions, Installer, NewTranslation, Result,
    RollbackManager, RollbackOptions, RuntimeCacheRecord, ScanOptions, TranslationDb,
    WorkbenchService,
};
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, text).expect("write fixture");
}

fn make_synthetic_game(root: &Path) {
    write_text(
        &root.join("data/System.json"),
        r#"{"gameTitle":"Usable Smoke","advanced":{},"optAutosave":true,"terms":{"basic":["Level","HP"]}}"#,
    );
    write_text(&root.join("js/plugins.js"), "var $plugins = [];");
    write_text(
        &root.join("data/CommonEvents.json"),
        r#"[
null,
{"id":1,"name":"Smoke Common","list":[
  {"code":101,"indent":0,"parameters":["",0,0,2,"Narrator"]},
  {"code":401,"indent":0,"parameters":["Emma looks at the locked gate."]},
  {"code":401,"indent":0,"parameters":["The city keeps its secrets."]},
  {"code":102,"indent":0,"parameters":[["Open it","Walk away"],0,0,2,0]},
  {"code":0,"indent":0,"parameters":[]}
]}
]"#,
    );
}

#[test]
fn usable_parity_smoke_scans_exports_installs_and_rolls_back_copy_game() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("copy-game");
    let export = temp.path().join("export");
    make_synthetic_game(&game);

    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let scan = WorkbenchService::scan_game(
        &mut db,
        &game,
        ScanOptions {
            source_language: "en".to_string(),
            disable_cjk_filter: false,
        },
    )?;
    assert_eq!(scan.skipped_count, 0);
    assert!(scan.source_text_count >= 3);
    assert!(scan.occurrence_count >= 3);
    assert_eq!(scan.added_source_text_count, scan.source_text_count);

    let rows = db.review_queue_rows(scan.project_id, "ko", None)?;
    assert!(
        rows.iter()
            .any(|row| row.normalized_text == "Emma looks at the locked gate.\nThe city keeps its secrets."),
        "scanner should keep Show Text as one runtime message block"
    );
    for row in rows {
        db.upsert_translation(&NewTranslation {
            source_text_id: row.source_text_id,
            target_language: "ko".to_string(),
            translated_text: format!("KO: {}", row.normalized_text),
            provider: "smoke-fixture".to_string(),
            model: Some("synthetic".to_string()),
            provider_run_id: None,
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
    assert_eq!(export_report.included_count as i64, scan.source_text_count);
    ExportBuilder::verify_bundle(&export)?;

    let cache_text = fs::read_to_string(export.join("cache.jsonl")).expect("read cache");
    assert!(cache_text.contains("Emma looks at the locked gate.\\nThe city keeps its secrets."));
    let block_record = cache_text
        .lines()
        .map(|line| serde_json::from_str::<RuntimeCacheRecord>(line).expect("parse record"))
        .find(|record| {
            record.normalized_text == "Emma looks at the locked gate.\nThe city keeps its secrets."
        })
        .expect("message block cache record");
    assert!(
        block_record
            .cache_aliases
            .iter()
            .any(|alias| alias == &block_record.cache_key),
        "runtime export should include the primary block lookup key"
    );

    let install_report = Installer::install_with_db(
        &mut db,
        &InstallOptions {
            game_root: game.clone(),
            export_dir: export.clone(),
            runtime_dir: None,
            project_id: Some(scan.project_id),
            export_id: Some(export_report.export_id),
        },
    )?;
    assert!(game.join("js/plugins/RPGTranslator.js").is_file());
    assert!(game.join("js/plugins/rpg-translator/overlay-config.json").is_file());
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    RollbackManager::rollback(&RollbackOptions {
        manifest_path: install_report.install_manifest_path,
    })?;
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        "var $plugins = [];"
    );
    assert!(!game.join("js/plugins/RPGTranslator.js").exists());
    assert!(!game.join("js/plugins/rpg-translator").exists());

    Ok(())
}
