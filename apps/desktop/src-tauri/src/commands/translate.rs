use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicI64, Ordering},
};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use rpg_translator_core::{
    BatchFailureDetail, BatchTranslator, BatchTranslatorConfig, Error, LocalOpenAiConfig,
    LocalOpenAiProvider, LocalProviderTransport, ProviderBatchItem, ProviderBatchRequest,
    ProviderClient, ProviderRequestSpacingConfig, ProviderSpeedBenchmark,
    ProviderSpeedBenchmarkConfig, ProviderSpeedBenchmarkReport, Result, TextCodec,
    TranslateProgressEvent, TranslateProgressSnapshot, translation_prompt_hash,
};

use super::shared::{
    CommandResult, normalize_windows_user_path, open_db_existing, run_blocking, write_gate,
};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TranslateRequest {
    pub db_path: String,
    pub project_id: Option<i64>,
    pub source_language: String,
    pub target_language: String,
    pub batch_size: Option<usize>,
    pub base_url: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<usize>,
    pub source_text_ids: Option<Vec<i64>>,
    pub issue_filter: Option<String>,
    pub retranslate_mode: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderTestRequest {
    pub base_url: String,
    pub model: String,
    pub source_language: String,
    pub target_language: String,
    pub system_prompt: String,
    pub sample_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTestResponse {
    pub ok: bool,
    pub latency_ms: u64,
    pub raw_output: String,
    pub model: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderSpeedBenchmarkRequest {
    pub db_path: String,
    pub project_id: Option<i64>,
    pub source_language: String,
    pub target_language: String,
    pub batch_size: Option<usize>,
    pub base_url: String,
    pub model: String,
    pub system_prompt: String,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<usize>,
    pub warmup_runs: Option<usize>,
    pub measured_runs: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PauseTranslationRequest {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PauseTranslationResponse {
    pub requested: bool,
    pub provider_run_id: Option<i64>,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeShutdownRequest {
    pub db_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SafeShutdownResponse {
    pub pause_requested: bool,
    pub provider_run_id: Option<i64>,
    pub mode: String,
    pub stale_runs_interrupted: i64,
}

#[derive(Default)]
pub struct TranslationJobState {
    running: AtomicBool,
    pause_requested: Arc<AtomicBool>,
    active_run_id: AtomicI64,
}

impl TranslationJobState {
    #[must_use]
    pub fn try_start(&self) -> bool {
        if self
            .running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            self.pause_requested.store(false, Ordering::SeqCst);
            self.active_run_id.store(0, Ordering::SeqCst);
            true
        } else {
            false
        }
    }

    pub fn finish(&self) {
        self.pause_requested.store(false, Ordering::SeqCst);
        self.active_run_id.store(0, Ordering::SeqCst);
        self.running.store(false, Ordering::SeqCst);
    }

    pub fn set_active_run_id(&self, provider_run_id: i64) {
        self.active_run_id
            .store(provider_run_id.max(0), Ordering::SeqCst);
    }

    #[must_use]
    pub fn pause_requested(&self) -> bool {
        self.pause_requested.load(Ordering::SeqCst)
    }

    #[must_use]
    pub fn pause_flag(&self) -> Arc<AtomicBool> {
        self.pause_requested.clone()
    }

    fn request_pause(&self) -> PauseTranslationResponse {
        if !self.running.load(Ordering::SeqCst) {
            return PauseTranslationResponse {
                requested: false,
                provider_run_id: None,
                mode: "no-active-run".to_string(),
            };
        }
        self.pause_requested.store(true, Ordering::SeqCst);
        let provider_run_id = match self.active_run_id.load(Ordering::SeqCst) {
            value if value > 0 => Some(value),
            _ => None,
        };
        PauseTranslationResponse {
            requested: true,
            provider_run_id,
            mode: "abort-current-request".to_string(),
        }
    }
}

pub fn request_translation_pause(state: &TranslationJobState) -> PauseTranslationResponse {
    state.request_pause()
}

#[tauri::command]
pub async fn translate_with_local_provider(
    app: AppHandle,
    state: State<'_, Arc<TranslationJobState>>,
    request: TranslateRequest,
) -> CommandResult<TranslateResponse> {
    translate_with_local_provider_inner(Some(app), state.inner().clone(), request).await
}

pub async fn translate_with_local_provider_for_test(
    request: TranslateRequest,
) -> CommandResult<TranslateResponse> {
    translate_with_local_provider_inner(None, Arc::new(TranslationJobState::default()), request)
        .await
}

pub async fn translate_with_local_provider_for_test_with_state(
    request: TranslateRequest,
    state: Arc<TranslationJobState>,
) -> CommandResult<TranslateResponse> {
    translate_with_local_provider_inner(None, state, request).await
}

async fn translate_with_local_provider_inner(
    app: Option<AppHandle>,
    state: Arc<TranslationJobState>,
    request: TranslateRequest,
) -> CommandResult<TranslateResponse> {
    if !state.try_start() {
        return Err(super::shared::CommandError::new(
            "translation is already running; pause or wait for the active run",
        ));
    }
    let finish_state = state.clone();
    let result = translate_with_local_provider_running(app, state, request).await;
    finish_state.finish();
    result
}

async fn translate_with_local_provider_running(
    app: Option<AppHandle>,
    state: Arc<TranslationJobState>,
    request: TranslateRequest,
) -> CommandResult<TranslateResponse> {
    let console_logging_enabled = translate_console_logging_enabled();
    run_blocking(move || {
        let mut provider = LocalOpenAiProvider::new(
            LocalOpenAiConfig {
                base_url: request.base_url.clone(),
                model: request.model.clone(),
                source_language: request.source_language.clone(),
                target_language: request.target_language.clone(),
                system_prompt: request.system_prompt.clone(),
                temperature: request.temperature,
                top_p: request.top_p,
                max_output_tokens: request.max_output_tokens,
            },
            ReqwestTransport::with_pause(state.pause_flag()),
        )?;
        let mut db = open_db_existing(&request.db_path)?;
        let issue_source_text_ids = if request.source_text_ids.is_none()
            && let (Some(project_id), Some(issue_filter)) =
                (request.project_id, request.issue_filter.as_deref())
        {
            Some(db.review_issue_source_text_ids(
                project_id,
                &request.target_language,
                issue_filter,
            )?)
        } else {
            None
        };
        let source_text_ids = request.source_text_ids.clone().or(issue_source_text_ids);
        let include_existing_translations = matches!(
            request.retranslate_mode.as_deref(),
            Some("selected_issue_rows" | "current_issue_filter")
        ) || source_text_ids.is_some();
        let checkpoint_path =
            translation_checkpoint_path(&request.db_path, &request.target_language);
        let prompt_hash = translation_prompt_hash(
            &request.source_language,
            &request.target_language,
            &request.system_prompt,
        );
        let progress_state = state.clone();
        let report = BatchTranslator::run_with_checkpoint_and_progress(
            &mut db,
            &mut provider,
            &request.target_language,
            BatchTranslatorConfig {
                project_id: request.project_id,
                source_language: request.source_language.clone(),
                max_items_per_batch: request.batch_size.unwrap_or(16),
                retry_attempts: 0,
                source_text_ids,
                include_existing_translations,
                prompt_hash,
                ..BatchTranslatorConfig::default()
            },
            Some(&checkpoint_path),
            move |event| {
                if let TranslateProgressEvent::Started(snapshot) = event {
                    progress_state.set_active_run_id(snapshot.provider_run_id);
                }
                if console_logging_enabled {
                    write_translate_progress_log(event);
                }
                if let Some(app) = app.as_ref() {
                    emit_translate_progress_event(app, event);
                }
            },
            || state.pause_requested(),
        )?;
        Ok(TranslateResponse {
            status: report.status.as_key().to_string(),
            provider_run_id: report.provider_run_id,
            accepted_count: report.completed_source_text_ids.len(),
            failed_count: report.failed_source_text_ids.len(),
            split_batches: report.split_batches,
            failures: report.failure_details.into_iter().map(Into::into).collect(),
            completed_items: report.initial_completed_source_text_count
                + report.completed_source_text_ids.len(),
            failed_items: report.failed_source_text_ids.len(),
            total_items: report.total_source_text_count,
            processed_batches: report.processed_batches,
            total_batches: report.total_batches,
            elapsed_ms: report.elapsed_ms,
            eta_ms: report.eta_ms,
            item_eta_ms: report.item_eta_ms,
            batch_eta_ms: report.batch_eta_ms,
            last_batch_elapsed_ms: report.last_batch_elapsed_ms,
            avg_batch_elapsed_ms: report.avg_batch_elapsed_ms,
            current_batch_items: report.current_batch_items,
            started_completed_items: report.initial_completed_source_text_count,
            parse_failed_items: report.parse_failed_items,
            validation_failed_items: report.validation_failed_items,
            skipped_items: report.skipped_items,
            censored_retry_count: report.censored_retry_count,
            retry_pending_items: report.retry_pending_items,
            recoverable_provider_failures: report.recoverable_provider_failures,
            final_failed_items: report.final_failed_items,
            provider_backoff_ms: report.provider_backoff_ms,
            effective_batch_size: report.effective_batch_size,
            speed_mode: report.speed_mode,
            success_streak: report.success_streak,
            success_delay_floor_ms: report.success_delay_floor_ms,
            next_delay_ms: report.next_delay_ms,
            failure_reason_counts: report.failure_reason_counts,
            legacy_checkpoint_only: report.legacy_checkpoint_only,
            model: provider.model_name().map(str::to_string),
        })
    })
    .await
}

#[tauri::command]
pub async fn pause_translation(
    app: AppHandle,
    state: State<'_, Arc<TranslationJobState>>,
    _request: PauseTranslationRequest,
) -> CommandResult<PauseTranslationResponse> {
    let response = request_translation_pause(state.inner());
    if response.requested {
        let _ = app.emit("translate-pause-requested", &response);
    }
    Ok(response)
}

#[tauri::command]
pub async fn prepare_safe_shutdown(
    app: AppHandle,
    state: State<'_, Arc<TranslationJobState>>,
    request: SafeShutdownRequest,
) -> CommandResult<SafeShutdownResponse> {
    let pause = request_translation_pause(state.inner());
    if pause.requested {
        let _ = app.emit("translate-pause-requested", &pause);
    }
    let db_path = request
        .db_path
        .as_deref()
        .map(normalize_windows_user_path)
        .filter(|path| !path.trim().is_empty());
    let stale_runs_interrupted = if let Some(db_path) = db_path {
        run_blocking(move || {
            let _gate = write_gate()?;
            let mut db = open_db_existing(&db_path)?;
            Ok(db.interrupt_stale_provider_runs()? + db.interrupt_stale_translation_jobs()?)
        })
        .await?
    } else {
        0
    };
    Ok(SafeShutdownResponse {
        pause_requested: pause.requested,
        provider_run_id: pause.provider_run_id,
        mode: pause.mode,
        stale_runs_interrupted,
    })
}

#[tauri::command]
pub async fn test_local_provider(
    request: ProviderTestRequest,
) -> CommandResult<ProviderTestResponse> {
    run_blocking(move || {
        let mut provider = LocalOpenAiProvider::new(
            LocalOpenAiConfig {
                base_url: request.base_url,
                model: request.model,
                source_language: request.source_language,
                target_language: request.target_language,
                system_prompt: request.system_prompt,
                temperature: Some(0.0),
                top_p: None,
                max_output_tokens: Some(128),
            },
            ReqwestTransport::default(),
        )?;
        let sample_text = request
            .sample_text
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Hello".to_string());
        let started = Instant::now();
        let response = provider.translate_batch(&ProviderBatchRequest {
            items: vec![ProviderBatchItem {
                id: 1,
                text: sample_text,
            }],
            instruction: None,
        })?;
        Ok(ProviderTestResponse {
            ok: true,
            latency_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
            raw_output: response.raw_output,
            model: provider.model_name().map(str::to_string),
            message: Some(
                provider
                    .model_name()
                    .map(|model| format!("Provider responded with model {model}"))
                    .unwrap_or_else(|| "Provider responded".to_string()),
            ),
        })
    })
    .await
}

#[tauri::command]
pub async fn benchmark_provider_translation_speed(
    request: ProviderSpeedBenchmarkRequest,
) -> CommandResult<ProviderSpeedBenchmarkReport> {
    run_blocking(move || {
        let db = open_db_existing(&request.db_path)?;
        let items = benchmark_provider_items(
            &db,
            request.project_id,
            &request.source_language,
            request.batch_size.unwrap_or(16),
        )?;
        let mut provider = LocalOpenAiProvider::new(
            LocalOpenAiConfig {
                base_url: request.base_url,
                model: request.model,
                source_language: request.source_language,
                target_language: request.target_language,
                system_prompt: request.system_prompt,
                temperature: request.temperature.or(Some(0.0)),
                top_p: request.top_p,
                max_output_tokens: request.max_output_tokens,
            },
            ReqwestTransport::default(),
        )?;
        Ok(ProviderSpeedBenchmark::run(
            &mut provider,
            &ProviderBatchRequest {
                items,
                instruction: None,
            },
            ProviderSpeedBenchmarkConfig {
                warmup_runs: request.warmup_runs.unwrap_or(1),
                measured_runs: request.measured_runs.unwrap_or(5),
            },
            &ProviderRequestSpacingConfig::stable(),
        )?)
    })
    .await
}

fn benchmark_provider_items(
    db: &rpg_translator_core::TranslationDb,
    project_id: Option<i64>,
    source_language: &str,
    batch_size: usize,
) -> Result<Vec<ProviderBatchItem>> {
    let records = db.benchmark_source_texts(project_id, source_language, batch_size.max(1))?;
    if records.is_empty() {
        return Err(Error::invalid_input(
            "no scanned source text is available for the selected source language; scan the game first",
        ));
    }
    Ok(records
        .into_iter()
        .enumerate()
        .map(|(index, record)| ProviderBatchItem {
            id: i64::try_from(index + 1).unwrap_or(i64::MAX),
            text: TextCodec::encode_for_provider(&record.normalized_text).provider_text,
        })
        .collect())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslateResponse {
    pub status: String,
    pub provider_run_id: i64,
    pub accepted_count: usize,
    pub failed_count: usize,
    pub split_batches: usize,
    pub failures: Vec<BatchFailure>,
    pub completed_items: usize,
    pub failed_items: usize,
    pub total_items: usize,
    pub processed_batches: usize,
    pub total_batches: usize,
    pub elapsed_ms: u64,
    pub eta_ms: Option<u64>,
    pub item_eta_ms: Option<u64>,
    pub batch_eta_ms: Option<u64>,
    pub last_batch_elapsed_ms: Option<u64>,
    pub avg_batch_elapsed_ms: Option<u64>,
    pub current_batch_items: usize,
    pub started_completed_items: usize,
    pub parse_failed_items: usize,
    pub validation_failed_items: usize,
    pub skipped_items: usize,
    pub censored_retry_count: usize,
    pub retry_pending_items: usize,
    pub recoverable_provider_failures: usize,
    pub final_failed_items: usize,
    pub provider_backoff_ms: Option<u64>,
    pub effective_batch_size: usize,
    pub speed_mode: String,
    pub success_streak: usize,
    pub success_delay_floor_ms: u64,
    pub next_delay_ms: Option<u64>,
    pub failure_reason_counts: BTreeMap<String, usize>,
    pub legacy_checkpoint_only: bool,
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchFailure {
    pub source_text_ids: Vec<i64>,
    pub message: String,
}

struct ReqwestTransport {
    client: reqwest::Client,
    pause_requested: Option<Arc<AtomicBool>>,
}

impl Default for ReqwestTransport {
    fn default() -> Self {
        Self {
            client: reqwest::Client::new(),
            pause_requested: None,
        }
    }
}

impl ReqwestTransport {
    fn with_pause(pause_requested: Arc<AtomicBool>) -> Self {
        Self {
            client: reqwest::Client::new(),
            pause_requested: Some(pause_requested),
        }
    }
}

impl LocalProviderTransport for ReqwestTransport {
    fn get_json(&mut self, url: &str) -> Result<Value> {
        request_json(
            self.client.get(url),
            self.pause_requested.clone(),
            "local provider model lookup failed",
            "local provider model lookup response was not JSON",
        )
    }

    fn post_json(&mut self, url: &str, body: &Value) -> Result<Value> {
        request_json(
            self.client.post(url).json(body),
            self.pause_requested.clone(),
            "local provider request failed",
            "local provider response was not JSON",
        )
    }
}

fn request_json(
    builder: reqwest::RequestBuilder,
    pause_requested: Option<Arc<AtomicBool>>,
    request_error: &'static str,
    json_error: &'static str,
) -> Result<Value> {
    tauri::async_runtime::block_on(async move {
        let request_future = async move {
            let response = builder
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|error| Error::invalid_input(format!("{request_error}: {error}")))?;
            response
                .json::<Value>()
                .await
                .map_err(|error| Error::invalid_input(format!("{json_error}: {error}")))
        };
        if let Some(pause_requested) = pause_requested {
            tokio::select! {
                _ = wait_for_pause(pause_requested) => {
                    Err(Error::invalid_input("translation paused; provider request aborted"))
                }
                result = request_future => result,
            }
        } else {
            request_future.await
        }
    })
}

async fn wait_for_pause(pause_requested: Arc<AtomicBool>) {
    while !pause_requested.load(Ordering::SeqCst) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

impl From<BatchFailureDetail> for BatchFailure {
    fn from(failure: BatchFailureDetail) -> Self {
        Self {
            source_text_ids: failure.source_text_ids,
            message: failure.message,
        }
    }
}

pub fn translate_console_logging_enabled() -> bool {
    translate_console_logging_enabled_from(
        std::env::args().skip(1),
        std::env::var("RPG_TRANSLATOR_TRANSLATE_LOG")
            .ok()
            .as_deref(),
    )
}

pub fn write_translate_console_startup_status() {
    println!(
        "{}",
        translate_console_startup_status(translate_console_logging_enabled())
    );
    let _ = io::stdout().flush();
}

pub fn translate_console_startup_status(enabled: bool) -> &'static str {
    if enabled {
        "[RPG-Translator][translate] console logging enabled. Batch translation progress, ETA, pause, and completion events will stream here."
    } else {
        "[RPG-Translator][translate] console logging disabled by --no-translate-log or RPG_TRANSLATOR_TRANSLATE_LOG=0."
    }
}

pub fn translate_console_logging_enabled_from<I, S>(args: I, env_value: Option<&str>) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut arg_override = None;
    for arg in args {
        arg_override = match arg.as_ref() {
            "--translate-log" | "--translate-logs" | "--console-translate-log" => Some(true),
            "--no-translate-log" | "--no-translate-logs" | "--no-console-translate-log" => {
                Some(false)
            }
            _ => arg_override,
        };
    }
    if let Some(enabled) = arg_override {
        return enabled;
    }
    env_value
        .and_then(translate_log_env_override)
        .unwrap_or(true)
}

fn translate_log_env_override(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn format_translate_progress_event(event: &TranslateProgressEvent) -> String {
    let (name, parts) = translate_progress_parts(event);
    format!(
        "[RPG-Translator][translate] {name} run={run} batch={batch_done}/{batch_total} text={items_done}/{items_total} retry_pending={retry_pending} provider_failures={provider_failures} final_failed={final_failed} parse_failed={parse_failed} validation_failed={validation_failed} skipped={skipped} censored_retry={censored_retry} split={split} speed_mode={speed_mode} success_streak={success_streak} success_floor={success_floor} next_delay={next_delay} effective_batch={effective_batch} backoff={backoff} reasons={reasons} current_items={current_items} last_batch={last_batch} avg_batch={avg_batch} elapsed={elapsed} eta_text={eta_text} eta_batch={eta_batch} model={model} target={target}",
        name = name,
        run = parts.provider_run_id,
        batch_done = parts.processed_batches,
        batch_total = parts.total_batches,
        items_done = parts.completed_items,
        items_total = parts.total_items,
        retry_pending = parts.retry_pending_items,
        provider_failures = parts.recoverable_provider_failures,
        final_failed = parts.final_failed_items,
        parse_failed = parts.parse_failed_items,
        validation_failed = parts.validation_failed_items,
        skipped = parts.skipped_items,
        censored_retry = parts.censored_retry_count,
        split = parts.split_batches,
        speed_mode = parts.speed_mode,
        success_streak = parts.success_streak,
        success_floor = format_duration(parts.success_delay_floor_ms),
        next_delay = parts
            .next_delay_ms
            .map(format_duration)
            .unwrap_or_else(|| "--:--:--".to_string()),
        effective_batch = parts.effective_batch_size,
        backoff = parts
            .provider_backoff_ms
            .map(format_duration)
            .unwrap_or_else(|| "--:--:--".to_string()),
        reasons = format_failure_reasons(&parts.failure_reason_counts),
        current_items = parts.current_batch_items,
        last_batch = parts
            .last_batch_elapsed_ms
            .map(format_duration)
            .unwrap_or_else(|| "--:--:--".to_string()),
        avg_batch = parts
            .avg_batch_elapsed_ms
            .map(format_duration)
            .unwrap_or_else(|| "--:--:--".to_string()),
        elapsed = format_duration(parts.elapsed_ms),
        eta_text = parts
            .item_eta_ms
            .map(format_duration)
            .unwrap_or_else(|| "--:--:--".to_string()),
        eta_batch = parts
            .batch_eta_ms
            .map(format_duration)
            .unwrap_or_else(|| "--:--:--".to_string()),
        model = parts.model.as_deref().unwrap_or("unknown"),
        target = parts.target_language
    )
}

fn translate_progress_parts(
    event: &TranslateProgressEvent,
) -> (&'static str, &TranslateProgressSnapshot) {
    match event {
        TranslateProgressEvent::Started(snapshot) => ("start", snapshot),
        TranslateProgressEvent::BatchStarted(snapshot) => ("batch_start", snapshot),
        TranslateProgressEvent::ProviderBackoff(snapshot) => ("provider_backoff", snapshot),
        TranslateProgressEvent::BatchFinished(snapshot) => ("batch_done", snapshot),
        TranslateProgressEvent::PauseRequested(snapshot) => ("pause_requested", snapshot),
        TranslateProgressEvent::Paused(snapshot) => ("paused", snapshot),
        TranslateProgressEvent::Completed(snapshot) => ("completed", snapshot),
    }
}

fn format_failure_reasons(reasons: &BTreeMap<String, usize>) -> String {
    if reasons.is_empty() {
        return "none".to_string();
    }
    reasons
        .iter()
        .map(|(reason, count)| format!("{reason}:{count}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn write_translate_progress_log(event: &TranslateProgressEvent) {
    println!("{}", format_translate_progress_event(event));
    let _ = io::stdout().flush();
}

fn emit_translate_progress_event(app: &AppHandle, event: &TranslateProgressEvent) {
    let _ = app.emit("translate-progress", event);
}

fn format_duration(ms: u64) -> String {
    let total_seconds = ms / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

pub fn translation_checkpoint_path(db_path: &str, target_language: &str) -> PathBuf {
    let sanitized = sanitize_checkpoint_component(target_language);
    let db_path = PathBuf::from(normalize_windows_user_path(db_path));
    if let Some(project_root) = project_artifact_root_for_db(&db_path) {
        return project_root
            .join("checkpoints")
            .join(format!("translation-{sanitized}.checkpoint.json"));
    }
    let db_path = db_path.to_string_lossy();
    PathBuf::from(format!("{db_path}.translation-{sanitized}.checkpoint.json"))
}

fn project_artifact_root_for_db(db_path: &Path) -> Option<PathBuf> {
    let db_dir = db_path.parent()?;
    if db_dir.file_name().and_then(|value| value.to_str()) != Some("db") {
        return None;
    }
    let artifact_root = db_dir.parent()?;
    if artifact_root.file_name().and_then(|value| value.to_str()) != Some("rpg-translator") {
        return None;
    }
    Some(artifact_root.to_path_buf())
}

fn sanitize_checkpoint_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.trim_matches('_').is_empty() {
        "target".to_string()
    } else {
        sanitized
    }
}
