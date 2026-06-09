use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::{Arc, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use rpg_translator_core::{
    BatchCheckpoint, CheckpointWriter, Engine, GameLayoutKind, NewOccurrence, NewProject,
    NewSourceText, NewTranslation, NewTranslationSpeedSample, ScanProgressEvent, TextCodec,
    TranslateProgressEvent, TranslateProgressSnapshot, TranslationDb, WorkbenchSettingsUpdate,
    translation_prompt_hash,
};
use rpg_translator_desktop::commands::{
    diagnostics::{self, DiagnosticsRequest},
    export_install::{self, ExportBundleRequest, InstallOverlayRequest, RollbackOverlayRequest},
    projects::{
        self, ListProjectsRequest, OpenProjectFileRequest, OpenProjectRequest,
        RecreateProjectDatabaseRequest,
    },
    review::{self, ReviewQueueRequest, UpdateReviewStateRequest},
    scan::{self, ScanGameRequest},
    translate::{self, ProviderSpeedBenchmarkRequest, ProviderTestRequest, TranslateRequest},
    workbench::{self, HydrateWorkbenchRequest},
};
use rusqlite::Connection;
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent directory");
    }
    fs::write(path, text).expect("write fixture file");
}

fn source_text_fixture(source_language: &str, text: &str) -> NewSourceText {
    let analysis = TextCodec::analyze(text);
    let provider_state = TextCodec::encode_for_provider(&analysis.normalized_text);
    NewSourceText {
        source_language: source_language.to_string(),
        unit_kind: "text".to_string(),
        normalized_hash: String::new(),
        normalized_text: analysis.normalized_text.clone(),
        visible_text: analysis.visible_text,
        codec_text: provider_state.provider_text,
        control_code_signature: analysis.control_code_signature,
        line_count: analysis.normalized_text.matches('\n').count() as i64 + 1,
        newline_count: analysis.normalized_text.matches('\n').count() as i64,
        placeholder_count: provider_state.control_codes.len() as i64,
    }
}

fn write_json(path: &Path, text: &str) {
    write_text(path, text);
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn make_direct_game(root: &Path) {
    write_json(
        &root.join("data/System.json"),
        r#"{"gameTitle":"Workbench Fixture","advanced":{},"optAutosave":true}"#,
    );
    write_text(&root.join("js/plugins.js"), "var $plugins = [];");
    write_json(
        &root.join("data/Map001.json"),
        r#"{
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
        }"#,
    );
}

fn make_english_direct_game(root: &Path) {
    write_json(
        &root.join("data/System.json"),
        r#"{"gameTitle":"English Fixture","advanced":{},"optAutosave":true}"#,
    );
    write_text(&root.join("js/plugins.js"), "var $plugins = [];");
    write_json(
        &root.join("data/Map001.json"),
        r#"{
          "events": [
            null,
            {
              "id": 1,
              "pages": [
                {
                  "list": [
                    { "code": 401, "parameters": ["Hello there."] },
                    { "code": 102, "parameters": [["Yes", "No"], 0, 0, 2, 0] }
                  ]
                }
              ]
            }
          ]
        }"#,
    );
}

fn add_english_common_event(root: &Path, line: &str) {
    write_json(
        &root.join("data/CommonEvents.json"),
        &format!(
            r#"[null,{{"id":103,"name":"Nico_Handler","list":[{{"code":101,"parameters":["",0,0,2,"Nico"]}},{{"code":401,"parameters":["{line}"]}}]}}]"#
        ),
    );
}

fn make_korean_direct_game(root: &Path) {
    write_json(
        &root.join("data/System.json"),
        r#"{"gameTitle":"Korean Fixture","advanced":{},"optAutosave":true}"#,
    );
    write_text(&root.join("js/plugins.js"), "var $plugins = [];");
    write_json(
        &root.join("data/Map001.json"),
        r#"{
          "events": [
            null,
            {
              "id": 1,
              "pages": [
                {
                  "list": [
                    { "code": 401, "parameters": ["안녕하세요."] },
                    { "code": 102, "parameters": [["예", "아니오"], 0, 0, 2, 0] }
                  ]
                }
              ]
            }
          ]
        }"#,
    );
}

fn make_export_bundle(root: &Path) {
    write_text(
        &root.join("manifest.json"),
        r#"{"schema_version":1,"project_id":1,"source_language":"ja","target_language":"ko","created_timestamp":"1","key_schema_version":"v1","cache_files":["cache.jsonl"],"record_count":1}"#,
    );
    write_text(
        &root.join("overlay-config.json"),
        r#"{"schema_version":1,"diagnostics_enabled":false,"startup_toast_enabled":true,"startup_toast_text":"RPG-Translator 작동중","foresight_command_catalog":{"schemaVersion":4,"eventCommands":{},"movementRouteCommands":{}}}"#,
    );
    write_text(
        &root.join("cache.jsonl"),
        r#"{"cache_key":"ck:v1:0000000000000000000000000000000000000000000000000000000000000000","cache_aliases":["ck:v1:0000000000000000000000000000000000000000000000000000000000000000"],"source_text_id":1,"source_hash":"0000000000000000000000000000000000000000000000000000000000000000","source_language":"ja","target_language":"ko","normalized_text":"世界","visible_text":"世界","translation":"세계","control_code_signature":"","context_hash":null}"#,
    );
}

fn seed_review_project(db_path: &Path) -> i64 {
    let mut db = TranslationDb::open(db_path).expect("open db");
    db.migrate().expect("migrate db");
    let project_id = db
        .upsert_project(&NewProject {
            game_root: "/synthetic/paged-game".to_string(),
            display_name: "Paged Game".to_string(),
            engine: Engine::Mz,
        })
        .expect("insert project");

    for (index, text) in ["Alpha", "Beta", "Gamma"].iter().enumerate() {
        let source_text_id = db
            .upsert_source_text(&source_text_fixture("en", text))
            .expect("insert source text");
        db.insert_project_occurrence(
            project_id,
            &NewOccurrence {
                project_id: Some(project_id),
                source_text_id,
                file_path: format!("data/Map{index:03}.json"),
                json_path: format!("$.events[1].pages[0].list[{index}].parameters[0]"),
                entity_type: "event_command".to_string(),
                event_id: Some(1),
                page_index: Some(0),
                command_index: Some(index as i64),
                command_code: Some(401),
                parameter_index: Some(0),
                object_key: None,
                extraction_rule_id: "event.message.line".to_string(),
            },
        )
        .expect("insert occurrence");
        if *text == "Beta" {
            db.upsert_translation(&NewTranslation {
                source_text_id,
                target_language: "ko".to_string(),
                translated_text: "베타".to_string(),
                provider: "local-openai-compatible".to_string(),
                model: Some("fixture-model".to_string()),
                provider_run_id: None,
                review_state: "accepted".to_string(),
                qa_state: "passed".to_string(),
            })
            .expect("insert accepted translation");
        }
    }

    project_id
}

