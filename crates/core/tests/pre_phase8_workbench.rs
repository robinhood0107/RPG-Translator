use std::fs;
use std::path::Path;

use rpg_translator_core::{
    BatchTranslator, BatchTranslatorConfig, Engine, InstallStatusRecord, LocalOpenAiConfig,
    LocalOpenAiProvider, LocalProviderTransport, NewInstallRecord, NewProject, NewSourceText,
    NewTranslation, ProviderBatchRequest, Result, ScanOptions, TextCodec, TranslationDb,
    TranslationJobProgressUpdate, TranslationQualityAuditor, WorkbenchService,
    build_provider_system_prompt, build_quality_retry_instruction,
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
        json!({ "gameTitle": "Synthetic Workbench", "advanced": {}, "optAutosave": true }),
    );
    write_text(&root.join("js/plugins.js"), "var $plugins = [];");
    write_json(
        &root.join("data/Map001.json"),
        json!({
            "events": [
                null,
                {
                    "id": 3,
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

#[derive(Default)]
struct RecordingTransport {
    url: Option<String>,
    body: Option<Value>,
}

impl LocalProviderTransport for RecordingTransport {
    fn post_json(&mut self, url: &str, body: &Value) -> Result<Value> {
        self.url = Some(url.to_string());
        self.body = Some(body.clone());
        Ok(json!({
            "model": "fixture-model",
            "choices": [
                { "message": { "content": "<|channel>thought\n<channel|>{\"id\":1,\"translation\":\"안녕¤\"}" } }
            ]
        }))
    }
}

#[test]
fn local_openai_provider_builds_safe_request_and_parses_chat_response() -> Result<()> {
    let ui_prompt = "UI prompt first.";
    let mut provider = LocalOpenAiProvider::new(
        LocalOpenAiConfig {
            base_url: "http://127.0.0.1:1234".to_string(),
            model: "fixture-model".to_string(),
            source_language: "ja".to_string(),
            target_language: "ko".to_string(),
            system_prompt: ui_prompt.to_string(),
            temperature: Some(0.2),
            top_p: Some(0.9),
            max_output_tokens: Some(256),
        },
        RecordingTransport::default(),
    )?;

    let response = provider.translate_batch(&ProviderBatchRequest {
        items: vec![rpg_translator_core::ProviderBatchItem {
            id: 1,
            text: "こんにちは¤".to_string(),
        }],
        instruction: None,
    })?;

    let transport = provider.transport();
    let body = transport.body.as_ref().expect("recorded request body");
    let system_prompt = body["messages"][0]["content"]
        .as_str()
        .expect("system prompt");

    assert_eq!(
        transport.url.as_deref(),
        Some("http://127.0.0.1:1234/v1/chat/completions")
    );
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["temperature"], 0.2);
    assert_eq!(body["top_p"], 0.9);
    assert_eq!(body["max_tokens"], 256);
    assert!(
        body["messages"][1]["content"]
            .as_str()
            .expect("user prompt content")
            .contains("\"id\":1")
    );
    assert!(system_prompt.contains("JSON Lines"));
    assert!(system_prompt.contains(rpg_translator_core::DEFAULT_SYSTEM_PROMPT));
    assert!(system_prompt.contains("Provider I/O Contract:"));
    assert!(system_prompt.contains("Source language: Japanese"));
    assert!(system_prompt.contains("Target language: Korean"));
    assert!(
        system_prompt
            .contains("Translate only the human-visible story/dialogue/game text into Korean.")
    );
    assert!(system_prompt.contains("Return exactly one JSON object per input item"));
    assert!(system_prompt.contains("one JSON object per line"));
    assert!(system_prompt.contains("id must be an integer"));
    assert!(system_prompt.contains("Use only the translation field"));
    assert!(system_prompt.contains("Do NOT use text instead of translation"));
    assert!(system_prompt.contains("complete <...> metadata tags byte-for-byte"));
    assert!(system_prompt.contains("Localize names and short dialogue"));
    assert!(system_prompt.contains("Do not leave third-language connector words"));
    assert!(!system_prompt.contains("System: You are an expert game localization engine."));
    assert!(!system_prompt.contains("Strict Rules:"));
    assert!(!system_prompt.contains("Output ONLY the final valid JSONL line"));
    assert!(
        system_prompt.find(ui_prompt).expect("ui prompt present")
            < system_prompt
                .find(rpg_translator_core::DEFAULT_SYSTEM_PROMPT)
                .expect("rust default prompt present")
    );
    assert!(
        system_prompt
            .find(rpg_translator_core::DEFAULT_SYSTEM_PROMPT)
            .expect("rust default prompt present")
            < system_prompt
                .find("Provider I/O Contract:")
                .expect("provider contract present")
    );
    assert_eq!(response.raw_output, "{\"id\":1,\"translation\":\"안녕¤\"}");

    Ok(())
}

#[test]
fn provider_prompt_builder_forces_display_target_language() {
    let prompt = build_provider_system_prompt("Custom prompt.", "en", "vi");
    assert!(prompt.starts_with("Custom prompt."));
    assert!(prompt.contains(rpg_translator_core::DEFAULT_SYSTEM_PROMPT));
    assert!(prompt.contains("Source language: English"));
    assert!(prompt.contains("Target language: Vietnamese"));
    assert!(prompt.contains("into Vietnamese"));
    assert!(prompt.contains("{\"id\":123,\"translation\":\"...\"}"));
    assert!(prompt.contains("Do NOT quote id values"));
    assert!(prompt.contains("Do NOT use text instead of translation"));
    assert!(prompt.contains("complete <...> metadata tags byte-for-byte"));
    assert!(prompt.contains("Do NOT include markdown code blocks"));
    assert!(!prompt.contains("System: You are an expert game localization engine."));

    let custom_target = build_provider_system_prompt("", "English", "Pirate Korean");
    assert!(custom_target.starts_with(rpg_translator_core::DEFAULT_SYSTEM_PROMPT));
    assert!(custom_target.contains("Source language: English"));
    assert!(custom_target.contains("Target language: Pirate Korean"));
    assert!(custom_target.contains("into Pirate Korean"));
}

#[test]
fn translation_quality_audit_flags_high_risk_defects_and_allows_technical_tokens() {
    let issues = TranslationQualityAuditor::audit_text("Horny Man", "욕정 de 있는 남자", "ko");
    assert!(issues.iter().any(|issue| issue.code == "foreign_connector"));
    assert!(
        issues
            .iter()
            .any(|issue| issue.classification == "high_risk")
    );

    let issues = TranslationQualityAuditor::audit_text(
        "Nether Aura Strike 4",
        "네더 오I라 스트라이크 4",
        "ko",
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == "embedded_ascii_in_hangul")
    );

    let issues = TranslationQualityAuditor::audit_text(
        "This stolen power is only a fragment.",
        "이 훔친\\n힘은 파편일 뿐입니다.",
        "ko",
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == "literal_backslash_n")
    );

    let issues =
        TranslationQualityAuditor::audit_text("Emma, you look pale.", "Emma, 얼굴이 창백해.", "ko");
    assert!(issues.iter().any(|issue| issue.code == "raw_source_token"));

    let issues = TranslationQualityAuditor::audit_text(
        "Haa~, s-stop making me say those words!",
        "하아~, way, way s-stop making me say those naughty words~!",
        "ko",
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.code == "source_english_fragment")
    );

    for technical in [
        "ATK+100%",
        "Lv",
        "${Text1}",
        "[Space]",
        "[Escape]",
        "Crypt_Tileset_Outside",
        "►D1-F1",
    ] {
        assert!(
            TranslationQualityAuditor::audit_text(technical, technical, "ko").is_empty(),
            "{technical} should stay allowed as a technical token"
        );
    }
    assert!(
        TranslationQualityAuditor::audit_text(
            "<Show Switch: 63>Pass Time",
            "<Show Switch: 63>시간 경과",
            "ko",
        )
        .is_empty(),
        "angle-bracket command metadata should be protected during quality audit"
    );
    assert!(
        TranslationQualityAuditor::audit_text(
            "<Disable Switch: 8>Diluted Blood of the Goddess",
            "<Disable Switch: 나 8>희석된 여신의 피",
            "ko",
        )
        .iter()
        .any(|issue| {
            issue.code == "protected_tag_mismatch" && issue.classification == "high_risk"
        }),
        "mutated angle-bracket command metadata should be high risk"
    );
    assert!(
        TranslationQualityAuditor::audit_text(
            "Click [Space] or press [Escape] to exit.",
            "[Space]를 클릭하거나 종료하려면 [Escape]를 누르세요.",
            "ko",
        )
        .is_empty(),
        "protected keyboard keys inside sentences should not be retried"
    );
    assert!(
        TranslationQualityAuditor::audit_text(
            "Office_Tileset (Lexi)",
            "Office_Tileset (렉시)",
            "ko",
        )
        .is_empty(),
        "technical tileset tokens may remain while names are localized"
    );

    let report = TranslationQualityAuditor::report_from_issues_with_allowlist(
        3,
        vec![
            TranslationQualityAuditor::audit_text("Horny Man", "욕정 de 있는 남자", "ko").remove(0),
            TranslationQualityAuditor::audit_text("Emma looks", "엠마 Emma", "ko")
                .into_iter()
                .find(|issue| issue.classification == "quality_retry")
                .expect("quality retry issue"),
        ],
        1,
        1,
    );
    assert_eq!(report.high_risk_source_count, 1);
    assert_eq!(report.quality_retry_source_count, 1);
    assert_eq!(report.allowlisted_technical_count, 1);
}

#[test]
fn quality_retry_instruction_forces_korean_purity_and_name_localization() {
    let instruction = build_quality_retry_instruction("ko");

    assert!(instruction.contains("Korean"));
    assert!(instruction.contains("Emma -> 엠마"));
    assert!(instruction.contains("Laura -> 로라"));
    assert!(instruction.contains("literal \\\\n"));
    assert!(instruction.contains("Do not leave foreign connector words"));
    assert!(instruction.contains("Preserve JSONL ids"));
}

#[test]
fn scan_persist_service_populates_project_dashboard_and_review_queue() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    make_direct_game(&game);

    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let report = WorkbenchService::scan_game(&mut db, &game, ScanOptions::default())?;
    let projects = db.list_projects()?;
    let dashboard = db.workbench_dashboard_summary(report.project_id, "ko")?;
    let rows = db.review_queue_rows(report.project_id, "ko", None)?;

    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].id, report.project_id);
    assert_eq!(projects[0].engine, Engine::Mz);
    assert_eq!(report.source_text_count, 3);
    assert_eq!(report.occurrence_count, 3);
    assert_eq!(dashboard.project_id, report.project_id);
    assert_eq!(dashboard.source_text_count, 3);
    assert_eq!(dashboard.occurrence_count, 3);
    assert_eq!(dashboard.translated_count, 0);
    assert_eq!(dashboard.review_queue_count, 3);
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().any(|row| {
        row.visible_text == "こんにちは"
            && row.first_file_path == "data/Map001.json"
            && row.review_state == "missing"
            && row.qa_state == "unchecked"
    }));

    Ok(())
}

