use std::{collections::VecDeque, fs, thread, time::Duration};

use rpg_translator_core::{
    BatchPlanner, BatchPlannerConfig, BatchRunStatus, BatchTranslator, BatchTranslatorConfig,
    BatchValidator, CheckpointWriter, Engine, Error, FakeProvider, NewOccurrence, NewProject,
    NewQaFinding, NewSourceText, NewTranslation, ProviderBatchItem, ProviderBatchRequest,
    ProviderBatchResponse, ProviderClient, ProviderRequestSpacingConfig, ProviderSpeedBenchmark,
    ProviderSpeedBenchmarkConfig, TextCodec, TranslateProgressEvent, TranslationDb,
    TranslationSpeedSample, adaptive_translation_tuning_from_samples,
    adaptive_translation_tuning_from_samples_for_lanes,
};
use tempfile::tempdir;

fn seed_source(db: &mut TranslationDb, source_language: &str, text: &str) -> i64 {
    seed_source_with_kind(db, source_language, text, "text")
}

fn seed_source_with_kind(
    db: &mut TranslationDb,
    source_language: &str,
    text: &str,
    unit_kind: &str,
) -> i64 {
    let analysis = TextCodec::analyze(text);
    let provider_state = TextCodec::encode_for_provider(&analysis.normalized_text);
    db.upsert_source_text(&NewSourceText {
        source_language: source_language.to_string(),
        unit_kind: unit_kind.to_string(),
        normalized_hash: String::new(),
        normalized_text: analysis.normalized_text.clone(),
        visible_text: analysis.visible_text,
        codec_text: provider_state.provider_text,
        control_code_signature: analysis.control_code_signature,
        line_count: analysis.normalized_text.matches('\n').count() as i64 + 1,
        newline_count: analysis.normalized_text.matches('\n').count() as i64,
        placeholder_count: provider_state.control_codes.len() as i64,
    })
    .expect("insert source text")
}

