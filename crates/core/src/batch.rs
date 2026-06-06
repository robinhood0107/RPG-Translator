use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Error, NewProviderRun, NewQaFinding, NewTranslation, ProviderTextState, Result,
    SourceTextRecord, TextCodec, TranslationDb,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBatchItem {
    pub id: i64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderBatchRequest {
    pub items: Vec<ProviderBatchItem>,
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
}

impl Default for BatchPlannerConfig {
    fn default() -> Self {
        Self {
            max_items_per_batch: 32,
            input_token_budget: 4096,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchJob {
    pub id: i64,
    pub source_text_ids: Vec<i64>,
    pub provider_text: String,
    pub token_estimate: usize,
    provider_state: ProviderTextState,
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
        let records = db.pending_source_texts(target_language)?;
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
                provider_state,
            });
        }

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
                    provider_state,
                }
            })
            .collect()
    }
}

pub struct BatchValidator;

impl BatchValidator {
    pub fn validate(raw_output: &str, jobs: &[BatchJob]) -> Result<Vec<ValidatedTranslation>> {
        let raw = raw_output.trim();
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
pub struct BatchTranslatorConfig {
    pub max_items_per_batch: usize,
    pub input_token_budget: usize,
    pub retry_attempts: usize,
}

impl Default for BatchTranslatorConfig {
    fn default() -> Self {
        Self {
            max_items_per_batch: 16,
            input_token_budget: 4096,
            retry_attempts: 1,
        }
    }
}

impl BatchTranslatorConfig {
    fn planner_config(&self) -> BatchPlannerConfig {
        BatchPlannerConfig {
            max_items_per_batch: self.max_items_per_batch,
            input_token_budget: self.input_token_budget,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRunReport {
    pub provider_run_id: i64,
    pub completed_source_text_ids: Vec<i64>,
    pub failed_source_text_ids: Vec<i64>,
    pub split_batches: usize,
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
        let mut checkpoint = match checkpoint_path {
            Some(path) => CheckpointWriter::read(path)?.unwrap_or_else(|| BatchCheckpoint {
                provider_run_id: 0,
                target_language: target_language.to_string(),
                completed_source_text_ids: Vec::new(),
                failed_source_text_ids: Vec::new(),
            }),
            None => BatchCheckpoint {
                provider_run_id: 0,
                target_language: target_language.to_string(),
                completed_source_text_ids: Vec::new(),
                failed_source_text_ids: Vec::new(),
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

        let completed_set: BTreeSet<i64> = checkpoint
            .completed_source_text_ids
            .iter()
            .copied()
            .collect();
        let plan = BatchPlanner::plan_with_completed(
            db,
            target_language,
            config.planner_config(),
            &completed_set,
        )?;
        let mut report = BatchRunReport {
            provider_run_id,
            completed_source_text_ids: Vec::new(),
            failed_source_text_ids: Vec::new(),
            split_batches: 0,
        };

        {
            let mut processor = BatchProcessor {
                db,
                provider,
                target_language,
                config: &config,
                report: &mut report,
                checkpoint: &mut checkpoint,
                checkpoint_path,
            };
            for batch in &plan.batches {
                processor.process(batch)?;
            }
        }

        let status = if report.failed_source_text_ids.is_empty() {
            "completed"
        } else {
            "completed_with_failures"
        };
        let failure_detail = if report.failed_source_text_ids.is_empty() {
            None
        } else {
            Some("one or more batch items failed validation")
        };
        db.finish_provider_run(provider_run_id, status, failure_detail)?;
        if let Some(path) = checkpoint_path {
            CheckpointWriter::write_atomic(path, &checkpoint)?;
        }
        Ok(report)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchCheckpoint {
    pub provider_run_id: i64,
    pub target_language: String,
    pub completed_source_text_ids: Vec<i64>,
    pub failed_source_text_ids: Vec<i64>,
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
}

struct BatchProcessor<'a> {
    db: &'a mut TranslationDb,
    provider: &'a mut dyn ProviderClient,
    target_language: &'a str,
    config: &'a BatchTranslatorConfig,
    report: &'a mut BatchRunReport,
    checkpoint: &'a mut BatchCheckpoint,
    checkpoint_path: Option<&'a Path>,
}

impl BatchProcessor<'_> {
    fn process(&mut self, batch: &[BatchJob]) -> Result<()> {
        if batch.is_empty() {
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
            };
            match self
                .provider
                .translate_batch(&request)
                .and_then(|response| BatchValidator::validate(&response.raw_output, batch))
            {
                Ok(translations) => {
                    persist_translations(
                        self.db,
                        self.target_language,
                        self.provider,
                        translations,
                        self.report,
                        self.checkpoint,
                    )?;
                    if let Some(path) = self.checkpoint_path {
                        CheckpointWriter::write_atomic(path, self.checkpoint)?;
                    }
                    return Ok(());
                }
                Err(error) => {
                    last_error = error;
                }
            }
        }

        if batch.len() > 1 {
            self.report.split_batches += 1;
            let midpoint = batch.len() / 2;
            self.process(&batch[..midpoint])?;
            self.process(&batch[midpoint..])?;
            return Ok(());
        }

        let failed_job = &batch[0];
        for source_text_id in &failed_job.source_text_ids {
            push_unique(&mut self.report.failed_source_text_ids, *source_text_id);
            push_unique(&mut self.checkpoint.failed_source_text_ids, *source_text_id);
            self.db.insert_qa_finding(&NewQaFinding {
                source_text_id: *source_text_id,
                translation_id: None,
                finding_type: "batch-validation".to_string(),
                severity: "error".to_string(),
                message: last_error.to_string(),
            })?;
        }
        if let Some(path) = self.checkpoint_path {
            CheckpointWriter::write_atomic(path, self.checkpoint)?;
        }
        Ok(())
    }
}

fn persist_translations(
    db: &mut TranslationDb,
    target_language: &str,
    provider: &dyn ProviderClient,
    translations: Vec<ValidatedTranslation>,
    report: &mut BatchRunReport,
    checkpoint: &mut BatchCheckpoint,
) -> Result<()> {
    for translation in translations {
        for source_text_id in translation.source_text_ids {
            db.upsert_translation(&NewTranslation {
                source_text_id,
                target_language: target_language.to_string(),
                translated_text: translation.translated_text.clone(),
                provider: provider.provider_name().to_string(),
                model: provider.model_name().map(str::to_string),
                review_state: "pending".to_string(),
                qa_state: "unchecked".to_string(),
            })?;
            push_unique(&mut report.completed_source_text_ids, source_text_id);
            push_unique(&mut checkpoint.completed_source_text_ids, source_text_id);
        }
    }
    Ok(())
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
        if would_exceed_items || would_exceed_tokens {
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

fn parse_rows(raw: &str) -> Result<Vec<Value>> {
    if raw.starts_with('[') {
        let rows: Vec<Value> = serde_json::from_str(raw).map_err(|error| {
            Error::invalid_input(format!("invalid provider JSON array: {error}"))
        })?;
        return Ok(rows);
    }
    if raw.starts_with('{') && !raw.contains('\n') {
        let row: Value = serde_json::from_str(raw)
            .map_err(|error| Error::invalid_input(format!("invalid provider JSON row: {error}")))?;
        return Ok(vec![row]);
    }

    let mut rows = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim().trim_end_matches(',');
        if trimmed.is_empty() {
            continue;
        }
        let row = serde_json::from_str(trimmed).map_err(|error| {
            Error::invalid_input(format!("invalid provider JSONL row: {error}"))
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
