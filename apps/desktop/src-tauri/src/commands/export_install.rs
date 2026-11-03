use serde::{Deserialize, Serialize};

use rpg_translator_core::{
    ExportBuilder, ExportPolicy, InstallOptions, Installer, RollbackManager, RollbackOptions,
};

use super::shared::{
    CommandResult, normalize_windows_user_path, open_db_existing, run_blocking, write_gate,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportBundleRequest {
    pub db_path: String,
    pub project_id: i64,
    pub target_language: String,
    pub output_dir: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportBundleResponse {
    pub export_id: i64,
    pub output_dir: String,
    pub included_count: usize,
    pub skipped_count: usize,
    pub manifest_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallOverlayRequest {
    pub db_path: String,
    pub game_root: String,
    pub export_dir: String,
    pub project_id: Option<i64>,
    pub export_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallOverlayResponse {
    pub install_id: Option<i64>,
    pub install_manifest_path: String,
    pub plugins_file: String,
    pub plugins_backup_path: String,
    pub installed_files: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollbackOverlayRequest {
    pub db_path: String,
    pub manifest_path: String,
    pub install_id: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RollbackOverlayResponse {
    pub restored_plugins_file: String,
    pub removed_files: Vec<String>,
}

#[tauri::command]
pub async fn export_bundle(request: ExportBundleRequest) -> CommandResult<ExportBundleResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_existing(&request.db_path)?;
        let report = ExportBuilder::export_project(
            &mut db,
            request.project_id,
            &request.target_language,
            normalize_windows_user_path(&request.output_dir),
            ExportPolicy::accepted_and_reviewed(),
        )?;
        Ok(ExportBundleResponse {
            export_id: report.export_id,
            output_dir: normalize_windows_user_path(&report.output_dir.to_string_lossy()),
            included_count: report.included_count,
            skipped_count: report.skipped_count,
            manifest_hash: report.manifest_hash,
        })
    })
    .await
}

#[tauri::command]
pub async fn install_overlay(
    request: InstallOverlayRequest,
) -> CommandResult<InstallOverlayResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_existing(&request.db_path)?;
        let report = Installer::install_with_db(
            &mut db,
            &InstallOptions {
                game_root: normalize_windows_user_path(&request.game_root).into(),
                export_dir: normalize_windows_user_path(&request.export_dir).into(),
                runtime_dir: None,
                project_id: request.project_id,
                export_id: request.export_id,
            },
        )?;
        Ok(InstallOverlayResponse {
            install_id: report.install_id,
            install_manifest_path: normalize_windows_user_path(
                &report.install_manifest_path.to_string_lossy(),
            ),
            plugins_file: normalize_windows_user_path(&report.plugins_file.to_string_lossy()),
            plugins_backup_path: normalize_windows_user_path(
                &report.plugins_backup_path.to_string_lossy(),
            ),
            installed_files: report
                .installed_files
                .into_iter()
                .map(|path| normalize_windows_user_path(&path.to_string_lossy()))
                .collect(),
        })
    })
    .await
}

#[tauri::command]
pub async fn rollback_overlay(
    request: RollbackOverlayRequest,
) -> CommandResult<RollbackOverlayResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_existing(&request.db_path)?;
        let report = RollbackManager::rollback_with_db(
            &mut db,
            request.install_id,
            &RollbackOptions {
                manifest_path: normalize_windows_user_path(&request.manifest_path).into(),
            },
        )?;
        Ok(RollbackOverlayResponse {
            restored_plugins_file: normalize_windows_user_path(
                &report.restored_plugins_file.to_string_lossy(),
            ),
            removed_files: report
                .removed_files
                .into_iter()
                .map(|path| normalize_windows_user_path(&path.to_string_lossy()))
                .collect(),
        })
    })
    .await
}
