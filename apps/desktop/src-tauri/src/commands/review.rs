use serde::{Deserialize, Serialize};

use rpg_translator_core::{NewTranslation, ReviewQueueRow, TranslationRecord};

use super::shared::{CommandResult, open_db, run_blocking};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewQueueRequest {
    pub db_path: String,
    pub project_id: i64,
    pub target_language: String,
    pub review_state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewQueueResponse {
    pub rows: Vec<ReviewQueueRow>,
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
        let db = open_db(&request.db_path)?;
        let rows = db.review_queue_rows(
            request.project_id,
            &request.target_language,
            request.review_state.as_deref(),
        )?;
        Ok(ReviewQueueResponse { rows })
    })
    .await
}

#[tauri::command]
pub async fn update_review_state(
    request: UpdateReviewStateRequest,
) -> CommandResult<UpdateReviewStateResponse> {
    run_blocking(move || {
        let mut db = open_db(&request.db_path)?;
        db.upsert_translation(&NewTranslation {
            source_text_id: request.source_text_id,
            target_language: request.target_language.clone(),
            translated_text: request.translated_text,
            provider: request.provider,
            model: request.model,
            review_state: request.review_state,
            qa_state: request.qa_state,
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