#[test]
fn hydrate_backfills_latest_job_from_legacy_checkpoint_only_db() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let project_id = seed_review_project(&db_path);
        let provider_run_id = {
            let mut db = TranslationDb::open(&db_path).expect("open db");
            db.migrate().expect("migrate db");
            db.save_workbench_settings(&WorkbenchSettingsUpdate {
                selected_project_id: Some(Some(project_id)),
                source_language: Some("en".to_string()),
                target_language: Some("ko".to_string()),
                ..WorkbenchSettingsUpdate::default()
            })
            .expect("save settings");
            let provider_run_id = db
                .start_provider_run(&rpg_translator_core::NewProviderRun {
                    provider: "local-openai-compatible".to_string(),
                    model: Some("legacy-model.gguf".to_string()),
                    request_settings_json: "{}".to_string(),
                })
                .expect("start provider run");
            db.finish_provider_run(provider_run_id, "paused", None)
                .expect("mark provider run paused");
            provider_run_id
        };
        let checkpoint_path =
            translate::translation_checkpoint_path(&db_path.to_string_lossy(), "ko");
        CheckpointWriter::write_atomic(
            &checkpoint_path,
            &BatchCheckpoint {
                provider_run_id,
                target_language: "ko".to_string(),
                completed_source_text_ids: vec![1, 2],
                failed_source_text_ids: vec![3],
                failure_details: Vec::new(),
            },
        )
        .expect("write checkpoint");

        let hydrated = workbench::hydrate_workbench(HydrateWorkbenchRequest {
            db_path: Some(path_string(&db_path)),
            project_file_path: None,
        })
        .await
        .expect("hydrate workbench");
        let latest_job = hydrated.latest_job.expect("latest job is backfilled");

        assert_eq!(latest_job.provider_run_id, Some(provider_run_id));
        assert_eq!(latest_job.project_id, Some(project_id));
        assert_eq!(latest_job.source_language, "en");
        assert_eq!(latest_job.target_language, "ko");
        assert_eq!(latest_job.status, "paused");
        assert_eq!(latest_job.completed_items, 2);
        assert_eq!(latest_job.failed_items, 1);
        assert_eq!(latest_job.total_items, 3);
        assert_eq!(latest_job.processed_batches, 0);
        assert_eq!(latest_job.total_batches, 0);
        assert_eq!(latest_job.model.as_deref(), Some("legacy-model.gguf"));
    });
}

#[test]
fn hydrate_migrates_legacy_speed_columns_with_schema_backup() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        {
            let conn = Connection::open(&db_path).expect("open legacy db");
            conn.execute_batch(
                "
                CREATE TABLE translation_jobs (
                    id INTEGER PRIMARY KEY,
                    provider_run_id INTEGER,
                    project_id INTEGER,
                    source_language TEXT NOT NULL DEFAULT '',
                    target_language TEXT NOT NULL,
                    checkpoint_path TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    completed_items INTEGER NOT NULL DEFAULT 0,
                    failed_items INTEGER NOT NULL DEFAULT 0,
                    total_items INTEGER NOT NULL DEFAULT 0,
                    processed_batches INTEGER NOT NULL DEFAULT 0,
                    total_batches INTEGER NOT NULL DEFAULT 0,
                    split_batches INTEGER NOT NULL DEFAULT 0,
                    parse_failed_items INTEGER NOT NULL DEFAULT 0,
                    validation_failed_items INTEGER NOT NULL DEFAULT 0,
                    skipped_items INTEGER NOT NULL DEFAULT 0,
                    censored_retry_count INTEGER NOT NULL DEFAULT 0,
                    item_eta_ms INTEGER,
                    batch_eta_ms INTEGER,
                    last_batch_elapsed_ms INTEGER,
                    avg_batch_elapsed_ms INTEGER,
                    current_batch_items INTEGER NOT NULL DEFAULT 0,
                    elapsed_ms INTEGER NOT NULL DEFAULT 0,
                    retry_pending_items INTEGER NOT NULL DEFAULT 0,
                    recoverable_provider_failures INTEGER NOT NULL DEFAULT 0,
                    final_failed_items INTEGER NOT NULL DEFAULT 0,
                    provider_backoff_ms INTEGER,
                    effective_batch_size INTEGER NOT NULL DEFAULT 0,
                    failure_reason_counts_json TEXT NOT NULL DEFAULT '{}',
                    legacy_checkpoint_only INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                INSERT INTO translation_jobs (
                    source_language,
                    target_language,
                    checkpoint_path,
                    status,
                    completed_items,
                    failed_items,
                    total_items,
                    processed_batches,
                    total_batches,
                    current_batch_items,
                    recoverable_provider_failures,
                    final_failed_items,
                    provider_backoff_ms,
                    effective_batch_size
                )
                VALUES (
                    'en',
                    'ko',
                    'translation-ko.checkpoint.json',
                    'running',
                    20648,
                    126,
                    20774,
                    1299,
                    1299,
                    8,
                    32,
                    126,
                    10000,
                    0
                );
                ",
            )
            .expect("seed legacy job table");
        }

        let hydrated = workbench::hydrate_workbench(HydrateWorkbenchRequest {
            db_path: Some(path_string(&db_path)),
            project_file_path: None,
        })
        .await
        .expect("hydrate migrated legacy db");

        let latest_job = hydrated.latest_job.expect("latest job survives migration");
        assert_eq!(latest_job.status, "completed_with_failures");
        assert_eq!(latest_job.completed_items, 20648);
        assert_eq!(latest_job.final_failed_items, 126);
        assert_eq!(latest_job.speed_mode, "steady");
        assert_eq!(latest_job.success_delay_floor_ms, 1500);
        assert_eq!(latest_job.next_delay_ms, None);
        assert_eq!(latest_job.effective_batch_size, 8);
        assert_eq!(latest_job.next_experiment_batch_size, 8);
        assert_eq!(latest_job.input_token_budget, 4096);
        assert_eq!(hydrated.stale_runs_interrupted, 1);

        let backups_dir = temp.path().join("backups");
        let backups = fs::read_dir(&backups_dir)
            .expect("schema backup directory exists")
            .collect::<Result<Vec<_>, _>>()
            .expect("read schema backups");
        assert_eq!(backups.len(), 1);
        assert!(
            backups[0]
                .file_name()
                .to_string_lossy()
                .starts_with("schema-upgrade-")
        );

        let conn = Connection::open(&db_path).expect("open migrated db");
        let has_review_drafts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'review_drafts'",
                [],
                |row| row.get(0),
            )
            .expect("query review_drafts table");
        assert_eq!(has_review_drafts, 1);
        let speed_columns: i64 = conn
            .query_row(
                "
                SELECT COUNT(*)
                FROM pragma_table_info('translation_jobs')
                WHERE name IN ('speed_mode', 'success_streak', 'success_delay_floor_ms', 'next_delay_ms', 'next_experiment_batch_size', 'input_token_budget')
                ",
                [],
                |row| row.get(0),
            )
            .expect("query speed columns");
        assert_eq!(speed_columns, 6);
    });
}

