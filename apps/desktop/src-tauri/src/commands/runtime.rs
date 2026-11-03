//! 실시간 번역 작업자의 시작·중지와 수명을 관리합니다. 파일 요청은 코어에서 검증합니다.

use super::shared::{
    CommandError, CommandResult, normalize_windows_user_path, open_db_existing, run_blocking,
    write_gate,
};
use super::translate::{ReqwestTransport, TranslateRequest};
use rpg_translator_core::{
    Error, ExportBuilder, InstallOptions, Installer, LocalOpenAiConfig, LocalOpenAiProvider,
    RuntimeMailbox, RuntimeSession, runtime_mailbox_directory,
};
use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;
use tauri::State;

#[derive(Default)]
pub struct RuntimeWorkerState {
    running: AtomicBool,
    stop: Arc<AtomicBool>,
    error: Mutex<Option<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub running: bool,
    pub error: Option<String>,
}

impl RuntimeWorkerState {
    fn status(&self) -> CommandResult<RuntimeStatus> {
        let error = self
            .error
            .lock()
            .map_err(|_| CommandError::new("runtime status lock failed"))?
            .clone();
        Ok(RuntimeStatus {
            running: self.running.load(Ordering::SeqCst),
            error,
        })
    }

    fn finish(&self, error: Option<String>) {
        if let Ok(mut current) = self.error.lock() {
            *current = error;
        }
        self.running.store(false, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn start_runtime_translation(
    state: State<'_, Arc<RuntimeWorkerState>>,
    request: TranslateRequest,
) -> CommandResult<RuntimeStatus> {
    let state = state.inner().clone();
    if state.running.swap(true, Ordering::SeqCst) {
        return Err(CommandError::new("runtime translation is already running"));
    }
    state.stop.store(false, Ordering::SeqCst);
    if let Ok(mut error) = state.error.lock() {
        *error = None;
    }
    let startup_state = state.clone();
    let result = run_blocking(move || {
        let db_path = normalize_windows_user_path(&request.db_path);
        let mut db = open_db_existing(&db_path)?;
        let project_id = request
            .project_id
            .ok_or_else(|| Error::invalid_input("runtime project_id is required"))?;
        let project = db
            .get_project(project_id)?
            .ok_or_else(|| Error::invalid_input("runtime project is missing"))?;
        let root =
            rpg_translator_core::native_runtime_path(std::path::Path::new(&project.game_root));
        let mut provider = LocalOpenAiProvider::new(
            LocalOpenAiConfig {
                base_url: request.base_url,
                model: request.model,
                source_language: request.source_language.clone(),
                target_language: request.target_language.clone(),
                system_prompt: request.system_prompt,
                temperature: request.temperature,
                top_p: request.top_p,
                max_output_tokens: request.max_output_tokens.or(Some(1536)),
            },
            ReqwestTransport::with_pause(startup_state.stop.clone()),
        )?;
        let mut mailbox = RuntimeMailbox::open(runtime_mailbox_directory(&root)?)?;
        let export = root.join("rpg-translator/exports/runtime");
        {
            let _gate = write_gate()?;
            let report = ExportBuilder::export_runtime_project(
                &mut db,
                project_id,
                &request.source_language,
                &request.target_language,
                &export,
            )?;
            if startup_state.stop.load(Ordering::SeqCst) {
                return Err(Error::invalid_input("runtime startup cancelled").into());
            }
            Installer::install_with_db(
                &mut db,
                &InstallOptions {
                    game_root: root,
                    export_dir: export,
                    runtime_dir: None,
                    project_id: Some(project_id),
                    export_id: Some(report.export_id),
                },
            )?;
        }
        let session = RuntimeSession {
            project_id,
            engine: project.engine,
            source_language: request.source_language,
            target_language: request.target_language,
        };
        std::thread::spawn(move || {
            while !startup_state.stop.load(Ordering::SeqCst) {
                let result =
                    mailbox.process_pending_with_control(&mut db, &mut provider, &session, || {
                        startup_state.stop.load(Ordering::SeqCst)
                    });
                let failed = result.is_err();
                if let Ok(mut error) = startup_state.error.lock() {
                    *error = result
                        .err()
                        .map(|error| error.to_string())
                        .or_else(|| mailbox.last_error());
                }
                // 일시적인 파일 공유 오류로 작업자를 끝내지 않고 상태를 보여 준 뒤 다시 시도합니다.
                std::thread::sleep(Duration::from_millis(if failed { 500 } else { 100 }));
            }
            startup_state.finish(None);
        });
        Ok(())
    })
    .await;
    if let Err(error) = result {
        state.finish(Some(error.message.clone()));
        return Err(error);
    }
    state.status()
}

#[tauri::command]
pub fn stop_runtime_translation(
    state: State<'_, Arc<RuntimeWorkerState>>,
) -> CommandResult<RuntimeStatus> {
    state.stop.store(true, Ordering::SeqCst);
    state.status()
}

#[tauri::command]
pub fn runtime_translation_status(
    state: State<'_, Arc<RuntimeWorkerState>>,
) -> CommandResult<RuntimeStatus> {
    state.status()
}