fn output(rows: &[(i64, &str)]) -> String {
    rows.iter()
        .map(|(id, translation)| format!(r#"{{"id":{id},"translation":"{translation}"}}"#))
        .collect::<Vec<_>>()
        .join("\n")
}

struct SequenceProvider {
    responses: VecDeque<rpg_translator_core::Result<String>>,
    requests: Vec<ProviderBatchRequest>,
}

impl SequenceProvider {
    fn new(responses: Vec<rpg_translator_core::Result<String>>) -> Self {
        Self {
            responses: responses.into(),
            requests: Vec::new(),
        }
    }

    fn requests(&self) -> &[ProviderBatchRequest] {
        &self.requests
    }
}

impl ProviderClient for SequenceProvider {
    fn provider_name(&self) -> &str {
        "sequence"
    }

    fn model_name(&self) -> Option<&str> {
        Some("sequence-model")
    }

    fn translate_batch(
        &mut self,
        request: &ProviderBatchRequest,
    ) -> rpg_translator_core::Result<ProviderBatchResponse> {
        self.requests.push(request.clone());
        let Some(response) = self.responses.pop_front() else {
            return Err(Error::invalid_input(
                "sequence provider has no queued output",
            ));
        };
        response.map(|raw_output| ProviderBatchResponse { raw_output })
    }
}

fn test_config() -> BatchTranslatorConfig {
    BatchTranslatorConfig {
        provider_spacing: ProviderRequestSpacingConfig::disabled(),
        ..BatchTranslatorConfig::default()
    }
}

fn stable_test_spacing() -> ProviderRequestSpacingConfig {
    ProviderRequestSpacingConfig {
        base_success_spacing_ms: 0,
        min_success_spacing_ms: 0,
        max_success_spacing_ms: 0,
        success_spacing_step_ms: 0,
        success_recovery_threshold: 4,
        provider_503_backoff_ms: vec![0, 0, 0],
        provider_connection_backoff_ms: vec![0, 0, 0],
    }
}

fn speed_sample(status: &str, batch_size: i64, total_elapsed_ms: i64) -> TranslationSpeedSample {
    TranslationSpeedSample {
        id: 0,
        provider_run_id: 1,
        batch_index: 1,
        lane: "plain_block".to_string(),
        item_count: batch_size,
        char_count: batch_size * 40,
        estimated_token_count: batch_size * 10,
        request_elapsed_ms: total_elapsed_ms.saturating_sub(750),
        success_delay_ms: 750,
        total_elapsed_ms,
        status: status.to_string(),
        failure_type: None,
        effective_batch_size: batch_size,
        adaptive_decision_reason: "adaptive: fixture".to_string(),
        model: Some("gemma".to_string()),
        prompt_hash: "prompt".to_string(),
        created_at: "2026-01-01T00:00:00Z".to_string(),
    }
}

#[test]
fn adaptive_tuning_uses_speed_history_for_initial_batch_and_delay() {
    let spacing = ProviderRequestSpacingConfig::stable();
    let fast_samples = vec![
        speed_sample("success", 16, 2_000),
        speed_sample("success", 16, 2_500),
        speed_sample("success", 16, 3_000),
    ];
    let fast = adaptive_translation_tuning_from_samples(&fast_samples, 8, 4096, spacing.clone());
    assert_eq!(fast.max_items_per_batch, 32);
    assert!(fast.input_token_budget >= 1024);
    assert_eq!(fast.provider_spacing.base_success_spacing_ms, 1250);
    assert!(fast.decision_reason.contains("accelerating"));

    let slow_samples = vec![
        speed_sample("success", 16, 22_000),
        speed_sample("final_failed", 16, 25_000),
    ];
    let slow = adaptive_translation_tuning_from_samples(&slow_samples, 16, 4096, spacing);
    assert_eq!(slow.max_items_per_batch, 8);
    assert_eq!(slow.provider_spacing.base_success_spacing_ms, 1500);
    assert!(slow.decision_reason.contains("conservative"));
}

#[test]
fn adaptive_tuning_uses_failure_only_history_conservatively() {
    let spacing = ProviderRequestSpacingConfig::stable();
    let failure_samples = vec![
        speed_sample("recoverable_provider", 16, 1_000),
        speed_sample("parse_failed", 16, 1_000),
        speed_sample("final_failed", 16, 1_000),
    ];

    let tuning = adaptive_translation_tuning_from_samples(&failure_samples, 16, 4096, spacing);

    assert_eq!(tuning.max_items_per_batch, 8);
    assert_eq!(tuning.input_token_budget, 4096);
    assert_eq!(tuning.provider_spacing.base_success_spacing_ms, 1500);
    assert!(tuning.decision_reason.contains("conservative"));
    assert!(tuning.decision_reason.contains("failure_rate=100%"));
}

#[test]
fn adaptive_tuning_recommends_provider_restart_after_connection_failure_cluster() {
    let spacing = ProviderRequestSpacingConfig::stable();
    let mut samples = vec![
        speed_sample("success", 8, 6_000),
        speed_sample("recoverable_provider", 8, 1_000),
        speed_sample("recoverable_provider", 8, 1_000),
        speed_sample("final_failed", 8, 1_000),
    ];
    for sample in samples.iter_mut().skip(1) {
        sample.failure_type = Some("provider-connection".to_string());
    }

    let tuning = adaptive_translation_tuning_from_samples_for_lanes(
        &samples,
        &["plain_block"],
        8,
        3072,
        spacing,
    );

    assert_eq!(tuning.max_items_per_batch, 4);
    assert!(
        tuning
            .decision_reason
            .contains("provider_restart_recommended"),
        "connection failure clusters should leave a visible DB/UI reason: {}",
        tuning.decision_reason
    );
}

#[test]
fn adaptive_tuning_uses_real_prompt_benchmark_samples() {
    let spacing = ProviderRequestSpacingConfig::stable();
    let benchmark_samples = vec![
        speed_sample("benchmark", 16, 2_000),
        speed_sample("benchmark", 16, 2_500),
        speed_sample("benchmark", 16, 3_000),
    ];

    let tuning = adaptive_translation_tuning_from_samples(&benchmark_samples, 8, 4096, spacing);

    assert_eq!(tuning.max_items_per_batch, 32);
    assert_eq!(tuning.provider_spacing.base_success_spacing_ms, 1250);
    assert!(tuning.decision_reason.contains("accelerating"));
}

#[test]
fn adaptive_tuning_filters_history_to_current_lanes() {
    let spacing = ProviderRequestSpacingConfig::stable();
    let mut fast_short = vec![
        speed_sample("success", 16, 2_000),
        speed_sample("success", 16, 2_500),
        speed_sample("success", 16, 3_000),
    ];
    for sample in &mut fast_short {
        sample.lane = "short".to_string();
    }
    let mut failing_complex = vec![
        speed_sample("recoverable_provider", 16, 1_000),
        speed_sample("parse_failed", 16, 1_000),
        speed_sample("final_failed", 16, 1_000),
    ];
    for sample in &mut failing_complex {
        sample.lane = "complex".to_string();
    }
    let mut samples = fast_short;
    samples.extend(failing_complex);

    let short_tuning = adaptive_translation_tuning_from_samples_for_lanes(
        &samples,
        &["short"],
        8,
        3072,
        spacing.clone(),
    );
    assert_eq!(short_tuning.max_items_per_batch, 16);
    assert_eq!(short_tuning.provider_spacing.base_success_spacing_ms, 1250);
    assert!(short_tuning.decision_reason.contains("accelerating"));
    assert!(short_tuning.decision_reason.contains("lane_cap=16"));
    assert!(short_tuning.decision_reason.contains("lanes=short"));
    assert!(short_tuning.decision_reason.contains("lane_samples=3/6"));

    let complex_tuning = adaptive_translation_tuning_from_samples_for_lanes(
        &samples,
        &["complex"],
        8,
        3072,
        spacing,
    );
    assert_eq!(complex_tuning.max_items_per_batch, 4);
    assert_eq!(complex_tuning.input_token_budget, 3072);
    assert_eq!(
        complex_tuning.provider_spacing.base_success_spacing_ms,
        1500
    );
    assert!(complex_tuning.decision_reason.contains("conservative"));
    assert!(complex_tuning.decision_reason.contains("lanes=complex"));
    assert!(complex_tuning.decision_reason.contains("lane_samples=3/6"));
}

#[test]
fn stable_translation_defaults_use_phase8_speed_profile() {
    let config = BatchTranslatorConfig::default();

    assert_eq!(config.max_items_per_batch, 8);
    assert_eq!(config.input_token_budget, 3072);
}

#[test]
fn adaptive_tuning_caps_batch_by_translation_lane() {
    let spacing = ProviderRequestSpacingConfig::stable();
    let mut short_samples = vec![
        speed_sample("success", 8, 2_000),
        speed_sample("success", 8, 2_500),
        speed_sample("success", 8, 3_000),
    ];
    for sample in &mut short_samples {
        sample.lane = "short".to_string();
    }
    let short = adaptive_translation_tuning_from_samples_for_lanes(
        &short_samples,
        &["short"],
        8,
        3072,
        spacing.clone(),
    );
    assert_eq!(short.max_items_per_batch, 16);
    assert!(short.decision_reason.contains("lane_cap=16"));

    let plain = adaptive_translation_tuning_from_samples_for_lanes(
        &short_samples
            .iter()
            .cloned()
            .map(|mut sample| {
                sample.lane = "plain_block".to_string();
                sample
            })
            .collect::<Vec<_>>(),
        &["plain_block"],
        8,
        3072,
        spacing.clone(),
    );
    assert_eq!(plain.max_items_per_batch, 8);
    assert!(plain.decision_reason.contains("lane_cap=8"));

    let quality = adaptive_translation_tuning_from_samples_for_lanes(
        &short_samples
            .iter()
            .cloned()
            .map(|mut sample| {
                sample.lane = "quality_retry".to_string();
                sample
            })
            .collect::<Vec<_>>(),
        &["quality_retry"],
        8,
        3072,
        spacing,
    );
    assert_eq!(quality.max_items_per_batch, 4);
    assert!(quality.decision_reason.contains("lane_cap=4"));
}

#[test]
fn fake_provider_success_persists_batch_translations() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "ja", "\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}");
    let second = seed_source(&mut db, "ja", "\u{4e16}\u{754c}\\N[1]");
    let mut provider = FakeProvider::from_outputs(vec![
        output(&[(1, "\u{c548}\u{b155}")]),
        output(&[(2, "\u{c138}\u{acc4}\u{00a4}")]),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 8,
            prompt_hash: "prompt-fixture".to_string(),
            ..test_config()
        },
    )
    .expect("translate batch");

    assert_eq!(provider.requests().len(), 2);
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
    let samples = db
        .recent_translation_speed_samples(None, Some("prompt-fixture"), 10)
        .expect("speed samples");
    assert_eq!(samples.len(), 2);
    assert!(samples.iter().all(|sample| sample.status == "success"));
    assert!(samples.iter().all(|sample| sample.item_count == 1));
    assert!(samples.iter().all(|sample| sample.char_count > 0));
    assert!(
        samples
            .iter()
            .all(|sample| sample.provider_run_id == report.provider_run_id)
    );
    assert!(
        samples
            .iter()
            .all(|sample| sample.effective_batch_size == report.effective_batch_size as i64)
    );
    assert!(
        samples
            .iter()
            .all(|sample| sample.prompt_hash == "prompt-fixture")
    );
    assert!(
        samples.iter().all(|sample| sample.batch_index >= 1
            && sample.batch_index <= report.processed_batches as i64)
    );
    assert!(
        samples
            .iter()
            .all(|sample| sample.adaptive_decision_reason.starts_with("adaptive:"))
    );
    assert!(
        samples
            .iter()
            .any(|sample| sample.lane == "short" && sample.estimated_token_count > 0)
    );
    assert!(
        samples
            .iter()
            .any(|sample| sample.lane == "complex" && sample.estimated_token_count > 0)
    );
}

