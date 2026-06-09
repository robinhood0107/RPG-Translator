use std::fs;
use std::path::Path;

use rpg_translator_core::{
    BatchTranslator, BatchTranslatorConfig, Engine, InstallStatusRecord, LocalOpenAiConfig,
    LocalOpenAiProvider, LocalProviderTransport, NewInstallRecord, NewProject, NewSourceText,
    NewTranslation, ProviderBatchRequest, Result, ScanOptions, TextCodec, TranslationDb,
    TranslationJobProgressUpdate, WorkbenchService, build_provider_system_prompt,
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
    assert!(system_prompt.contains("from Japanese to Korean"));
    assert!(
        system_prompt
            .contains("Translation: Translate only the actual story/dialogue text into Korean.")
    );
    assert!(system_prompt.contains("Output ONLY the final valid JSONL line"));
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
                .find("Strict Rules:")
                .expect("final strict rules present")
    );
    assert_eq!(response.raw_output, "{\"id\":1,\"translation\":\"안녕¤\"}");

    Ok(())
}

#[test]
fn provider_prompt_builder_forces_display_target_language() {
    let prompt = build_provider_system_prompt("Custom prompt.", "en", "vi");
    assert!(prompt.starts_with("Custom prompt."));
    assert!(prompt.contains(rpg_translator_core::DEFAULT_SYSTEM_PROMPT));
    assert!(prompt.contains("from English to Vietnamese"));
    assert!(prompt.contains("into Vietnamese"));
    assert!(prompt.contains("Do NOT include markdown code blocks"));

    let custom_target = build_provider_system_prompt("", "English", "Pirate Korean");
    assert!(custom_target.starts_with(rpg_translator_core::DEFAULT_SYSTEM_PROMPT));
    assert!(custom_target.contains("from English to Pirate Korean"));
    assert!(custom_target.contains("into Pirate Korean"));
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
            speed_mode: "backoff".to_string(),
            success_streak: 0,
            success_delay_floor_ms: 1500,
            next_delay_ms: Some(5_000),
            failure_reason_counts_json: "{\"provider-503\":6367,\"provider-connection\":5462}"
                .to_string(),
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
