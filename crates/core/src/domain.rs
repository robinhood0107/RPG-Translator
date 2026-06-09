use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Engine {
    Mv,
    Mz,
    Unknown,
}

impl Engine {
    #[must_use]
    pub fn as_key(&self) -> &'static str {
        match self {
            Self::Mv => "mv",
            Self::Mz => "mz",
            Self::Unknown => "unknown",
        }
    }

    #[must_use]
    pub fn from_key(value: &str) -> Self {
        match value {
            "mv" => Self::Mv,
            "mz" => Self::Mz,
            _ => Self::Unknown,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameLayoutKind {
    Direct,
    Www,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedGame {
    pub game_root: String,
    pub engine: Engine,
    pub layout: GameLayoutKind,
    pub data_path: String,
    pub plugin_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextAnalysis {
    pub original_text: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub control_codes: Vec<String>,
    pub control_code_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewProject {
    pub game_root: String,
    pub display_name: String,
    pub engine: Engine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: i64,
    pub game_root: String,
    pub display_name: String,
    pub engine: Engine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DuplicateProjectCleanupReport {
    pub merged_project_count: i64,
    pub survivor_project_ids: Vec<i64>,
    pub removed_project_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportStatusRecord {
    pub id: i64,
    pub project_id: Option<i64>,
    pub target_language: String,
    pub export_path: String,
    pub manifest_hash: String,
    pub included_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameSnapshotRecord {
    pub id: i64,
    pub project_id: i64,
    pub snapshot_hash: String,
    pub data_root_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewSourceText {
    pub source_language: String,
    pub unit_kind: String,
    pub normalized_hash: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub codec_text: String,
    pub control_code_signature: String,
    pub line_count: i64,
    pub newline_count: i64,
    pub placeholder_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceTextRecord {
    pub id: i64,
    pub source_language: String,
    pub unit_kind: String,
    pub normalized_hash: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub codec_text: String,
    pub control_code_signature: String,
    pub line_count: i64,
    pub newline_count: i64,
    pub placeholder_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataFileRecord {
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccurrenceContext {
    pub file_path: String,
    pub json_path: String,
    pub entity_type: String,
    pub event_id: Option<i64>,
    pub page_index: Option<i64>,
    pub command_index: Option<i64>,
    pub command_code: Option<i64>,
    pub parameter_index: Option<i64>,
    pub object_key: Option<String>,
    pub extraction_rule_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedOccurrence {
    pub raw_text: String,
    pub source_text: NewSourceText,
    pub context: OccurrenceContext,
    pub segments: Vec<OccurrenceSegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccurrenceSegment {
    pub segment_index: i64,
    pub command_code: Option<i64>,
    pub json_path: String,
    pub raw_text: String,
    pub line_index: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedCandidate {
    pub raw_text: String,
    pub reason: String,
    pub context: OccurrenceContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedDataFile {
    pub file_path: String,
    pub reason: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanReport {
    pub detected_game: DetectedGame,
    pub files: Vec<DataFileRecord>,
    pub accepted: Vec<ExtractedOccurrence>,
    pub rejected: Vec<RejectedCandidate>,
    pub skipped: Vec<SkippedDataFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScanProgressEvent {
    Started {
        game_root: String,
        source_language: String,
    },
    Detected {
        engine: Engine,
        layout: GameLayoutKind,
        data_path: String,
    },
    FileStarted {
        index: usize,
        file_path: String,
    },
    FileFinished {
        index: usize,
        file_path: String,
        accepted_delta: usize,
        rejected_delta: usize,
        skipped: bool,
    },
    Finished {
        file_count: usize,
        accepted_count: usize,
        rejected_count: usize,
        skipped_count: usize,
    },
    Persisting {
        occurrence_count: usize,
    },
    Persisted {
        project_id: i64,
        snapshot_id: i64,
        source_text_count: i64,
        occurrence_count: i64,
        added_source_text_count: i64,
        removed_occurrence_count: i64,
        unchanged_source_text_count: i64,
        rejected_count: i64,
        skipped_count: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TranslateProgressEvent {
    Started(TranslateProgressSnapshot),
    BatchStarted(TranslateProgressSnapshot),
    ProviderBackoff(TranslateProgressSnapshot),
    BatchFinished(TranslateProgressSnapshot),
    PauseRequested(TranslateProgressSnapshot),
    Paused(TranslateProgressSnapshot),
    Completed(TranslateProgressSnapshot),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslateProgressSnapshot {
    pub provider_run_id: i64,
    pub target_language: String,
    pub model: Option<String>,
    pub total_batches: usize,
    pub processed_batches: usize,
    pub total_items: usize,
    pub completed_items: usize,
    pub failed_items: usize,
    pub split_batches: usize,
    pub elapsed_ms: u64,
    pub eta_ms: Option<u64>,
    pub item_eta_ms: Option<u64>,
    pub batch_eta_ms: Option<u64>,
    pub last_batch_elapsed_ms: Option<u64>,
    pub avg_batch_elapsed_ms: Option<u64>,
    pub recent_p50_batch_elapsed_ms: Option<u64>,
    pub recent_p95_batch_elapsed_ms: Option<u64>,
    pub best_items_per_minute: Option<u64>,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewOccurrence {
    pub project_id: Option<i64>,
    pub source_text_id: i64,
    pub file_path: String,
    pub json_path: String,
    pub entity_type: String,
    pub event_id: Option<i64>,
    pub page_index: Option<i64>,
    pub command_index: Option<i64>,
    pub command_code: Option<i64>,
    pub parameter_index: Option<i64>,
    pub object_key: Option<String>,
    pub extraction_rule_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewTranslation {
    pub source_text_id: i64,
    pub target_language: String,
    pub translated_text: String,
    pub provider: String,
    pub model: Option<String>,
    pub provider_run_id: Option<i64>,
    pub review_state: String,
    pub qa_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationRecord {
    pub id: i64,
    pub source_text_id: i64,
    pub target_language: String,
    pub translated_text: String,
    pub provider: String,
    pub model: Option<String>,
    pub provider_run_id: Option<i64>,
    pub review_state: String,
    pub qa_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExportableTranslationRecord {
    pub source_text_id: i64,
    pub source_language: String,
    pub target_language: String,
    pub unit_kind: String,
    pub normalized_hash: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub codec_text: String,
    pub control_code_signature: String,
    pub line_count: i64,
    pub newline_count: i64,
    pub placeholder_count: i64,
    pub translated_text: String,
    pub review_state: String,
    pub qa_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewProviderRun {
    pub provider: String,
    pub model: Option<String>,
    pub request_settings_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewQaFinding {
    pub source_text_id: i64,
    pub translation_id: Option<i64>,
    pub target_language: Option<String>,
    pub provider_run_id: Option<i64>,
    pub finding_type: String,
    pub severity: String,
    pub message: String,
    pub status: String,
    pub details_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QaFindingRecord {
    pub id: i64,
    pub source_text_id: i64,
    pub translation_id: Option<i64>,
    pub target_language: Option<String>,
    pub provider_run_id: Option<i64>,
    pub finding_type: String,
    pub severity: String,
    pub message: String,
    pub status: String,
    pub resolved_at: Option<String>,
    pub details_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewInstallRecord {
    pub project_id: Option<i64>,
    pub game_root: String,
    pub export_id: Option<i64>,
    pub backup_manifest_path: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallRecord {
    pub id: i64,
    pub project_id: Option<i64>,
    pub game_root: String,
    pub export_id: Option<i64>,
    pub backup_manifest_path: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallStatusRecord {
    pub id: i64,
    pub project_id: Option<i64>,
    pub game_root: String,
    pub export_id: Option<i64>,
    pub backup_manifest_path: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderRunStatusRecord {
    pub id: i64,
    pub provider: String,
    pub model: Option<String>,
    pub status: String,
    pub failure_detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkbenchSettingsRecord {
    pub selected_project_id: Option<i64>,
    pub source_language: String,
    pub target_language: String,
    pub provider_base_url: String,
    pub provider_model: String,
    pub system_prompt: String,
    pub export_dir: String,
    pub active_tab: String,
    pub show_hover_help: bool,
    pub ui_font_size: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct WorkbenchSettingsUpdate {
    pub selected_project_id: Option<Option<i64>>,
    pub source_language: Option<String>,
    pub target_language: Option<String>,
    pub provider_base_url: Option<String>,
    pub provider_model: Option<String>,
    pub system_prompt: Option<String>,
    pub export_dir: Option<String>,
    pub active_tab: Option<String>,
    pub show_hover_help: Option<bool>,
    pub ui_font_size: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationJobSummary {
    pub id: i64,
    pub provider_run_id: Option<i64>,
    pub project_id: Option<i64>,
    pub source_language: String,
    pub target_language: String,
    pub checkpoint_path: String,
    pub status: String,
    pub completed_items: i64,
    pub failed_items: i64,
    pub total_items: i64,
    pub processed_batches: i64,
    pub total_batches: i64,
    pub split_batches: i64,
    pub parse_failed_items: i64,
    pub validation_failed_items: i64,
    pub skipped_items: i64,
    pub censored_retry_count: i64,
    pub item_eta_ms: Option<i64>,
    pub batch_eta_ms: Option<i64>,
    pub last_batch_elapsed_ms: Option<i64>,
    pub avg_batch_elapsed_ms: Option<i64>,
    pub current_batch_items: i64,
    pub elapsed_ms: i64,
    pub model: Option<String>,
    pub retry_pending_items: i64,
    pub recoverable_provider_failures: i64,
    pub final_failed_items: i64,
    pub provider_backoff_ms: Option<i64>,
    pub effective_batch_size: i64,
    pub next_experiment_batch_size: i64,
    pub input_token_budget: i64,
    pub speed_mode: String,
    pub success_streak: i64,
    pub success_delay_floor_ms: i64,
    pub next_delay_ms: Option<i64>,
    pub failure_reason_counts_json: String,
    pub adaptive_decision_reason: String,
    pub legacy_checkpoint_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TranslationJobProgressUpdate {
    pub provider_run_id: i64,
    pub project_id: Option<i64>,
    pub source_language: String,
    pub target_language: String,
    pub checkpoint_path: String,
    pub status: String,
    pub completed_items: i64,
    pub failed_items: i64,
    pub total_items: i64,
    pub processed_batches: i64,
    pub total_batches: i64,
    pub split_batches: i64,
    pub parse_failed_items: i64,
    pub validation_failed_items: i64,
    pub skipped_items: i64,
    pub censored_retry_count: i64,
    pub item_eta_ms: Option<i64>,
    pub batch_eta_ms: Option<i64>,
    pub last_batch_elapsed_ms: Option<i64>,
    pub avg_batch_elapsed_ms: Option<i64>,
    pub current_batch_items: i64,
    pub elapsed_ms: i64,
    pub model: Option<String>,
    pub retry_pending_items: i64,
    pub recoverable_provider_failures: i64,
    pub final_failed_items: i64,
    pub provider_backoff_ms: Option<i64>,
    pub effective_batch_size: i64,
    pub next_experiment_batch_size: i64,
    pub input_token_budget: i64,
    pub speed_mode: String,
    pub success_streak: i64,
    pub success_delay_floor_ms: i64,
    pub next_delay_ms: Option<i64>,
    pub failure_reason_counts_json: String,
    pub adaptive_decision_reason: String,
    pub legacy_checkpoint_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewTranslationSpeedSample {
    pub provider_run_id: i64,
    pub batch_index: i64,
    pub lane: String,
    pub item_count: i64,
    pub char_count: i64,
    pub estimated_token_count: i64,
    pub request_elapsed_ms: i64,
    pub success_delay_ms: i64,
    pub total_elapsed_ms: i64,
    pub status: String,
    pub failure_type: Option<String>,
    pub effective_batch_size: i64,
    pub adaptive_decision_reason: String,
    pub model: Option<String>,
    pub prompt_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationSpeedSample {
    pub id: i64,
    pub provider_run_id: i64,
    pub batch_index: i64,
    pub lane: String,
    pub item_count: i64,
    pub char_count: i64,
    pub estimated_token_count: i64,
    pub request_elapsed_ms: i64,
    pub success_delay_ms: i64,
    pub total_elapsed_ms: i64,
    pub status: String,
    pub failure_type: Option<String>,
    pub effective_batch_size: i64,
    pub adaptive_decision_reason: String,
    pub model: Option<String>,
    pub prompt_hash: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewCounts {
    pub all: i64,
    pub missing: i64,
    pub pending: i64,
    pub accepted: i64,
    pub reviewed: i64,
    pub attention: i64,
    pub exportable: i64,
    pub open_issues: i64,
    pub json_parse: i64,
    pub validation: i64,
    pub final_failed: i64,
    pub clean_approvable: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewUpdateRequest {
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
pub struct BulkReviewApproveReport {
    pub updated_count: i64,
    pub skipped_missing_count: i64,
    pub skipped_finding_count: i64,
    pub skipped_attention_count: i64,
    pub skipped_validation_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkbenchDashboardSummary {
    pub project_id: i64,
    pub target_language: String,
    pub source_text_count: i64,
    pub occurrence_count: i64,
    pub translated_count: i64,
    pub accepted_count: i64,
    pub reviewed_count: i64,
    pub review_queue_count: i64,
    pub qa_finding_count: i64,
    pub latest_export: Option<ExportStatusRecord>,
    pub latest_install: Option<InstallStatusRecord>,
    pub latest_provider_run: Option<ProviderRunStatusRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewQueueRow {
    pub source_text_id: i64,
    pub source_language: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub control_code_signature: String,
    pub occurrence_count: i64,
    pub first_file_path: String,
    pub first_json_path: String,
    pub translation_id: Option<i64>,
    pub target_language: String,
    pub translated_text: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub review_state: String,
    pub qa_state: String,
    pub qa_finding_count: i64,
    pub qa_findings: Vec<QaFindingRecord>,
    pub issue_badges: Vec<String>,
    pub translation_updated_at: Option<String>,
    pub draft_text: Option<String>,
    pub draft_updated_at: Option<String>,
    pub has_unapplied_draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanPersistenceReport {
    pub project_id: i64,
    pub snapshot_id: i64,
    pub source_text_count: i64,
    pub occurrence_count: i64,
    pub added_source_text_count: i64,
    pub removed_occurrence_count: i64,
    pub unchanged_source_text_count: i64,
    pub rejected_count: i64,
    pub skipped_count: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanPersistenceStats {
    pub source_text_count: i64,
    pub occurrence_count: i64,
    pub added_source_text_count: i64,
    pub removed_occurrence_count: i64,
    pub unchanged_source_text_count: i64,
}
