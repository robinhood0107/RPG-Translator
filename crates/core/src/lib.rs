mod batch;
mod cache_key;
mod db;
mod domain;
mod error;
mod export;
mod install;
mod project_manifest;
mod provider;
mod scanner;
mod text_codec;
mod workbench;

pub use batch::{
    AdaptiveTranslationTuning, BatchCheckpoint, BatchFailureDetail, BatchJob, BatchPlan,
    BatchPlanner, BatchPlannerConfig, BatchRunReport, BatchRunStatus, BatchTranslator,
    BatchTranslatorConfig, BatchValidator, CheckpointFailureDetail, CheckpointWriter, FakeProvider,
    ProviderBatchItem, ProviderBatchRequest, ProviderBatchResponse, ProviderClient,
    ProviderRequestSpacingConfig, ProviderSpeedBenchmark, ProviderSpeedBenchmarkConfig,
    ProviderSpeedBenchmarkReport, ProviderSpeedBenchmarkRun, ValidatedTranslation,
    adaptive_translation_tuning_from_samples, translation_prompt_hash,
};
pub use cache_key::{CacheKeyBuilder, CacheKeyParts};
pub use db::{SchemaMigrationReport, TranslationDb};
pub use domain::{
    BulkReviewApproveReport, DuplicateProjectCleanupReport, ExportableTranslationRecord,
    GameSnapshotRecord, InstallRecord,
};
pub use domain::{
    DataFileRecord, DetectedGame, Engine, ExportStatusRecord, ExtractedOccurrence, GameLayoutKind,
    InstallStatusRecord, NewInstallRecord, NewOccurrence, NewProject, NewProviderRun, NewQaFinding,
    NewSourceText, NewTranslation, NewTranslationSpeedSample, OccurrenceContext, OccurrenceSegment,
    ProjectRecord, ProviderRunStatusRecord, QaFindingRecord, RejectedCandidate, ReviewCounts,
    ReviewQueueRow, ReviewUpdateRequest, ScanPersistenceReport, ScanPersistenceStats,
    ScanProgressEvent, ScanReport, SkippedDataFile, SourceTextRecord, TextAnalysis,
    TranslateProgressEvent, TranslateProgressSnapshot, TranslationJobProgressUpdate,
    TranslationJobSummary, TranslationRecord, TranslationSpeedSample, WorkbenchDashboardSummary,
    WorkbenchSettingsRecord, WorkbenchSettingsUpdate,
};
pub use error::{Error, Result};
pub use export::{
    ExportBuilder, ExportPolicy, ExportReport, ForesightCommandCatalog, ForesightCommandMetadata,
    OverlayConfig, RuntimeCacheRecord, RuntimeExportManifest,
};
pub use install::{
    InstallManifest, InstallOptions, InstallReport, InstalledFileRecord, Installer,
    RollbackManager, RollbackOptions, RollbackReport,
};
pub use project_manifest::{
    PROJECT_ARTIFACT_DIR, ProjectManifest, ProjectManifestPaths, ProjectWorkspace,
    ProjectWorkspaceLoad,
};
pub use provider::{
    DEFAULT_SYSTEM_PROMPT, LocalOpenAiConfig, LocalOpenAiProvider, LocalProviderTransport,
    build_provider_system_prompt,
};
pub use scanner::{ExtractionRuleSet, GameScanner, RpgMakerDetector, ScanOptions};
pub use text_codec::{ProviderTextState, TextCodec};
pub use workbench::WorkbenchService;

pub const PROJECT_NAME: &str = "RPG-Translator";

#[must_use]
pub fn workspace_ready_message() -> String {
    format!("{PROJECT_NAME} workspace ready")
}
