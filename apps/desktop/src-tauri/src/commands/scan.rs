use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use rpg_translator_core::{
    Engine, GameLayoutKind, ScanOptions, ScanPersistenceReport, ScanProgressEvent, WorkbenchService,
};

use super::shared::{CommandResult, normalize_windows_user_path, open_db, run_blocking};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanGameRequest {
    pub db_path: String,
    pub game_root: String,
    pub source_language: Option<String>,
    pub disable_cjk_filter: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanGameResponse {
    pub report: ScanPersistenceReport,
}

#[tauri::command]
pub async fn scan_game(
    app: AppHandle,
    request: ScanGameRequest,
) -> CommandResult<ScanGameResponse> {
    scan_game_inner(Some(app), request).await
}

pub async fn scan_game_for_test(request: ScanGameRequest) -> CommandResult<ScanGameResponse> {
    scan_game_inner(None, request).await
}

async fn scan_game_inner(
    app: Option<AppHandle>,
    request: ScanGameRequest,
) -> CommandResult<ScanGameResponse> {
    let console_logging_enabled = scan_console_logging_enabled();
    run_blocking(move || {
        let mut db = open_db(&request.db_path)?;
        let mut options = ScanOptions::default();
        if let Some(source_language) = request.source_language {
            options.source_language = source_language;
        }
        if let Some(disable_cjk_filter) = request.disable_cjk_filter {
            options.disable_cjk_filter = disable_cjk_filter;
        }
        let report = WorkbenchService::scan_game_with_progress(
            &mut db,
            normalize_windows_user_path(&request.game_root),
            options,
            move |event| {
                if console_logging_enabled {
                    write_scan_progress_log(event);
                }
                if let Some(app) = app.as_ref() {
                    emit_scan_progress_event(app, event);
                }
            },
        )?;
        Ok(ScanGameResponse { report })
    })
    .await
}

pub fn scan_console_logging_enabled() -> bool {
    scan_console_logging_enabled_from(
        std::env::args().skip(1),
        std::env::var("RPG_TRANSLATOR_SCAN_LOG").ok().as_deref(),
    )
}

pub fn write_scan_console_startup_status() {
    println!(
        "{}",
        scan_console_startup_status(scan_console_logging_enabled())
    );
    let _ = io::stdout().flush();
}

pub fn scan_console_startup_status(enabled: bool) -> &'static str {
    if enabled {
        "[RPG-Translator][scan] console logging enabled. The workbench window should open separately; select a game and click Scan to stream scan progress here."
    } else {
        "[RPG-Translator] console ready. Scan logs are off because --no-scan-log or RPG_TRANSLATOR_SCAN_LOG=0 was set."
    }
}

pub fn scan_console_logging_enabled_from<I, S>(args: I, env_value: Option<&str>) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut arg_override = None;
    for arg in args {
        arg_override = match arg.as_ref() {
            "--scan-log" | "--scan-logs" | "--console-scan-log" => Some(true),
            "--no-scan-log" | "--no-scan-logs" | "--no-console-scan-log" => Some(false),
            _ => arg_override,
        };
    }
    if let Some(enabled) = arg_override {
        return enabled;
    }
    env_value.and_then(scan_log_env_override).unwrap_or(true)
}

fn scan_log_env_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn format_scan_progress_event(event: &ScanProgressEvent) -> String {
    match event {
        ScanProgressEvent::Started {
            game_root,
            source_language,
        } => format!(
            "[RPG-Translator][scan] start game_root=\"{}\" source_language={source_language}",
            normalize_windows_user_path(game_root)
        ),
        ScanProgressEvent::Detected {
            engine,
            layout,
            data_path,
        } => format!(
            "[RPG-Translator][scan] detected engine={} layout={} data_path=\"{}\"",
            engine_key(engine),
            layout_key(layout),
            normalize_windows_user_path(data_path)
        ),
        ScanProgressEvent::FileStarted { index, file_path } => {
            format!(
                "[RPG-Translator][scan] file_start index={} path=\"{}\"",
                index + 1,
                file_path
            )
        }
        ScanProgressEvent::FileFinished {
            index,
            file_path,
            accepted_delta,
            rejected_delta,
            skipped,
        } => format!(
            "[RPG-Translator][scan] file_done index={} path=\"{}\" accepted={} rejected={} skipped={}",
            index + 1,
            file_path,
            accepted_delta,
            rejected_delta,
            skipped
        ),
        ScanProgressEvent::Finished {
            file_count,
            accepted_count,
            rejected_count,
            skipped_count,
        } => format!(
            "[RPG-Translator][scan] extraction_done files={} accepted={} rejected={} skipped={}",
            file_count, accepted_count, rejected_count, skipped_count
        ),
        ScanProgressEvent::Persisting { occurrence_count } => {
            format!("[RPG-Translator][scan] persisting occurrences={occurrence_count}")
        }
        ScanProgressEvent::Persisted {
            project_id,
            snapshot_id,
            source_text_count,
            occurrence_count,
            added_source_text_count,
            removed_occurrence_count,
            unchanged_source_text_count,
            rejected_count,
            skipped_count,
        } => format!(
            "[RPG-Translator][scan] persisted project_id={} snapshot_id={} source_texts={} occurrences={} added_sources={} unchanged_sources={} removed_occurrences={} rejected={} skipped={}",
            project_id,
            snapshot_id,
            source_text_count,
            occurrence_count,
            added_source_text_count,
            unchanged_source_text_count,
            removed_occurrence_count,
            rejected_count,
            skipped_count
        ),
    }
}

fn write_scan_progress_log(event: &ScanProgressEvent) {
    println!("{}", format_scan_progress_event(event));
    let _ = io::stdout().flush();
}

fn emit_scan_progress_event(app: &AppHandle, event: &ScanProgressEvent) {
    let event = normalize_scan_progress_event(event);
    let _ = app.emit("scan-progress", event);
}

fn normalize_scan_progress_event(event: &ScanProgressEvent) -> ScanProgressEvent {
    match event {
        ScanProgressEvent::Started {
            game_root,
            source_language,
        } => ScanProgressEvent::Started {
            game_root: normalize_windows_user_path(game_root),
            source_language: source_language.clone(),
        },
        ScanProgressEvent::Detected {
            engine,
            layout,
            data_path,
        } => ScanProgressEvent::Detected {
            engine: engine.clone(),
            layout: layout.clone(),
            data_path: normalize_windows_user_path(data_path),
        },
        _ => event.clone(),
    }
}

fn engine_key(engine: &Engine) -> &'static str {
    engine.as_key()
}

fn layout_key(layout: &GameLayoutKind) -> &'static str {
    match layout {
        GameLayoutKind::Direct => "direct",
        GameLayoutKind::Www => "www",
    }
}
