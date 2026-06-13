use std::{collections::HashSet, fs, path::PathBuf};

use serde::{Deserialize, Serialize};

use rpg_translator_core::{
    CheckpointWriter, GameScanner, NewOccurrence, NewSourceText, ScanOptions, TextCodec,
    TranslationJobSummary, WorkbenchDashboardSummary,
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
    pub runtime_candidate_count: i64,
    pub runtime_imported_translatable_count: i64,
    pub unsupported_image_text_count: i64,
    pub layout_overflow_count: i64,
    pub stale_render_count: i64,
    pub ownership_conflict_count: i64,
    pub replay_failure_count: i64,
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
        let mut db = open_db_existing(&request.db_path)?;
        let runtime_import = import_runtime_misses(&mut db, request.project_id)?;
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
            runtime_candidate_count: runtime_import.runtime_candidate_count,
            runtime_imported_translatable_count: runtime_import.runtime_imported_translatable_count,
            unsupported_image_text_count: runtime_import.unsupported_image_text_count,
            layout_overflow_count: runtime_import.layout_overflow_count,
            stale_render_count: runtime_import.stale_render_count,
            ownership_conflict_count: runtime_import.ownership_conflict_count,
            replay_failure_count: runtime_import.replay_failure_count,
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

#[derive(Debug, Clone, Copy, Default)]
struct RuntimeMissImportSummary {
    runtime_candidate_count: i64,
    runtime_imported_translatable_count: i64,
    unsupported_image_text_count: i64,
    layout_overflow_count: i64,
    stale_render_count: i64,
    ownership_conflict_count: i64,
    replay_failure_count: i64,
}

fn import_runtime_misses(
    db: &mut rpg_translator_core::TranslationDb,
    project_id: i64,
) -> rpg_translator_core::Result<RuntimeMissImportSummary> {
    let Some(project) = db.get_project(project_id)? else {
        return Ok(RuntimeMissImportSummary::default());
    };
    let settings = db.load_workbench_settings()?;
    let entries = runtime_miss_entries(&project.game_root);
    let mut summary = RuntimeMissImportSummary::default();
    let mut seen_cache_keys = HashSet::new();
    for entry in entries {
        let category = json_string(&entry, "category");
        let reason = json_string(&entry, "reason");
        if category == "unsupported-image-text" || reason == "unsupported-image-text" {
            summary.unsupported_image_text_count += 1;
            continue;
        }
        if is_layout_overflow_reason(&reason) {
            summary.layout_overflow_count += 1;
            continue;
        }
        if is_stale_render_reason(&reason) {
            summary.stale_render_count += 1;
            continue;
        }
        if is_ownership_conflict_reason(&reason) {
            summary.ownership_conflict_count += 1;
            continue;
        }
        if is_replay_failure_reason(&reason) {
            summary.replay_failure_count += 1;
            continue;
        }
        if !is_runtime_candidate_reason(&category, &reason) {
            continue;
        }
        let text = json_string(&entry, "text");
        if !is_display_safe_runtime_candidate(&text) {
            continue;
        }
        let cache_key = json_string(&entry, "cache_key");
        let unique_key = if cache_key.is_empty() {
            text.clone()
        } else {
            cache_key.clone()
        };
        if !seen_cache_keys.insert(unique_key.clone()) {
            continue;
        }
        summary.runtime_candidate_count += 1;
        let source_language = json_string(&entry, "source_language");
        let source_language = if source_language.trim().is_empty() {
            settings.source_language.clone()
        } else {
            source_language
        };
        let analysis = TextCodec::analyze(&text);
        let provider_state = TextCodec::encode_for_provider(&analysis.normalized_text);
        let source_text = NewSourceText {
            source_language,
            unit_kind: "runtime_candidate".to_string(),
            normalized_hash: String::new(),
            normalized_text: analysis.normalized_text.clone(),
            visible_text: analysis.visible_text.trim().to_string(),
            codec_text: provider_state.provider_text,
            control_code_signature: analysis.control_code_signature,
            line_count: analysis.normalized_text.matches('\n').count() as i64 + 1,
            newline_count: analysis.normalized_text.matches('\n').count() as i64,
            placeholder_count: provider_state.control_codes.len() as i64,
        };
        let occurrence = NewOccurrence {
            project_id: Some(project_id),
            source_text_id: 0,
            file_path: "rpg-translator/logs/runtime-misses.jsonl".to_string(),
            json_path: runtime_miss_json_path(&cache_key, &text),
            entity_type: "runtime.visible_text".to_string(),
            event_id: json_i64(&entry, "eventId"),
            page_index: None,
            command_index: None,
            command_code: None,
            parameter_index: None,
            object_key: Some(first_non_empty_string(&[
                json_string(&entry, "adapter"),
                json_string(&entry, "methodName"),
                "runtime".to_string(),
            ])),
            extraction_rule_id: "runtime.cache-miss".to_string(),
        };
        db.upsert_runtime_candidate_occurrence(project_id, &source_text, &occurrence)?;
        summary.runtime_imported_translatable_count += 1;
    }
    Ok(summary)
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

    for sample in runtime_miss_samples(&project.game_root) {
        if samples.len() >= 12 {
            break;
        }
        samples.push(sample);
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
    runtime_miss_entries(game_root)
        .into_iter()
        .rev()
        .filter(|value| {
            let category = json_string(value, "category");
            let reason = json_string(value, "reason");
            is_runtime_candidate_reason(&category, &reason)
        })
        .take(4)
        .map(|value| CoverageAuditSample {
            category: "runtime-cache-miss".to_string(),
            text: json_string(&value, "text"),
            file_path: json_string(&value, "adapter"),
            json_path: json_string(&value, "slotKey"),
            reason: Some(first_non_empty_string(&[
                json_string(&value, "reason"),
                json_string(&value, "cache_key"),
            ])),
        })
        .collect()
}

fn runtime_miss_entries(game_root: &str) -> Vec<serde_json::Value> {
    let log_path = PathBuf::from(game_root)
        .join("rpg-translator")
        .join("logs")
        .join("runtime-misses.jsonl");
    let Ok(content) = fs::read_to_string(log_path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .collect()
}

fn is_display_safe_runtime_candidate(text: &str) -> bool {
    let value = text.trim();
    !value.is_empty()
        && value.len() <= 512
        && value.chars().any(|ch| ch.is_alphabetic())
        && !value.starts_with("data:image/")
}

fn is_runtime_candidate_reason(category: &str, reason: &str) -> bool {
    let category = category.trim();
    let reason = reason.trim();
    (category.is_empty() && reason.is_empty())
        || category == "runtime-cache-miss"
        || reason == "cache-miss"
        || reason == "runtime-cache-miss"
}

fn is_layout_overflow_reason(reason: &str) -> bool {
    matches!(
        reason.trim(),
        "layout-overflow" | "layout_overflow" | "overflow"
    )
}

fn is_stale_render_reason(reason: &str) -> bool {
    let value = reason.trim();
    value == "stale-render" || value == "render-stale" || value.ends_with("-stale")
}

fn is_ownership_conflict_reason(reason: &str) -> bool {
    matches!(
        reason.trim(),
        "ownership-conflict"
            | "ownership_conflict"
            | "surface-owned"
            | "message-glyph-source"
            | "duplicate-owner"
    )
}

fn is_replay_failure_reason(reason: &str) -> bool {
    matches!(
        reason.trim(),
        "replay-failure"
            | "replay_failed"
            | "replay-failed"
            | "snapshot-restore-failed"
            | "background-replay-failed"
    )
}

fn runtime_miss_json_path(cache_key: &str, text: &str) -> String {
    let key = if cache_key.trim().is_empty() {
        text.chars().take(48).collect::<String>()
    } else {
        cache_key.to_string()
    };
    let encoded = serde_json::to_string(&key).unwrap_or_else(|_| "\"runtime\"".to_string());
    format!("$.runtime_misses[{encoded}]")
}

fn json_string(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string()
}

fn json_i64(value: &serde_json::Value, key: &str) -> Option<i64> {
    value.get(key).and_then(|value| value.as_i64())
}

fn first_non_empty_string(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}
