use std::fs;

use rpg_translator_core::{
    BatchTranslator, BatchTranslatorConfig, Engine, NewProject, NewSourceText, NewTranslation,
    Result, TextCodec, TranslationDb,
};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct CodecVector {
    input: String,
    normalized_text: String,
    visible_text: String,
    provider_text: String,
    control_codes: Vec<String>,
    restored_provider_translation: String,
    restored_text: String,
}

#[test]
fn shared_codec_vectors_match_rust_codec_behavior() -> Result<()> {
    let text =
        fs::read_to_string("../../runtime/overlay-plugin/test/fixtures/text-codec-vectors.json")
            .expect("read shared codec vectors");
    let vectors: Vec<CodecVector> =
        serde_json::from_str(&text).expect("parse shared codec vectors");

    for vector in vectors {
        let analysis = TextCodec::analyze(&vector.input);
        assert_eq!(analysis.normalized_text, vector.normalized_text);
        assert_eq!(analysis.visible_text, vector.visible_text);
        assert_eq!(analysis.control_codes, vector.control_codes);

        let provider_state = TextCodec::encode_for_provider(&vector.input);
        assert_eq!(provider_state.provider_text, vector.provider_text);
        assert_eq!(provider_state.control_codes, vector.control_codes);
        assert_eq!(
            TextCodec::restore_provider_translation(
                &vector.restored_provider_translation,
                &provider_state,
            )?,
            vector.restored_text
        );
    }

    Ok(())
}

#[test]
fn db_exposes_project_snapshot_and_exportable_translation_rows() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;

    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let snapshot_id = db.record_game_snapshot(project_id, "root-hash", "data-hash")?;
    let source_id = db.upsert_source_text(&NewSourceText {
        source_language: "ja".to_string(),
        normalized_text: "\\C[1]こんにちは".to_string(),
        visible_text: "こんにちは".to_string(),
        control_code_signature: "\\C[1]".to_string(),
    })?;
    db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "\\C[1]안녕".to_string(),
        provider: "fake".to_string(),
        model: Some("fixture".to_string()),
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
    })?;

    let project = db.get_project(project_id)?.expect("project exists");
    let snapshot = db.get_game_snapshot(snapshot_id)?.expect("snapshot exists");
    let rows = db.exportable_translations("ko", &["accepted", "reviewed"])?;

    assert_eq!(project.display_name, "Synthetic Game");
    assert_eq!(project.engine, Engine::Mz);
    assert_eq!(snapshot.snapshot_hash, "root-hash");
    assert_eq!(snapshot.data_root_hash, "data-hash");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].source_text_id, source_id);
    assert_eq!(rows[0].source_language, "ja");
    assert_eq!(rows[0].target_language, "ko");
    assert_eq!(rows[0].translated_text, "\\C[1]안녕");
    assert_eq!(rows[0].review_state, "accepted");
    assert_eq!(rows[0].qa_state, "passed");

    Ok(())
}

#[test]
fn batch_report_preserves_validation_failure_detail() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let source_id = db.upsert_source_text(&NewSourceText {
        source_language: "ja".to_string(),
        normalized_text: "失敗".to_string(),
        visible_text: "失敗".to_string(),
        control_code_signature: String::new(),
    })?;
    let mut provider =
        rpg_translator_core::FakeProvider::from_outputs(vec!["not json".to_string()]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            retry_attempts: 0,
            ..BatchTranslatorConfig::default()
        },
    )?;
    let findings = db.qa_findings_for_source(source_id)?;

    assert_eq!(report.failed_source_text_ids, vec![source_id]);
    assert_eq!(report.failure_details.len(), 1);
    assert_eq!(report.failure_details[0].source_text_ids, vec![source_id]);
    assert!(
        report.failure_details[0]
            .message
            .contains("provider output")
    );
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].source_text_id, source_id);
    assert_eq!(findings[0].finding_type, "batch-validation");
    assert!(findings[0].message.contains("provider output"));

    Ok(())
}
