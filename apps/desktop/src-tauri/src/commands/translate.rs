use serde::{Deserialize, Serialize};
use serde_json::json;

use rpg_translator_core::{
    BatchFailureDetail, BatchTranslator, BatchTranslatorConfig, ProviderBatchRequest,
    ProviderBatchResponse, ProviderClient, Result,
};

use super::shared::{CommandResult, open_db, run_blocking};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslateRequest {
    pub db_path: String,
    pub target_language: String,
    pub batch_size: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslateResponse {
    pub provider_run_id: i64,
    pub accepted_count: usize,
    pub failed_count: usize,
    pub split_batches: usize,
    pub failures: Vec<BatchFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchFailure {
    pub source_text_ids: Vec<i64>,
    pub message: String,
}

struct WorkbenchFakeProvider {
    target_language: String,
}

impl ProviderClient for WorkbenchFakeProvider {
    fn provider_name(&self) -> &str {
        "desktop-fake"
    }

    fn model_name(&self) -> Option<&str> {
        Some("synthetic-workbench")
    }

    fn translate_batch(&mut self, request: &ProviderBatchRequest) -> Result<ProviderBatchResponse> {
        let raw_output = request
            .items
            .iter()
            .map(|item| {
                json!({
                    "id": item.id,
                    "translation": format!("[{}] {}", self.target_language, item.text)
                })
                .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ProviderBatchResponse { raw_output })
    }
}

#[tauri::command]
pub async fn translate_with_fake_provider(
    request: TranslateRequest,
) -> CommandResult<TranslateResponse> {
    run_blocking(move || {
        let mut db = open_db(&request.db_path)?;
        let mut provider = WorkbenchFakeProvider {
            target_language: request.target_language.clone(),
        };
        let report = BatchTranslator::run(
            &mut db,
            &mut provider,
            &request.target_language,
            BatchTranslatorConfig {
                max_items_per_batch: request.batch_size.unwrap_or(16),
                retry_attempts: 0,
                ..BatchTranslatorConfig::default()
            },
        )?;
        Ok(TranslateResponse {
            provider_run_id: report.provider_run_id,
            accepted_count: report.completed_source_text_ids.len(),
            failed_count: report.failed_source_text_ids.len(),
            split_batches: report.split_batches,
            failures: report.failure_details.into_iter().map(Into::into).collect(),
        })
    })
    .await
}

impl From<BatchFailureDetail> for BatchFailure {
    fn from(failure: BatchFailureDetail) -> Self {
        Self {
            source_text_ids: failure.source_text_ids,
            message: failure.message,
        }
    }
}
