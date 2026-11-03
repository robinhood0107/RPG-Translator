use serde::{Deserialize, Serialize};

use rpg_translator_core::{ReviewQueueRow, ReviewUpdateRequest, TranslationRecord};

use super::shared::{CommandResult, open_db_existing, run_blocking, write_gate};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewQueueRequest {
    pub db_path: String,
    pub project_id: i64,
    pub target_language: String,
    pub review_state: Option<String>,
    pub issue_filter: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewQueueResponse {
    pub rows: Vec<ReviewQueueRow>,
    pub total_count: i64,
    pub next_offset: Option<usize>,
    pub page: usize,
    pub page_size: usize,
    pub total_pages: usize,
    pub range_start: usize,
    pub range_end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateReviewStateRequest {
    pub db_path: String,
    pub source_text_id: i64,
    pub target_language: String,
    pub translated_text: String,
    pub provider: String,
    pub model: Option<String>,
    pub review_state: String,
    pub qa_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateReviewRowRequest {
    pub db_path: String,
    pub source_text_id: i64,
    pub target_language: String,
    pub translated_text: String,
    pub provider: String,
    pub model: Option<String>,
    pub review_state: String,
    pub qa_state: String,
    pub expected_updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateReviewRowResponse {
    pub row: ReviewQueueRow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkApproveReviewRowsRequest {
    pub db_path: String,
    pub project_id: i64,
    pub target_language: String,
    pub source_text_ids: Option<Vec<i64>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkApproveReviewRowsResponse {
    pub updated_count: i64,
    pub skipped_missing_count: i64,
    pub skipped_finding_count: i64,
    pub skipped_attention_count: i64,
    pub skipped_validation_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateReviewStateResponse {
    pub translation: TranslationRecord,
}

impl UpdateReviewStateResponse {
    #[must_use]
    pub fn review_state(&self) -> &str {
        &self.translation.review_state
    }
}

#[tauri::command]
pub async fn review_queue(request: ReviewQueueRequest) -> CommandResult<ReviewQueueResponse> {
    run_blocking(move || {
        let db = open_db_existing(&request.db_path)?;
        let limit = request.limit.unwrap_or(200).clamp(1, 500);
        let offset = request.offset.unwrap_or(0);
        let (rows, total_count) = db.review_queue_page(
            request.project_id,
            &request.target_language,
            request.review_state.as_deref(),
            request.issue_filter.as_deref(),
            limit,
            offset,
        )?;
        let loaded_until = offset.saturating_add(rows.len());
        let next_offset = (loaded_until < total_count as usize).then_some(loaded_until);
        let total_count_usize = usize::try_from(total_count).unwrap_or(usize::MAX);
        let total_pages = if total_count_usize == 0 {
            0
        } else {
            total_count_usize.div_ceil(limit)
        };
        let page = if total_count_usize == 0 {
            0
        } else {
            offset / limit + 1
        };
        let range_start = if rows.is_empty() { 0 } else { offset + 1 };
        let range_end = offset.saturating_add(rows.len()).min(total_count_usize);
        Ok(ReviewQueueResponse {
            rows,
            total_count,
            next_offset,
            page,
            page_size: limit,
            total_pages,
            range_start,
            range_end,
        })
    })
    .await
}

#[tauri::command]
pub async fn update_review_state(
    request: UpdateReviewStateRequest,
) -> CommandResult<UpdateReviewStateResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_existing(&request.db_path)?;
        db.update_review_row(&ReviewUpdateRequest {
            source_text_id: request.source_text_id,
            target_language: request.target_language.clone(),
            translated_text: request.translated_text,
            provider: request.provider,
            model: request.model,
            review_state: request.review_state,
            qa_state: request.qa_state,
            expected_updated_at: None,
        })?;
        let translation = db
            .get_translation(request.source_text_id, &request.target_language)?
            .ok_or_else(|| {
                rpg_translator_core::Error::invalid_input("updated translation was not found")
            })?;
        Ok(UpdateReviewStateResponse { translation })
    })
    .await
}

#[tauri::command]
pub async fn update_review_row(
    request: UpdateReviewRowRequest,
) -> CommandResult<UpdateReviewRowResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_existing(&request.db_path)?;
        let row = db.update_review_row(&ReviewUpdateRequest {
            source_text_id: request.source_text_id,
            target_language: request.target_language,
            translated_text: request.translated_text,
            provider: request.provider,
            model: request.model,
            review_state: request.review_state,
            qa_state: request.qa_state,
            expected_updated_at: request.expected_updated_at,
        })?;
        Ok(UpdateReviewRowResponse { row })
    })
    .await
}

#[tauri::command]
pub async fn bulk_approve_review_rows(
    request: BulkApproveReviewRowsRequest,
) -> CommandResult<BulkApproveReviewRowsResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db_existing(&request.db_path)?;
        let report = db.bulk_approve_pending_review_rows(
            request.project_id,
            &request.target_language,
            request.source_text_ids.as_deref(),
        )?;
        Ok(BulkApproveReviewRowsResponse {
            updated_count: report.updated_count,
            skipped_missing_count: report.skipped_missing_count,
            skipped_finding_count: report.skipped_finding_count,
            skipped_attention_count: report.skipped_attention_count,
            skipped_validation_count: report.skipped_validation_count,
        })
    })
    .await
}
