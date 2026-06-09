use std::fs;
use std::process::Command;

use rpg_translator_core::{
    CacheKeyBuilder, CacheKeyParts, Engine, ExportBuilder, ExportPolicy, NewOccurrence, NewProject,
    NewSourceText, NewTranslation, OverlayConfig, Result, RuntimeCacheRecord,
    RuntimeExportManifest, TextCodec, TranslationDb,
};
use tempfile::tempdir;

fn seed_project(db: &mut TranslationDb) -> Result<i64> {
    db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })
}

fn seed_source(
    db: &mut TranslationDb,
    project_id: i64,
    text: &str,
    command_index: i64,
) -> Result<i64> {
    let analysis = TextCodec::analyze(text);
    let provider_state = TextCodec::encode_for_provider(&analysis.normalized_text);
    let source_text_id = db.upsert_source_text(&NewSourceText {
        source_language: "ja".to_string(),
        unit_kind: "text".to_string(),
        normalized_hash: String::new(),
        normalized_text: analysis.normalized_text,
        visible_text: analysis.visible_text,
        codec_text: provider_state.provider_text,
        control_code_signature: analysis.control_code_signature,
        line_count: text.matches('\n').count() as i64 + 1,
        newline_count: text.matches('\n').count() as i64,
        placeholder_count: provider_state.control_codes.len() as i64,
    })?;
    db.insert_project_occurrence(
        project_id,
        &NewOccurrence {
            project_id: Some(project_id),
            source_text_id,
            file_path: "data/Map001.json".to_string(),
            json_path: format!("$.events[1].pages[0].list[{command_index}].parameters[0]"),
            entity_type: "event_command".to_string(),
            event_id: Some(1),
            page_index: Some(0),
            command_index: Some(command_index),
            command_code: Some(401),
            parameter_index: Some(0),
            object_key: None,
            extraction_rule_id: "event.message.line".to_string(),
        },
    )?;
    Ok(source_text_id)
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
        provider_run_id: None,
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
    let accepted = seed_source(&mut db, project_id, "\\C[1]こんにちは", 0)?;
    let reviewed = seed_source(&mut db, project_id, "世界", 1)?;
    let pending = seed_source(&mut db, project_id, "未確認", 2)?;
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
    assert_eq!(db.last_export_included_count()?, Some(2));

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
    let config_text =
        fs::read_to_string(temp.path().join("overlay-config.json")).expect("read config");
    let config: OverlayConfig = serde_json::from_str(&config_text).expect("parse config");

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
    assert!(config_text.contains("\"foresight_command_catalog\""));
    assert!(config_text.contains("\"schemaVersion\""));
    assert!(config_text.contains("\"eventCommands\""));
    assert!(config_text.contains("\"movementRouteCommands\""));
    assert_eq!(config.foresight_command_catalog.schema_version, 4);
    assert_eq!(
        config
            .foresight_command_catalog
            .event_commands
            .get("205")
            .map(|command| command.scan_behavior.as_str()),
        Some("movement-route")
    );
    assert_eq!(
        config
            .foresight_command_catalog
            .movement_route_commands
            .get("1")
            .map(|command| command.scan_behavior.as_str()),
        Some("advance")
    );

    Ok(())
}

#[test]
fn exported_cache_records_use_versioned_cache_key_schema() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = seed_project(&mut db)?;
    let source_text_id = seed_source(&mut db, project_id, "\\C[2]名前", 0)?;
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
    assert!(
        record.cache_aliases.contains(&expected_key),
        "primary key should be included in cache aliases"
    );
    assert!(
        record
            .cache_aliases
            .iter()
            .any(|alias| alias != &expected_key),
        "runtime cache should expose at least one normalized/codec alias"
    );
    let codec_lookup_key = CacheKeyBuilder::build(&CacheKeyParts {
        engine: Engine::Mz,
        source_language: "ja".to_string(),
        target_language: "ko".to_string(),
        normalized_text: "¤名前".to_string(),
        control_code_signature: String::new(),
        context_hash: None,
    });
    assert!(
        record.cache_aliases.contains(&codec_lookup_key),
        "codec text alias should match runtime TextCodec analysis"
    );
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
        r#"{"schema_version":1,"diagnostics_enabled":false,"startup_toast_enabled":true,"startup_toast_text":"RPG-Translator 작동중","foresight_command_catalog":{"schemaVersion":4,"eventCommands":{},"movementRouteCommands":{}}}"#,
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
fn export_verification_rejects_wrong_foresight_catalog_schema() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    fs::write(
        temp.path().join("manifest.json"),
        r#"{"schema_version":1,"project_id":1,"source_language":"ja","target_language":"ko","created_timestamp":"1","key_schema_version":"v1","cache_files":["cache.jsonl"],"record_count":1}"#,
    )
    .expect("write manifest");
    fs::write(
        temp.path().join("overlay-config.json"),
        r#"{"schema_version":1,"diagnostics_enabled":false,"startup_toast_enabled":true,"startup_toast_text":"RPG-Translator 작동중","foresight_command_catalog":{"schemaVersion":3,"eventCommands":{},"movementRouteCommands":{}}}"#,
    )
    .expect("write config");
    fs::write(
        temp.path().join("cache.jsonl"),
        "{\"cache_key\":\"ck:v1:fixture\",\"cache_aliases\":[\"ck:v1:fixture\"],\"source_text_id\":1,\"source_hash\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\"source_language\":\"ja\",\"target_language\":\"ko\",\"normalized_text\":\"a\",\"visible_text\":\"a\",\"translation\":\"b\",\"control_code_signature\":\"\",\"context_hash\":null}\n",
    )
    .expect("write cache");

    let error = ExportBuilder::verify_bundle(temp.path()).expect_err("wrong catalog schema fails");
    assert!(
        error
            .to_string()
            .contains("foresight command catalog schema")
    );

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