#[test]
fn translator_records_project_and_source_language_in_job_progress() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let project_id = db
        .upsert_project(&NewProject {
            game_root: "/synthetic/project".to_string(),
            display_name: "Synthetic Project".to_string(),
            engine: Engine::Mz,
        })
        .expect("insert project");
    seed_source(&mut db, "en", "Hello");
    let mut provider = FakeProvider::from_outputs(vec![output(&[(1, "\u{c548}\u{b155}")])]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            project_id: Some(project_id),
            source_language: "en".to_string(),
            ..test_config()
        },
    )
    .expect("translate batch");
    let summary = db
        .latest_translation_job_summary(Some("ko"))
        .expect("load latest job")
        .expect("latest job exists");

    assert_eq!(summary.provider_run_id, Some(report.provider_run_id));
    assert_eq!(summary.project_id, Some(project_id));
    assert_eq!(summary.source_language, "en");
    assert_eq!(summary.target_language, "ko");
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
    assert_eq!(plan.batches.len(), 2);
}

#[test]
fn planner_skips_generic_candidates_by_default() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let display_safe = seed_source_with_kind(&mut db, "en", "Potion", "db_field");
    let generic = seed_source_with_kind(&mut db, "en", "GALV_MapTravelMZ", "generic_candidate");

    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan batches");

    assert_eq!(plan.jobs.len(), 1);
    assert_eq!(plan.jobs[0].source_text_ids, vec![display_safe]);
    assert!(
        !plan
            .jobs
            .iter()
            .any(|job| job.source_text_ids.contains(&generic))
    );
}

#[test]
fn planner_deduplicates_block_units_with_multiple_occurrences() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let project_id = db
        .upsert_project(&NewProject {
            game_root: "/synthetic/game".to_string(),
            display_name: "Synthetic Game".to_string(),
            engine: Engine::Mz,
        })
        .expect("insert project");
    let source_id = seed_source_with_kind(&mut db, "en", "Line one\nLine two", "message_block");

    for (index, path) in [
        "$.events[1].pages[0].list[2]",
        "$.events[7].pages[0].list[9]",
    ]
    .into_iter()
    .enumerate()
    {
        db.insert_project_occurrence(
            project_id,
            &NewOccurrence {
                project_id: Some(project_id),
                source_text_id: source_id,
                file_path: "data/Map001.json".to_string(),
                json_path: path.to_string(),
                entity_type: "event_command".to_string(),
                event_id: Some((index + 1) as i64),
                page_index: Some(0),
                command_index: Some(index as i64),
                command_code: Some(101),
                parameter_index: None,
                object_key: None,
                extraction_rule_id: "event.message.block".to_string(),
            },
        )
        .expect("insert occurrence");
    }

    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan batches");

    assert_eq!(plan.jobs.len(), 1);
    assert_eq!(plan.jobs[0].source_text_ids, vec![source_id]);
    assert_eq!(plan.jobs[0].provider_text, "Line one\nLine two");
}

#[test]
fn planner_separates_short_block_and_complex_lanes() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source(&mut db, "ja", "短文");
    seed_source_with_kind(&mut db, "ja", "Line one\nLine two", "message_block");
    seed_source(&mut db, "ja", "\\C[2]名前");

    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            input_token_budget: 4096,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan lane batches");

    assert_eq!(
        plan.batches.len(),
        3,
        "short, block, and control-code texts should not share one provider JSONL batch"
    );
    assert!(plan.batches.iter().all(|batch| !batch.is_empty()));
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
        r#"{"id":"1","translation":"x"}"#,
        r#"{"*id":1,"translation":"x"}"#,
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
fn validator_accepts_text_field_as_translation_alias_for_provider_compatibility() {
    let item = ProviderBatchItem {
        id: 1,
        text: "Emma".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    let validated = BatchValidator::validate(r#"{"id":1,"text":"엠마"}"#, &jobs)
        .expect("provider text field alias should be accepted");

    assert_eq!(validated[0].translated_text, "엠마");
}

#[test]
fn translator_records_warning_for_text_field_alias() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source(&mut db, "en", "Emma");
    let mut provider = FakeProvider::from_outputs(vec![r#"{"id":1,"text":"엠마"}"#.to_string()]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
    )
    .expect("translate with text field alias");

    assert_eq!(report.completed_source_text_ids, vec![source]);
    let findings = db.qa_findings_for_source(source).expect("findings");
    assert!(
        findings.iter().any(|finding| {
            finding.finding_type == "provider-output-used-text-alias"
                && finding.severity == "warning"
                && finding.status == "resolved"
        }),
        "expected provider-output-used-text-alias warning, got {findings:?}"
    );
}

#[test]
fn validator_allows_unchanged_output_for_technical_token_only_text() {
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![
        ProviderBatchItem {
            id: 1,
            text: "ExNo".to_string(),
        },
        ProviderBatchItem {
            id: 2,
            text: "ATK+100%".to_string(),
        },
        ProviderBatchItem {
            id: 3,
            text: "MHP +5%".to_string(),
        },
        ProviderBatchItem {
            id: 4,
            text: "Lv".to_string(),
        },
        ProviderBatchItem {
            id: 5,
            text: "Crypt_Tileset_Outside".to_string(),
        },
        ProviderBatchItem {
            id: 6,
            text: "\u{25ba}D1-F1".to_string(),
        },
        ProviderBatchItem {
            id: 7,
            text: "${Text1}".to_string(),
        },
        ProviderBatchItem {
            id: 8,
            text: "t".to_string(),
        },
    ]);

    let validated = BatchValidator::validate(
        r#"{"id":1,"translation":"ExNo"}
{"id":2,"translation":"ATK+100%"}
{"id":3,"translation":"MHP +5%"}
{"id":4,"translation":"Lv"}
{"id":5,"translation":"Crypt_Tileset_Outside"}
{"id":6,"translation":"►D1-F1"}
{"id":7,"translation":"${Text1}"}
{"id":8,"translation":"t"}"#,
        &jobs,
    )
    .expect("technical tokens may remain unchanged");

    assert_eq!(validated[0].translated_text, "ExNo");
    assert_eq!(validated[1].translated_text, "ATK+100%");
    assert_eq!(validated[2].translated_text, "MHP +5%");
    assert_eq!(validated[3].translated_text, "Lv");
    assert_eq!(validated[4].translated_text, "Crypt_Tileset_Outside");
    assert_eq!(validated[5].translated_text, "\u{25ba}D1-F1");
    assert_eq!(validated[6].translated_text, "${Text1}");
    assert_eq!(validated[7].translated_text, "t");
}

#[test]
fn validator_rejects_unchanged_short_effect_and_skill_name_text() {
    for text in [
        "Zzz...",
        "X-113?",
        "Err-",
        "F-fading...",
        "B-BWUB?!?",
        "H-hu- *glug*",
        "Darkness One 2",
        "Soulplay 4",
    ] {
        let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![ProviderBatchItem {
            id: 1,
            text: text.to_string(),
        }]);

        let error = BatchValidator::validate(
            &format!(
                r#"{{"id":1,"translation":{}}}"#,
                serde_json::to_string(text).expect("fixture text should JSON-encode")
            ),
            &jobs,
        )
        .expect_err("short visible text should not pass through unchanged");

        assert!(
            error.to_string().contains("unchanged provider output"),
            "unexpected error for {text}: {error}"
        );
    }
}

