export type ProjectSummary = {
  id: number;
  game_root: string;
  display_name: string;
  engine: "mv" | "mz" | "unknown" | string;
};

export type DashboardSummary = {
  project_id: number;
  target_language: string;
  source_text_count: number;
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
};

export type ScanPersistenceReport = {
  project_id: number;
  snapshot_id: number;
  source_text_count: number;
  occurrence_count: number;
  rejected_count: number;
  skipped_count: number;
};

export type TranslateResponse = {
  provider_run_id: number;
  accepted_count: number;
  failed_count: number;
  split_batches: number;
  failures: Array<{ source_text_ids: number[]; message: string }>;
};

export type DiagnosticsResponse = {
  dashboard: DashboardSummary;
  runtime_provider_surface: string;
  runtime_ui_surface: string;
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