#[test]
fn commands_run_synthetic_workbench_flow() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let game_root = temp.path().join("game");
        let export_dir = temp.path().join("export");
        make_direct_game(&game_root);

        let opened = projects::open_project(OpenProjectRequest {
            game_root: game_root.to_string_lossy().into_owned(),
        })
        .await
        .expect("open project");
        let project = opened.project.as_ref().expect("project created");
        assert_eq!(project.display_name, "game");
        assert_eq!(project.engine, "mz");
        assert!(
            opened
                .workspace
                .project_file_path
                .ends_with("rpg-translator/game.rpgmakers")
        );
        assert!(
            opened
                .workspace
                .db_path
                .ends_with("rpg-translator/db/game.sqlite")
        );
        let reopened = projects::open_project_file(OpenProjectFileRequest {
            project_file_path: opened.workspace.project_file_path.clone(),
        })
        .await
        .expect("open project file");
        assert_eq!(reopened.workspace.db_path, opened.workspace.db_path);
        let db_path = opened.workspace.db_path.clone();

        let scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: db_path.clone(),
            game_root: game_root.to_string_lossy().into_owned(),
            source_language: Some("ja".to_string()),
            disable_cjk_filter: None,
        })
        .await
        .expect("scan game");
        assert_eq!(scan.report.source_text_count, 3);

        let projects = projects::list_projects(ListProjectsRequest {
            db_path: db_path.clone(),
        })
        .await
        .expect("list projects");
        assert_eq!(projects.projects.len(), 1);

        let provider = spawn_local_provider_with_model_list_responses(vec![
            r#"{"choices":[{"message":{"content":"{\"id\":2,\"translation\":\"예\"}\n{\"id\":3,\"translation\":\"아니요\"}"}}]}"#,
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"안녕¤\"}"}}]}"#,
        ]);
        let translated = translate::translate_with_local_provider_for_test(TranslateRequest {
            db_path: db_path.clone(),
            project_id: Some(scan.report.project_id),
            source_language: "ja".to_string(),
            target_language: "ko".to_string(),
            batch_size: Some(8),
            base_url: provider.base_url.clone(),
            model: "auto".to_string(),
            system_prompt: rpg_translator_core::DEFAULT_SYSTEM_PROMPT.to_string(),
            temperature: None,
            top_p: None,
            max_output_tokens: None,
            source_text_ids: None,
            issue_filter: None,
            retranslate_mode: None,
        })
        .await
        .expect("translate");
        assert_eq!(translated.accepted_count, 3);

        let review_rows = review::review_queue(ReviewQueueRequest {
            db_path: db_path.clone(),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
            review_state: None,
            issue_filter: None,
            limit: Some(200),
            offset: Some(0),
        })
        .await
        .expect("review queue");
        assert_eq!(review_rows.rows.len(), 3);
        assert_eq!(review_rows.rows[0].review_state, "pending");
        assert_eq!(review_rows.rows[0].model.as_deref(), Some("fixture-model"));

        let accepted = review::update_review_state(UpdateReviewStateRequest {
            db_path: db_path.clone(),
            source_text_id: review_rows.rows[0].source_text_id,
            target_language: "ko".to_string(),
            translated_text: review_rows.rows[0]
                .translated_text
                .clone()
                .expect("translated text"),
            provider: review_rows.rows[0]
                .provider
                .clone()
                .expect("translation provider"),
            model: review_rows.rows[0].model.clone(),
            review_state: "accepted".to_string(),
            qa_state: "passed".to_string(),
        })
        .await
        .expect("update review state");
        assert_eq!(accepted.translation.review_state, "accepted");

        let exported = export_install::export_bundle(ExportBundleRequest {
            db_path: db_path.clone(),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
            output_dir: export_dir.to_string_lossy().into_owned(),
        })
        .await
        .expect("export bundle");
        assert_eq!(exported.included_count, 1);

        let installed = export_install::install_overlay(InstallOverlayRequest {
            db_path: db_path.clone(),
            game_root: game_root.to_string_lossy().into_owned(),
            export_dir: export_dir.to_string_lossy().into_owned(),
            project_id: Some(scan.report.project_id),
            export_id: Some(exported.export_id),
        })
        .await
        .expect("install overlay");
        assert!(
            installed
                .install_manifest_path
                .ends_with("install-manifest.json")
        );

        let diagnostics = diagnostics::diagnostics_summary(DiagnosticsRequest {
            db_path: db_path.clone(),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
        })
        .await
        .expect("diagnostics");
        assert_eq!(diagnostics.dashboard.accepted_count, 1);
        assert_eq!(diagnostics.runtime_provider_surface, "not-present");
        assert_eq!(diagnostics.integrity_check, "ok");
        assert_eq!(diagnostics.foreign_key_violations, 0);
        assert_eq!(diagnostics.journal_mode, "wal");
        assert_eq!(diagnostics.busy_timeout_ms, 10_000);
        assert_eq!(diagnostics.exportable_count, 1);
        assert!(diagnostics.latest_job.is_some());

        let rolled_back = export_install::rollback_overlay(RollbackOverlayRequest {
            db_path: db_path.clone(),
            manifest_path: installed.install_manifest_path,
            install_id: installed.install_id.expect("install id"),
        })
        .await
        .expect("rollback overlay");
        assert!(
            rolled_back
                .removed_files
                .iter()
                .any(|path| path.ends_with("RPGTranslator.js"))
        );
    });
}

#[test]
fn commands_apply_without_local_test_allowance_flag() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let game_root = temp.path().join("dontupload").join("game");
        let export_dir = temp.path().join("export");
        let original_plugins = "var $plugins = [];";
        make_direct_game(&game_root);
        write_text(&game_root.join("js/plugins.js"), original_plugins);
        make_export_bundle(&export_dir);
        {
            let mut db = TranslationDb::open(&db_path).expect("open db");
            db.migrate().expect("migrate db");
        }

        let installed = export_install::install_overlay(InstallOverlayRequest {
            db_path: path_string(&db_path),
            game_root: game_root.to_string_lossy().into_owned(),
            export_dir: export_dir.to_string_lossy().into_owned(),
            project_id: None,
            export_id: None,
        })
        .await
        .expect("install overlay");
        assert!(
            fs::read_to_string(game_root.join("js/plugins.js"))
                .expect("read installed plugins")
                .contains("\"name\": \"RPGTranslator\"")
        );

        let rolled_back = export_install::rollback_overlay(RollbackOverlayRequest {
            db_path: path_string(&db_path),
            manifest_path: installed.install_manifest_path,
            install_id: installed.install_id.expect("install id"),
        })
        .await
        .expect("rollback overlay");
        assert_eq!(
            fs::read_to_string(&rolled_back.restored_plugins_file).expect("read restored plugins"),
            original_plugins
        );
    });
}

