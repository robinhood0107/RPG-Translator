export type ProjectSummary = {
  id: number;
  game_root: string;
  display_name: string;
  engine: "mv" | "mz" | "unknown" | string;
};

export type ProjectWorkspaceSummary = {
  project_file_path: string;
  artifact_root: string;
  db_path: string;
  game_root: string;
  display_name: string;
  engine: "mv" | "mz" | "unknown" | string;
  database_missing: boolean;
  checkpoints_path: string;
  exports_path: string;
  installs_path: string;
  logs_path: string;
  temp_path: string;
};

export type DuplicateProjectCleanupReport = {
  merged_project_count: number;
  survivor_project_ids: number[];
  removed_project_ids: number[];
};

export type DashboardSummary = {
  project_id: number;
  target_language: string;
  source_text_count: number;
  translatable_source_text_count?: number;
  unsupported_candidate_count?: number;
  missing_translatable_count?: number;
  failed_translatable_count?: number;
  occurrence_count: number;
  translated_count: number;
  accepted_count: number;
  reviewed_count: number;
  review_queue_count: number;
  qa_finding_count: number;
  latest_export?: ExportStatus | null;
  latest_install?: InstallStatus | null;
  latest_provider_run?: ProviderRunStatus | null;
};

export type ExportStatus = {
  id: number;
  project_id?: number | null;
  target_language: string;
  export_path: string;
  manifest_hash: string;
  included_count: number;
};

export type InstallStatus = {
  id: number;
  project_id?: number | null;
  game_root: string;
  export_id?: number | null;
  backup_manifest_path: string;
  status: string;
};

export type ProviderRunStatus = {
  id: number;
  provider: string;
  model?: string | null;
  status: string;
  failure_detail?: string | null;
};

export type WorkbenchSettings = {
  selected_project_id?: number | null;
  source_language: string;
  target_language: string;
  provider_base_url: string;
  provider_model: string;
  system_prompt: string;
  export_dir: string;
  active_tab: string;
  show_hover_help: boolean;
  ui_font_size: "small" | "medium" | "large";
};

export type ReviewCounts = {
  all: number;
  missing: number;
  pending: number;
  accepted: number;
  reviewed: number;
  attention: number;
  exportable: number;
  open_issues?: number;
  json_parse?: number;
  validation?: number;
  final_failed?: number;
  clean_approvable?: number;
  unsupported?: number;
};

export type CheckpointSummary = {
  path: string;
  exists: boolean;
  provider_run_id?: number | null;
  target_language: string;
  completed_count: number;
  failed_count: number;
  failure_type_counts?: Record<string, number>;
};

export type TranslationJobSummary = {
  id: number;
  provider_run_id?: number | null;
  project_id?: number | null;
  source_language: string;
  target_language: string;
  checkpoint_path: string;
  status: string;
  completed_items: number;
  failed_items: number;
  total_items: number;
  processed_batches: number;
  total_batches: number;
  split_batches: number;
  parse_failed_items: number;
  validation_failed_items: number;
  skipped_items: number;
  censored_retry_count: number;
  retry_pending_items?: number;
  recoverable_provider_failures?: number;
  final_failed_items?: number;
	  provider_backoff_ms?: number | null;
	  effective_batch_size?: number;
	  next_experiment_batch_size?: number;
	  input_token_budget?: number;
	  speed_mode?: string;
	  success_streak?: number;
	  success_delay_floor_ms?: number;
	  next_delay_ms?: number | null;
	  failure_reason_counts_json?: string;
	  adaptive_decision_reason?: string;
	  legacy_checkpoint_only?: boolean;
  item_eta_ms?: number | null;
  batch_eta_ms?: number | null;
  last_batch_elapsed_ms?: number | null;
  avg_batch_elapsed_ms?: number | null;
  recent_p50_batch_elapsed_ms?: number | null;
  recent_p95_batch_elapsed_ms?: number | null;
  best_items_per_minute?: number | null;
  current_batch_items: number;
  elapsed_ms: number;
  model?: string | null;
};

export type HydrateWorkbenchResponse = {
  workspace?: ProjectWorkspaceSummary | null;
  projects: ProjectSummary[];
  selected_project_id?: number | null;
  settings: WorkbenchSettings;
  dashboard?: DashboardSummary | null;
  review_counts?: ReviewCounts | null;
  checkpoint?: CheckpointSummary | null;
  latest_job?: TranslationJobSummary | null;
  stale_runs_interrupted: number;
};

