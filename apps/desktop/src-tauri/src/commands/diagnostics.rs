use std::{collections::HashSet, fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use rpg_translator_core::{
    CheckpointWriter, GameScanner, ScanOptions, TranslationJobSummary, WorkbenchDashboardSummary,
};

use super::shared::{CommandResult, open_db_existing, run_blocking};
use super::translate::translation_checkpoint_path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticsRequest {
    pub db_path: String,
    pub project_id: i64,
    pub target_language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiagnosticsResponse {
    pub dashboard: WorkbenchDashboardSummary,
    pub runtime_provider_surface: String,
    pub runtime_ui_surface: String,
    pub integrity_check: String,
    pub foreign_key_violations: i64,
    pub journal_mode: String,
    pub busy_timeout_ms: i64,
    pub stale_running_provider_runs: i64,
    pub checkpoint_completed_count: usize,
    pub checkpoint_failed_count: usize,
    pub exportable_count: i64,
    pub unscanned_runtime_candidate_count: i64,
    pub unscanned_unique_source_count: i64,
    pub unscanned_occurrence_count: i64,
    pub export_missing_count: i64,
    pub unsupported_string_candidate_count: i64,
    pub coverage_samples: Vec<CoverageAuditSample>,
    pub latest_job: Option<TranslationJobSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CoverageAuditSample {
    pub category: String,
    pub text: String,
    pub file_path: String,
    pub json_path: String,
    pub reason: Option<String>,
}

#[tauri::command]
pub async fn diagnostics_summary(
    request: DiagnosticsRequest,
) -> CommandResult<DiagnosticsResponse> {
    run_blocking(move || {
        let db = open_db_existing(&request.db_path)?;
        let dashboard =
            db.workbench_dashboard_summary(request.project_id, &request.target_language)?;
        let review_counts = db.review_counts(request.project_id, &request.target_language)?;
        let coverage = coverage_audit_summary(
            &db,
            request.project_id,
            &request.target_language,
            &dashboard,
            review_counts.exportable,
        )?;
        let checkpoint_path =
            translation_checkpoint_path(&request.db_path, &request.target_language);
        let checkpoint = CheckpointWriter::read(&checkpoint_path)?;
        let (checkpoint_completed_count, checkpoint_failed_count) = checkpoint
            .map(|checkpoint| {
                (
                    checkpoint.completed_source_text_ids.len(),
                    checkpoint.failed_source_text_ids.len(),
                )
            })
            .unwrap_or((0, 0));
        Ok(DiagnosticsResponse {
            dashboard,
            runtime_provider_surface: "not-present".to_string(),
            runtime_ui_surface: "startup-toast-only".to_string(),
            integrity_check: db.pragma_string("integrity_check")?,
            foreign_key_violations: db.foreign_key_violation_count()?,
            journal_mode: db.pragma_string("journal_mode")?,
            busy_timeout_ms: db.pragma_i64("busy_timeout")?,
            stale_running_provider_runs: db.count_running_provider_runs()?,
            checkpoint_completed_count,
            checkpoint_failed_count,
            exportable_count: review_counts.exportable,
            unscanned_runtime_candidate_count: coverage.unscanned_runtime_candidate_count,
            unscanned_unique_source_count: coverage.unscanned_unique_source_count,
            unscanned_occurrence_count: coverage.unscanned_occurrence_count,
            export_missing_count: coverage.export_missing_count,
            unsupported_string_candidate_count: coverage.unsupported_string_candidate_count,
            coverage_samples: coverage.samples,
            latest_job: db.latest_translation_job_summary(Some(&request.target_language))?,
        })
    })
    .await
}

struct CoverageAuditSummary {
    unscanned_runtime_candidate_count: i64,
    unscanned_unique_source_count: i64,
    unscanned_occurrence_count: i64,
    export_missing_count: i64,
    unsupported_string_candidate_count: i64,
    samples: Vec<CoverageAuditSample>,
}

fn coverage_audit_summary(
    db: &rpg_translator_core::TranslationDb,
    project_id: i64,
    target_language: &str,
    dashboard: &WorkbenchDashboardSummary,
    exportable_count: i64,
) -> rpg_translator_core::Result<CoverageAuditSummary> {
    let settings = db.load_workbench_settings()?;
    let source_language = settings.source_language;
    let export_missing_count = dashboard.source_text_count.saturating_sub(exportable_count);
    let Some(project) = db.get_project(project_id)? else {
        return Ok(CoverageAuditSummary {
            unscanned_runtime_candidate_count: 0,
            unscanned_unique_source_count: 0,
            unscanned_occurrence_count: 0,
            export_missing_count,
            unsupported_string_candidate_count: 0,
            samples: Vec::new(),
        });
    };

    let known_keys = db
        .benchmark_source_texts(Some(project_id), &source_language, usize::MAX)?
        .into_iter()
        .map(|record| {
            (
                record.source_language,
                record.normalized_text,
                record.control_code_signature,
            )
        })
        .collect::<HashSet<_>>();
    let scan = GameScanner::scan(
        &project.game_root,
        ScanOptions {
            source_language: source_language.clone(),
            disable_cjk_filter: false,
        },
    )?;
    let mut unscanned_runtime_candidate_count = 0i64;
    let mut unscanned_source_keys = HashSet::new();
    let mut unsupported_string_candidate_count = 0i64;
    let mut samples = Vec::new();

    for item in &scan.accepted {
        let key = (
            item.source_text.source_language.clone(),
            item.source_text.normalized_text.clone(),
            item.source_text.control_code_signature.clone(),
        );
        if known_keys.contains(&key) {
            continue;
        }
        unscanned_runtime_candidate_count += 1;
        unscanned_source_keys.insert(key);
        if samples.len() < 8 {
            samples.push(CoverageAuditSample {
                category: "unscanned-static-accepted".to_string(),
                text: item.raw_text.clone(),
                file_path: item.context.file_path.clone(),
                json_path: item.context.json_path.clone(),
                reason: None,
            });
        }
    }

    if export_missing_count > 0 {
        let (rows, _) = db.review_queue_page(project_id, target_language, None, None, 16, 0)?;
        for row in rows {
            if matches!(row.review_state.as_str(), "accepted" | "reviewed") {
                continue;
            }
            if samples.len() >= 12 {
                break;
            }
            samples.push(CoverageAuditSample {
                category: "export-missing".to_string(),
                text: row.visible_text,
                file_path: row.first_file_path,
                json_path: row.first_json_path,
                reason: Some(row.review_state),
            });
        }
    }

    for sample in runtime_miss_samples(&project.game_root) {
        if samples.len() >= 12 {
            break;
        }
        samples.push(sample);
    }

    for item in &scan.rejected {
        if item.raw_text.trim().is_empty() {
            continue;
        }
        unsupported_string_candidate_count += 1;
        if samples.len() < 12 {
            samples.push(CoverageAuditSample {
                category: "unsupported-string-candidate".to_string(),
                text: item.raw_text.clone(),
                file_path: item.context.file_path.clone(),
                json_path: item.context.json_path.clone(),
                reason: Some(item.reason.clone()),
            });
        }
    }

    Ok(CoverageAuditSummary {
        unscanned_runtime_candidate_count,
        unscanned_unique_source_count: unscanned_source_keys.len() as i64,
        unscanned_occurrence_count: unscanned_runtime_candidate_count,
        export_missing_count,
        unsupported_string_candidate_count,
        samples,
    })
}

fn runtime_miss_samples(game_root: &str) -> Vec<CoverageAuditSample> {
    let log_path = PathBuf::from(game_root)
        .join("rpg-translator")
        .join("logs")
        .join("runtime-misses.jsonl");
    let Ok(content) = fs::read_to_string(log_path) else {
        return Vec::new();
    };
    content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .take(4)
        .map(|value| CoverageAuditSample {
            category: "runtime-cache-miss".to_string(),
            text: value
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or_default()
                .to_string(),
            file_path: String::new(),
            json_path: String::new(),
            reason: value
                .get("cache_key")
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
        })
        .collect()
}