#[test]
fn diagnostics_reports_unscanned_runtime_candidates_and_export_misses() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let game_root = temp.path().join("EnglishGame");
        let db_path = temp.path().join("workbench.sqlite");
        make_english_direct_game(&game_root);

        let scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: path_string(&game_root),
            source_language: Some("en".to_string()),
            disable_cjk_filter: Some(false),
        })
        .await
        .expect("scan english game");

        add_english_common_event(
            &game_root,
            "Do you have something you need... err... Elly? ",
        );

        let diagnostics = diagnostics::diagnostics_summary(DiagnosticsRequest {
            db_path: path_string(&db_path),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
        })
        .await
        .expect("diagnostics");

        assert_eq!(diagnostics.unscanned_runtime_candidate_count, 3);
        assert_eq!(diagnostics.unscanned_occurrence_count, 3);
        assert_eq!(diagnostics.unscanned_unique_source_count, 3);
        assert_eq!(
            diagnostics.export_missing_count,
            diagnostics.dashboard.source_text_count - diagnostics.exportable_count
        );
        assert!(diagnostics.coverage_samples.iter().any(|sample| {
            sample.category == "unscanned-static-accepted"
                && sample.file_path == "data/CommonEvents.json"
                && sample.text.contains("Do you have something you need")
        }));
        assert!(
            diagnostics
                .coverage_samples
                .iter()
                .any(|sample| sample.category == "export-missing")
        );
    });
}

#[test]
fn scanned_common_events_flow_into_review_counts_and_export() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let game_root = temp.path().join("EnglishGame");
        let db_path = temp.path().join("workbench.sqlite");
        let export_dir = temp.path().join("export");
        make_english_direct_game(&game_root);
        add_english_common_event(
            &game_root,
            "Do you have something you need... err... Elly? ",
        );

        let scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: path_string(&game_root),
            source_language: Some("en".to_string()),
            disable_cjk_filter: Some(false),
        })
        .await
        .expect("scan english game");
        assert_eq!(scan.report.source_text_count, 7);

        let mut db = TranslationDb::open(&db_path).expect("open scanned db");
        let rows = db
            .review_queue_rows(scan.report.project_id, "ko", None)
            .expect("review rows");
        let common_line = rows
            .iter()
            .find(|row| row.visible_text.contains("Do you have something you need"))
            .expect("common event line in review queue");
        assert_eq!(common_line.first_file_path, "data/CommonEvents.json");
        assert_eq!(common_line.first_json_path, "$[1].list[0]");
        assert_eq!(common_line.review_state, "missing");

        for row in rows {
            db.upsert_translation(&NewTranslation {
                source_text_id: row.source_text_id,
                target_language: "ko".to_string(),
                translated_text: format!("ko: {}", row.normalized_text),
                provider: "manual-review".to_string(),
                model: None,
                provider_run_id: None,
                review_state: "accepted".to_string(),
                qa_state: "passed".to_string(),
            })
            .expect("accept row");
        }
        let counts = db
            .review_counts(scan.report.project_id, "ko")
            .expect("review counts");
        assert_eq!(counts.exportable, 7);

        let exported = export_install::export_bundle(ExportBundleRequest {
            db_path: path_string(&db_path),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
            output_dir: path_string(&export_dir),
        })
        .await
        .expect("export bundle");
        assert_eq!(exported.included_count, 7);
        assert_eq!(exported.skipped_count, 0);
    });
}

#[test]
fn missing_project_database_requires_explicit_recreation() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let game_root = temp.path().join("game");
        make_direct_game(&game_root);

        let opened = projects::open_project(OpenProjectRequest {
            game_root: game_root.to_string_lossy().into_owned(),
        })
        .await
        .expect("open project");
        assert!(Path::new(&opened.workspace.db_path).is_file());

        fs::remove_file(&opened.workspace.db_path).expect("remove project db");
        let reopened = projects::open_project_file(OpenProjectFileRequest {
            project_file_path: opened.workspace.project_file_path.clone(),
        })
        .await
        .expect("reopen missing-db project");
        assert!(reopened.database_missing);
        assert!(reopened.project.is_none());
        assert!(!Path::new(&opened.workspace.db_path).exists());

        let hydrated = workbench::hydrate_workbench(HydrateWorkbenchRequest {
            db_path: None,
            project_file_path: Some(opened.workspace.project_file_path.clone()),
        })
        .await
        .expect("hydrate missing-db project");
        assert!(hydrated.workspace.expect("workspace").database_missing);
        assert!(hydrated.projects.is_empty());
        assert!(!Path::new(&opened.workspace.db_path).exists());

        let recreated = projects::recreate_project_database(RecreateProjectDatabaseRequest {
            project_file_path: opened.workspace.project_file_path,
        })
        .await
        .expect("recreate project database");
        assert!(!recreated.database_missing);
        assert!(recreated.project.is_some());
        assert!(Path::new(&opened.workspace.db_path).is_file());
    });
}

#[test]
fn scan_command_accepts_english_sources_without_cjk_characters() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let game_root = temp.path().join("english-game");
        make_english_direct_game(&game_root);

        let scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: game_root.to_string_lossy().into_owned(),
            source_language: Some("en".to_string()),
            disable_cjk_filter: None,
        })
        .await
        .expect("scan english game");

        assert_eq!(scan.report.source_text_count, 4);
        assert_eq!(scan.report.occurrence_count, 4);
        assert_eq!(scan.report.rejected_count, 0);
    });
}