#[test]
fn validator_rejects_mutated_independent_angle_metadata_tag() {
    let item = ProviderBatchItem {
        id: 1,
        text: "<Disable Switch: 8>Diluted Blood of the Goddess".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    let error = BatchValidator::validate(
        r#"{"id":1,"translation":"<Disable Switch: 나 8>희석된 여신의 피"}"#,
        &jobs,
    )
    .expect_err("mutated metadata tag should be rejected");

    assert!(
        error.to_string().contains("protected tag mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn validator_accepts_preserved_independent_angle_metadata_tag() {
    let item = ProviderBatchItem {
        id: 1,
        text: "<Disable Switch: 8>Diluted Blood of the Goddess".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    let validated = BatchValidator::validate(
        r#"{"id":1,"translation":"<Disable Switch: 8>희석된 여신의 피"}"#,
        &jobs,
    )
    .expect("preserved metadata tag should pass");

    assert_eq!(
        validated[0].translated_text,
        "<Disable Switch: 8>희석된 여신의 피"
    );
}

#[test]
fn validator_accepts_preserved_inline_angle_formatting_tags() {
    let item = ProviderBatchItem {
        id: 1,
        text: "(Is it doing <i>that</i> again?)".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    let validated = BatchValidator::validate(
        r#"{"id":1,"translation":"(또 <i>그걸</i> 하는 거야?)"}"#,
        &jobs,
    )
    .expect("paired inline formatting tags should pass when preserved");

    assert_eq!(validated[0].translated_text, "(또 <i>그걸</i> 하는 거야?)");
}

#[test]
fn validator_rejects_line_local_placeholder_drift() {
    let item = ProviderBatchItem {
        id: 1,
        text: "Line \u{00a4}\nSecond line".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    let error = BatchValidator::validate(r#"{"id":1,"translation":"첫 줄\n둘째 줄¤"}"#, &jobs)
        .expect_err("placeholder moved to another line should be rejected");

    assert!(
        error
            .to_string()
            .contains("line-local placeholder mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn validator_allows_message_block_placeholder_reflow_with_total_count_preserved() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source_with_kind(
        &mut db,
        "en",
        "\\c[7]What else... Ah, how about we have \\Effect<Pulse>you get turned on by my\nvoice now?",
        "message_block",
    );
    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan message block");

    assert_eq!(plan.jobs[0].provider_text.matches('\u{00a4}').count(), 2);
    let validated = BatchValidator::validate(
        r#"{"id":1,"translation":"¤또 뭐가 있을까... 아, 내 목소리에\n¤흥분하게 만들어볼까?"}"#,
        &plan.jobs,
    )
    .expect("message blocks may reflow placeholders across lines");

    assert_eq!(
        validated[0].translated_text,
        "\\c[7]또 뭐가 있을까... 아, 내 목소리에\n\\Effect<Pulse>흥분하게 만들어볼까?"
    );
}

#[test]
fn validator_rejects_message_block_placeholder_count_loss() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source_with_kind(
        &mut db,
        "en",
        "\\c[7]Hmm... Let's give you an \\Effect<Pulse>uncontrollable desire to be touched\nby me.",
        "message_block",
    );
    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan message block");

    let error = BatchValidator::validate(
        r#"{"id":1,"translation":"¤흠... 네가 나에게\n만져지고 싶은 욕망을 느끼게 해볼까."}"#,
        &plan.jobs,
    )
    .expect_err("missing placeholder should still fail");

    assert!(
        error.to_string().contains("placeholder mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn validator_keeps_db_field_placeholder_reflow_strict() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source_with_kind(
        &mut db,
        "en",
        "Skill \\Effect<Pulse>one\nline two",
        "db_field",
    );
    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan db field");

    let error = BatchValidator::validate(
        r#"{"id":1,"translation":"스킬 하나\n¤둘째 줄"}"#,
        &plan.jobs,
    )
    .expect_err("non-message units should keep line-local strictness");

    assert!(
        error
            .to_string()
            .contains("line-local placeholder mismatch"),
        "unexpected error: {error}"
    );
}

#[test]
fn validator_preserves_converted_escape_codes() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source(&mut db, "en", "Hello \u{1b}C[1]Emma\u{1b}C[0]");
    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan batches");

    let validated = BatchValidator::validate(r#"{"id":1,"translation":"안녕 ¤엠마¤"}"#, &plan.jobs)
        .expect("converted escape placeholders should restore");

    assert_eq!(
        validated[0].translated_text,
        "안녕 \u{1b}C[1]엠마\u{1b}C[0]"
    );
}

#[test]
fn validator_preserves_angle_and_bracket_params() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source(&mut db, "en", "\\N[1] found \\Quest<main>");
    let plan = BatchPlanner::plan(
        &db,
        "ko",
        BatchPlannerConfig {
            max_items_per_batch: 16,
            ..BatchPlannerConfig::default()
        },
    )
    .expect("plan batches");

    let validated =
        BatchValidator::validate(r#"{"id":1,"translation":"¤이 ¤를 찾았다"}"#, &plan.jobs)
            .expect("angle and bracket parameter placeholders should restore");

    assert_eq!(
        validated[0].translated_text,
        "\\N[1]이 \\Quest<main>를 찾았다"
    );
}

#[test]
fn validator_allows_message_block_line_break_mismatch_for_runtime_wrapping() {
    let item = ProviderBatchItem {
        id: 1,
        text: "Line one\nLine two".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    let validated = BatchValidator::validate(r#"{"id":1,"translation":"한 줄로 합침"}"#, &jobs)
        .expect("runtime wrapping handles line count changes");
    assert_eq!(validated[0].translated_text, "한 줄로 합침");
}

#[test]
fn validator_strips_gemma_channel_wrappers_before_json_parsing() {
    let item = ProviderBatchItem {
        id: 1,
        text: "\u{30c6}\u{30b9}\u{30c8}\u{00a4}".to_string(),
    };
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![item]);

    for raw in [
        "<|channel>thought\n<channel|>{\"id\":1,\"translation\":\"통과¤\"}",
        "<|channel>thought\nintermediate reasoning should be discarded\n<channel|>{\"id\":1,\"translation\":\"통과¤\"}",
        "<|channel>thought\n<channel|><|channel>final\n<channel|>{\"id\":1,\"translation\":\"통과¤\"}",
        "  <|channel>analysis\nhidden\n<channel|>\n{\"id\":1,\"translation\":\"통과¤\"}",
        "<|turn>model\n<|channel>thought\n<channel|>{\"id\":1,\"translation\":\"통과¤\"}<turn|>",
        "<|start_header_id|>assistant<|end_header_id|>\n{\"id\":1,\"translation\":\"통과¤\"}<|eot_id|>",
    ] {
        let rows = BatchValidator::validate(raw, &jobs).unwrap_or_else(|error| {
            panic!("expected channel wrapper stripping for {raw}: {error}")
        });
        assert_eq!(rows[0].translated_text, "\u{d1b5}\u{acfc}\\TEST");
    }
}

#[test]
fn validator_repairs_common_invalid_json_string_escapes() {
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![ProviderBatchItem {
        id: 1,
        text: "*Yawn*".to_string(),
    }]);

    let validated = BatchValidator::validate("{\"id\":1,\"translation\":\"\\*하품\\*\"}", &jobs)
        .expect("common invalid model escapes should be repaired");

    assert_eq!(validated[0].translated_text, "*하품*");
}

#[test]
fn validator_repairs_unescaped_quotes_inside_provider_json_row() {
    let jobs = BatchPlanner::jobs_from_provider_items_for_test(vec![ProviderBatchItem {
        id: 1,
        text: "(I feel sleepy.)".to_string(),
    }]);

    let validated = BatchValidator::validate(
        "{\"id\":1,\"translation\":\"(다시... \"졸려\"...)\"}",
        &jobs,
    )
    .expect("unescaped provider quotes should be recovered");

    assert_eq!(validated[0].translated_text, "(다시... \"졸려\"...)");
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
            ..test_config()
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
fn json_parse_failure_is_preserved_in_db_and_checkpoint_details() {
    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source(&mut db, "en", "Hello");
    let mut provider = FakeProvider::from_outputs(vec!["not json".to_string()]);

    let report = BatchTranslator::run_with_checkpoint(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
        Some(&checkpoint_path),
    )
    .expect("translate with parse failure");
    let checkpoint = CheckpointWriter::read(&checkpoint_path)
        .expect("read checkpoint")
        .expect("checkpoint remains");
    let findings = db.qa_findings_for_source(source).expect("read findings");

    assert_eq!(report.parse_failed_items, 1);
    assert_eq!(report.final_failed_items, 1);
    assert_eq!(checkpoint.failed_source_text_ids, vec![source]);
    assert_eq!(checkpoint.failure_details.len(), 1);
    assert_eq!(
        checkpoint.failure_details[0].finding_type,
        "provider-json-parse"
    );
    assert_eq!(findings[0].finding_type, "provider-json-parse");
    assert_eq!(findings[0].status, "open");
    let samples = db
        .recent_translation_speed_samples(None, None, 10)
        .expect("speed samples");
    assert_eq!(samples.len(), 1);
    assert_eq!(samples[0].status, "parse_failed");
    assert_eq!(
        samples[0].failure_type.as_deref(),
        Some("provider-json-parse")
    );
    assert_eq!(samples[0].item_count, 1);
}

#[test]
fn translator_rejects_unchanged_provider_output() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source(&mut db, "en", "Hello");
    let mut provider = FakeProvider::from_outputs(vec![output(&[(1, "Hello")])]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
    )
    .expect("translate unchanged output");

    assert_eq!(report.completed_source_text_ids, Vec::<i64>::new());
    assert_eq!(report.failed_source_text_ids, vec![source]);
    assert!(db.get_translation(source, "ko").expect("lookup").is_none());
    let findings = db.qa_findings_for_source(source).expect("findings");
    assert!(
        findings
            .iter()
            .any(|finding| finding.message.contains("unchanged provider output")),
        "expected unchanged provider output finding, got {findings:?}"
    );
}

#[test]
fn translator_retries_unchanged_output_with_localization_instruction() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source_with_kind(&mut db, "en", "Darkness All 2", "db_field");
    let mut provider = SequenceProvider::new(vec![
        Ok(output(&[(1, "Darkness All 2")])),
        Ok(output(&[(1, "어둠 전체 2")])),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 1,
            ..test_config()
        },
    )
    .expect("translate unchanged output after retry");

    assert_eq!(provider.requests().len(), 2);
    let retry_instruction = provider.requests()[1]
        .instruction
        .as_deref()
        .expect("retry instruction");
    assert!(retry_instruction.starts_with(
        "Repair note: Keep the configured system prompt and all prior rules. Fix only this validation failure:"
    ));
    assert!(retry_instruction.contains("previous output copied the source unchanged"));
    assert_eq!(report.failed_source_text_ids, Vec::<i64>::new());
    assert_eq!(report.completed_source_text_ids, vec![source]);
    assert_eq!(
        db.get_translation(source, "ko")
            .expect("lookup")
            .expect("translation")
            .translated_text,
        "어둠 전체 2"
    );
}

#[test]
fn translator_retries_unchanged_short_effect_and_skill_names_like_runtime() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    for text in [
        "Zzz...",
        "X-113?",
        "Err-",
        "F-fading...",
        "B-BWUB?!?",
        "H-hu- *glug*",
        "Darkness One 2",
        "Soulplay 4",
    ] {
        seed_source_with_kind(&mut db, "en", text, "db_field");
    }
    let mut provider = SequenceProvider::new(vec![
        Ok(output(&[
            (1, "Zzz..."),
            (2, "X-113?"),
            (3, "Err-"),
            (4, "F-fading..."),
            (5, "B-BWUB?!?"),
            (6, "H-hu- *glug*"),
            (7, "Darkness One 2"),
            (8, "Soulplay 4"),
        ])),
        Ok(output(&[
            (1, "쿨..."),
            (2, "X-113인가?"),
            (3, "어-"),
            (4, "사-사라져..."),
            (5, "브-부웁?!?"),
            (6, "허- *꿀꺽*"),
            (7, "어둠의 일격 2"),
            (8, "소울플레이 4"),
        ])),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 8,
            retry_attempts: 1,
            ..test_config()
        },
    )
    .expect("translate short/effect/name rows after retry");

    assert_eq!(provider.requests().len(), 2);
    let retry_instruction = provider.requests()[1]
        .instruction
        .as_deref()
        .expect("retry instruction");
    assert!(retry_instruction.starts_with(
        "Repair note: Keep the configured system prompt and all prior rules. Fix only this validation failure:"
    ));
    assert!(retry_instruction.contains("short terms"));
    assert_eq!(report.failed_source_text_ids, Vec::<i64>::new());
    assert_eq!(report.completed_source_text_ids.len(), 8);
}

#[test]
fn translator_retry_instruction_preserves_prompt_and_placeholder_counts() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source_with_kind(&mut db, "en", "Line \u{1b}C[1]\nSecond line", "db_field");
    let mut provider = SequenceProvider::new(vec![
        Ok(r#"{"id":1,"translation":"첫 줄\n둘째 줄¤"}"#.to_string()),
        Ok(r#"{"id":1,"translation":"첫 줄 ¤\n둘째 줄"}"#.to_string()),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 1,
            ..test_config()
        },
    )
    .expect("translate after placeholder repair");

    assert_eq!(provider.requests().len(), 2);
    let retry_instruction = provider.requests()[1]
        .instruction
        .as_deref()
        .expect("retry instruction");
    assert!(retry_instruction.starts_with(
        "Repair note: Keep the configured system prompt and all prior rules. Fix only this validation failure:"
    ));
    assert!(retry_instruction.contains("exact total number of ¤ placeholders"));
    assert!(retry_instruction.contains("Message and scroll blocks may use natural line reflow"));
    assert!(retry_instruction.contains("same number of ¤ placeholders on each original line"));
    assert!(retry_instruction.contains("Do not create any new backslash escape sequences"));
    assert!(retry_instruction.contains("never literal \\n"));
    assert!(retry_instruction.contains("do not add \\N[n], \\C[n], \\H, \\h"));
    assert_eq!(report.failed_source_text_ids, Vec::<i64>::new());
    assert_eq!(report.completed_source_text_ids, vec![source]);
}

#[test]
fn translator_persists_requested_review_state_per_batch() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source_with_kind(&mut db, "en", "Emma", "db_field");
    let mut provider = SequenceProvider::new(vec![Ok(output(&[(1, "엠마")]))]);

    BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            output_review_state: "accepted".to_string(),
            max_items_per_batch: 1,
            ..test_config()
        },
    )
    .expect("translate with requested review state");

    let row = db
        .get_translation(source, "ko")
        .expect("lookup translation")
        .expect("translation exists");
    assert_eq!(row.review_state, "accepted");
    assert_eq!(row.qa_state, "passed");
}

#[test]
fn targeted_retranslation_replaces_failed_row_and_resolves_findings() {
    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source(&mut db, "en", "Hello");
    db.insert_qa_finding(&NewQaFinding {
        source_text_id: source,
        translation_id: None,
        target_language: Some("ko".to_string()),
        provider_run_id: None,
        finding_type: "provider-json-parse".to_string(),
        severity: "error".to_string(),
        message: "provider output was not JSON".to_string(),
        status: "open".to_string(),
        details_json: "{}".to_string(),
    })
    .expect("insert finding");
    CheckpointWriter::write_atomic(
        &checkpoint_path,
        &rpg_translator_core::BatchCheckpoint {
            provider_run_id: 41,
            target_language: "ko".to_string(),
            completed_source_text_ids: Vec::new(),
            failed_source_text_ids: vec![source],
            failure_details: vec![rpg_translator_core::CheckpointFailureDetail {
                source_text_id: source,
                finding_type: "provider-json-parse".to_string(),
                message: "provider output was not JSON".to_string(),
                provider_run_id: Some(41),
                created_at_ms: 0,
            }],
        },
    )
    .expect("write checkpoint");
    let mut provider = FakeProvider::from_outputs(vec![output(&[(1, "안녕")])]);

    let report = BatchTranslator::run_with_checkpoint(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            source_text_ids: Some(vec![source]),
            include_existing_translations: true,
            ..test_config()
        },
        Some(&checkpoint_path),
    )
    .expect("targeted retranslate");

    assert_eq!(provider.requests().len(), 1);
    assert_eq!(report.completed_source_text_ids, vec![source]);
    assert!(
        CheckpointWriter::read(&checkpoint_path)
            .expect("read checkpoint")
            .is_none()
    );
    assert!(
        db.qa_findings_for_source(source)
            .expect("findings")
            .iter()
            .all(|finding| finding.status == "resolved")
    );
    assert_eq!(
        db.get_translation(source, "ko")
            .expect("lookup")
            .expect("translation")
            .translated_text,
        "안녕"
    );
}

#[test]
fn translator_retries_only_censored_outputs_and_keeps_clean_rows() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let censored = seed_source(&mut db, "en", "White Underwear");
    let clean = seed_source(&mut db, "en", "Potion");
    let mut provider = FakeProvider::from_outputs(vec![
        output(&[(1, "흰색 속***"), (2, "물약")]),
        output(&[(1, "흰색 속옷")]),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 2,
            retry_attempts: 0,
            ..test_config()
        },
    )
    .expect("translate censored row");

    assert_eq!(provider.requests().len(), 2);
    assert_eq!(provider.requests()[0].items.len(), 2);
    assert_eq!(provider.requests()[1].items.len(), 1);
    assert!(
        provider.requests()[1]
            .instruction
            .as_deref()
            .expect("retry instruction")
            .contains("Do not censor")
    );
    assert_eq!(report.censored_retry_count, 1);
    assert_eq!(report.completed_source_text_ids, vec![clean, censored]);
    assert_eq!(
        db.get_translation(censored, "ko")
            .expect("lookup censored")
            .expect("translation")
            .translated_text,
        "흰색 속옷"
    );
    assert_eq!(
        db.get_translation(clean, "ko")
            .expect("lookup clean")
            .expect("translation")
            .translated_text,
        "물약"
    );
}

#[test]
fn provider_503_is_retry_pending_until_retry_succeeds() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let source = seed_source(&mut db, "en", "Hello");
    let mut provider = SequenceProvider::new(vec![
        Err(Error::invalid_input(
            "local provider request failed: HTTP status 503 Service Unavailable",
        )),
        Ok(output(&[(1, "\u{c548}\u{b155}")]).to_string()),
    ]);
    let mut events = Vec::new();

    let report = BatchTranslator::run_with_checkpoint_and_progress(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 16,
            retry_attempts: 0,
            provider_spacing: stable_test_spacing(),
            ..BatchTranslatorConfig::default()
        },
        None,
        |event| events.push(event.clone()),
        || false,
    )
    .expect("provider 503 retry succeeds");

    assert_eq!(provider.requests().len(), 2);
    assert_eq!(report.completed_source_text_ids, vec![source]);
    assert!(report.failed_source_text_ids.is_empty());
    assert_eq!(report.final_failed_items, 0);
    assert_eq!(report.retry_pending_items, 0);
    assert_eq!(report.recoverable_provider_failures, 1);
    assert_eq!(
        report.failure_reason_counts.get("provider-503").copied(),
        Some(1)
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, TranslateProgressEvent::ProviderBackoff(snapshot) if snapshot.provider_backoff_ms == Some(0)))
    );
    let samples = db
        .recent_translation_speed_samples(None, None, 10)
        .expect("speed samples");
    assert!(
        samples
            .iter()
            .any(|sample| sample.status == "recoverable_provider"
                && sample.failure_type.as_deref() == Some("provider-503")),
        "recoverable provider failures should seed adaptive failure-rate history"
    );
    assert!(
        samples
            .iter()
            .any(|sample| sample.status == "success_after_retry"),
        "retry success should still seed adaptive throughput history"
    );
}