#[test]
fn dashboard_reports_latest_export_install_and_provider_status() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/workbench".to_string(),
        display_name: "Synthetic Workbench".to_string(),
        engine: Engine::Mz,
    })?;
    let analysis = TextCodec::analyze("世界");
    let provider_state = TextCodec::encode_for_provider(&analysis.normalized_text);
    let source_id = db.upsert_source_text(&NewSourceText {
        source_language: "ja".to_string(),
        unit_kind: "text".to_string(),
        normalized_hash: String::new(),
        normalized_text: analysis.normalized_text,
        visible_text: analysis.visible_text,
        codec_text: provider_state.provider_text,
        control_code_signature: analysis.control_code_signature,
        line_count: 1,
        newline_count: 0,
        placeholder_count: provider_state.control_codes.len() as i64,
    })?;
    db.insert_project_occurrence(
        project_id,
        &rpg_translator_core::NewOccurrence {
            project_id: Some(project_id),
            source_text_id: source_id,
            file_path: "data/Map001.json".to_string(),
            json_path: "$.events[1].pages[0].list[0].parameters[0]".to_string(),
            entity_type: "event.command".to_string(),
            event_id: Some(1),
            page_index: Some(0),
            command_index: Some(0),
            command_code: Some(401),
            parameter_index: Some(0),
            object_key: None,
            extraction_rule_id: "event.message.line".to_string(),
        },
    )?;
    db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "세계".to_string(),
        provider: "local-openai-compatible".to_string(),
        model: Some("fixture-model".to_string()),
        provider_run_id: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
    })?;
    let export_id = db.record_export(project_id, "ko", "/tmp/export", "manifest-hash", 1)?;
    let install_id = db.record_install(&NewInstallRecord {
        project_id: Some(project_id),
        game_root: "/synthetic/workbench".to_string(),
        export_id: Some(export_id),
        backup_manifest_path: "/tmp/install-manifest.json".to_string(),
        status: "installed".to_string(),
    })?;
    let mut provider =
        rpg_translator_core::FakeProvider::from_outputs(vec!["not-json".to_string()]);
    let batch_report = BatchTranslator::run(
        &mut db,
        &mut provider,
        "fr",
        BatchTranslatorConfig {
            retry_attempts: 0,
            ..BatchTranslatorConfig::default()
        },
    )?;

    let dashboard = db.workbench_dashboard_summary(project_id, "ko")?;

    assert_eq!(dashboard.translated_count, 1);
    assert_eq!(dashboard.accepted_count, 1);
    assert_eq!(dashboard.review_queue_count, 0);
    let latest_export = dashboard.latest_export.as_ref().expect("latest export");
    let latest_provider_run = dashboard
        .latest_provider_run
        .as_ref()
        .expect("latest provider run");
    assert_eq!(latest_export.id, export_id);
    assert_eq!(latest_export.included_count, 1);
    assert_eq!(
        dashboard.latest_install,
        Some(InstallStatusRecord {
            id: install_id,
            project_id: Some(project_id),
            game_root: "/synthetic/workbench".to_string(),
            export_id: Some(export_id),
            backup_manifest_path: "/tmp/install-manifest.json".to_string(),
            status: "installed".to_string(),
        })
    );
    assert_eq!(latest_provider_run.id, batch_report.provider_run_id);
    assert_eq!(latest_provider_run.status, "completed_with_failures");
    assert!(
        latest_provider_run
            .failure_detail
            .as_deref()
            .unwrap_or_default()
            .contains("batch")
    );

    Ok(())
}