#[test]
fn scan_command_applies_source_language_profiles() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let japanese_game_root = temp.path().join("japanese-game");
        make_direct_game(&japanese_game_root);
        let japanese_scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: japanese_game_root.to_string_lossy().into_owned(),
            source_language: Some("ja".to_string()),
            disable_cjk_filter: None,
        })
        .await
        .expect("scan japanese game as japanese");
        assert_eq!(japanese_scan.report.source_text_count, 3);

        let chinese_scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: japanese_game_root.to_string_lossy().into_owned(),
            source_language: Some("zh".to_string()),
            disable_cjk_filter: None,
        })
        .await
        .expect("scan japanese game as chinese cjk gate");
        assert_eq!(chinese_scan.report.source_text_count, 3);

        let game_root = temp.path().join("korean-game");
        make_korean_direct_game(&game_root);

        let korean_scan = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: game_root.to_string_lossy().into_owned(),
            source_language: Some("ko".to_string()),
            disable_cjk_filter: None,
        })
        .await
        .expect("scan korean game");

        assert_eq!(korean_scan.report.source_text_count, 3);
        assert_eq!(korean_scan.report.occurrence_count, 3);
        assert_eq!(korean_scan.report.rejected_count, 1);

        let korean_as_japanese = scan::scan_game_for_test(ScanGameRequest {
            db_path: path_string(&db_path),
            game_root: game_root.to_string_lossy().into_owned(),
            source_language: Some("ja".to_string()),
            disable_cjk_filter: None,
        })
        .await
        .expect("scan korean game as japanese");

        assert_eq!(korean_as_japanese.report.source_text_count, 0);
        assert_eq!(korean_as_japanese.report.rejected_count, 4);
    });
}

#[test]
fn review_queue_command_paginates_and_counts_filtered_rows() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let project_id = seed_review_project(&db_path);

        let first_page = review::review_queue(ReviewQueueRequest {
            db_path: path_string(&db_path),
            project_id,
            target_language: "ko".to_string(),
            review_state: None,
            issue_filter: None,
            limit: Some(2),
            offset: Some(0),
        })
        .await
        .expect("first review page");
        assert_eq!(first_page.rows.len(), 2);
        assert_eq!(first_page.total_count, 3);
        assert_eq!(first_page.next_offset, Some(2));
        assert_eq!(first_page.page, 1);
        assert_eq!(first_page.page_size, 2);
        assert_eq!(first_page.total_pages, 2);
        assert_eq!(first_page.range_start, 1);
        assert_eq!(first_page.range_end, 2);
        assert_eq!(first_page.rows[0].visible_text, "Alpha");
        assert_eq!(first_page.rows[1].visible_text, "Beta");

        let second_page = review::review_queue(ReviewQueueRequest {
            db_path: path_string(&db_path),
            project_id,
            target_language: "ko".to_string(),
            review_state: None,
            issue_filter: None,
            limit: Some(2),
            offset: Some(2),
        })
        .await
        .expect("second review page");
        assert_eq!(second_page.rows.len(), 1);
        assert_eq!(second_page.total_count, 3);
        assert_eq!(second_page.next_offset, None);
        assert_eq!(second_page.page, 2);
        assert_eq!(second_page.range_start, 3);
        assert_eq!(second_page.range_end, 3);
        assert_eq!(second_page.rows[0].visible_text, "Gamma");

        let accepted = review::review_queue(ReviewQueueRequest {
            db_path: path_string(&db_path),
            project_id,
            target_language: "ko".to_string(),
            review_state: Some("accepted".to_string()),
            issue_filter: None,
            limit: Some(10),
            offset: Some(0),
        })
        .await
        .expect("accepted review page");
        assert_eq!(accepted.rows.len(), 1);
        assert_eq!(accepted.total_count, 1);
        assert_eq!(accepted.next_offset, None);
        assert_eq!(accepted.rows[0].visible_text, "Beta");
    });
}

#[test]
fn scan_command_console_log_mode_defaults_on_with_explicit_opt_out() {
    assert!(scan::scan_console_logging_enabled_from(
        ["--scan-log"],
        None
    ));
    assert!(scan::scan_console_logging_enabled_from(
        Vec::<&str>::new(),
        Some("true")
    ));
    assert!(scan::scan_console_logging_enabled_from(
        Vec::<&str>::new(),
        Some("1")
    ));
    assert!(scan::scan_console_logging_enabled_from(
        Vec::<&str>::new(),
        None
    ));
    assert!(!scan::scan_console_logging_enabled_from(
        Vec::<&str>::new(),
        Some("0")
    ));
    assert!(!scan::scan_console_logging_enabled_from(
        ["--no-scan-log"],
        Some("1")
    ));
    assert!(scan::scan_console_startup_status(true).contains("console logging enabled"));
    assert!(scan::scan_console_startup_status(false).contains("Scan logs are off"));
}

#[test]
fn scan_command_formats_progress_logs_for_cmd_output() {
    let line = scan::format_scan_progress_event(&ScanProgressEvent::FileFinished {
        index: 2,
        file_path: "data/Map001.json".to_string(),
        accepted_delta: 7,
        rejected_delta: 3,
        skipped: false,
    });
    assert_eq!(
        line,
        r#"[RPG-Translator][scan] file_done index=3 path="data/Map001.json" accepted=7 rejected=3 skipped=false"#
    );

    let started = scan::format_scan_progress_event(&ScanProgressEvent::Started {
        game_root: "/mnt/c/Game".to_string(),
        source_language: "en".to_string(),
    });
    assert_eq!(
        started,
        r#"[RPG-Translator][scan] start game_root="C:\Game" source_language=en"#
    );

    let detected = scan::format_scan_progress_event(&ScanProgressEvent::Detected {
        engine: Engine::Mz,
        layout: GameLayoutKind::Direct,
        data_path: "C:/Game/data".to_string(),
    });
    assert_eq!(
        detected,
        r#"[RPG-Translator][scan] detected engine=mz layout=direct data_path="C:\Game\data""#
    );

    let persisting = scan::format_scan_progress_event(&ScanProgressEvent::Persisting {
        occurrence_count: 42,
    });
    assert_eq!(
        persisting,
        "[RPG-Translator][scan] persisting occurrences=42"
    );

    let persisted = scan::format_scan_progress_event(&ScanProgressEvent::Persisted {
        project_id: 1,
        snapshot_id: 2,
        source_text_count: 3,
        occurrence_count: 4,
        added_source_text_count: 7,
        removed_occurrence_count: 8,
        unchanged_source_text_count: 9,
        rejected_count: 5,
        skipped_count: 6,
    });
    assert_eq!(
        persisted,
        "[RPG-Translator][scan] persisted project_id=1 snapshot_id=2 source_texts=3 occurrences=4 added_sources=7 unchanged_sources=9 removed_occurrences=8 rejected=5 skipped=6"
    );
}

