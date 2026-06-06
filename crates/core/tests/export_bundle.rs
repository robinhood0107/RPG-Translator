use std::fs;
use std::process::Command;

use rpg_translator_core::{
    CacheKeyBuilder, CacheKeyParts, Engine, ExportBuilder, ExportPolicy, NewProject, NewSourceText,
    NewTranslation, OverlayConfig, Result, RuntimeCacheRecord, RuntimeExportManifest, TextCodec,
    TranslationDb,
};
use tempfile::tempdir;

fn seed_project(db: &mut TranslationDb) -> Result<i64> {
    db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })
}

fn seed_source(db: &mut TranslationDb, text: &str) -> Result<i64> {
    let analysis = TextCodec::analyze(text);
    db.upsert_source_text(&NewSourceText {
        source_language: "ja".to_string(),
        normalized_text: analysis.normalized_text,
        visible_text: analysis.visible_text,
        control_code_signature: analysis.control_code_signature,
    })
}

fn seed_translation(
    db: &mut TranslationDb,
    source_text_id: i64,
    text: &str,
    review_state: &str,
    qa_state: &str,
) -> Result<()> {
    db.upsert_translation(&NewTranslation {
        source_text_id,
        target_language: "ko".to_string(),
        translated_text: text.to_string(),
        provider: "fake".to_string(),
        model: Some("fixture".to_string()),
        review_state: review_state.to_string(),
        qa_state: qa_state.to_string(),
    })?;
    Ok(())
}

#[test]
fn export_builder_writes_static_runtime_bundle_for_reviewed_translations() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = seed_project(&mut db)?;
    let accepted = seed_source(&mut db, "\\C[1]こんにちは")?;
    let reviewed = seed_source(&mut db, "世界")?;
    let pending = seed_source(&mut db, "未確認")?;
    seed_translation(&mut db, accepted, "\\C[1]안녕", "accepted", "passed")?;
    seed_translation(&mut db, reviewed, "세계", "reviewed", "passed")?;
    seed_translation(&mut db, pending, "미확인", "pending", "unchecked")?;

    let report = ExportBuilder::export_project(
        &mut db,
        project_id,
        "ko",
        temp.path(),
        ExportPolicy::accepted_and_reviewed(),
    )?;

    assert_eq!(report.included_count, 2);
    assert_eq!(report.skipped_count, 1);
    assert_eq!(db.export_count()?, 1);

    let mut files = fs::read_dir(temp.path())
        .expect("read export dir")
        .map(|entry| {
            entry
                .expect("read export entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(
        files,
        vec!["cache.jsonl", "manifest.json", "overlay-config.json"]
    );

    let manifest: RuntimeExportManifest = serde_json::from_str(
        &fs::read_to_string(temp.path().join("manifest.json")).expect("read manifest"),
    )
    .expect("parse manifest");
    let config: OverlayConfig = serde_json::from_str(
        &fs::read_to_string(temp.path().join("overlay-config.json")).expect("read config"),
    )
    .expect("parse config");

    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.project_id, project_id);
    assert_eq!(manifest.source_language, "ja");
    assert_eq!(manifest.target_language, "ko");
    assert_eq!(manifest.key_schema_version, "v1");
    assert_eq!(manifest.cache_files, vec!["cache.jsonl"]);
    assert_eq!(manifest.record_count, 2);
    assert!(!manifest.created_timestamp.is_empty());
    assert!(!config.diagnostics_enabled);
    assert!(config.startup_toast_enabled);
    assert_eq!(config.startup_toast_text, "RPG-Translator 작동중");

    Ok(())
}

#[test]
fn exported_cache_records_use_versioned_cache_key_schema() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = seed_project(&mut db)?;
    let source_text_id = seed_source(&mut db, "\\C[2]名前")?;
    seed_translation(&mut db, source_text_id, "\\C[2]이름", "accepted", "passed")?;

    ExportBuilder::export_project(
        &mut db,
        project_id,
        "ko",
        temp.path(),
        ExportPolicy::accepted_and_reviewed(),
    )?;

    let cache_text = fs::read_to_string(temp.path().join("cache.jsonl")).expect("read cache");
    let record: RuntimeCacheRecord =
        serde_json::from_str(cache_text.trim()).expect("parse cache record");
    let expected_key = CacheKeyBuilder::build(&CacheKeyParts {
        engine: Engine::Mz,
        source_language: "ja".to_string(),
        target_language: "ko".to_string(),
        normalized_text: "\\C[2]名前".to_string(),
        control_code_signature: "\\C[2]".to_string(),
        context_hash: None,
    });

    assert_eq!(record.cache_key, expected_key);
    assert_eq!(record.source_text_id, source_text_id);
    assert_eq!(record.source_hash.len(), 64);
    assert_eq!(record.translation, "\\C[2]이름");

    Ok(())
}

#[test]
fn export_verification_rejects_malformed_runtime_bundle() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    fs::write(
        temp.path().join("manifest.json"),
        r#"{"schema_version":1,"project_id":1,"source_language":"ja","target_language":"ko","created_timestamp":"1","key_schema_version":"v1","cache_files":["cache.jsonl"],"record_count":1}"#,
    )
    .expect("write manifest");
    fs::write(
        temp.path().join("overlay-config.json"),
        r#"{"schema_version":1,"diagnostics_enabled":false,"startup_toast_enabled":true,"startup_toast_text":"RPG-Translator 작동중"}"#,
    )
    .expect("write config");
    fs::write(
        temp.path().join("cache.jsonl"),
        "{\"translation\":\"missing key\"}\n",
    )
    .expect("write malformed cache");

    let error = ExportBuilder::verify_bundle(temp.path()).expect_err("malformed bundle fails");
    assert!(error.to_string().contains("cache_key"));

    Ok(())
}

#[test]
fn runtime_js_cache_key_builder_matches_rust_schema() {
    let expected_key = CacheKeyBuilder::build(&CacheKeyParts {
        engine: Engine::Mz,
        source_language: "ja".to_string(),
        target_language: "ko".to_string(),
        normalized_text: "\\C[2]名前".to_string(),
        control_code_signature: "\\C[2]".to_string(),
        context_hash: None,
    });
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..");
    let script = r#"
const { CacheKeyBuilder } = require('./runtime/overlay-plugin/lookup-index');
process.stdout.write(CacheKeyBuilder.build({
  engine: 'mz',
  sourceLanguage: 'ja',
  targetLanguage: 'ko',
  normalizedText: '\\C[2]名前',
  controlCodeSignature: '\\C[2]',
  contextHash: null,
}));
"#;
    let output = Command::new("node")
        .arg("-e")
        .arg(script)
        .current_dir(repo_root)
        .output()
        .expect("run node cache key check");

    assert!(
        output.status.success(),
        "node failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).expect("utf8 node output"),
        expected_key
    );
}
