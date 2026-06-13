import { invoke } from "@tauri-apps/api/core";
import type {
  DiagnosticsResponse,
  DuplicateProjectCleanupReport,
  ExportBundleResponse,
  HydrateWorkbenchResponse,
  InstallOverlayResponse,
  ProviderSpeedBenchmarkReport,
  ProjectWorkspaceSummary,
  ProjectSummary,
  ReviewQueueRow,
  ScanPersistenceReport,
  TranslateResponse,
} from "./types";

type CommandMap = {
  hydrate_workbench: { request: { db_path?: string; project_file_path?: string }; response: HydrateWorkbenchResponse };
  save_workbench_settings: {
    request: {
      db_path: string;
      selected_project_id?: number | null;
      source_language?: string;
      target_language?: string;
      provider_base_url?: string;
      provider_model?: string;
      system_prompt?: string;
      export_dir?: string;
      active_tab?: string;
      show_hover_help?: boolean;
      ui_font_size?: "small" | "medium" | "large";
    };
    response: { settings: HydrateWorkbenchResponse["settings"] };
  };
  save_workbench_state: {
    request: {
      db_path: string;
      selected_project_id?: number | null;
      source_language?: string;
      target_language?: string;
      provider_base_url?: string;
      provider_model?: string;
      system_prompt?: string;
      export_dir?: string;
      active_tab?: string;
      show_hover_help?: boolean;
      ui_font_size?: "small" | "medium" | "large";
      review_drafts?: Array<{
        source_text_id: number;
        target_language: string;
        draft_text: string;
        base_translation_updated_at?: string | null;
      }>;
    };
    response: { settings: HydrateWorkbenchResponse["settings"]; saved_drafts: number; saved_at: string };
  };
  list_projects: { request: { db_path: string }; response: { projects: ProjectSummary[] } };
  open_project: {
    request: { game_root: string };
    response: {
      project?: ProjectSummary | null;
      workspace: ProjectWorkspaceSummary;
      layout: string;
      data_path: string;
      plugin_path: string;
      database_missing: boolean;
      manifest_created: boolean;
    };
  };
  open_project_file: {
    request: { project_file_path: string };
    response: {
      project?: ProjectSummary | null;
      workspace: ProjectWorkspaceSummary;
      layout: string;
      data_path: string;
      plugin_path: string;
      database_missing: boolean;
      manifest_created: boolean;
    };
  };
  recreate_project_database: {
    request: { project_file_path: string };
    response: {
      project?: ProjectSummary | null;
      workspace: ProjectWorkspaceSummary;
      layout: string;
      data_path: string;
      plugin_path: string;
      database_missing: boolean;
      manifest_created: boolean;
    };
  };
  cleanup_duplicate_projects: {
    request: { db_path: string };
    response: { report: DuplicateProjectCleanupReport };
  };
  reveal_path_in_explorer: {
    request: { project_file_path: string; target_path: string };
    response: { path: string };
  };
  open_folder_in_explorer: {
    request: { project_file_path: string; target_path: string };
    response: { path: string };
  };
  copy_path_to_clipboard: {
    request: { project_file_path: string; target_path: string };
    response: { path: string };
  };
  scan_game: {
    request: { db_path: string; game_root: string; source_language?: string; disable_cjk_filter?: boolean };
    response: { report: ScanPersistenceReport };
  };
  translate_with_local_provider: {
    request: {
      db_path: string;
      project_id?: number | null;
      source_language: string;
      target_language: string;
      batch_size?: number;
      base_url: string;
      model: string;
      system_prompt: string;
      temperature?: number | null;
      top_p?: number | null;
      max_output_tokens?: number | null;
      source_text_ids?: number[] | null;
      issue_filter?: string | null;
      retranslate_mode?: "normal" | "selected_issue_rows" | "current_issue_filter" | null;
    };
    response: TranslateResponse;
  };
  pause_translation: {
    request: Record<string, never>;
    response: { requested: boolean; provider_run_id?: number | null; mode: string };
  };
  prepare_safe_shutdown: {
    request: { db_path?: string | null };
    response: {
      pause_requested: boolean;
      provider_run_id?: number | null;
      mode: string;
      stale_runs_interrupted: number;
    };
  };
  force_close_workbench: {
    request: { reason?: string | null };
    response: { requested: boolean };
  };
	  test_local_provider: {
    request: {
      base_url: string;
      model: string;
      source_language: string;
      target_language: string;
      system_prompt: string;
      sample_text?: string | null;
    };
	    response: { ok: boolean; latency_ms: number; raw_output: string; model?: string | null; message?: string | null };
	  };
  benchmark_provider_translation_speed: {
    request: {
      db_path: string;
      project_id?: number | null;
      source_language: string;
      target_language: string;
      batch_size?: number;
      base_url: string;
      model: string;
      system_prompt: string;
      temperature?: number | null;
      top_p?: number | null;
      max_output_tokens?: number | null;
      warmup_runs?: number | null;
      measured_runs?: number | null;
    };
    response: ProviderSpeedBenchmarkReport;
  };
  review_queue: {
    request: {
      db_path: string;
      project_id: number;
      target_language: string;
      review_state?: string | null;
      issue_filter?: string | null;
      limit?: number;
      offset?: number;
    };
    response: {
      rows: ReviewQueueRow[];
      total_count: number;
      next_offset: number | null;
      page: number;
      page_size: number;
      total_pages: number;
      range_start: number;
      range_end: number;
    };
  };
  update_review_state: {
    request: {
      db_path: string;
      source_text_id: number;
      target_language: string;
      translated_text: string;
      provider: string;
      model?: string | null;
      review_state: string;
      qa_state: string;
    };
    response: { translation: { review_state: string; qa_state: string } };
  };
  update_review_row: {
    request: {
      db_path: string;
      source_text_id: number;
      target_language: string;
      translated_text: string;
      provider: string;
      model?: string | null;
      review_state: string;
      qa_state: string;
      expected_updated_at?: string | null;
    };
    response: { row: ReviewQueueRow };
  };
  bulk_approve_review_rows: {
    request: {
      db_path: string;
      project_id: number;
      target_language: string;
      source_text_ids?: number[] | null;
    };
    response: {
      updated_count: number;
      skipped_missing_count?: number;
      skipped_finding_count?: number;
      skipped_attention_count?: number;
      skipped_validation_count?: number;
    };
  };
  export_bundle: {
    request: { db_path: string; project_id: number; target_language: string; output_dir: string };
    response: ExportBundleResponse;
  };
  install_overlay: {
    request: {
      db_path: string;
      game_root: string;
      export_dir: string;
      project_id?: number | null;
      export_id?: number | null;
    };
    response: InstallOverlayResponse;
  };
  rollback_overlay: {
    request: { db_path: string; manifest_path: string; install_id: number };
    response: { restored_plugins_file: string; removed_files: string[] };
  };
  diagnostics_summary: {
    request: { db_path: string; project_id: number; target_language: string };
    response: DiagnosticsResponse;
  };
};

type CommandName = keyof CommandMap;

export async function callCommand<Name extends CommandName>(
  name: Name,
  request: CommandMap[Name]["request"],
): Promise<CommandMap[Name]["response"]> {
  if (!isDesktopRuntime()) {
    throw new Error(`desktop runtime is required for ${String(name)}`);
  }
  try {
    return await invoke<CommandMap[Name]["response"]>(name, { request });
  } catch (caught) {
    throw new Error(commandErrorMessage(caught));
  }
}

export function isDesktopRuntime() {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function commandErrorMessage(caught: unknown) {
  const normalize = (message: string) => message.replace(/^(invalid input|invalid_input):\s*/i, "").trim();
  if (caught instanceof Error) {
    return normalize(caught.message);
  }
  if (typeof caught === "string") {
    return normalize(caught);
  }
  if (caught && typeof caught === "object") {
    const message = (caught as { message?: unknown }).message;
    if (typeof message === "string" && message.trim() !== "") {
      return normalize(message);
    }
    try {
      return normalize(JSON.stringify(caught));
    } catch {
      return normalize(String(caught));
    }
  }
  return normalize(String(caught));
}
