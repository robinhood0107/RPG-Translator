import type {
  DashboardSummary,
  DiagnosticsResponse,
  ExportBundleResponse,
  InstallOverlayResponse,
  ProjectSummary,
  ReviewQueueRow,
  ScanPersistenceReport,
  TranslateResponse,
} from "./types";

export const mockProjects: ProjectSummary[] = [
  {
    id: 1,
    display_name: "Synthetic Workbench",
    game_root: "C:/Games/SyntheticWorkbench",
    engine: "mz",
  },
  {
    id: 2,
    display_name: "Menu Regression Fixture",
    game_root: "C:/Games/MenuFixture",
    engine: "mv",
  },
];

export const mockDashboard: DashboardSummary = {
  project_id: 1,
  target_language: "ko",
  source_text_count: 1286,
  occurrence_count: 3419,
  translated_count: 924,
  accepted_count: 602,
  reviewed_count: 188,
  review_queue_count: 134,
  qa_finding_count: 17,
  latest_export: {
    id: 42,
    project_id: 1,
    target_language: "ko",
    export_path: "C:/Exports/synthetic-ko",
    manifest_hash: "9e3a7f",
    included_count: 790,
  },
  latest_install: {
    id: 19,
    project_id: 1,
    game_root: "C:/Games/SyntheticWorkbench",
    export_id: 42,
    backup_manifest_path: "js/plugins/rpg-translator/install-manifest.json",
    status: "installed",
  },
  latest_provider_run: {
    id: 73,
    provider: "local-openai-compatible",
    model: "lm-studio/synthetic",
    status: "completed_with_failures",
    failure_detail: "2 batches failed placeholder validation",
  },
};

export const mockRows: ReviewQueueRow[] = [
  {
    source_text_id: 11,
    source_language: "ja",
    normalized_text: "こんにちは¤",
    visible_text: "こんにちは",
    control_code_signature: "\\N[1]",
    occurrence_count: 8,
    first_file_path: "data/Map001.json",
    first_json_path: "$.events[3].pages[0].list[1].parameters[0]",
    translation_id: 501,
    target_language: "ko",
    translated_text: "안녕¤",
    provider: "local-openai-compatible",
    model: "gemma-3-local",
    review_state: "pending",
    qa_state: "passed",
    qa_finding_count: 0,
  },
  {
    source_text_id: 12,
    source_language: "ja",
    normalized_text: "はい",
    visible_text: "はい",
    control_code_signature: "",
    occurrence_count: 16,
    first_file_path: "data/Map001.json",
    first_json_path: "$.events[3].pages[0].list[2].parameters[0][0]",
    translation_id: null,
    target_language: "ko",
    translated_text: null,
    provider: null,
    model: null,
    review_state: "missing",
    qa_state: "unchecked",
    qa_finding_count: 0,
  },
  {
    source_text_id: 13,
    source_language: "ja",
    normalized_text: "古い鍵を手に入れた",
    visible_text: "古い鍵を手に入れた",
    control_code_signature: "",
    occurrence_count: 2,
    first_file_path: "data/Items.json",
    first_json_path: "$[4].description",
    translation_id: 503,
    target_language: "ko",
    translated_text: "낡은 열쇠를 얻었다",
    provider: "desktop-fake",
    model: "synthetic-workbench",
    review_state: "accepted",
    qa_state: "passed",
    qa_finding_count: 0,
  },
  {
    source_text_id: 14,
    source_language: "ja",
    normalized_text: "扉は固く閉ざされている",
    visible_text: "扉は固く閉ざされている",
    control_code_signature: "",
    occurrence_count: 3,
    first_file_path: "data/Map002.json",
    first_json_path: "$.events[9].pages[0].list[4].parameters[0]",
    translation_id: 504,
    target_language: "ko",
    translated_text: "문은 굳게 닫혀 있다",
    provider: "local-openai-compatible",
    model: "gemma-3-local",
    review_state: "pending",
    qa_state: "failed",
    qa_finding_count: 1,
  },
];

export const mockScanReport: ScanPersistenceReport = {
  project_id: 1,
  snapshot_id: 8,
  source_text_count: 1286,
  occurrence_count: 3419,
  rejected_count: 92,
  skipped_count: 0,
};

export const mockTranslate: TranslateResponse = {
  provider_run_id: 74,
  accepted_count: 34,
  failed_count: 2,
  split_batches: 1,
  failures: [{ source_text_ids: [14], message: "placeholder validation failed" }],
};

export const mockExport: ExportBundleResponse = {
  export_id: 43,
  output_dir: "C:/Exports/synthetic-ko",
  included_count: 790,
  skipped_count: 134,
  manifest_hash: "c0ffee",
};

export const mockInstall: InstallOverlayResponse = {
  install_id: 20,
  install_manifest_path: "js/plugins/rpg-translator/install-manifest.json",
  plugins_file: "js/plugins.js",
  plugins_backup_path: "js/plugins/rpg-translator/plugins.js.backup",
  installed_files: ["js/plugins/RPGTranslator.js", "js/plugins/rpg-translator/cache.jsonl"],
};

export const mockDiagnostics: DiagnosticsResponse = {
  dashboard: mockDashboard,
  runtime_provider_surface: "not-present",
  runtime_ui_surface: "startup-toast-only",
};