#[test]
fn connection_failures_backoff_and_only_then_become_final_failures() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "en", "Alpha");
    let second = seed_source(&mut db, "en", "Beta");
    let mut provider = SequenceProvider::new(vec![
        Err(Error::invalid_input(
            "local provider request failed: error sending request for url",
        )),
        Err(Error::invalid_input(
            "local provider request failed: connection refused",
        )),
        Err(Error::invalid_input(
            "local provider request failed: connection reset",
        )),
        Err(Error::invalid_input(
            "local provider request failed: operation timed out",
        )),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 2,
            retry_attempts: 0,
            provider_spacing: stable_test_spacing(),
            ..BatchTranslatorConfig::default()
        },
    )
    .expect("provider connection failures are handled");

    assert_eq!(provider.requests().len(), 4);
    assert_eq!(report.failed_source_text_ids, vec![first, second]);
    assert_eq!(report.final_failed_items, 2);
    assert_eq!(report.retry_pending_items, 0);
    assert_eq!(report.recoverable_provider_failures, 6);
    assert_eq!(report.effective_batch_size, 1);
    assert_eq!(
        report
            .failure_reason_counts
            .get("provider-connection")
            .copied(),
        Some(6)
    );
    assert!(
        report
            .adaptive_decision_reason
            .contains("provider-connection"),
        "runtime adaptive reductions should explain the provider failure reason"
    );
    assert!(
        report.adaptive_decision_reason.contains("batch"),
        "runtime adaptive reductions should explain the batch-size decision"
    );
    assert_eq!(db.qa_finding_count().expect("qa count"), 2);
    let samples = db
        .recent_translation_speed_samples(None, None, 10)
        .expect("speed samples");
    assert!(
        samples
            .iter()
            .any(|sample| sample.status == "recoverable_provider"
                && sample.failure_type.as_deref() == Some("provider-connection")
                && sample
                    .adaptive_decision_reason
                    .contains("provider-connection")
                && sample.adaptive_decision_reason.contains("batch")),
        "recoverable provider samples should carry the adaptive reduction reason"
    );
    assert!(
        samples.iter().any(|sample| sample.status == "final_failed"
            && sample.failure_type.as_deref() == Some("provider-connection")
            && sample.item_count == 2),
        "final provider failures should seed adaptive failure-rate history"
    );
}