#[test]
fn translate_command_formats_progress_logs_for_cmd_output() {
    let mut reason_counts = BTreeMap::new();
    reason_counts.insert("provider-503".to_string(), 16);
    let line = translate::format_translate_progress_event(&TranslateProgressEvent::BatchFinished(
        TranslateProgressSnapshot {
            provider_run_id: 9,
            target_language: "ko".to_string(),
            model: Some("gemma.gguf".to_string()),
            total_batches: 1299,
            processed_batches: 12,
            total_items: 20_774,
            completed_items: 192,
            failed_items: 0,
            split_batches: 0,
            elapsed_ms: 190_000,
            eta_ms: Some(19_304_000),
            item_eta_ms: Some(19_304_000),
            batch_eta_ms: Some(20_377_000),
            last_batch_elapsed_ms: Some(1_484),
            avg_batch_elapsed_ms: Some(15_833),
            current_batch_items: 16,
            started_completed_items: 0,
            parse_failed_items: 3,
            validation_failed_items: 5,
            skipped_items: 7,
            censored_retry_count: 1,
            retry_pending_items: 16,
            recoverable_provider_failures: 16,
            final_failed_items: 0,
            provider_backoff_ms: Some(5_000),
            effective_batch_size: 8,
            next_experiment_batch_size: 8,
            input_token_budget: 6144,
            speed_mode: "backoff".to_string(),
            success_streak: 0,
            success_delay_floor_ms: 1500,
            next_delay_ms: Some(5_000),
            failure_reason_counts: reason_counts,
            adaptive_decision_reason: "adaptive: conservative from history".to_string(),
            legacy_checkpoint_only: false,
        },
    ));
    assert_eq!(
        line,
        "[RPG-Translator][translate] batch_done run=9 batch=12/1299 text=192/20774 retry_pending=16 provider_failures=16 final_failed=0 parse_failed=3 validation_failed=5 skipped=7 censored_retry=1 split=0 speed_mode=backoff success_streak=0 success_floor=00:00:01 next_delay=00:00:05 effective_batch=8 next_experiment_batch=8 token_budget=6144 backoff=00:00:05 reasons=provider-503:16 adaptive=\"adaptive: conservative from history\" current_items=16 last_batch=00:00:01 avg_batch=00:00:15 elapsed=00:03:10 eta_text=05:21:44 eta_batch=05:39:37 model=gemma.gguf target=ko"
    );

    let paused = translate::format_translate_progress_event(&TranslateProgressEvent::Paused(
        TranslateProgressSnapshot {
            provider_run_id: 9,
            target_language: "ko".to_string(),
            model: None,
            total_batches: 1299,
            processed_batches: 12,
            total_items: 20_774,
            completed_items: 192,
            failed_items: 0,
            split_batches: 0,
            elapsed_ms: 190_000,
            eta_ms: Some(19_304_000),
            item_eta_ms: Some(19_304_000),
            batch_eta_ms: Some(20_377_000),
            last_batch_elapsed_ms: None,
            avg_batch_elapsed_ms: None,
            current_batch_items: 0,
            started_completed_items: 0,
            parse_failed_items: 0,
            validation_failed_items: 0,
            skipped_items: 0,
            censored_retry_count: 0,
            retry_pending_items: 0,
            recoverable_provider_failures: 0,
            final_failed_items: 0,
            provider_backoff_ms: None,
            effective_batch_size: 16,
            next_experiment_batch_size: 16,
            input_token_budget: 4096,
            speed_mode: "steady".to_string(),
            success_streak: 3,
            success_delay_floor_ms: 1500,
            next_delay_ms: None,
            failure_reason_counts: BTreeMap::new(),
            adaptive_decision_reason: "adaptive: no speed history loaded".to_string(),
            legacy_checkpoint_only: false,
        },
    ));
    assert!(paused.contains("[RPG-Translator][translate] paused"));

    assert!(translate::translate_console_logging_enabled_from(
        Vec::<String>::new(),
        None
    ));
    assert!(!translate::translate_console_logging_enabled_from(
        vec!["--no-translate-log"],
        None
    ));
    assert!(translate::translate_console_logging_enabled_from(
        Vec::<String>::new(),
        Some("1")
    ));
}

#[test]
fn translation_job_state_accepts_pause_only_for_active_run() {
    let state = translate::TranslationJobState::default();
    let idle = translate::request_translation_pause(&state);
    assert!(!idle.requested);

    assert!(state.try_start());
    state.set_active_run_id(44);
    let active = translate::request_translation_pause(&state);
    assert!(active.requested);
    assert_eq!(active.provider_run_id, Some(44));
    assert!(state.pause_requested());
    state.finish();
}

#[test]
fn translate_pause_aborts_active_provider_request() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let mut db = TranslationDb::open(&db_path).expect("open db");
        db.migrate().expect("migrate db");
        db.upsert_source_text(&source_text_fixture("en", "Hello"))
            .expect("insert source text");
        drop(db);

        let (provider, request_started) = spawn_hanging_local_provider();
        let state = Arc::new(translate::TranslationJobState::default());
        let request = TranslateRequest {
            db_path: path_string(&db_path),
            project_id: None,
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            batch_size: Some(1),
            base_url: provider.base_url.clone(),
            model: "fixture-model".to_string(),
            system_prompt: rpg_translator_core::DEFAULT_SYSTEM_PROMPT.to_string(),
            temperature: None,
            top_p: None,
            max_output_tokens: None,
            source_text_ids: None,
            issue_filter: None,
            retranslate_mode: None,
        };
        let translate_state = state.clone();
        let handle = tauri::async_runtime::spawn(async move {
            translate::translate_with_local_provider_for_test_with_state(request, translate_state)
                .await
        });

        request_started
            .recv_timeout(Duration::from_secs(5))
            .expect("provider request started");
        let pause = translate::request_translation_pause(&state);
        assert!(pause.requested);
        assert_eq!(pause.mode, "abort-current-request");

        let started = Instant::now();
        let response = tokio::time::timeout(Duration::from_secs(3), handle)
            .await
            .expect("paused translation should return promptly")
            .expect("join translation task")
            .expect("translate returns paused response");
        assert!(started.elapsed() < Duration::from_secs(3));
        assert_eq!(response.status, "paused");
        assert_eq!(response.completed_items, 0);
        assert_eq!(response.processed_batches, 0);
    });
}

#[test]
fn local_provider_command_rejects_missing_endpoint_and_model() {
    tauri::async_runtime::block_on(async {
        let error = translate::translate_with_local_provider_for_test(TranslateRequest {
            db_path: "workbench.sqlite".to_string(),
            project_id: None,
            source_language: "ja".to_string(),
            target_language: "ko".to_string(),
            batch_size: Some(8),
            base_url: String::new(),
            model: String::new(),
            system_prompt: rpg_translator_core::DEFAULT_SYSTEM_PROMPT.to_string(),
            temperature: None,
            top_p: None,
            max_output_tokens: None,
            source_text_ids: None,
            issue_filter: None,
            retranslate_mode: None,
        })
        .await
        .expect_err("missing provider settings fail");

        assert!(error.message.contains("base_url"));
    });
}

