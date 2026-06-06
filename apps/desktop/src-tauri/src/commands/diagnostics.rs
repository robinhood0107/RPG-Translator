use serde::{Deserialize, Serialize};

use rpg_translator_core::WorkbenchDashboardSummary;

use super::shared::{CommandResult, open_db, run_blocking};

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
}

#[tauri::command]
pub async fn diagnostics_summary(
    request: DiagnosticsRequest,
) -> CommandResult<DiagnosticsResponse> {
    run_blocking(move || {
        let db = open_db(&request.db_path)?;
        let dashboard =
            db.workbench_dashboard_summary(request.project_id, &request.target_language)?;
        Ok(DiagnosticsResponse {
            dashboard,
            runtime_provider_surface: "not-present".to_string(),
            runtime_ui_surface: "startup-toast-only".to_string(),
        })
    })
    .await
}
