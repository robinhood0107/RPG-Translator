use std::fs;
use std::path::Path;

use rpg_translator_desktop::commands::{
    diagnostics::{self, DiagnosticsRequest},
    export_install::{self, ExportBundleRequest, InstallOverlayRequest, RollbackOverlayRequest},
    projects::{self, ListProjectsRequest, OpenProjectRequest},
    review::{self, ReviewQueueRequest, UpdateReviewStateRequest},
    scan::{self, ScanGameRequest},
    translate::{self, TranslateRequest},
};
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent directory");
    }
    fs::write(path, text).expect("write fixture file");
}

fn write_json(path: &Path, text: &str) {
    write_text(path, text);
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

#[test]
fn commands_run_synthetic_workbench_flow() {
    tauri::async_runtime::block_on(async {
        let temp = tempdir().expect("create temp dir");
        let db_path = temp.path().join("workbench.sqlite");
        let game_root = temp.path().join("game");
        let export_dir = temp.path().join("export");
        make_direct_game(&game_root);

        let opened = projects::open_project(OpenProjectRequest {
            db_path: db_path.to_string_lossy().into_owned(),
            game_root: game_root.to_string_lossy().into_owned(),
        })
        .await
        .expect("open project");
        assert_eq!(opened.project.display_name, "game");
        assert_eq!(opened.project.engine, "mz");

        let scan = scan::scan_game(ScanGameRequest {
            db_path: db_path.to_string_lossy().into_owned(),
            game_root: game_root.to_string_lossy().into_owned(),
            source_language: Some("ja".to_string()),
        })
        .await
        .expect("scan game");
        assert_eq!(scan.report.source_text_count, 3);

        let projects = projects::list_projects(ListProjectsRequest {
            db_path: db_path.to_string_lossy().into_owned(),
        })
        .await
        .expect("list projects");
        assert_eq!(projects.projects.len(), 1);

        let translated = translate::translate_with_fake_provider(TranslateRequest {
            db_path: db_path.to_string_lossy().into_owned(),
            target_language: "ko".to_string(),
            batch_size: Some(8),
        })
        .await
        .expect("translate");
        assert_eq!(translated.accepted_count, 3);

        let review_rows = review::review_queue(ReviewQueueRequest {
            db_path: db_path.to_string_lossy().into_owned(),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
            review_state: None,
        })
        .await
        .expect("review queue");
        assert_eq!(review_rows.rows.len(), 3);
        assert_eq!(review_rows.rows[0].review_state, "pending");

        let accepted = review::update_review_state(UpdateReviewStateRequest {
            db_path: db_path.to_string_lossy().into_owned(),
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
            db_path: db_path.to_string_lossy().into_owned(),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
            output_dir: export_dir.to_string_lossy().into_owned(),
        })
        .await
        .expect("export bundle");
        assert_eq!(exported.included_count, 1);

        let installed = export_install::install_overlay(InstallOverlayRequest {
            db_path: db_path.to_string_lossy().into_owned(),
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
            db_path: db_path.to_string_lossy().into_owned(),
            project_id: scan.report.project_id,
            target_language: "ko".to_string(),
        })
        .await
        .expect("diagnostics");
        assert_eq!(diagnostics.dashboard.accepted_count, 1);
        assert_eq!(diagnostics.runtime_provider_surface, "not-present");

        let rolled_back = export_install::rollback_overlay(RollbackOverlayRequest {
            db_path: db_path.to_string_lossy().into_owned(),
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