#[test]
fn translation_job_progress_survives_restart_and_reports_latest_summary() -> Result<()> {
    let temp = tempdir().expect("create temp dir");
    let db_path = temp.path().join("workbench.sqlite");
    {
        let mut db = TranslationDb::open(&db_path)?;
        db.migrate()?;
        let project_id = db.upsert_project(&NewProject {
            game_root: "/synthetic/workbench".to_string(),
            display_name: "Synthetic Workbench".to_string(),
            engine: Engine::Mz,
        })?;
        let provider_run_id = db.start_provider_run(&rpg_translator_core::NewProviderRun {
            provider: "local-openai-compatible".to_string(),
            model: Some("gemma-4-26B-IQ4_NL.gguf".to_string()),
            request_settings_json: "{}".to_string(),
        })?;
        db.upsert_translation_job_progress(&TranslationJobProgressUpdate {
            provider_run_id,
            project_id: Some(project_id),
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            checkpoint_path: "/tmp/workbench.sqlite.translation-ko.checkpoint.json".to_string(),
            status: "paused".to_string(),
            completed_items: 3_831,
            failed_items: 11_841,
            total_items: 20_630,
            processed_batches: 952,
            total_batches: 1_290,
            split_batches: 7,
            parse_failed_items: 3,
            validation_failed_items: 5,
            skipped_items: 2,
            censored_retry_count: 1,
            retry_pending_items: 11_841,
            recoverable_provider_failures: 11_841,
            final_failed_items: 0,
            provider_backoff_ms: None,
            effective_batch_size: 8,
            next_experiment_batch_size: 8,
            input_token_budget: 4096,
            speed_mode: "backoff".to_string(),
            success_streak: 0,
            success_delay_floor_ms: 1500,
            next_delay_ms: Some(5_000),
            failure_reason_counts_json: "{\"provider-503\":6367,\"provider-connection\":5462}"
                .to_string(),
            adaptive_decision_reason: "adaptive: test history".to_string(),
            legacy_checkpoint_only: false,
            item_eta_ms: Some(26_880_000),
            batch_eta_ms: Some(1_880_000),
            last_batch_elapsed_ms: Some(17_000),
            avg_batch_elapsed_ms: Some(11_000),
            current_batch_items: 16,
            elapsed_ms: 5_298_000,
            model: Some("gemma-4-26B-IQ4_NL.gguf".to_string()),
        })?;
    }

    let mut reopened = TranslationDb::open(&db_path)?;
    reopened.migrate()?;
    let summary = reopened
        .latest_translation_job_summary(Some("ko"))?
        .expect("latest job summary");

    assert_eq!(summary.status, "paused");
    assert_eq!(summary.completed_items, 3_831);
    assert_eq!(summary.failed_items, 11_841);
    assert_eq!(summary.processed_batches, 952);
    assert_eq!(summary.total_batches, 1_290);
    assert_eq!(summary.split_batches, 7);
    assert_eq!(summary.parse_failed_items, 3);
    assert_eq!(summary.validation_failed_items, 5);
    assert_eq!(summary.skipped_items, 2);
    assert_eq!(summary.censored_retry_count, 1);
    assert_eq!(summary.item_eta_ms, Some(26_880_000));
    assert_eq!(summary.batch_eta_ms, Some(1_880_000));
    assert_eq!(summary.model.as_deref(), Some("gemma-4-26B-IQ4_NL.gguf"));

    Ok(())
}
