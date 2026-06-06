use std::fs;

use rpg_translator_core::{
    BatchPlanner, BatchPlannerConfig, BatchTranslator, BatchTranslatorConfig, BatchValidator,
    CheckpointWriter, FakeProvider, NewSourceText, ProviderBatchItem, TextCodec, TranslationDb,
};
use tempfile::tempdir;

fn seed_source(db: &mut TranslationDb, source_language: &str, text: &str) -> i64 {
    let analysis = TextCodec::analyze(text);
    db.upsert_source_text(&NewSourceText {
        source_language: source_language.to_string(),
        normalized_text: analysis.normalized_text,
        visible_text: analysis.visible_text,
        control_code_signature: analysis.control_code_signature,
    })
    .expect("insert source text")
}

fn output(rows: &[(i64, &str)]) -> String {
    rows.iter()
        .map(|(id, translation)| format!(r#"{{"id":{id},"translation":"{translation}"}}"#))
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn fake_provider_success_persists_batch_translations() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "ja", "\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}");
    let second = seed_source(&mut db, "ja", "\u{4e16}\u{754c}\\N[1]");
    let mut provider = FakeProvider::from_outputs(vec![output(&[
        (1, "\u{c548}\u{b155}"),
        (2, "\u{c138}\u{acc4}\u{00a4}"),
    ])]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 8,
            ..BatchTranslatorConfig::default()
        },
    )
    .expect("translate batch");

    assert_eq!(provider.requests().len(), 1);
    assert_eq!(report.completed_source_text_ids, vec![first, second]);
    assert!(report.failed_source_text_ids.is_empty());
    assert_eq!(
        db.get_translation(first, "ko")
            .expect("lookup first")
            .expect("first translation")
            .translated_text,
        "\u{c548}\u{b155}"
    );
    assert_eq!(
        db.get_translation(second, "ko")
            .expect("lookup second")
            .expect("second translation")
            .translated_text,
        "\u{c138}\u{acc4}\\N[1]"
    );
}

#[test]
fn planner_deduplicates_same_normalized_text_and_signature() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "ja", "\u{5171}\u{901a}\\C[1]");
    let second = seed_source(&mut db, "zh", "\u{5171}\u{901a}\\C[1]");
    let third = seed_source(&mut db, "ja", "\u{5225}\u{30c6}\u{30ad}\u{30b9}\u{30c8}");

    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan batches");

    assert_eq!(plan.jobs.len(), 2);
    assert!(
        plan.jobs
            .iter()
            .any(|job| job.source_text_ids == vec![first, second])
    );
    assert!(
        plan.jobs
            .iter()
            .any(|job| job.source_text_ids == vec![third])
    );
    assert_eq!(plan.batches.len(), 1);
}

#[test]
fn validator_rejects_bad_model_output_shapes() {
    let item = ProviderBatchItem {
        id: 1,
        text: "\u{30c6}\u{30b9}\u{30c8}\u{00a4}".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    for raw in [
        "",
        r#"{"id":2,"translation":"x"}"#,
        r#"{"id":1,"translation":""}"#,
        r#"{"id":1,"translation":"x"}\n{"id":1,"translation":"y"}"#,
        r#"{"id":1,"translation":"x"}\n{"id":2,"translation":"y"}"#,
        r#"```json\n[{"id":1,"translation":"x"}]\n```"#,
        r#"<think>hidden</think>{"id":1,"translation":"x"}"#,
        "Here is the translation:",
        r#"{"id":1,"translation":"placeholder missing"}"#,
    ] {
        assert!(
            BatchValidator::validate(raw, &jobs).is_err(),
            "expected validator rejection for {raw}"
        );
    }
}

#[test]
fn translator_retries_splits_and_records_single_item_failures() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "ja", "\u{6210}\u{529f}");
    let second = seed_source(&mut db, "ja", "\u{5931}\u{6557}");
    let mut provider = FakeProvider::from_outputs(vec![
        "not json".to_string(),
        output(&[(1, "\u{c131}\u{acf5}")]),
        "not json".to_string(),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 2,
            retry_attempts: 0,
            ..BatchTranslatorConfig::default()
        },
    )
    .expect("translate with split");

    assert_eq!(provider.requests().len(), 3);
    assert_eq!(report.completed_source_text_ids, vec![first]);
    assert_eq!(report.failed_source_text_ids, vec![second]);
    assert_eq!(report.split_batches, 1);
    assert!(
        db.get_translation(first, "ko")
            .expect("lookup first")
            .is_some()
    );
    assert!(
        db.get_translation(second, "ko")
            .expect("lookup second")
            .is_none()
    );
    assert_eq!(db.qa_finding_count().expect("qa count"), 1);
}

#[test]
fn checkpoint_resume_skips_completed_source_texts() {
    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let completed = seed_source(&mut db, "ja", "\u{6e08}");
    let pending = seed_source(&mut db, "ja", "\u{672a}");

    CheckpointWriter::write_atomic(
        &checkpoint_path,
        &rpg_translator_core::BatchCheckpoint {
            provider_run_id: 77,
            target_language: "ko".to_string(),
            completed_source_text_ids: vec![completed],
            failed_source_text_ids: Vec::new(),
        },
    )
    .expect("write checkpoint");

    let mut provider = FakeProvider::from_outputs(vec![output(&[(1, "\u{bbf8}")])]);
    let report = BatchTranslator::run_with_checkpoint(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig::default(),
        Some(&checkpoint_path),
    )
    .expect("resume translation");

    assert_eq!(provider.requests().len(), 1);
    assert_eq!(provider.requests()[0].items.len(), 1);
    assert_eq!(report.completed_source_text_ids, vec![pending]);
    assert!(
        db.get_translation(completed, "ko")
            .expect("completed lookup")
            .is_none()
    );
    assert!(
        db.get_translation(pending, "ko")
            .expect("pending lookup")
            .is_some()
    );

    let saved = CheckpointWriter::read(&checkpoint_path)
        .expect("read checkpoint")
        .expect("checkpoint exists");
    assert!(saved.completed_source_text_ids.contains(&completed));
    assert!(saved.completed_source_text_ids.contains(&pending));
}

#[test]
fn runtime_overlay_does_not_import_provider_modules() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("runtime")
        .join("overlay-plugin");
    let mut checked_js_files = 0;
    for entry in fs::read_dir(root).expect("read runtime overlay dir") {
        let path = entry.expect("read runtime entry").path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("js") {
            continue;
        }
        checked_js_files += 1;
        let content = fs::read_to_string(&path).expect("read runtime js");
        assert!(!content.contains("ProviderClient"));
        assert!(!content.contains("translate_batch"));
        assert!(!content.contains("apiKey"));
        assert!(!content.contains("Authorization"));
    }
    assert!(checked_js_files > 0);
}
