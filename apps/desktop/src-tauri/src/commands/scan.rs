use serde::{Deserialize, Serialize};

use rpg_translator_core::{ScanOptions, ScanPersistenceReport, WorkbenchService};

use super::shared::{CommandResult, open_db, run_blocking};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanGameRequest {
    pub db_path: String,
    pub game_root: String,
    pub source_language: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanGameResponse {
    pub report: ScanPersistenceReport,
}

#[tauri::command]
pub async fn scan_game(request: ScanGameRequest) -> CommandResult<ScanGameResponse> {
    run_blocking(move || {
        let mut db = open_db(&request.db_path)?;
        let mut options = ScanOptions::default();
        if let Some(source_language) = request.source_language {
            options.source_language = source_language;
        }
        let report = WorkbenchService::scan_game(&mut db, request.game_root, options)?;
        Ok(ScanGameResponse { report })
    })
    .await
}