#[test]
fn progress_reports_item_and_batch_eta_separately() {
    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    for text in ["A", "B", "C"] {
        seed_source(&mut db, "en", text);
    }
    let mut provider = FakeProvider::from_outputs(vec![
        output(&[(1, "에이")]),
        output(&[(2, "비")]),
        output(&[(3, "씨")]),
    ]);
    let mut events = Vec::new();

    let report = BatchTranslator::run_with_checkpoint_and_progress(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
        Some(&checkpoint_path),
        |event| events.push(event.clone()),
        || false,
    )
    .expect("translate with progress");

    assert_eq!(report.status, BatchRunStatus::Completed);
    assert!(events.iter().any(|event| match event {
        TranslateProgressEvent::BatchFinished(snapshot) => {
            snapshot.current_batch_items == 1
                && snapshot.started_completed_items == 0
                && snapshot.recent_p50_batch_elapsed_ms.is_some()
                && snapshot.recent_p95_batch_elapsed_ms.is_some()
                && snapshot.best_items_per_minute.is_some()
                && (snapshot.item_eta_ms.is_some() || snapshot.batch_eta_ms.is_some())
        }
        _ => false,
    }));
}

#[test]
fn progress_starts_from_existing_db_translations() {
    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "en", "Already one");
    let second = seed_source(&mut db, "en", "Already two");
    let pending = seed_source(&mut db, "en", "Pending three");
    for (source_text_id, translated_text) in [(first, "이미 하나"), (second, "이미 둘")] {
        db.upsert_translation(&NewTranslation {
            source_text_id,
            target_language: "ko".to_string(),
            translated_text: translated_text.to_string(),
            provider: "fixture".to_string(),
            model: None,
            provider_run_id: None,
            review_state: "pending".to_string(),
            qa_state: "passed".to_string(),
        })
        .expect("seed existing translation");
    }
    let mut provider = FakeProvider::from_outputs(vec![output(&[(1, "대기 셋")])]);
    let mut events = Vec::new();

    let report = BatchTranslator::run_with_checkpoint_and_progress(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
        Some(&checkpoint_path),
        |event| events.push(event.clone()),
        || false,
    )
    .expect("translate remaining row with DB baseline");

    assert_eq!(provider.requests().len(), 1);
    assert_eq!(provider.requests()[0].items.len(), 1);
    assert_eq!(report.initial_completed_source_text_count, 2);
    assert_eq!(report.total_source_text_count, 3);
    assert_eq!(report.completed_source_text_ids, vec![pending]);
    assert!(events.iter().any(|event| match event {
        TranslateProgressEvent::Started(snapshot) =>
            snapshot.started_completed_items == 2
                && snapshot.completed_items == 2
                && snapshot.total_items == 3,
        _ => false,
    }));
}

