import { invoke } from "@tauri-apps/api/core";
import {
  mockDashboard,
  mockDiagnostics,
  mockExport,
  mockInstall,
  mockProjects,
  mockRows,
  mockScanReport,
  mockTranslate,
} from "./mockData";
import type {
  DiagnosticsResponse,
  ExportBundleResponse,
  InstallOverlayResponse,
  ProjectSummary,
  ReviewQueueRow,
  ScanPersistenceReport,
  TranslateResponse,
} from "./types";

type CommandMap = {
  list_projects: { request: { db_path: string }; response: { projects: ProjectSummary[] } };
  open_project: {
    request: { db_path: string; game_root: string };
    response: { project: ProjectSummary; layout: string; data_path: string; plugin_path: string };
  };
  scan_game: {
    request: { db_path: string; game_root: string; source_language?: string };
    response: { report: ScanPersistenceReport };
  };
  translate_with_fake_provider: {
    request: { db_path: string; target_language: string; batch_size?: number };
    response: TranslateResponse;
  };
  review_queue: {
    request: {
      db_path: string;
      project_id: number;
      target_language: string;
      review_state?: string | null;
    };
    response: { rows: ReviewQueueRow[] };
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

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

export async function callCommand<Name extends CommandName>(
  name: Name,
  request: CommandMap[Name]["request"],
): Promise<CommandMap[Name]["response"]> {
  if (isTauriRuntime()) {
    return invoke<CommandMap[Name]["response"]>(name, { request });
  }
  return mockCommand(name, request);
}

function isTauriRuntime() {
  return Boolean((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

async function mockCommand<Name extends CommandName>(
  name: Name,
  request: CommandMap[Name]["request"],
): Promise<CommandMap[Name]["response"]> {
  await delay(25);
  if ("game_root" in request && String(request.game_root).includes("fail")) {
    throw new Error("synthetic command failure");
  }

  switch (name) {
    case "list_projects":
      return { projects: mockProjects } as CommandMap[Name]["response"];
    case "open_project":
      return {
        project: mockProjects[0],
        layout: "direct",
        data_path: `${mockProjects[0].game_root}/data`,
        plugin_path: `${mockProjects[0].game_root}/js/plugins.js`,
      } as CommandMap[Name]["response"];
    case "scan_game":
      return { report: mockScanReport } as CommandMap[Name]["response"];
    case "translate_with_fake_provider":
      return mockTranslate as CommandMap[Name]["response"];
    case "review_queue":
      return {
        rows: filterRows(
          mockRows,
          (request as CommandMap["review_queue"]["request"]).review_state,
        ),
      } as CommandMap[Name]["response"];
    case "update_review_state":
      return {
        translation: {
          ...mockRows[0],
          review_state: (request as CommandMap["update_review_state"]["request"]).review_state,
        },
      } as CommandMap[Name]["response"];
    case "export_bundle":
      return mockExport as CommandMap[Name]["response"];
    case "install_overlay":
      return mockInstall as CommandMap[Name]["response"];
    case "rollback_overlay":
      return {
        restored_plugins_file: "js/plugins.js",
        removed_files: ["js/plugins/RPGTranslator.js"],
      } as CommandMap[Name]["response"];
    case "diagnostics_summary":
      return mockDiagnostics as CommandMap[Name]["response"];
    default:
      throw new Error(`unknown command ${String(name)}`);
  }
}

function filterRows(rows: ReviewQueueRow[], filter?: string | null) {
  if (!filter || filter === "all") {
    return rows;
  }
  if (filter === "attention") {
    return rows.filter((row) => row.qa_state === "failed" || row.qa_finding_count > 0);
  }
  return rows.filter((row) => row.review_state === filter);
}
