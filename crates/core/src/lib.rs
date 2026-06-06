mod batch;
mod cache_key;
mod db;
mod domain;
mod error;
mod scanner;
mod text_codec;

pub use batch::{
    BatchCheckpoint, BatchFailureDetail, BatchJob, BatchPlan, BatchPlanner, BatchPlannerConfig,
    BatchRunReport, BatchTranslator, BatchTranslatorConfig, BatchValidator, CheckpointWriter,
    FakeProvider, ProviderBatchItem, ProviderBatchRequest, ProviderBatchResponse, ProviderClient,
    ValidatedTranslation,
};
pub use cache_key::{CacheKeyBuilder, CacheKeyParts};
pub use db::TranslationDb;
pub use domain::{
    DataFileRecord, DetectedGame, Engine, ExtractedOccurrence, GameLayoutKind, NewOccurrence,
    NewProject, NewProviderRun, NewQaFinding, NewSourceText, NewTranslation, OccurrenceContext,
    ProjectRecord, QaFindingRecord, RejectedCandidate, ScanReport, SkippedDataFile,
    SourceTextRecord, TextAnalysis, TranslationRecord,
};
pub use domain::{ExportableTranslationRecord, GameSnapshotRecord};
pub use error::{Error, Result};
pub use scanner::{ExtractionRuleSet, GameScanner, RpgMakerDetector, ScanOptions};
pub use text_codec::{ProviderTextState, TextCodec};

pub const PROJECT_NAME: &str = "RPG-Translator";

#[must_use]
pub fn workspace_ready_message() -> String {
    format!("{PROJECT_NAME} workspace ready")
}