#[test]
fn local_provider_test_command_reports_success_and_latency_without_db_writes() {
    tauri::async_runtime::block_on(async {
        let provider = spawn_local_provider_expect(
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"안녕\"}"}}]}"#,
            "Custom RPG prompt",
        );

        let response = translate::test_local_provider(ProviderTestRequest {
            base_url: provider.base_url.clone(),
            model: "fixture-model".to_string(),
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            system_prompt: "Custom RPG prompt".to_string(),
            sample_text: Some("Hello".to_string()),
        })
        .await
        .expect("provider test succeeds");

        assert!(response.ok);
        assert!(response.latency_ms < 10_000);
        assert!(response.raw_output.contains("안녕"));
        assert!(
            response
                .message
                .as_deref()
                .unwrap_or_default()
                .contains("responded")
        );
    });
}

#[test]
fn provider_benchmark_uses_real_prompt_and_does_not_write_translation_state() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let (project_id, source_id) = {
            let mut db = TranslationDb::open(&db_path).expect("open db");
            db.migrate().expect("migrate db");
            let project_id = db
                .upsert_project(&NewProject {
                    game_root: path_string(temp.path()),
                    display_name: "Benchmark Fixture".to_string(),
                    engine: Engine::Mz,
                })
                .expect("upsert project");
            let source_id = db
                .upsert_source_text(&source_text_fixture("en", "Hello there."))
                .expect("upsert source");
            db.insert_occurrence(&NewOccurrence {
                project_id: Some(project_id),
                source_text_id: source_id,
                file_path: "data/Map001.json".to_string(),
                json_path: "$.events[1].pages[0].list[0].parameters[0]".to_string(),
                entity_type: "event_command".to_string(),
                event_id: Some(1),
                page_index: Some(0),
                command_index: Some(0),
                command_code: Some(401),
                parameter_index: Some(0),
                object_key: None,
                extraction_rule_id: "test".to_string(),
            })
            .expect("insert occurrence");
            (project_id, source_id)
        };
        let provider = spawn_local_provider_expect_repeated(
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"안녕\"}"}}]}"#,
            "Custom RPG prompt",
            6,
        );

        let report =
            translate::benchmark_provider_translation_speed(ProviderSpeedBenchmarkRequest {
                db_path: path_string(&db_path),
                project_id: Some(project_id),
                source_language: "en".to_string(),
                target_language: "ko".to_string(),
                batch_size: Some(1),
                base_url: provider.base_url.clone(),
                model: "fixture-model".to_string(),
                system_prompt: "Custom RPG prompt".to_string(),
                temperature: None,
                top_p: None,
                max_output_tokens: None,
                warmup_runs: Some(1),
                measured_runs: Some(5),
            })
            .await
            .expect("benchmark succeeds");

        assert_eq!(report.runs.len(), 5);
        assert_eq!(report.resolved_model.as_deref(), Some("fixture-model"));
        assert!(report.warmup_ms.is_some());
        assert!(report.average_ms.is_some());
        assert!(report.estimated_paced_items_per_minute.is_some());

        let db = TranslationDb::open(&db_path).expect("reopen db");
        assert!(
            db.get_translation(source_id, "ko")
                .expect("translation lookup")
                .is_none()
        );
        assert!(
            db.latest_translation_job_summary(Some("ko"))
                .expect("job lookup")
                .is_none()
        );
        let prompt_hash = translation_prompt_hash("en", "ko", "Custom RPG prompt");
        let samples = db
            .recent_translation_speed_samples(Some("fixture-model"), Some(&prompt_hash), 10)
            .expect("benchmark speed samples");
        assert_eq!(
            samples.len(),
            5,
            "only measured benchmark runs should seed adaptive speed history"
        );
        assert!(samples.iter().all(|sample| sample.status == "benchmark"));
        assert!(samples.iter().all(|sample| sample.lane == "benchmark"));
        assert!(samples.iter().all(|sample| sample.provider_run_id > 0));
        assert!(samples.iter().all(|sample| sample.item_count == 1));
        assert!(samples.iter().all(|sample| {
            sample
                .adaptive_decision_reason
                .contains("real prompt benchmark")
        }));
    });
}

#[test]
fn translate_command_uses_speed_samples_for_initial_adaptive_settings() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let prompt = "Custom RPG prompt";
        {
            let mut db = TranslationDb::open(&db_path).expect("open db");
            db.migrate().expect("migrate db");
            db.upsert_source_text(&source_text_fixture("en", "Alpha"))
                .expect("insert alpha");
            db.upsert_source_text(&source_text_fixture("en", "Beta"))
                .expect("insert beta");
            let provider_run_id = db
                .start_provider_run(&rpg_translator_core::NewProviderRun {
                    provider: "local-openai-compatible".to_string(),
                    model: Some("fixture-model".to_string()),
                    request_settings_json: "{}".to_string(),
                })
                .expect("start provider run");
            let prompt_hash = translation_prompt_hash("en", "ko", prompt);
            for batch_index in 1..=3 {
                db.insert_translation_speed_sample(&NewTranslationSpeedSample {
                    provider_run_id,
                    batch_index,
                    lane: "plain_block".to_string(),
                    item_count: 16,
                    char_count: 640,
                    estimated_token_count: 160,
                    request_elapsed_ms: 2_000,
                    success_delay_ms: 750,
                    total_elapsed_ms: 2_750,
                    status: "success".to_string(),
                    failure_type: None,
                    effective_batch_size: 16,
                    adaptive_decision_reason: "adaptive: fixture".to_string(),
                    model: Some("fixture-model".to_string()),
                    prompt_hash: prompt_hash.clone(),
                })
                .expect("insert speed sample");
            }
        }
        let provider = spawn_local_provider_expect(
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"알파\"}\n{\"id\":2,\"translation\":\"베타\"}"}}]}"#,
            "from English to Korean",
        );

        let response = translate::translate_with_local_provider_for_test(TranslateRequest {
            db_path: path_string(&db_path),
            project_id: None,
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            batch_size: Some(4),
            base_url: provider.base_url.clone(),
            model: "fixture-model".to_string(),
            system_prompt: prompt.to_string(),
            temperature: None,
            top_p: None,
            max_output_tokens: None,
            source_text_ids: None,
            issue_filter: None,
            retranslate_mode: None,
        })
        .await
        .expect("translate with adaptive speed samples");

        assert_eq!(response.accepted_count, 2);
        assert_eq!(response.effective_batch_size, 32);
        assert!(response.adaptive_decision_reason.contains("accelerating"));
    });
}

#[test]
fn local_provider_test_command_resolves_auto_model() {
    tauri::async_runtime::block_on(async {
        let provider = spawn_local_provider_with_model_list(
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"안녕\"}"}}]}"#,
        );

        let response = translate::test_local_provider(ProviderTestRequest {
            base_url: provider.base_url.clone(),
            model: "auto".to_string(),
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            system_prompt: rpg_translator_core::DEFAULT_SYSTEM_PROMPT.to_string(),
            sample_text: Some("Hello".to_string()),
        })
        .await
        .expect("provider test resolves auto model");

        assert!(response.ok);
        assert!(response.raw_output.contains("안녕"));
    });
}