export type ReviewQueueRow = {
  source_text_id: number;
  source_language: string;
  normalized_text: string;
  visible_text: string;
  control_code_signature: string;
  occurrence_count: number;
  first_file_path: string;
  first_json_path: string;
  translation_id?: number | null;
  target_language: string;
  translated_text?: string | null;
  provider?: string | null;
  model?: string | null;
  review_state: string;
  qa_state: string;
  qa_finding_count: number;
  qa_findings?: QaFinding[];
  issue_badges?: string[];
  translation_updated_at?: string | null;
  draft_text?: string | null;
  draft_updated_at?: string | null;
  has_unapplied_draft?: boolean;
};

export type QaFinding = {
  id: number;
  source_text_id: number;
  translation_id?: number | null;
  target_language?: string | null;
  provider_run_id?: number | null;
  finding_type: string;
  severity: string;
  message: string;
  status: string;
  resolved_at?: string | null;
  details_json: string;
};

export type ScanPersistenceReport = {
  project_id: number;
  snapshot_id: number;
  source_text_count: number;
  occurrence_count: number;
  added_source_text_count: number;
  removed_occurrence_count: number;
  unchanged_source_text_count: number;
  rejected_count: number;
  skipped_count: number;
};

export type TranslateResponse = {
  status: "completed" | "completed_with_failures" | "paused" | string;
  provider_run_id: number;
  accepted_count: number;
  failed_count: number;
  split_batches: number;
  failures: Array<{ source_text_ids: number[]; message: string }>;
  completed_items: number;
  failed_items: number;
  total_items: number;
  processed_batches: number;
  total_batches: number;
  elapsed_ms: number;
  eta_ms?: number | null;
  item_eta_ms?: number | null;
  batch_eta_ms?: number | null;
  last_batch_elapsed_ms?: number | null;
  avg_batch_elapsed_ms?: number | null;
  recent_p50_batch_elapsed_ms?: number | null;
  recent_p95_batch_elapsed_ms?: number | null;
  best_items_per_minute?: number | null;
  current_batch_items?: number;
  started_completed_items?: number;
  parse_failed_items?: number;
  validation_failed_items?: number;
  skipped_items?: number;
  censored_retry_count?: number;
  retry_pending_items?: number;
  recoverable_provider_failures?: number;
  final_failed_items?: number;
	  provider_backoff_ms?: number | null;
	  effective_batch_size?: number;
	  next_experiment_batch_size?: number;
	  input_token_budget?: number;
	  speed_mode?: string;
	  success_streak?: number;
	  success_delay_floor_ms?: number;
	  next_delay_ms?: number | null;
	  failure_reason_counts?: Record<string, number>;
	  adaptive_decision_reason?: string;
	  legacy_checkpoint_only?: boolean;
	  model?: string | null;
	};

export type ProviderSpeedBenchmarkRun = {
  run_index: number;
  latency_ms: number;
  item_count: number;
  char_count: number;
};

export type ProviderSpeedBenchmarkReport = {
  warmup_ms?: number | null;
  runs: ProviderSpeedBenchmarkRun[];
  average_ms?: number | null;
  median_ms?: number | null;
  p95_ms?: number | null;
  items_per_minute?: number | null;
  chars_per_second?: number | null;
  estimated_paced_items_per_minute?: number | null;
  resolved_model?: string | null;
};

export type DiagnosticsResponse = {
  dashboard: DashboardSummary;
  runtime_provider_surface: string;
  runtime_ui_surface: string;
  integrity_check?: string;
  foreign_key_violations?: number;
  journal_mode?: string;
  busy_timeout_ms?: number;
  stale_running_provider_runs?: number;
  checkpoint_completed_count?: number;
  checkpoint_failed_count?: number;
  exportable_count?: number;
  unscanned_runtime_candidate_count?: number;
  unscanned_unique_source_count?: number;
  unscanned_occurrence_count?: number;
  export_missing_count?: number;
  unsupported_string_candidate_count?: number;
  runtime_candidate_count?: number;
  runtime_imported_translatable_count?: number;
  unsupported_image_text_count?: number;
  layout_overflow_count?: number;
  stale_render_count?: number;
  ownership_conflict_count?: number;
  replay_failure_count?: number;
  coverage_samples?: CoverageAuditSample[];
  latest_job?: TranslationJobSummary | null;
};

export type CoverageAuditSample = {
  category: string;
  text: string;
  file_path: string;
  json_path: string;
  reason?: string | null;
};

export type ExportBundleResponse = {
  export_id: number;
  output_dir: string;
  included_count: number;
  skipped_count: number;
  manifest_hash: string;
};

export type InstallOverlayResponse = {
  install_id?: number | null;
  install_manifest_path: string;
  plugins_file: string;
  plugins_backup_path: string;
  installed_files: string[];
};
