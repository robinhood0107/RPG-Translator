use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    Error, NewProviderRun, NewQaFinding, NewTranslation, NewTranslationSpeedSample,
    ProviderTextState, Result, SourceTextRecord, TextCodec, TranslateProgressEvent,
    TranslateProgressSnapshot, TranslationDb, TranslationJobProgressUpdate, TranslationSpeedSample,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBatchItem {
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBatchRequest {
    pub items: Vec<ProviderBatchItem>,
    pub instruction: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBatchResponse {
    pub raw_output: String,
}

pub trait ProviderClient {
    fn provider_name(&self) -> &str;
    fn model_name(&self) -> Option<&str> {
        None
    }
    fn translate_batch(&mut self, request: &ProviderBatchRequest) -> Result<ProviderBatchResponse>;
}

pub struct FakeProvider {
    outputs: VecDeque<String>,
    requests: Vec<ProviderBatchRequest>,
}

impl FakeProvider {
    #[must_use]
    pub fn from_outputs(outputs: Vec<String>) -> Self {
        Self {
            outputs: outputs.into(),
            requests: Vec::new(),
        }
    }

    #[must_use]
    pub fn requests(&self) -> &[ProviderBatchRequest] {
        &self.requests
    }
}

impl ProviderClient for FakeProvider {
    fn provider_name(&self) -> &str {
        "fake"
    }

    fn translate_batch(&mut self, request: &ProviderBatchRequest) -> Result<ProviderBatchResponse> {
        self.requests.push(request.clone());
        let Some(raw_output) = self.outputs.pop_front() else {
            return Err(Error::invalid_input("fake provider has no queued output"));
        };
        Ok(ProviderBatchResponse { raw_output })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchPlannerConfig {
    pub max_items_per_batch: usize,
    pub input_token_budget: usize,
    pub source_text_ids: Option<BTreeSet<i64>>,
    pub include_existing_translations: bool,
}

impl Default for BatchPlannerConfig {
    fn default() -> Self {
        Self {
            max_items_per_batch: 32,
            input_token_budget: 4096,
            source_text_ids: None,
            include_existing_translations: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchJob {
    pub id: i64,
    pub source_text_ids: Vec<i64>,
    pub provider_text: String,
    pub token_estimate: usize,
    lane: BatchLane,
    provider_state: ProviderTextState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum BatchLane {
    Short,
    PlainBlock,
    Complex,
}

impl BatchLane {
    fn as_key(self) -> &'static str {
        match self {
            Self::Short => "short",
            Self::PlainBlock => "plain_block",
            Self::Complex => "complex",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchPlan {
    pub jobs: Vec<BatchJob>,
    pub batches: Vec<Vec<BatchJob>>,
}

pub struct BatchPlanner;

impl BatchPlanner {
    pub fn plan(
        db: &TranslationDb,
        target_language: &str,
        config: BatchPlannerConfig,
    ) -> Result<BatchPlan> {
        Self::plan_with_completed(db, target_language, config, &BTreeSet::new())
    }

    pub fn plan_with_completed(
        db: &TranslationDb,
        target_language: &str,
        config: BatchPlannerConfig,
        completed_source_text_ids: &BTreeSet<i64>,
    ) -> Result<BatchPlan> {
        let records = db.translation_source_texts(
            target_language,
            config.source_text_ids.as_ref(),
            config.include_existing_translations,
        )?;
        let mut group_indexes: BTreeMap<(String, String), usize> = BTreeMap::new();
        let mut groups: Vec<Vec<SourceTextRecord>> = Vec::new();
        for record in records {
            if completed_source_text_ids.contains(&record.id) {
                continue;
            }
            let key = (
                record.normalized_text.clone(),
                record.control_code_signature.clone(),
            );
            if let Some(index) = group_indexes.get(&key) {
                groups[*index].push(record);
            } else {
                let index = groups.len();
                group_indexes.insert(key, index);
                groups.push(vec![record]);
            }
        }

        let mut jobs = Vec::new();
        for (index, records) in groups.into_iter().enumerate() {
            let first = records
                .first()
                .ok_or_else(|| Error::invalid_input("empty dedupe group"))?;
            let provider_state = TextCodec::encode_for_provider(&first.normalized_text);
            let token_estimate = estimate_tokens(&provider_state.provider_text);
            jobs.push(BatchJob {
                id: (index + 1) as i64,
                source_text_ids: records.iter().map(|record| record.id).collect(),
                provider_text: provider_state.provider_text.clone(),
                token_estimate,
                lane: lane_for_record(first),
                provider_state,
            });
        }
        jobs.sort_by_key(|job| (job.lane, job.id));

        let batches = build_batches(&jobs, &config);
        Ok(BatchPlan { jobs, batches })
    }

    #[must_use]
    pub fn jobs_from_provider_items_for_test(items: Vec<ProviderBatchItem>) -> Vec<BatchJob> {
        items
            .into_iter()
            .map(|item| {
                let control_count = item.text.chars().filter(|ch| *ch == '\u{00a4}').count();
                let provider_state = ProviderTextState {
                    provider_text: item.text.clone(),
                    control_codes: vec!["\\TEST".to_string(); control_count],
                    control_code_signature: vec!["\\TEST".to_string(); control_count].join("|"),
                };
                BatchJob {
                    id: item.id,
                    source_text_ids: vec![item.id],
                    provider_text: item.text,
                    token_estimate: 1,
                    lane: BatchLane::Short,
                    provider_state,
                }
            })
            .collect()
    }
}

pub struct BatchValidator;

impl BatchValidator {
    pub fn validate(raw_output: &str, jobs: &[BatchJob]) -> Result<Vec<ValidatedTranslation>> {
        let raw = strip_chat_template_artifacts(raw_output);
        if raw.is_empty() {
            return Err(Error::invalid_input("provider returned empty output"));
        }
        let lower = raw.to_ascii_lowercase();
        if raw.contains("```") {
            return Err(Error::invalid_input("provider returned markdown fence"));
        }
        if lower.contains("<think") || lower.contains("</think") {
            return Err(Error::invalid_input("provider returned think tag"));
        }

        let rows = parse_rows(raw)?;
        let expected: BTreeMap<i64, &BatchJob> = jobs.iter().map(|job| (job.id, job)).collect();
        let mut seen = BTreeSet::new();
        let mut validated = Vec::new();

        for row in rows {
            let id = row
                .get("id")
                .and_then(Value::as_i64)
                .ok_or_else(|| Error::invalid_input("provider row missing integer id"))?;
            let Some(job) = expected.get(&id) else {
                return Err(Error::invalid_input(format!(
                    "provider returned unexpected id {id}"
                )));
            };
            if !seen.insert(id) {
                return Err(Error::invalid_input(format!(
                    "provider returned duplicate id {id}"
                )));
            }
            let translation = row
                .get("translation")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    Error::invalid_input(format!("provider row {id} missing translation"))
                })?;
            if translation.trim().is_empty() {
                return Err(Error::invalid_input(format!(
                    "provider returned empty translation for id {id}"
                )));
            }
            let restored =
                TextCodec::restore_provider_translation(translation, &job.provider_state)?;
            validated.push(ValidatedTranslation {
                job_id: id,
                source_text_ids: job.source_text_ids.clone(),
                translated_text: restored,
            });
        }

        for id in expected.keys() {
            if !seen.contains(id) {
                return Err(Error::invalid_input(format!("provider omitted id {id}")));
            }
        }

        Ok(validated)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedTranslation {
    pub job_id: i64,
    pub source_text_ids: Vec<i64>,
    pub translated_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderRequestSpacingConfig {
    pub base_success_spacing_ms: u64,
    pub min_success_spacing_ms: u64,
    pub max_success_spacing_ms: u64,
    pub success_spacing_step_ms: u64,
    pub success_recovery_threshold: usize,
    pub provider_503_backoff_ms: Vec<u64>,
    pub provider_connection_backoff_ms: Vec<u64>,
}

impl ProviderRequestSpacingConfig {
    #[must_use]
    pub fn stable() -> Self {
        Self {
            base_success_spacing_ms: 1_500,
            min_success_spacing_ms: 750,
            max_success_spacing_ms: 5_000,
            success_spacing_step_ms: 250,
            success_recovery_threshold: 4,
            provider_503_backoff_ms: vec![5_000, 10_000, 20_000],
            provider_connection_backoff_ms: vec![10_000, 20_000, 40_000],
        }
    }

    #[must_use]
    pub fn disabled() -> Self {
        Self {
            base_success_spacing_ms: 0,
            min_success_spacing_ms: 0,
            max_success_spacing_ms: 0,
            success_spacing_step_ms: 0,
            success_recovery_threshold: 4,
            provider_503_backoff_ms: Vec::new(),
            provider_connection_backoff_ms: Vec::new(),
        }
    }
}

impl Default for ProviderRequestSpacingConfig {
    fn default() -> Self {
        Self::stable()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchTranslatorConfig {
    pub project_id: Option<i64>,
    pub source_language: String,
    pub max_items_per_batch: usize,
    pub input_token_budget: usize,
    pub retry_attempts: usize,
    pub provider_spacing: ProviderRequestSpacingConfig,
    pub source_text_ids: Option<Vec<i64>>,
    pub include_existing_translations: bool,
    pub prompt_hash: String,
    pub adaptive_decision_reason: String,
}

#[must_use]
pub fn translation_prompt_hash(
    source_language: &str,
    target_language: &str,
    system_prompt: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"rpg-translator:prompt:v1");
    update_hash_field(&mut hasher, "source_language", source_language);
    update_hash_field(&mut hasher, "target_language", target_language);
    update_hash_field(&mut hasher, "system_prompt", system_prompt);
    hex::encode(hasher.finalize())
}

fn update_hash_field(hasher: &mut Sha256, name: &str, value: &str) {
    hasher.update(name.as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    hasher.update([0xff]);
}

impl Default for BatchTranslatorConfig {
    fn default() -> Self {
        Self {
            project_id: Option::<i64>::default(),
            source_language: String::default(),
            max_items_per_batch: 16,
            input_token_budget: 4096,
            retry_attempts: 1,
            provider_spacing: ProviderRequestSpacingConfig::stable(),
            source_text_ids: None,
            include_existing_translations: false,
            prompt_hash: String::default(),
            adaptive_decision_reason: "adaptive: no speed history loaded".to_string(),
        }
    }
}

impl BatchTranslatorConfig {
    fn planner_config(&self) -> BatchPlannerConfig {
        BatchPlannerConfig {
            max_items_per_batch: self.max_items_per_batch,
            input_token_budget: self.input_token_budget,
            source_text_ids: self
                .source_text_ids
                .as_ref()
                .map(|ids| ids.iter().copied().collect()),
            include_existing_translations: self.include_existing_translations,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdaptiveTranslationTuning {
    pub max_items_per_batch: usize,
    pub input_token_budget: usize,
    pub provider_spacing: ProviderRequestSpacingConfig,
    pub decision_reason: String,
}

#[must_use]
pub fn adaptive_translation_tuning_from_samples(
    samples: &[TranslationSpeedSample],
    requested_batch_size: usize,
    default_token_budget: usize,
    default_spacing: ProviderRequestSpacingConfig,
) -> AdaptiveTranslationTuning {
    let requested_batch_size = requested_batch_size.max(1);
    let default_token_budget = default_token_budget.max(1);
    let mut spacing = default_spacing;
    let success_samples = samples
        .iter()
        .filter(|sample| is_success_speed_sample(sample) && sample.total_elapsed_ms > 0)
        .collect::<Vec<_>>();
    if success_samples.is_empty() {
        let success_floor_ms = spacing.base_success_spacing_ms;
        return AdaptiveTranslationTuning {
            max_items_per_batch: requested_batch_size,
            input_token_budget: default_token_budget,
            provider_spacing: spacing,
            decision_reason: format!(
                "adaptive: no prior speed samples; using requested batch={requested_batch_size}, token_budget={default_token_budget}, success_floor={}ms",
                success_floor_ms
            ),
        };
    }

    let failure_count = samples
        .iter()
        .filter(|sample| !is_success_speed_sample(sample))
        .count();
    let failure_rate = failure_count as f64 / samples.len().max(1) as f64;
    let p95_ms = percentile_i64(
        &success_samples
            .iter()
            .map(|sample| sample.total_elapsed_ms)
            .collect::<Vec<_>>(),
        95,
    )
    .unwrap_or(0);
    let median_effective_batch = median_i64(
        &success_samples
            .iter()
            .map(|sample| sample.effective_batch_size.max(1))
            .collect::<Vec<_>>(),
    )
    .unwrap_or(requested_batch_size as i64)
    .clamp(1, 64) as usize;
    let mut suggested_batch = median_effective_batch.max(requested_batch_size);
    let mode = if failure_rate >= 0.10 || p95_ms >= 15_000 {
        suggested_batch = (suggested_batch / 2).max(1);
        spacing.base_success_spacing_ms = spacing.base_success_spacing_ms.max(1_500);
        "conservative"
    } else if failure_rate == 0.0 && p95_ms <= 5_000 {
        suggested_batch = suggested_batch.saturating_mul(2).clamp(1, 64);
        spacing.base_success_spacing_ms = spacing
            .base_success_spacing_ms
            .saturating_sub(spacing.success_spacing_step_ms)
            .max(spacing.min_success_spacing_ms);
        "accelerating"
    } else {
        "steady"
    };

    let token_budget = suggested_token_budget(&success_samples, suggested_batch)
        .unwrap_or(default_token_budget)
        .max(default_token_budget.min(1024))
        .clamp(1024, 8192);
    AdaptiveTranslationTuning {
        max_items_per_batch: suggested_batch,
        input_token_budget: token_budget,
        provider_spacing: spacing.clone(),
        decision_reason: format!(
            "adaptive: {mode} from {} samples; failure_rate={:.0}%; p95={}ms; batch={}; token_budget={}; success_floor={}ms",
            samples.len(),
            failure_rate * 100.0,
            p95_ms,
            suggested_batch,
            token_budget,
            spacing.base_success_spacing_ms
        ),
    }
}

fn is_success_speed_sample(sample: &TranslationSpeedSample) -> bool {
    sample.status.starts_with("success") || sample.status == "benchmark"
}

fn suggested_token_budget(
    samples: &[&TranslationSpeedSample],
    suggested_batch: usize,
) -> Option<usize> {
    let total_items = samples
        .iter()
        .map(|sample| sample.item_count.max(0) as usize)
        .sum::<usize>();
    if total_items == 0 {
        return None;
    }
    let total_tokens = samples
        .iter()
        .map(|sample| sample.estimated_token_count.max(0) as usize)
        .sum::<usize>();
    let tokens_per_item = total_tokens.div_ceil(total_items).max(1);
    Some(
        tokens_per_item
            .saturating_mul(suggested_batch)
            .saturating_mul(2),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRunReport {
    pub provider_run_id: i64,
    pub status: BatchRunStatus,
    pub initial_completed_source_text_count: usize,
    pub completed_source_text_ids: Vec<i64>,
    pub failed_source_text_ids: Vec<i64>,
    pub failure_details: Vec<BatchFailureDetail>,
    pub split_batches: usize,
    pub total_source_text_count: usize,
    pub total_batches: usize,
    pub processed_batches: usize,
    pub elapsed_ms: u64,
    pub eta_ms: Option<u64>,
    pub item_eta_ms: Option<u64>,
    pub batch_eta_ms: Option<u64>,
    pub last_batch_elapsed_ms: Option<u64>,
    pub avg_batch_elapsed_ms: Option<u64>,
    pub current_batch_items: usize,
    pub parse_failed_items: usize,
    pub validation_failed_items: usize,
    pub skipped_items: usize,
    pub censored_retry_count: usize,
    pub retry_pending_items: usize,
    pub recoverable_provider_failures: usize,
    pub final_failed_items: usize,
    pub provider_backoff_ms: Option<u64>,
    pub effective_batch_size: usize,
    pub next_experiment_batch_size: usize,
    pub input_token_budget: usize,
    pub speed_mode: String,
    pub success_streak: usize,
    pub success_delay_floor_ms: u64,
    pub next_delay_ms: Option<u64>,
    pub failure_reason_counts: BTreeMap<String, usize>,
    pub adaptive_decision_reason: String,
    pub legacy_checkpoint_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchFailureDetail {
    pub source_text_ids: Vec<i64>,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchRunStatus {
    Completed,
    CompletedWithFailures,
    Paused,
}

impl BatchRunStatus {
    #[must_use]
    pub fn as_key(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::CompletedWithFailures => "completed_with_failures",
            Self::Paused => "paused",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSpeedBenchmarkConfig {
    pub warmup_runs: usize,
    pub measured_runs: usize,
}

impl Default for ProviderSpeedBenchmarkConfig {
    fn default() -> Self {
        Self {
            warmup_runs: 1,
            measured_runs: 5,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderSpeedBenchmarkRun {
    pub run_index: usize,
    pub latency_ms: u64,
    pub item_count: usize,
    pub char_count: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderSpeedBenchmarkReport {
    pub warmup_ms: Option<u64>,
    pub runs: Vec<ProviderSpeedBenchmarkRun>,
    pub average_ms: Option<u64>,
    pub median_ms: Option<u64>,
    pub p95_ms: Option<u64>,
    pub items_per_minute: Option<f64>,
    pub chars_per_second: Option<f64>,
    pub estimated_paced_items_per_minute: Option<f64>,
    pub resolved_model: Option<String>,
}

pub struct ProviderSpeedBenchmark;

impl ProviderSpeedBenchmark {
    pub fn run(
        provider: &mut dyn ProviderClient,
        request: &ProviderBatchRequest,
        config: ProviderSpeedBenchmarkConfig,
        spacing: &ProviderRequestSpacingConfig,
    ) -> Result<ProviderSpeedBenchmarkReport> {
        if request.items.is_empty() {
            return Err(Error::invalid_input(
                "benchmark request requires at least one item",
            ));
        }
        let warmup_runs = config.warmup_runs;
        let measured_runs = config.measured_runs.max(1);
        let item_count = request.items.len();
        let char_count = request
            .items
            .iter()
            .map(|item| item.text.chars().count())
            .sum::<usize>();
        let mut warmup_ms = None;
        for index in 0..warmup_runs {
            let started = Instant::now();
            provider.translate_batch(request)?;
            if index == 0 {
                warmup_ms = Some(elapsed_ms(started));
            }
        }

        let mut runs = Vec::with_capacity(measured_runs);
        for run_index in 0..measured_runs {
            let started = Instant::now();
            provider.translate_batch(request)?;
            runs.push(ProviderSpeedBenchmarkRun {
                run_index: run_index + 1,
                latency_ms: elapsed_ms(started),
                item_count,
                char_count,
            });
        }

        let latencies = runs.iter().map(|run| run.latency_ms).collect::<Vec<_>>();
        let average_ms = average_latency_ms(&latencies);
        let median_ms = percentile_latency_ms(&latencies, 50);
        let p95_ms = percentile_latency_ms(&latencies, 95);
        let total_ms = latencies.iter().copied().sum::<u64>();
        let total_items = item_count.saturating_mul(runs.len());
        let total_chars = char_count.saturating_mul(runs.len());
        let items_per_minute = throughput_per_minute(total_items, total_ms);
        let chars_per_second = throughput_per_second(total_chars, total_ms);
        let estimated_paced_items_per_minute = average_ms.and_then(|latency_ms| {
            let delay_ms = success_delay_ms(latency_ms, spacing, spacing.base_success_spacing_ms);
            throughput_per_minute(item_count, latency_ms.saturating_add(delay_ms))
        });

        Ok(ProviderSpeedBenchmarkReport {
            warmup_ms,
            runs,
            average_ms,
            median_ms,
            p95_ms,
            items_per_minute,
            chars_per_second,
            estimated_paced_items_per_minute,
            resolved_model: provider.model_name().map(str::to_string),
        })
    }
}

pub struct BatchTranslator;

impl BatchTranslator {
    pub fn run(
        db: &mut TranslationDb,
        provider: &mut dyn ProviderClient,
        target_language: &str,
        config: BatchTranslatorConfig,
    ) -> Result<BatchRunReport> {
        Self::run_with_checkpoint(db, provider, target_language, config, Option::<&Path>::None)
    }

    pub fn run_with_checkpoint(
        db: &mut TranslationDb,
        provider: &mut dyn ProviderClient,
        target_language: &str,
        config: BatchTranslatorConfig,
        checkpoint_path: Option<&Path>,
    ) -> Result<BatchRunReport> {
        Self::run_with_checkpoint_and_progress(
            db,
            provider,
            target_language,
            config,
            checkpoint_path,
            |_| {},
            || false,
        )
    }

    pub fn run_with_checkpoint_and_progress<F, P>(
        db: &mut TranslationDb,
        provider: &mut dyn ProviderClient,
        target_language: &str,
        config: BatchTranslatorConfig,
        checkpoint_path: Option<&Path>,
        mut on_progress: F,
        mut should_pause: P,
    ) -> Result<BatchRunReport>
    where
        F: FnMut(&TranslateProgressEvent),
        P: FnMut() -> bool,
    {
        let mut checkpoint = match checkpoint_path {
            Some(path) => CheckpointWriter::read(path)?.unwrap_or_else(|| BatchCheckpoint {
                provider_run_id: 0,
                target_language: target_language.to_string(),
                completed_source_text_ids: Vec::new(),
                failed_source_text_ids: Vec::new(),
                failure_details: Vec::new(),
            }),
            None => BatchCheckpoint {
                provider_run_id: 0,
                target_language: target_language.to_string(),
                completed_source_text_ids: Vec::new(),
                failed_source_text_ids: Vec::new(),
                failure_details: Vec::new(),
            },
        };
        if checkpoint.target_language != target_language {
            return Err(Error::invalid_input(format!(
                "checkpoint target language {} does not match {target_language}",
                checkpoint.target_language
            )));
        }

        let provider_run_id = db.start_provider_run(&NewProviderRun {
            provider: provider.provider_name().to_string(),
            model: provider.model_name().map(str::to_string),
            request_settings_json: "{}".to_string(),
        })?;
        checkpoint.provider_run_id = provider_run_id;

        let mut completed_set: BTreeSet<i64> = checkpoint
            .completed_source_text_ids
            .iter()
            .copied()
            .collect();
        if config.include_existing_translations
            && let Some(source_text_ids) = config.source_text_ids.as_ref()
        {
            for source_text_id in source_text_ids {
                completed_set.remove(source_text_id);
            }
        }
        let plan = BatchPlanner::plan_with_completed(
            db,
            target_language,
            config.planner_config(),
            &completed_set,
        )?;
        let total_batches = plan.batches.len();
        let initial_completed_source_text_count = completed_set.len();
        let total_source_text_count = initial_completed_source_text_count
            + plan
                .jobs
                .iter()
                .map(|job| job.source_text_ids.len())
                .sum::<usize>();
        let started = Instant::now();
        let mut report = BatchRunReport {
            provider_run_id,
            status: BatchRunStatus::Completed,
            initial_completed_source_text_count,
            completed_source_text_ids: Vec::new(),
            failed_source_text_ids: Vec::new(),
            failure_details: Vec::new(),
            split_batches: 0,
            total_source_text_count,
            total_batches,
            processed_batches: 0,
            elapsed_ms: 0,
            eta_ms: None,
            item_eta_ms: None,
            batch_eta_ms: None,
            last_batch_elapsed_ms: None,
            avg_batch_elapsed_ms: None,
            current_batch_items: 0,
            parse_failed_items: 0,
            validation_failed_items: 0,
            skipped_items: 0,
            censored_retry_count: 0,
            retry_pending_items: 0,
            recoverable_provider_failures: 0,
            final_failed_items: 0,
            provider_backoff_ms: None,
            effective_batch_size: config.max_items_per_batch.max(1),
            next_experiment_batch_size: config.max_items_per_batch.max(1),
            input_token_budget: config.input_token_budget.max(1),
            speed_mode: "steady".to_string(),
            success_streak: 0,
            success_delay_floor_ms: config.provider_spacing.base_success_spacing_ms,
            next_delay_ms: None,
            failure_reason_counts: BTreeMap::new(),
            adaptive_decision_reason: config.adaptive_decision_reason.clone(),
            legacy_checkpoint_only: false,
        };
        persist_translation_job_progress(
            db,
            &report,
            &config,
            target_language,
            checkpoint_path,
            provider.model_name(),
            "running",
        )?;
        emit_batch_progress(
            &mut on_progress,
            TranslateProgressKind::Started,
            &report,
            target_language,
            provider.model_name(),
            started,
        );

        {
            let mut processor = BatchProcessor {
                db,
                provider,
                target_language,
                config: &config,
                report: &mut report,
                checkpoint: &mut checkpoint,
                checkpoint_path,
                provider_run_id,
                on_progress: &mut on_progress,
                should_pause: &mut should_pause,
                started,
                recent_success_batch_elapsed_ms: VecDeque::new(),
            };
            let mut total_batch_elapsed_ms = 0u64;
            for batch in &plan.batches {
                processor.report.current_batch_items = batch
                    .iter()
                    .map(|job| job.source_text_ids.len())
                    .sum::<usize>();
                processor.emit_progress(TranslateProgressKind::BatchStarted);
                let batch_started = Instant::now();
                if let Err(error) = processor.process(batch) {
                    if is_pause_abort_error(&error) {
                        processor.report.status = BatchRunStatus::Paused;
                        persist_translation_job_progress(
                            processor.db,
                            processor.report,
                            &config,
                            target_language,
                            checkpoint_path,
                            processor.provider.model_name(),
                            processor.report.status.as_key(),
                        )?;
                        processor.emit_progress(TranslateProgressKind::PauseRequested);
                        break;
                    }
                    return Err(error);
                }
                let batch_elapsed_ms = elapsed_ms(batch_started);
                total_batch_elapsed_ms = total_batch_elapsed_ms.saturating_add(batch_elapsed_ms);
                processor.report.processed_batches += 1;
                processor.report.elapsed_ms = elapsed_ms(started);
                processor.report.batch_eta_ms = estimate_batch_eta_ms_with_recent(
                    processor.report.processed_batches,
                    processor.report.total_batches,
                    processor.report.elapsed_ms,
                    processor.report.avg_batch_elapsed_ms,
                );
                processor.report.item_eta_ms = estimate_item_eta_ms(
                    processor.report.initial_completed_source_text_count,
                    processor.report.initial_completed_source_text_count
                        + processor.report.completed_source_text_ids.len(),
                    processor.report.total_source_text_count,
                    processor.report.elapsed_ms,
                );
                processor.report.eta_ms = processor
                    .report
                    .batch_eta_ms
                    .or(processor.report.item_eta_ms);
                processor.report.last_batch_elapsed_ms = Some(batch_elapsed_ms);
                if processor.report.avg_batch_elapsed_ms.is_none() {
                    processor.report.avg_batch_elapsed_ms = Some(
                        total_batch_elapsed_ms
                            / u64::try_from(processor.report.processed_batches).unwrap_or(1),
                    );
                }
                persist_translation_job_progress(
                    processor.db,
                    processor.report,
                    &config,
                    target_language,
                    checkpoint_path,
                    processor.provider.model_name(),
                    "running",
                )?;
                processor.emit_progress(TranslateProgressKind::BatchFinished);
                if (processor.should_pause)() {
                    processor.report.status = BatchRunStatus::Paused;
                    persist_translation_job_progress(
                        processor.db,
                        processor.report,
                        &config,
                        target_language,
                        checkpoint_path,
                        processor.provider.model_name(),
                        processor.report.status.as_key(),
                    )?;
                    processor.emit_progress(TranslateProgressKind::PauseRequested);
                    break;
                }
            }
        }

        if report.status != BatchRunStatus::Paused {
            report.status = if report.failed_source_text_ids.is_empty() {
                BatchRunStatus::Completed
            } else {
                BatchRunStatus::CompletedWithFailures
            };
        }
        let failure_detail = if report.failed_source_text_ids.is_empty() {
            None
        } else {
            Some("one or more batch items failed validation")
        };
        report.elapsed_ms = elapsed_ms(started);
        report.batch_eta_ms = estimate_batch_eta_ms_with_recent(
            report.processed_batches,
            report.total_batches,
            report.elapsed_ms,
            report.avg_batch_elapsed_ms,
        );
        report.item_eta_ms = estimate_item_eta_ms(
            report.initial_completed_source_text_count,
            report.initial_completed_source_text_count + report.completed_source_text_ids.len(),
            report.total_source_text_count,
            report.elapsed_ms,
        );
        report.eta_ms = report.batch_eta_ms.or(report.item_eta_ms);
        db.finish_provider_run(provider_run_id, report.status.as_key(), failure_detail)?;
        persist_translation_job_progress(
            db,
            &report,
            &config,
            target_language,
            checkpoint_path,
            provider.model_name(),
            report.status.as_key(),
        )?;
        match (checkpoint_path, report.status) {
            (Some(path), BatchRunStatus::Completed) => {
                CheckpointWriter::remove_if_exists(path)?;
            }
            (Some(path), _) => {
                CheckpointWriter::write_atomic(path, &checkpoint)?;
            }
            (None, _) => {}
        }
        emit_batch_progress(
            &mut on_progress,
            if report.status == BatchRunStatus::Paused {
                TranslateProgressKind::Paused
            } else {
                TranslateProgressKind::Completed
            },
            &report,
            target_language,
            provider.model_name(),
            started,
        );
        Ok(report)
    }
}

enum TranslateProgressKind {
    Started,
    BatchStarted,
    ProviderBackoff,
    BatchFinished,
    PauseRequested,
    Paused,
    Completed,
}

fn emit_batch_progress<F>(
    on_progress: &mut F,
    kind: TranslateProgressKind,
    report: &BatchRunReport,
    target_language: &str,
    model: Option<&str>,
    started: Instant,
) where
    F: FnMut(&TranslateProgressEvent) + ?Sized,
{
    let snapshot = TranslateProgressSnapshot {
        provider_run_id: report.provider_run_id,
        target_language: target_language.to_string(),
        model: model.map(str::to_string),
        total_batches: report.total_batches,
        processed_batches: report.processed_batches,
        total_items: report.total_source_text_count,
        completed_items: report.initial_completed_source_text_count
            + report.completed_source_text_ids.len(),
        failed_items: report.failed_source_text_ids.len(),
        split_batches: report.split_batches,
        elapsed_ms: elapsed_ms(started),
        eta_ms: report.batch_eta_ms.or(report.item_eta_ms),
        item_eta_ms: report.item_eta_ms,
        batch_eta_ms: estimate_batch_eta_ms_with_recent(
            report.processed_batches,
            report.total_batches,
            elapsed_ms(started),
            report.avg_batch_elapsed_ms,
        ),
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
        next_experiment_batch_size: report.next_experiment_batch_size,
        input_token_budget: report.input_token_budget,
        speed_mode: report.speed_mode.clone(),
        success_streak: report.success_streak,
        success_delay_floor_ms: report.success_delay_floor_ms,
        next_delay_ms: report.next_delay_ms,
        failure_reason_counts: report.failure_reason_counts.clone(),
        adaptive_decision_reason: report.adaptive_decision_reason.clone(),
        legacy_checkpoint_only: report.legacy_checkpoint_only,
    };
    let event = progress_event_from_snapshot(kind, snapshot);
    on_progress(&event);
}

fn progress_event_from_snapshot(
    kind: TranslateProgressKind,
    snapshot: TranslateProgressSnapshot,
) -> TranslateProgressEvent {
    match kind {
        TranslateProgressKind::Started => TranslateProgressEvent::Started(snapshot),
        TranslateProgressKind::BatchStarted => TranslateProgressEvent::BatchStarted(snapshot),
        TranslateProgressKind::ProviderBackoff => TranslateProgressEvent::ProviderBackoff(snapshot),
        TranslateProgressKind::BatchFinished => TranslateProgressEvent::BatchFinished(snapshot),
        TranslateProgressKind::PauseRequested => TranslateProgressEvent::PauseRequested(snapshot),
        TranslateProgressKind::Paused => TranslateProgressEvent::Paused(snapshot),
        TranslateProgressKind::Completed => TranslateProgressEvent::Completed(snapshot),
    }
}

fn persist_translation_job_progress(
    db: &mut TranslationDb,
    report: &BatchRunReport,
    config: &BatchTranslatorConfig,
    target_language: &str,
    checkpoint_path: Option<&Path>,
    model: Option<&str>,
    status: &str,
) -> Result<()> {
    db.upsert_translation_job_progress(&TranslationJobProgressUpdate {
        provider_run_id: report.provider_run_id,
        project_id: config.project_id,
        source_language: config.source_language.clone(),
        target_language: target_language.to_string(),
        checkpoint_path: checkpoint_path
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        status: status.to_string(),
        completed_items: usize_to_i64(
            report.initial_completed_source_text_count + report.completed_source_text_ids.len(),
        ),
        failed_items: usize_to_i64(report.failed_source_text_ids.len()),
        total_items: usize_to_i64(report.total_source_text_count),
        processed_batches: usize_to_i64(report.processed_batches),
        total_batches: usize_to_i64(report.total_batches),
        split_batches: usize_to_i64(report.split_batches),
        parse_failed_items: usize_to_i64(report.parse_failed_items),
        validation_failed_items: usize_to_i64(report.validation_failed_items),
        skipped_items: usize_to_i64(report.skipped_items),
        censored_retry_count: usize_to_i64(report.censored_retry_count),
        item_eta_ms: report.item_eta_ms.map(u64_to_i64),
        batch_eta_ms: report.batch_eta_ms.map(u64_to_i64),
        last_batch_elapsed_ms: report.last_batch_elapsed_ms.map(u64_to_i64),
        avg_batch_elapsed_ms: report.avg_batch_elapsed_ms.map(u64_to_i64),
        current_batch_items: usize_to_i64(report.current_batch_items),
        elapsed_ms: u64_to_i64(report.elapsed_ms),
        model: model.map(str::to_string),
        retry_pending_items: usize_to_i64(report.retry_pending_items),
        recoverable_provider_failures: usize_to_i64(report.recoverable_provider_failures),
        final_failed_items: usize_to_i64(report.final_failed_items),
        provider_backoff_ms: report.provider_backoff_ms.map(u64_to_i64),
        effective_batch_size: usize_to_i64(report.effective_batch_size),
        next_experiment_batch_size: usize_to_i64(report.next_experiment_batch_size),
        input_token_budget: usize_to_i64(report.input_token_budget),
        speed_mode: report.speed_mode.clone(),
        success_streak: usize_to_i64(report.success_streak),
        success_delay_floor_ms: u64_to_i64(report.success_delay_floor_ms),
        next_delay_ms: report.next_delay_ms.map(u64_to_i64),
        failure_reason_counts_json: serde_json::to_string(&report.failure_reason_counts)
            .unwrap_or_else(|_| "{}".to_string()),
        adaptive_decision_reason: report.adaptive_decision_reason.clone(),
        legacy_checkpoint_only: report.legacy_checkpoint_only,
    })?;
    Ok(())
}

fn usize_to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn u64_to_i64(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn estimate_batch_eta_ms(
    processed_batches: usize,
    total_batches: usize,
    elapsed_ms: u64,
) -> Option<u64> {
    if processed_batches == 0 || processed_batches >= total_batches {
        return None;
    }
    let remaining = total_batches - processed_batches;
    let average = elapsed_ms / processed_batches as u64;
    Some(average.saturating_mul(remaining as u64))
}

fn estimate_batch_eta_ms_with_recent(
    processed_batches: usize,
    total_batches: usize,
    elapsed_ms: u64,
    recent_batch_ms: Option<u64>,
) -> Option<u64> {
    if processed_batches == 0 || processed_batches >= total_batches {
        return None;
    }
    let remaining = total_batches - processed_batches;
    let Some(average) = recent_batch_ms else {
        return estimate_batch_eta_ms(processed_batches, total_batches, elapsed_ms);
    };
    Some(average.saturating_mul(remaining as u64))
}

fn median_nonempty_ms(mut values: Vec<u64>) -> Option<u64> {
    if values.is_empty() {
        return None;
    }
    values.sort_unstable();
    Some(values[values.len() / 2])
}

fn estimate_item_eta_ms(
    started_completed_items: usize,
    completed_items: usize,
    total_items: usize,
    elapsed_ms: u64,
) -> Option<u64> {
    if completed_items >= total_items {
        return None;
    }
    let newly_completed = completed_items.saturating_sub(started_completed_items);
    if newly_completed == 0 {
        return None;
    }
    let remaining = total_items - completed_items;
    let average = elapsed_ms / newly_completed as u64;
    Some(average.saturating_mul(remaining as u64))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchCheckpoint {
    pub provider_run_id: i64,
    pub target_language: String,
    pub completed_source_text_ids: Vec<i64>,
    pub failed_source_text_ids: Vec<i64>,
    #[serde(default)]
    pub failure_details: Vec<CheckpointFailureDetail>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointFailureDetail {
    pub source_text_id: i64,
    pub finding_type: String,
    pub message: String,
    pub provider_run_id: Option<i64>,
    pub created_at_ms: u64,
}

pub struct CheckpointWriter;

impl CheckpointWriter {
    pub fn read(path: &Path) -> Result<Option<BatchCheckpoint>> {
        if !path.is_file() {
            return Ok(None);
        }
        let text = fs::read_to_string(path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to read checkpoint {}: {error}",
                path.display()
            ))
        })?;
        let checkpoint = serde_json::from_str(&text).map_err(|error| {
            Error::invalid_input(format!(
                "failed to parse checkpoint {}: {error}",
                path.display()
            ))
        })?;
        Ok(Some(checkpoint))
    }

    pub fn write_atomic(path: &Path, checkpoint: &BatchCheckpoint) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                Error::invalid_input(format!(
                    "failed to create checkpoint directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        let text = serde_json::to_string_pretty(checkpoint).map_err(|error| {
            Error::invalid_input(format!("failed to encode checkpoint: {error}"))
        })?;
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, format!("{text}\n")).map_err(|error| {
            Error::invalid_input(format!(
                "failed to write checkpoint temp file {}: {error}",
                temp_path.display()
            ))
        })?;
        fs::rename(&temp_path, path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to commit checkpoint {}: {error}",
                path.display()
            ))
        })?;
        Ok(())
    }

    pub fn remove_if_exists(path: &Path) -> Result<()> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(Error::invalid_input(format!(
                "failed to remove checkpoint {}: {error}",
                path.display()
            ))),
        }
    }
}

struct BatchProcessor<'a> {
    db: &'a mut TranslationDb,
    provider: &'a mut dyn ProviderClient,
    target_language: &'a str,
    config: &'a BatchTranslatorConfig,
    report: &'a mut BatchRunReport,
    checkpoint: &'a mut BatchCheckpoint,
    checkpoint_path: Option<&'a Path>,
    provider_run_id: i64,
    on_progress: &'a mut dyn FnMut(&TranslateProgressEvent),
    should_pause: &'a mut dyn FnMut() -> bool,
    started: Instant,
    recent_success_batch_elapsed_ms: VecDeque<u64>,
}

impl BatchProcessor<'_> {
    fn emit_progress(&mut self, kind: TranslateProgressKind) {
        emit_batch_progress(
            self.on_progress,
            kind,
            self.report,
            self.target_language,
            self.provider.model_name(),
            self.started,
        );
    }

    fn process(&mut self, batch: &[BatchJob]) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let effective_batch_size = self.report.effective_batch_size.max(1);
        if batch.len() > effective_batch_size {
            for chunk in batch.chunks(effective_batch_size) {
                self.process(chunk)?;
            }
            return Ok(());
        }

        let mut last_error = Error::invalid_input("batch failed without provider call");
        for _attempt in 0..=self.config.retry_attempts {
            let request = ProviderBatchRequest {
                items: batch
                    .iter()
                    .map(|job| ProviderBatchItem {
                        id: job.id,
                        text: job.provider_text.clone(),
                    })
                    .collect(),
                instruction: None,
            };
            let request_started = Instant::now();
            match self.provider.translate_batch(&request) {
                Ok(response) => match BatchValidator::validate(&response.raw_output, batch) {
                    Ok(translations) => {
                        self.report.retry_pending_items = 0;
                        self.report.provider_backoff_ms = None;
                        let request_elapsed_ms = elapsed_ms(request_started);
                        let success_delay_ms =
                            self.note_successful_provider_batch(request_elapsed_ms);
                        let (translations, censored) =
                            split_censored_translations(batch, translations);
                        persist_translations(
                            self.db,
                            self.target_language,
                            self.provider,
                            self.provider_run_id,
                            translations,
                            self.report,
                            self.checkpoint,
                        )?;
                        for censored_translation in censored {
                            self.report.censored_retry_count +=
                                censored_translation.translation.source_text_ids.len();
                            self.retry_censored_translation(censored_translation)?;
                        }
                        if let Some(path) = self.checkpoint_path {
                            CheckpointWriter::write_atomic(path, self.checkpoint)?;
                        }
                        self.record_speed_sample(
                            batch,
                            request_elapsed_ms,
                            success_delay_ms,
                            "success",
                            None,
                        )?;
                        return Ok(());
                    }
                    Err(error) => {
                        last_error = error;
                    }
                },
                Err(error) => {
                    if is_pause_abort_error(&error) {
                        return Err(error);
                    }
                    if let Some(reason) = ProviderFailureReason::classify(&error) {
                        self.retry_provider_failure(batch, reason, error)?;
                        return Ok(());
                    }
                    last_error = error;
                }
            }
        }

        self.record_validation_failure_or_split(batch, &last_error.to_string())
    }

    fn record_validation_failure_or_split(
        &mut self,
        batch: &[BatchJob],
        message: &str,
    ) -> Result<()> {
        if batch.len() > 1 {
            self.report.split_batches += 1;
            let midpoint = batch.len() / 2;
            self.process(&batch[..midpoint])?;
            self.process(&batch[midpoint..])?;
            return Ok(());
        }

        let failed_job = &batch[0];
        let message = message.to_string();
        let finding_type = finding_type_for_batch_message(&message);
        if finding_type == "provider-json-parse" {
            self.report.parse_failed_items += failed_job.source_text_ids.len();
        } else {
            self.report.validation_failed_items += failed_job.source_text_ids.len();
        }
        for source_text_id in &failed_job.source_text_ids {
            push_unique(&mut self.report.failed_source_text_ids, *source_text_id);
            push_unique(&mut self.checkpoint.failed_source_text_ids, *source_text_id);
            self.record_checkpoint_failure(*source_text_id, finding_type, &message);
            self.db.insert_qa_finding(&NewQaFinding {
                source_text_id: *source_text_id,
                translation_id: None,
                target_language: Some(self.target_language.to_string()),
                provider_run_id: Some(self.provider_run_id),
                finding_type: finding_type.to_string(),
                severity: "error".to_string(),
                message: message.clone(),
                status: "open".to_string(),
                details_json: "{}".to_string(),
            })?;
        }
        self.report.final_failed_items = self.report.failed_source_text_ids.len();
        self.report.failure_details.push(BatchFailureDetail {
            source_text_ids: failed_job.source_text_ids.clone(),
            message,
        });
        if let Some(path) = self.checkpoint_path {
            CheckpointWriter::write_atomic(path, self.checkpoint)?;
        }
        Ok(())
    }

    fn retry_provider_failure(
        &mut self,
        batch: &[BatchJob],
        reason: ProviderFailureReason,
        first_error: Error,
    ) -> Result<()> {
        let source_count = count_batch_source_text_ids(batch);
        let mut last_message = first_error.to_string();
        let schedule = reason
            .backoff_schedule(&self.config.provider_spacing)
            .to_vec();
        if schedule.is_empty() {
            self.record_final_provider_failure(batch, reason, &last_message)?;
            return Ok(());
        }
        for backoff_ms in schedule {
            self.note_recoverable_provider_failure(reason, source_count, Some(backoff_ms));
            if self.report.recoverable_provider_failures >= source_count.saturating_mul(2)
                && self.report.effective_batch_size > 1
            {
                self.report.effective_batch_size = (self.report.effective_batch_size / 2).max(1);
            }
            self.report.next_experiment_batch_size = self.report.effective_batch_size;
            persist_translation_job_progress(
                self.db,
                self.report,
                self.config,
                self.target_language,
                self.checkpoint_path,
                self.provider.model_name(),
                "running",
            )?;
            self.emit_progress(TranslateProgressKind::ProviderBackoff);
            sleep_or_pause(backoff_ms, &mut *self.should_pause)?;
            let request = ProviderBatchRequest {
                items: batch
                    .iter()
                    .map(|job| ProviderBatchItem {
                        id: job.id,
                        text: job.provider_text.clone(),
                    })
                    .collect(),
                instruction: None,
            };
            let request_started = Instant::now();
            match self.provider.translate_batch(&request) {
                Ok(response) => match BatchValidator::validate(&response.raw_output, batch) {
                    Ok(translations) => {
                        self.report.retry_pending_items = 0;
                        self.report.provider_backoff_ms = None;
                        let request_elapsed_ms = elapsed_ms(request_started);
                        let success_delay_ms =
                            self.note_successful_provider_batch(request_elapsed_ms);
                        let (translations, censored) =
                            split_censored_translations(batch, translations);
                        persist_translations(
                            self.db,
                            self.target_language,
                            self.provider,
                            self.provider_run_id,
                            translations,
                            self.report,
                            self.checkpoint,
                        )?;
                        for censored_translation in censored {
                            self.report.censored_retry_count +=
                                censored_translation.translation.source_text_ids.len();
                            self.retry_censored_translation(censored_translation)?;
                        }
                        if let Some(path) = self.checkpoint_path {
                            CheckpointWriter::write_atomic(path, self.checkpoint)?;
                        }
                        self.record_speed_sample(
                            batch,
                            request_elapsed_ms,
                            success_delay_ms,
                            "success_after_retry",
                            None,
                        )?;
                        return Ok(());
                    }
                    Err(error) => {
                        self.report.retry_pending_items = 0;
                        self.report.provider_backoff_ms = None;
                        return self.record_validation_failure_or_split(batch, &error.to_string());
                    }
                },
                Err(error) => {
                    if is_pause_abort_error(&error) {
                        return Err(error);
                    }
                    if let Some(next_reason) = ProviderFailureReason::classify(&error) {
                        last_message = error.to_string();
                        if next_reason != reason {
                            self.note_recoverable_provider_failure(next_reason, source_count, None);
                        }
                    } else {
                        self.report.retry_pending_items = 0;
                        self.report.provider_backoff_ms = None;
                        return self.record_validation_failure_or_split(batch, &error.to_string());
                    }
                }
            }
        }
        self.record_final_provider_failure(batch, reason, &last_message)
    }

    fn note_recoverable_provider_failure(
        &mut self,
        reason: ProviderFailureReason,
        source_count: usize,
        backoff_ms: Option<u64>,
    ) {
        self.report.retry_pending_items = source_count;
        self.report.provider_backoff_ms = backoff_ms;
        self.report.next_delay_ms = backoff_ms;
        self.report.speed_mode = "backoff".to_string();
        self.report.success_streak = 0;
        self.report.success_delay_floor_ms = self.config.provider_spacing.base_success_spacing_ms;
        self.report.recoverable_provider_failures = self
            .report
            .recoverable_provider_failures
            .saturating_add(source_count);
        *self
            .report
            .failure_reason_counts
            .entry(reason.as_key().to_string())
            .or_insert(0) += source_count;
    }

    fn note_successful_provider_batch(&mut self, request_elapsed_ms: u64) -> u64 {
        self.report.provider_backoff_ms = None;
        self.report.success_streak = self.report.success_streak.saturating_add(1);
        self.report.speed_mode = "steady".to_string();

        let threshold = self
            .config
            .provider_spacing
            .success_recovery_threshold
            .max(1);
        if self.report.success_streak.is_multiple_of(threshold) {
            let max_batch = self.config.max_items_per_batch.max(1);
            if self.report.effective_batch_size < max_batch {
                self.report.effective_batch_size = self
                    .report
                    .effective_batch_size
                    .saturating_mul(2)
                    .min(max_batch);
                self.report.speed_mode = "recovering".to_string();
            }
            let floor_before = self.report.success_delay_floor_ms;
            let floor_after = floor_before
                .saturating_sub(self.config.provider_spacing.success_spacing_step_ms)
                .max(self.config.provider_spacing.min_success_spacing_ms);
            if floor_after < floor_before {
                self.report.success_delay_floor_ms = floor_after;
                if self.report.speed_mode == "steady" {
                    self.report.speed_mode = "accelerating".to_string();
                }
            }
        }
        self.report.next_experiment_batch_size = self.report.effective_batch_size;

        let delay_ms = success_delay_ms(
            request_elapsed_ms,
            &self.config.provider_spacing,
            self.report.success_delay_floor_ms,
        );
        self.recent_success_batch_elapsed_ms
            .push_back(request_elapsed_ms.saturating_add(delay_ms));
        while self.recent_success_batch_elapsed_ms.len() > 12 {
            self.recent_success_batch_elapsed_ms.pop_front();
        }
        self.report.avg_batch_elapsed_ms = median_nonempty_ms(
            self.recent_success_batch_elapsed_ms
                .iter()
                .copied()
                .collect(),
        );
        self.report.next_delay_ms = (delay_ms > 0).then_some(delay_ms);
        sleep_success_delay(delay_ms);
        delay_ms
    }

    fn record_speed_sample(
        &mut self,
        batch: &[BatchJob],
        request_elapsed_ms: u64,
        success_delay_ms: u64,
        status: &str,
        failure_type: Option<&str>,
    ) -> Result<()> {
        self.db
            .insert_translation_speed_sample(&NewTranslationSpeedSample {
                provider_run_id: self.provider_run_id,
                batch_index: usize_to_i64(self.report.processed_batches.saturating_add(1)),
                lane: batch_lane_key(batch).to_string(),
                item_count: usize_to_i64(batch.len()),
                char_count: usize_to_i64(batch_char_count(batch)),
                estimated_token_count: usize_to_i64(batch_token_estimate(batch)),
                request_elapsed_ms: u64_to_i64(request_elapsed_ms),
                success_delay_ms: u64_to_i64(success_delay_ms),
                total_elapsed_ms: u64_to_i64(request_elapsed_ms.saturating_add(success_delay_ms)),
                status: status.to_string(),
                failure_type: failure_type.map(str::to_string),
                effective_batch_size: usize_to_i64(self.report.effective_batch_size),
                adaptive_decision_reason: self.report.adaptive_decision_reason.clone(),
                model: self.provider.model_name().map(str::to_string),
                prompt_hash: self.config.prompt_hash.clone(),
            })?;
        Ok(())
    }

    fn record_final_provider_failure(
        &mut self,
        batch: &[BatchJob],
        reason: ProviderFailureReason,
        message: &str,
    ) -> Result<()> {
        self.report.retry_pending_items = 0;
        self.report.provider_backoff_ms = None;
        let source_text_ids = batch
            .iter()
            .flat_map(|job| job.source_text_ids.iter().copied())
            .collect::<Vec<_>>();
        self.record_failure(
            &source_text_ids,
            "final-failed",
            &format!("{}: {message}", reason.as_key()),
        )?;
        self.report.final_failed_items = self.report.failed_source_text_ids.len();
        Ok(())
    }

    fn retry_censored_translation(&mut self, censored: CensoredTranslation) -> Result<()> {
        let retry_instruction = "Do not censor, mask, redact, omit, or replace any word with asterisks. Translate the source meaning directly.";
        let retry_batch = [censored.job.clone()];
        let request = ProviderBatchRequest {
            items: vec![ProviderBatchItem {
                id: retry_batch[0].id,
                text: retry_batch[0].provider_text.clone(),
            }],
            instruction: Some(retry_instruction.to_string()),
        };
        let response = self.provider.translate_batch(&request);
        if let Err(error) = &response
            && is_pause_abort_error(error)
        {
            return Err(Error::invalid_input(
                "translation paused; provider request aborted",
            ));
        }
        let retry_result = response
            .and_then(|response| BatchValidator::validate(&response.raw_output, &retry_batch));
        match retry_result {
            Ok(translations) => {
                let (translations, censored) =
                    split_censored_translations(&retry_batch, translations);
                if !censored.is_empty() {
                    self.record_censored_failure(&retry_batch[0].source_text_ids)?;
                    return Ok(());
                }
                persist_translations(
                    self.db,
                    self.target_language,
                    self.provider,
                    self.provider_run_id,
                    translations,
                    self.report,
                    self.checkpoint,
                )?;
            }
            Err(error) => {
                self.record_failure(
                    &retry_batch[0].source_text_ids,
                    "final-failed",
                    &format!("censored output retry failed: {error}"),
                )?;
            }
        }
        Ok(())
    }

    fn record_censored_failure(&mut self, source_text_ids: &[i64]) -> Result<()> {
        self.record_failure(
            source_text_ids,
            "final-failed",
            "provider censored translation output after retry",
        )
    }

    fn record_failure(
        &mut self,
        source_text_ids: &[i64],
        finding_type: &str,
        message: &str,
    ) -> Result<()> {
        for source_text_id in source_text_ids {
            push_unique(&mut self.report.failed_source_text_ids, *source_text_id);
            push_unique(&mut self.checkpoint.failed_source_text_ids, *source_text_id);
            self.record_checkpoint_failure(*source_text_id, finding_type, message);
            self.db.insert_qa_finding(&NewQaFinding {
                source_text_id: *source_text_id,
                translation_id: None,
                target_language: Some(self.target_language.to_string()),
                provider_run_id: Some(self.provider_run_id),
                finding_type: finding_type.to_string(),
                severity: "error".to_string(),
                message: message.to_string(),
                status: "open".to_string(),
                details_json: "{}".to_string(),
            })?;
        }
        self.report.failure_details.push(BatchFailureDetail {
            source_text_ids: source_text_ids.to_vec(),
            message: message.to_string(),
        });
        self.report.final_failed_items = self.report.failed_source_text_ids.len();
        Ok(())
    }

    fn record_checkpoint_failure(
        &mut self,
        source_text_id: i64,
        finding_type: &str,
        message: &str,
    ) {
        self.checkpoint
            .failure_details
            .retain(|detail| detail.source_text_id != source_text_id);
        self.checkpoint
            .failure_details
            .push(CheckpointFailureDetail {
                source_text_id,
                finding_type: finding_type.to_string(),
                message: message.to_string(),
                provider_run_id: Some(self.provider_run_id),
                created_at_ms: elapsed_ms(self.started),
            });
    }
}

fn finding_type_for_batch_message(message: &str) -> &'static str {
    if message.contains("invalid provider output JSON")
        || message.contains("provider returned markdown fence")
        || message.contains("provider returned think tag")
        || message.contains("provider returned empty output")
        || message.contains("provider output")
    {
        "provider-json-parse"
    } else {
        "translation-validation"
    }
}

fn is_pause_abort_error(error: &Error) -> bool {
    matches!(
        error,
        Error::InvalidInput { message }
            if message.contains("translation paused; provider request aborted")
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProviderFailureReason {
    ServiceUnavailable503,
    Connection,
}

impl ProviderFailureReason {
    fn classify(error: &Error) -> Option<Self> {
        let message = error.to_string().to_ascii_lowercase();
        if message.contains("503") || message.contains("service unavailable") {
            return Some(Self::ServiceUnavailable503);
        }
        if message.contains("local provider request failed")
            || message.contains("error sending request")
            || message.contains("connection refused")
            || message.contains("connection reset")
            || message.contains("operation timed out")
        {
            return Some(Self::Connection);
        }
        None
    }

    fn as_key(self) -> &'static str {
        match self {
            Self::ServiceUnavailable503 => "provider-503",
            Self::Connection => "provider-connection",
        }
    }

    fn backoff_schedule(self, config: &ProviderRequestSpacingConfig) -> &[u64] {
        match self {
            Self::ServiceUnavailable503 => &config.provider_503_backoff_ms,
            Self::Connection => &config.provider_connection_backoff_ms,
        }
    }
}

fn count_batch_source_text_ids(batch: &[BatchJob]) -> usize {
    batch.iter().map(|job| job.source_text_ids.len()).sum()
}

fn median_i64(values: &[i64]) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    Some(values[values.len() / 2])
}

fn percentile_i64(values: &[i64], percentile: u64) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    let mut values = values.to_vec();
    values.sort_unstable();
    let percentile = percentile.min(100);
    let index = (values.len().saturating_sub(1) as u64)
        .saturating_mul(percentile)
        .div_ceil(100);
    values.get(index as usize).copied()
}

fn success_delay_ms(
    request_elapsed_ms: u64,
    config: &ProviderRequestSpacingConfig,
    current_floor_ms: u64,
) -> u64 {
    if config.base_success_spacing_ms == 0 && current_floor_ms == 0 {
        return 0;
    }
    let floor = current_floor_ms.max(config.min_success_spacing_ms);
    let computed = request_elapsed_ms.saturating_mul(20) / 100;
    computed
        .max(floor)
        .min(config.max_success_spacing_ms.max(floor))
}

fn batch_lane_key(batch: &[BatchJob]) -> &'static str {
    batch
        .iter()
        .map(|job| job.lane)
        .max()
        .unwrap_or(BatchLane::PlainBlock)
        .as_key()
}

fn batch_char_count(batch: &[BatchJob]) -> usize {
    batch
        .iter()
        .map(|job| job.provider_text.chars().count())
        .sum()
}

fn batch_token_estimate(batch: &[BatchJob]) -> usize {
    batch.iter().map(|job| job.token_estimate).sum()
}

fn sleep_success_delay(delay_ms: u64) {
    if delay_ms > 0 {
        thread::sleep(Duration::from_millis(delay_ms));
    }
}

fn average_latency_ms(latencies: &[u64]) -> Option<u64> {
    if latencies.is_empty() {
        return None;
    }
    Some(latencies.iter().copied().sum::<u64>() / latencies.len() as u64)
}

fn percentile_latency_ms(latencies: &[u64], percentile: u64) -> Option<u64> {
    if latencies.is_empty() {
        return None;
    }
    let mut values = latencies.to_vec();
    values.sort_unstable();
    let percentile = percentile.min(100);
    let index = (values.len().saturating_sub(1) as u64)
        .saturating_mul(percentile)
        .div_ceil(100);
    values.get(index as usize).copied()
}

fn throughput_per_minute(items: usize, elapsed_ms: u64) -> Option<f64> {
    if elapsed_ms == 0 {
        return None;
    }
    Some(items as f64 * 60_000.0 / elapsed_ms as f64)
}

fn throughput_per_second(chars: usize, elapsed_ms: u64) -> Option<f64> {
    if elapsed_ms == 0 {
        return None;
    }
    Some(chars as f64 * 1_000.0 / elapsed_ms as f64)
}

fn sleep_or_pause<P>(duration_ms: u64, should_pause: &mut P) -> Result<()>
where
    P: FnMut() -> bool + ?Sized,
{
    if duration_ms == 0 {
        if should_pause() {
            return Err(Error::invalid_input(
                "translation paused; provider request aborted",
            ));
        }
        return Ok(());
    }
    let started = Instant::now();
    loop {
        if should_pause() {
            return Err(Error::invalid_input(
                "translation paused; provider request aborted",
            ));
        }
        if elapsed_ms(started) >= duration_ms {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn persist_translations(
    db: &mut TranslationDb,
    target_language: &str,
    provider: &dyn ProviderClient,
    provider_run_id: i64,
    translations: Vec<ValidatedTranslation>,
    report: &mut BatchRunReport,
    checkpoint: &mut BatchCheckpoint,
) -> Result<()> {
    let mut rows = Vec::new();
    let mut completed_source_text_ids = Vec::new();
    for translation in translations {
        for source_text_id in translation.source_text_ids.iter().copied() {
            rows.push(NewTranslation {
                source_text_id,
                target_language: target_language.to_string(),
                translated_text: translation.translated_text.clone(),
                provider: provider.provider_name().to_string(),
                model: provider.model_name().map(str::to_string),
                provider_run_id: Some(provider_run_id),
                review_state: "pending".to_string(),
                qa_state: "passed".to_string(),
            });
            completed_source_text_ids.push(source_text_id);
        }
    }
    db.upsert_translations_in_transaction(&rows)?;
    for source_text_id in &completed_source_text_ids {
        let source_text_id = *source_text_id;
        push_unique(&mut report.completed_source_text_ids, source_text_id);
        push_unique(&mut checkpoint.completed_source_text_ids, source_text_id);
        checkpoint
            .failed_source_text_ids
            .retain(|failed_id| *failed_id != source_text_id);
        checkpoint
            .failure_details
            .retain(|detail| detail.source_text_id != source_text_id);
    }
    db.resolve_open_qa_findings_for_sources(&completed_source_text_ids, target_language)?;
    Ok(())
}

struct CensoredTranslation {
    job: BatchJob,
    translation: ValidatedTranslation,
}

fn split_censored_translations(
    batch: &[BatchJob],
    translations: Vec<ValidatedTranslation>,
) -> (Vec<ValidatedTranslation>, Vec<CensoredTranslation>) {
    let jobs: BTreeMap<i64, &BatchJob> = batch.iter().map(|job| (job.id, job)).collect();
    let mut accepted = Vec::new();
    let mut censored = Vec::new();
    for translation in translations {
        let Some(job) = jobs.get(&translation.job_id) else {
            accepted.push(translation);
            continue;
        };
        if has_censored_marker(&job.provider_text, &translation.translated_text) {
            censored.push(CensoredTranslation {
                job: (*job).clone(),
                translation,
            });
        } else {
            accepted.push(translation);
        }
    }
    (accepted, censored)
}

fn has_censored_marker(source: &str, translation: &str) -> bool {
    for marker in ["***", "＊＊＊", "[redacted]", "redacted", "검열됨"] {
        if translation
            .to_ascii_lowercase()
            .contains(&marker.to_ascii_lowercase())
            && !source
                .to_ascii_lowercase()
                .contains(&marker.to_ascii_lowercase())
        {
            return true;
        }
    }
    false
}

fn build_batches(jobs: &[BatchJob], config: &BatchPlannerConfig) -> Vec<Vec<BatchJob>> {
    let max_items = config.max_items_per_batch.max(1);
    let token_budget = config.input_token_budget.max(1);
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_tokens = 0usize;

    for job in jobs {
        let would_exceed_items = current.len() >= max_items;
        let would_exceed_tokens =
            !current.is_empty() && current_tokens + job.token_estimate > token_budget;
        let would_change_lane = current
            .first()
            .is_some_and(|first: &BatchJob| first.lane != job.lane);
        if would_exceed_items || would_exceed_tokens || would_change_lane {
            batches.push(current);
            current = Vec::new();
            current_tokens = 0;
        }
        current.push(job.clone());
        current_tokens += job.token_estimate;
    }

    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn lane_for_record(record: &SourceTextRecord) -> BatchLane {
    if record.placeholder_count > 0
        || record.newline_count > 0
            && record.unit_kind != "message_block"
            && record.unit_kind != "scroll_block"
    {
        return BatchLane::Complex;
    }
    match record.unit_kind.as_str() {
        "message_block" | "scroll_block" => BatchLane::PlainBlock,
        _ => BatchLane::Short,
    }
}

fn strip_chat_template_artifacts(raw: &str) -> &str {
    let mut value = raw.trim();
    loop {
        let before = value;
        value = strip_known_prefix(value);
        value = strip_channel_prefix(value);
        value = strip_known_suffix(value);
        if value == before {
            return value;
        }
    }
}

fn strip_channel_prefix(raw: &str) -> &str {
    let mut value = raw.trim_start();
    loop {
        let Some(rest) = value.strip_prefix("<|channel>") else {
            return value;
        };
        let Some(end_index) = rest.find("<channel|>") else {
            return value;
        };
        value = rest[end_index + "<channel|>".len()..].trim_start();
    }
}

fn strip_known_prefix(raw: &str) -> &str {
    let mut value = raw.trim_start();
    loop {
        let Some(next) = strip_one_known_prefix(value) else {
            return value;
        };
        value = next.trim_start();
    }
}

fn strip_one_known_prefix(raw: &str) -> Option<&str> {
    for prefix in [
        "<|turn>model",
        "<|turn>assistant",
        "<|start_header_id|>assistant<|end_header_id|>",
        "<|assistant|>",
    ] {
        if let Some(rest) = raw.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

fn strip_known_suffix(raw: &str) -> &str {
    let mut value = raw.trim_end();
    loop {
        let Some(next) = strip_one_known_suffix(value) else {
            return value;
        };
        value = next.trim_end();
    }
}

fn strip_one_known_suffix(raw: &str) -> Option<&str> {
    for suffix in ["<turn|>", "<|eot_id|>", "<|end_of_turn|>", "<|endoftext|>"] {
        if let Some(rest) = raw.strip_suffix(suffix) {
            return Some(rest);
        }
    }
    None
}

fn parse_rows(raw: &str) -> Result<Vec<Value>> {
    if raw.starts_with('[') {
        let rows: Vec<Value> = serde_json::from_str(raw).map_err(|error| {
            Error::invalid_input(format!("invalid provider output JSON array: {error}"))
        })?;
        return Ok(rows);
    }
    if raw.starts_with('{') && !raw.contains('\n') {
        let row: Value = serde_json::from_str(raw).map_err(|error| {
            Error::invalid_input(format!("invalid provider output JSON row: {error}"))
        })?;
        return Ok(vec![row]);
    }

    let mut rows = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.is_empty() {
            continue;
        }
        let row = serde_json::from_str(trimmed).map_err(|error| {
            Error::invalid_input(format!("invalid provider output JSONL row: {error}"))
        })?;
        rows.push(row);
    }
    Ok(rows)
}

fn estimate_tokens(text: &str) -> usize {
    ((text.chars().count() as f64) * 1.15).ceil() as usize
}

fn push_unique(values: &mut Vec<i64>, value: i64) {
    if !values.contains(&value) {
        values.push(value);
    }
}
