mod batch;
mod cache_key;
mod db;
mod domain;
mod error;
mod export;
mod install;
mod provider;
mod scanner;
mod text_codec;
mod workbench;

pub use batch::{
    BatchCheckpoint, BatchFailureDetail, BatchJob, BatchPlan, BatchPlanner, BatchPlannerConfig,
    BatchRunReport, BatchTranslator, BatchTranslatorConfig, BatchValidator, CheckpointWriter,
    FakeProvider, ProviderBatchItem, ProviderBatchRequest, ProviderBatchResponse, ProviderClient,
    ValidatedTranslation,
};
pub use cache_key::{CacheKeyBuilder, CacheKeyParts};
pub use db::TranslationDb;
pub use domain::{
    DataFileRecord, DetectedGame, Engine, ExportStatusRecord, ExtractedOccurrence, GameLayoutKind,
    InstallStatusRecord, NewInstallRecord, NewOccurrence, NewProject, NewProviderRun, NewQaFinding,
    NewSourceText, NewTranslation, OccurrenceContext, ProjectRecord, ProviderRunStatusRecord,
    QaFindingRecord, RejectedCandidate, ReviewQueueRow, ScanPersistenceReport, ScanReport,
    SkippedDataFile, SourceTextRecord, TextAnalysis, TranslationRecord, WorkbenchDashboardSummary,
};
pub use domain::{ExportableTranslationRecord, GameSnapshotRecord, InstallRecord};
pub use error::{Error, Result};
pub use export::{
    ExportBuilder, ExportPolicy, ExportReport, OverlayConfig, RuntimeCacheRecord,
    RuntimeExportManifest,
};
pub use install::{
    InstallManifest, InstallOptions, InstallReport, InstalledFileRecord, Installer,
    RollbackManager, RollbackOptions, RollbackReport,
};
pub use provider::{LocalOpenAiConfig, LocalOpenAiProvider, LocalProviderTransport};
pub use scanner::{ExtractionRuleSet, GameScanner, RpgMakerDetector, ScanOptions};
pub use text_codec::{ProviderTextState, TextCodec};
pub use workbench::WorkbenchService;

pub const PROJECT_NAME: &str = "RPG-Translator";

#[must_use]
pub fn workspace_ready_message() -> String {
    format!("{PROJECT_NAME} workspace ready")
}