#[test]
fn provider_abort_marks_run_paused_without_checkpointing_current_batch() {
    struct AbortProvider;

    impl ProviderClient for AbortProvider {
        fn provider_name(&self) -> &str {
            "abort-provider"
        }

        fn translate_batch(
            &mut self,
            _request: &ProviderBatchRequest,
        ) -> rpg_translator_core::Result<ProviderBatchResponse> {
            Err(Error::invalid_input(
                "translation paused; provider request aborted",
            ))
        }
    }

    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    seed_source(&mut db, "en", "Alpha");
    seed_source(&mut db, "en", "Beta");
    let mut provider = AbortProvider;
    let mut events = Vec::new();

    let report = BatchTranslator::run_with_checkpoint_and_progress(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 2,
            retry_attempts: 0,
            ..test_config()
        },
        Some(&checkpoint_path),
        |event| events.push(event.clone()),
        || false,
    )
    .expect("pause abort should not be a batch failure");

    assert_eq!(report.status, BatchRunStatus::Paused);
    assert!(report.completed_source_text_ids.is_empty());
    assert!(report.failed_source_text_ids.is_empty());
    assert_eq!(report.processed_batches, 0);
    let checkpoint = CheckpointWriter::read(&checkpoint_path)
        .expect("read checkpoint")
        .expect("checkpoint remains");
    assert!(checkpoint.completed_source_text_ids.is_empty());
    assert!(checkpoint.failed_source_text_ids.is_empty());
    assert!(matches!(
        events.last(),
        Some(TranslateProgressEvent::Paused(_))
    ));
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
            failure_details: Vec::new(),
        },
    )
    .expect("write checkpoint");

    let mut provider = FakeProvider::from_outputs(vec![output(&[(1, "\u{bbf8}")])]);
    let report = BatchTranslator::run_with_checkpoint(
        &mut db,
        &mut provider,
        "ko",
        test_config(),
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

    assert!(
        CheckpointWriter::read(&checkpoint_path)
            .expect("read checkpoint")
            .is_none(),
        "completed runs remove their checkpoint"
    );
}

