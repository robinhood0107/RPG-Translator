use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use rpg_translator_core::{
    CheckpointWriter, ProjectRecord, ProjectWorkspace, ReviewCounts, TranslationJobProgressUpdate,
    TranslationJobSummary, WorkbenchDashboardSummary, WorkbenchSettingsRecord,
    WorkbenchSettingsUpdate,
};

use super::shared::{
    CommandResult, ProjectSummary, ProjectWorkspaceSummary, normalize_windows_user_path,
    open_db_migrating, run_blocking, write_gate,
};
use super::translate::translation_checkpoint_path;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HydrateWorkbenchRequest {
    #[serde(default)]
    pub db_path: Option<String>,
    #[serde(default)]
    pub project_file_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointSummary {
    pub path: String,
    pub exists: bool,
    pub provider_run_id: Option<i64>,
    pub target_language: String,
    pub completed_count: usize,
    pub failed_count: usize,
    pub failure_type_counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HydrateWorkbenchResponse {
    pub workspace: Option<ProjectWorkspaceSummary>,
    pub projects: Vec<ProjectSummary>,
    pub selected_project_id: Option<i64>,
    pub settings: WorkbenchSettingsRecord,
    pub dashboard: Option<WorkbenchDashboardSummary>,
    pub review_counts: Option<ReviewCounts>,
    pub checkpoint: Option<CheckpointSummary>,
    pub latest_job: Option<TranslationJobSummary>,
    pub stale_runs_interrupted: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveWorkbenchSettingsRequest {
    pub db_path: String,
    pub selected_project_id: Option<Option<i64>>,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub provider_base_url: Option<String>,
    pub provider_model: Option<String>,
    pub system_prompt: Option<String>,
    pub export_dir: Option<String>,
    pub active_tab: Option<String>,
    pub show_hover_help: Option<bool>,
    pub ui_font_size: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveWorkbenchSettingsResponse {
    pub settings: WorkbenchSettingsRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewDraftInput {
    pub source_text_id: i64,
    pub target_language: String,
    pub draft_text: String,
    pub base_translation_updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveWorkbenchStateRequest {
    pub db_path: String,
    pub selected_project_id: Option<Option<i64>>,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub provider_base_url: Option<String>,
    pub provider_model: Option<String>,
    pub system_prompt: Option<String>,
    pub export_dir: Option<String>,
    pub active_tab: Option<String>,
    pub show_hover_help: Option<bool>,
    pub ui_font_size: Option<String>,
    #[serde(default)]
    pub review_drafts: Vec<ReviewDraftInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SaveWorkbenchStateResponse {
    pub settings: WorkbenchSettingsRecord,
    pub saved_drafts: usize,
    pub saved_at: String,
}

#[tauri::command]
pub async fn hydrate_workbench(
    request: HydrateWorkbenchRequest,
) -> CommandResult<HydrateWorkbenchResponse> {
    run_blocking(move || {
        let workspace = request
            .project_file_path
            .as_deref()
            .map(normalize_windows_user_path)
            .map(ProjectWorkspace::open_project_file)
            .transpose()?;
        let db_path = workspace
            .as_ref()
            .map(|workspace| workspace.database_path.to_string_lossy().into_owned())
            .or_else(|| {
                request
                    .db_path
                    .map(|path| normalize_windows_user_path(&path))
            })
            .ok_or_else(|| {
                rpg_translator_core::Error::invalid_input(
                    "project_file_path or db_path is required",
                )
            })?;
        if let Some(workspace) = workspace
            .as_ref()
            .filter(|workspace| workspace.database_missing)
        {
            return Ok(HydrateWorkbenchResponse {
                workspace: Some(workspace.clone().into()),
                projects: Vec::new(),
                selected_project_id: None,
                settings: WorkbenchSettingsRecord {
                    selected_project_id: None,
                    source_language: "ja".to_string(),
                    target_language: "ko".to_string(),
                    provider_base_url: String::new(),
                    provider_model: "auto".to_string(),
                    system_prompt: String::new(),
                    export_dir: normalize_windows_user_path(
                        &workspace.exports_path.to_string_lossy(),
                    ),
                    active_tab: "scan".to_string(),
                    show_hover_help: true,
                    ui_font_size: "medium".to_string(),
                },
                dashboard: None,
                review_counts: None,
                checkpoint: None,
                latest_job: None,
                stale_runs_interrupted: 0,
            });
        }
        let _gate = write_gate()?;
        let mut db = open_db_migrating(&db_path)?;
        let stale_runs_interrupted =
            db.interrupt_stale_provider_runs()? + db.interrupt_stale_translation_jobs()?;
        let projects = db.list_projects()?;
        let settings = db.load_workbench_settings()?;
        let selected_project = selected_project(&projects, settings.selected_project_id);
        let selected_project_id = selected_project.as_ref().map(|project| project.id);
        let target_language = settings.target_language.clone();
        let dashboard = selected_project_id
            .map(|project_id| db.workbench_dashboard_summary(project_id, &target_language))
            .transpose()?;
        let review_counts = selected_project_id
            .map(|project_id| db.review_counts(project_id, &target_language))
            .transpose()?;
        let checkpoint = checkpoint_summary(&db_path, &target_language)?;
        let mut latest_job = db.latest_translation_job_summary(Some(&target_language))?;
        if latest_job.is_none() {
            latest_job = backfill_latest_job_from_checkpoint(
                &mut db,
                selected_project_id,
                &settings,
                dashboard.as_ref(),
                checkpoint.as_ref(),
            )?;
        }
        Ok(HydrateWorkbenchResponse {
            workspace: workspace.map(Into::into),
            projects: projects.into_iter().map(Into::into).collect(),
            selected_project_id,
            settings,
            dashboard,
            review_counts,
            checkpoint,
            latest_job,
            stale_runs_interrupted,
        })
    })
    .await
}

fn backfill_latest_job_from_checkpoint(
    db: &mut rpg_translator_core::TranslationDb,
    selected_project_id: Option<i64>,
    settings: &WorkbenchSettingsRecord,
    dashboard: Option<&WorkbenchDashboardSummary>,
    checkpoint: Option<&CheckpointSummary>,
) -> rpg_translator_core::Result<Option<TranslationJobSummary>> {
    let Some(checkpoint) = checkpoint.filter(|checkpoint| checkpoint.exists) else {
        return Ok(None);
    };
    let Some(provider_run_id) = checkpoint.provider_run_id.filter(|id| *id > 0) else {
        return Ok(None);
    };
    let completed_items = usize_to_i64(checkpoint.completed_count);
    let failed_items = usize_to_i64(checkpoint.failed_count);
    let checkpoint_total = completed_items.saturating_add(failed_items);
    let total_items = dashboard
        .map(|dashboard| dashboard.source_text_count)
        .unwrap_or(checkpoint_total)
        .max(checkpoint_total);
    let status = dashboard
        .and_then(|dashboard| dashboard.latest_provider_run.as_ref())
        .filter(|run| run.id == provider_run_id)
        .map(|run| run.status.clone())
        .unwrap_or_else(|| "paused".to_string());

    db.upsert_translation_job_progress(&TranslationJobProgressUpdate {
        provider_run_id,
        project_id: selected_project_id,
        source_language: settings.source_language.clone(),
        target_language: checkpoint.target_language.clone(),
        checkpoint_path: checkpoint.path.clone(),
        status,
        completed_items,
        failed_items,
        total_items,
        processed_batches: 0,
        total_batches: 0,
        split_batches: 0,
        parse_failed_items: 0,
        validation_failed_items: 0,
        skipped_items: 0,
        censored_retry_count: 0,
        item_eta_ms: None,
        batch_eta_ms: None,
        last_batch_elapsed_ms: None,
        avg_batch_elapsed_ms: None,
        current_batch_items: 0,
        elapsed_ms: 0,
        model: None,
        retry_pending_items: failed_items,
        recoverable_provider_failures: failed_items,
        final_failed_items: 0,
        provider_backoff_ms: None,
        effective_batch_size: 0,
        speed_mode: "steady".to_string(),
        success_streak: 0,
        success_delay_floor_ms: 1500,
        next_delay_ms: None,
        failure_reason_counts_json: "{}".to_string(),
        adaptive_decision_reason: "adaptive: legacy checkpoint only".to_string(),
        legacy_checkpoint_only: true,
    })?;
    db.latest_translation_job_summary(Some(&checkpoint.target_language))
}

fn usize_to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

#[tauri::command]
pub async fn save_workbench_settings(
    request: SaveWorkbenchSettingsRequest,
) -> CommandResult<SaveWorkbenchSettingsResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_migrating(&request.db_path)?;
        let export_dir = request
            .export_dir
            .as_deref()
            .map(normalize_windows_user_path);
        db.save_workbench_settings(&WorkbenchSettingsUpdate {
            selected_project_id: request.selected_project_id,
            source_language: request.source_language,
            target_language: request.target_language,
            provider_base_url: request.provider_base_url,
            provider_model: request.provider_model,
            system_prompt: request.system_prompt,
            export_dir,
            active_tab: request.active_tab,
            show_hover_help: request.show_hover_help,
            ui_font_size: request.ui_font_size,
        })?;
        Ok(SaveWorkbenchSettingsResponse {
            settings: db.load_workbench_settings()?,
        })
    })
    .await
}

#[tauri::command]
pub async fn save_workbench_state(
    request: SaveWorkbenchStateRequest,
) -> CommandResult<SaveWorkbenchStateResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_migrating(&request.db_path)?;
        let export_dir = request
            .export_dir
            .as_deref()
            .map(normalize_windows_user_path);
        db.save_workbench_settings(&WorkbenchSettingsUpdate {
            selected_project_id: request.selected_project_id,
            source_language: request.source_language,
            target_language: request.target_language,
            provider_base_url: request.provider_base_url,
            provider_model: request.provider_model,
            system_prompt: request.system_prompt,
            export_dir,
            active_tab: request.active_tab,
            show_hover_help: request.show_hover_help,
            ui_font_size: request.ui_font_size,
        })?;
        let mut saved_drafts = 0usize;
        for draft in &request.review_drafts {
            db.upsert_review_draft(
                draft.source_text_id,
                &draft.target_language,
                &draft.draft_text,
                draft.base_translation_updated_at.as_deref(),
            )?;
            saved_drafts = saved_drafts.saturating_add(1);
        }
        Ok(SaveWorkbenchStateResponse {
            settings: db.load_workbench_settings()?,
            saved_drafts,
            saved_at: chrono_like_timestamp(),
        })
    })
    .await
}

fn chrono_like_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

fn selected_project(
    projects: &[ProjectRecord],
    selected_project_id: Option<i64>,
) -> Option<ProjectRecord> {
    selected_project_id
        .and_then(|id| projects.iter().find(|project| project.id == id).cloned())
        .or_else(|| projects.first().cloned())
}

fn checkpoint_summary(
    db_path: &str,
    target_language: &str,
) -> rpg_translator_core::Result<Option<CheckpointSummary>> {
    let path = translation_checkpoint_path(db_path, target_language);
    let checkpoint = CheckpointWriter::read(&path)?;
    Ok(Some(match checkpoint {
        Some(checkpoint) => {
            let mut failure_type_counts = BTreeMap::new();
            for detail in &checkpoint.failure_details {
                *failure_type_counts
                    .entry(detail.finding_type.clone())
                    .or_insert(0) += 1;
            }
            CheckpointSummary {
                path: normalize_windows_user_path(&path.to_string_lossy()),
                exists: true,
                provider_run_id: Some(checkpoint.provider_run_id),
                target_language: checkpoint.target_language,
                completed_count: checkpoint.completed_source_text_ids.len(),
                failed_count: checkpoint.failed_source_text_ids.len(),
                failure_type_counts,
            }
        }
        None => CheckpointSummary {
            path: normalize_windows_user_path(&path.to_string_lossy()),
            exists: false,
            provider_run_id: None,
            target_language: target_language.to_string(),
            completed_count: 0,
            failed_count: 0,
            failure_type_counts: BTreeMap::new(),
        },
    }))
}