#[test]
fn local_provider_commands_allow_empty_and_custom_prompts() {
    tauri::async_runtime::block_on(async {
        let empty_prompt_provider = spawn_local_provider_expect(
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"안녕\"}"}}]}"#,
            "Return JSON Lines only",
        );
        let empty = translate::test_local_provider(ProviderTestRequest {
            base_url: empty_prompt_provider.base_url.clone(),
            model: "fixture-model".to_string(),
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            system_prompt: String::new(),
            sample_text: None,
        })
        .await
        .expect("empty prompt uses rust default prompt");
        assert!(empty.ok);

        let custom_provider = spawn_local_provider_expect(
            r#"{"choices":[{"message":{"content":"{\"id\":1,\"translation\":\"안녕\"}"}}]}"#,
            "Custom RPG prompt",
        );
        let custom = translate::test_local_provider(ProviderTestRequest {
            base_url: custom_provider.base_url.clone(),
            model: "fixture-model".to_string(),
            source_language: "en".to_string(),
            target_language: "ko".to_string(),
            system_prompt: "Custom RPG prompt".to_string(),
            sample_text: None,
        })
        .await
        .expect("custom prompt succeeds");
        assert!(custom.ok);
    });
}

#[test]
fn command_errors_are_serializable() {
    tauri::async_runtime::block_on(async {
        let error = projects::list_projects(ListProjectsRequest {
            db_path: String::new(),
        })
        .await
        .expect_err("empty db path fails");

        let encoded = serde_json::to_value(error).expect("serialize command error");
        assert!(
            encoded["message"]
                .as_str()
                .expect("message")
                .contains("db_path")
        );
    });
}

struct ProviderServer {
    base_url: String,
    handle: Option<thread::JoinHandle<()>>,
}

impl Drop for ProviderServer {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            if thread::panicking() {
                let _ = handle.join();
            } else {
                handle.join().expect("provider server thread");
            }
        }
    }
}

fn spawn_local_provider_with_model_list(response_body: &'static str) -> ProviderServer {
    spawn_local_provider_with_model_list_responses(vec![response_body])
}

fn spawn_local_provider_with_model_list_responses(
    response_bodies: Vec<&'static str>,
) -> ProviderServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind provider server");
    let address = listener.local_addr().expect("provider server address");
    let handle = thread::spawn(move || {
        let (mut model_stream, _) = listener.accept().expect("accept model request");
        let mut model_request = [0_u8; 8192];
        let model_read = model_stream
            .read(&mut model_request)
            .expect("read model request");
        let model_request_text = String::from_utf8_lossy(&model_request[..model_read]);
        assert!(model_request_text.contains("GET /v1/models"));
        let model_body = r#"{"data":[{"id":"fixture-model"}]}"#;
        let model_response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
            model_body.len(),
            model_body
        );
        model_stream
            .write_all(model_response.as_bytes())
            .expect("write model response");
        drop(model_stream);

        listener
            .set_nonblocking(true)
            .expect("set nonblocking provider listener");
        for response_body in response_bodies {
            let started = Instant::now();
            let (mut chat_stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            started.elapsed() < Duration::from_secs(5),
                            "timed out waiting for provider request"
                        );
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("accept provider request: {error}"),
                }
            };
            let mut chat_request = [0_u8; 8192];
            let chat_read = chat_stream
                .read(&mut chat_request)
                .expect("read provider request");
            let chat_request_text = String::from_utf8_lossy(&chat_request[..chat_read]);
            assert!(chat_request_text.contains("POST /v1/chat/completions"));
            assert!(chat_request_text.contains("fixture-model"));
            assert!(!chat_request_text.contains("\"model\":\"auto\""));
            let chat_response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            chat_stream
                .write_all(chat_response.as_bytes())
                .expect("write response");
        }
    });

    ProviderServer {
        base_url: format!("http://{address}"),
        handle: Some(handle),
    }
}

fn spawn_local_provider_expect(
    response_body: &'static str,
    expected_request_snippet: &'static str,
) -> ProviderServer {
    spawn_local_provider_with_expected_request(response_body, Some(expected_request_snippet))
}

fn spawn_local_provider_expect_repeated(
    response_body: &'static str,
    expected_request_snippet: &'static str,
    request_count: usize,
) -> ProviderServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind provider server");
    let address = listener.local_addr().expect("provider server address");
    let handle = thread::spawn(move || {
        for _ in 0..request_count {
            let (mut stream, _) = listener.accept().expect("accept provider request");
            let mut request = [0_u8; 8192];
            let read = stream.read(&mut request).expect("read provider request");
            let request_text = String::from_utf8_lossy(&request[..read]);
            assert!(request_text.contains("POST /v1/chat/completions"));
            assert!(request_text.contains("fixture-model"));
            assert!(request_text.contains(expected_request_snippet));
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        }
    });

    ProviderServer {
        base_url: format!("http://{address}"),
        handle: Some(handle),
    }
}

fn spawn_local_provider_with_expected_request(
    response_body: &'static str,
    expected_request_snippet: Option<&'static str>,
) -> ProviderServer {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind provider server");
    let address = listener.local_addr().expect("provider server address");
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept provider request");
        let mut request = [0_u8; 8192];
        let read = stream.read(&mut request).expect("read provider request");
        let request_text = String::from_utf8_lossy(&request[..read]);
        assert!(request_text.contains("POST /v1/chat/completions"));
        assert!(request_text.contains("fixture-model"));
        if let Some(expected) = expected_request_snippet {
            assert!(request_text.contains(expected));
        }
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    });

    ProviderServer {
        base_url: format!("http://{address}"),
        handle: Some(handle),
    }
}

fn spawn_hanging_local_provider() -> (ProviderServer, mpsc::Receiver<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind hanging provider server");
    let address = listener.local_addr().expect("provider server address");
    let (started_tx, started_rx) = mpsc::channel();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept hanging provider request");
        let mut request = [0_u8; 8192];
        let read = stream
            .read(&mut request)
            .expect("read hanging provider request");
        let request_text = String::from_utf8_lossy(&request[..read]);
        assert!(request_text.contains("POST /v1/chat/completions"));
        assert!(request_text.contains("fixture-model"));
        started_tx.send(()).expect("signal request start");
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .expect("set provider read timeout");
        let mut closed_probe = [0_u8; 1];
        let _ = stream.read(&mut closed_probe);
    });

    (
        ProviderServer {
            base_url: format!("http://{address}"),
            handle: Some(handle),
        },
        started_rx,
    )
}