#[test]
fn translator_emits_progress_and_pauses_after_current_batch() {
    use std::cell::Cell;

    let temp = tempdir().expect("create temp dir");
    let checkpoint_path = temp.path().join("checkpoint.json");
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    let first = seed_source(&mut db, "ja", "\u{4e00}");
    let second = seed_source(&mut db, "ja", "\u{4e8c}");
    let third = seed_source(&mut db, "ja", "\u{4e09}");
    let mut provider = FakeProvider::from_outputs(vec![
        output(&[(1, "\u{d558}\u{b098}")]),
        output(&[(1, "\u{b458}")]),
        output(&[(2, "\u{c14b}")]),
    ]);
    let finished_batches = Cell::new(0usize);
    let mut events = Vec::new();

    let paused = BatchTranslator::run_with_checkpoint_and_progress(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
        Some(&checkpoint_path),
        |event| {
            if matches!(event, TranslateProgressEvent::BatchFinished(_)) {
                finished_batches.set(finished_batches.get() + 1);
            }
            events.push(event.clone());
        },
        || finished_batches.get() >= 1,
    )
    .expect("pause after one finished top-level batch");

    assert_eq!(paused.status, BatchRunStatus::Paused);
    assert_eq!(provider.requests().len(), 1);
    assert_eq!(paused.completed_source_text_ids, vec![first]);
    assert!(matches!(
        events.first(),
        Some(TranslateProgressEvent::Started(_))
    ));
    assert!(
        events
            .iter()
            .any(|event| matches!(event, TranslateProgressEvent::PauseRequested(_)))
    );
    assert!(matches!(
        events.last(),
        Some(TranslateProgressEvent::Paused(_))
    ));
    assert!(
        CheckpointWriter::read(&checkpoint_path)
            .expect("read checkpoint")
            .expect("checkpoint exists")
            .completed_source_text_ids
            .contains(&first)
    );

    let resumed = BatchTranslator::run_with_checkpoint_and_progress(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 1,
            retry_attempts: 0,
            ..test_config()
        },
        Some(&checkpoint_path),
        |_| {},
        || false,
    )
    .expect("resume paused translation");

    assert_eq!(resumed.status, BatchRunStatus::Completed);
    assert_eq!(provider.requests().len(), 3);
    assert_eq!(resumed.completed_source_text_ids, vec![second, third]);
    assert!(
        CheckpointWriter::read(&checkpoint_path)
            .expect("read checkpoint")
            .is_none()
    );
}

#[test]
fn adaptive_pacing_recovers_batch_size_after_success_streaks() {
    let mut db = TranslationDb::open_in_memory().expect("open db");
    db.migrate().expect("migrate db");
    for index in 0..10 {
        seed_source(&mut db, "en", &format!("Line {index}"));
    }
    let mut provider = SequenceProvider::new(vec![
        Err(Error::invalid_input(
            "local provider request failed: 503 Service Unavailable",
        )),
        Err(Error::invalid_input(
            "local provider request failed: 503 Service Unavailable",
        )),
        Ok(output(&[
            (1, "Line 0 ko"),
            (2, "Line 1 ko"),
            (3, "Line 2 ko"),
            (4, "Line 3 ko"),
        ])),
        Ok(output(&[(5, "Line 4 ko"), (6, "Line 5 ko")])),
        Ok(output(&[(7, "Line 6 ko"), (8, "Line 7 ko")])),
        Ok(output(&[(9, "Line 8 ko"), (10, "Line 9 ko")])),
    ]);

    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "ko",
        BatchTranslatorConfig {
            max_items_per_batch: 4,
            retry_attempts: 0,
            provider_spacing: stable_test_spacing(),
            ..BatchTranslatorConfig::default()
        },
    )
    .expect("run adaptive pacing translation");

    assert_eq!(report.status, BatchRunStatus::Completed);
    assert_eq!(report.recoverable_provider_failures, 8);
    assert_eq!(report.success_streak, 4);
    assert_eq!(report.effective_batch_size, 4);
    assert_eq!(report.speed_mode, "recovering");
    assert_eq!(report.completed_source_text_ids.len(), 10);
    assert_eq!(provider.requests().len(), 6);
}

#[test]
fn provider_speed_benchmark_excludes_warmup_from_average() {
    struct DelayedProvider {
        delays_ms: VecDeque<u64>,
    }

    impl ProviderClient for DelayedProvider {
        fn provider_name(&self) -> &str {
            "delayed"
        }

        fn model_name(&self) -> Option<&str> {
            Some("delayed-model")
        }

        fn translate_batch(
            &mut self,
            _request: &ProviderBatchRequest,
        ) -> rpg_translator_core::Result<ProviderBatchResponse> {
            let delay_ms = self.delays_ms.pop_front().unwrap_or(1);
            thread::sleep(Duration::from_millis(delay_ms));
            Ok(ProviderBatchResponse {
                raw_output: "{}".to_string(),
            })
        }
    }

    let request = ProviderBatchRequest {
        items: vec![
            ProviderBatchItem {
                id: 1,
                text: "Alpha".to_string(),
            },
            ProviderBatchItem {
                id: 2,
                text: "Beta".to_string(),
            },
        ],
        instruction: None,
    };
    let mut provider = DelayedProvider {
        delays_ms: VecDeque::from(vec![40, 1, 1, 1, 1, 1]),
    };

    let report = ProviderSpeedBenchmark::run(
        &mut provider,
        &request,
        ProviderSpeedBenchmarkConfig {
            warmup_runs: 1,
            measured_runs: 5,
        },
        &ProviderRequestSpacingConfig::disabled(),
    )
    .expect("benchmark provider");

    assert_eq!(report.runs.len(), 5);
    assert_eq!(report.resolved_model.as_deref(), Some("delayed-model"));
    assert!(
        report.warmup_ms.expect("warmup latency") > report.average_ms.expect("average latency")
    );
    assert!(report.items_per_minute.is_some());
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
