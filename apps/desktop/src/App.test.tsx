import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import App, { buildAfterTranslationAnalysis, text } from "./App";
import { callCommand } from "./api";
import type {
  CheckpointSummary,
  DashboardSummary,
  ProjectSummary,
  ProjectWorkspaceSummary,
  ReviewCounts,
  TranslationJobSummary,
} from "./types";

const testProjectFilePath = "/tmp/fixture-game/rpg-translator/Fixture_Game.rpgmakers";
const testDbPath = "/tmp/fixture-game/rpg-translator/db/Fixture_Game.sqlite";

const invokeMock = vi.hoisted(() => vi.fn());
const openDialogMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const appWindowCloseMock = vi.hoisted(() => vi.fn());
const appWindowDestroyMock = vi.hoisted(() => vi.fn());
const eventHandlers = vi.hoisted(() => ({
  scanProgress: undefined as ((event: { payload: unknown }) => void) | undefined,
  translateProgress: undefined as ((event: { payload: unknown }) => void) | undefined,
}));
const appWindowHandlers = vi.hoisted(() => ({
  closeRequested: undefined as
    | ((event: { preventDefault: () => void }) => void | Promise<void>)
    | undefined,
  unlistenCloseRequested: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: openDialogMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    close: appWindowCloseMock,
    destroy: appWindowDestroyMock,
    onCloseRequested: (
      handler: (event: { preventDefault: () => void }) => void | Promise<void>,
    ) => {
      appWindowHandlers.closeRequested = handler;
      return Promise.resolve(appWindowHandlers.unlistenCloseRequested);
    },
  }),
}));

beforeEach(() => {
  invokeMock.mockReset();
  openDialogMock.mockReset();
  listenMock.mockReset();
  appWindowCloseMock.mockReset();
  appWindowDestroyMock.mockReset();
  appWindowDestroyMock.mockResolvedValue(undefined);
  appWindowHandlers.closeRequested = undefined;
  appWindowHandlers.unlistenCloseRequested.mockReset();
  eventHandlers.scanProgress = undefined;
  eventHandlers.translateProgress = undefined;
  listenMock.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
    if (eventName === "scan-progress") {
      eventHandlers.scanProgress = handler;
    }
    if (eventName === "translate-progress") {
      eventHandlers.translateProgress = handler;
    }
    return Promise.resolve(vi.fn());
  });
  localStorage.clear();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

test("web mode renders a mock-free desktop-required workbench without invoking Tauri", async () => {
  render(<App />);

  expect(await screen.findByText("No project selected")).toBeInTheDocument();
  expect(screen.getAllByText("Desktop required").length).toBeGreaterThan(0);
  expect(screen.getByLabelText("Project file / game folder")).toHaveValue("");
  expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Select game folder" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Translate" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Export" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Install" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Rollback" })).toBeDisabled();
  expect(screen.queryByText("Synthetic Workbench")).not.toBeInTheDocument();
  expect(screen.queryByText("Run fake provider")).not.toBeInTheDocument();
  expect(invokeMock).not.toHaveBeenCalled();
});

test("desktop startup without a recent project file does not open a global workbench database", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};

  render(<App />);

  expect(await screen.findByText("No project selected")).toBeInTheDocument();
  expect(screen.getByText("Open a .rpgmakers project first.")).toBeInTheDocument();
  expect(screen.getByText("Project DB").nextElementSibling).toHaveTextContent("none");
  expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
  expect(invokeMock).not.toHaveBeenCalled();
});

test("topbar language switch changes visible text and persists Korean preference", async () => {
  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "한국어" }));

  expect(screen.getByText("선택된 프로젝트 없음")).toBeInTheDocument();
  expect(screen.getAllByText("데스크톱 필요").length).toBeGreaterThan(0);
  expect(screen.getByText("스캔 상태")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "English" })).toBeInTheDocument();
  expect(localStorage.getItem("rpg-translator-language")).toBe("ko");
});

test("language settings restore stored source and target preferences", async () => {
  localStorage.setItem("rpg-translator-source-language", "zh");
  localStorage.setItem("rpg-translator-target-language", "Elvish");

  render(<App />);

  expect(await screen.findByLabelText("Source language")).toHaveValue("zh");
  expect(screen.getByLabelText("Target language")).toHaveValue("custom");
  expect(screen.getByLabelText("Custom target language")).toHaveValue("Elvish");
});

test("desktop folder button opens a directory picker and opens the selected project", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  openDialogMock.mockResolvedValue("/tmp/picked-game");
  invokeMock.mockImplementation((name: string) => {
    if (name === "open_project") {
      return Promise.resolve({
        project: {
          id: 12,
          display_name: "Picked Game",
          game_root: "/tmp/picked-game",
          engine: "mz",
        },
        layout: "direct",
        data_path: "/tmp/picked-game/data",
        plugin_path: "/tmp/picked-game/js/plugins.js",
        workspace: testWorkspace({
          project_file_path: "/tmp/picked-game/rpg-translator/picked-game.rpgmakers",
          artifact_root: "/tmp/picked-game/rpg-translator",
          db_path: "/tmp/picked-game/rpg-translator/db/picked-game.sqlite",
          game_root: "/tmp/picked-game",
          display_name: "Picked Game",
        }),
        database_missing: false,
        manifest_created: true,
      });
    }
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        project: testProject({
          id: 12,
          display_name: "Picked Game",
          game_root: "/tmp/picked-game",
        }),
        workspace: testWorkspace({
          project_file_path: "/tmp/picked-game/rpg-translator/picked-game.rpgmakers",
          artifact_root: "/tmp/picked-game/rpg-translator",
          db_path: "/tmp/picked-game/rpg-translator/db/picked-game.sqlite",
          game_root: "/tmp/picked-game",
          display_name: "Picked Game",
        }),
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Select game folder" }));

  await waitFor(() =>
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Select game folder",
    }),
  );
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("open_project", {
      request: {
        game_root: "/tmp/picked-game",
      },
    }),
  );
  expect(await screen.findByDisplayValue("/tmp/picked-game")).toBeInTheDocument();
  expect((await screen.findAllByText("Picked Game")).length).toBeGreaterThan(0);
});

test("missing project database blocks work until the user explicitly recreates it", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  const missingWorkspace = testWorkspace({ database_missing: true });
  const recreatedWorkspace = testWorkspace({ database_missing: false });
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(
        hydratedWorkbench({
          project: testProject(),
          workspace: recreatedWorkspace,
          active_tab: "scan",
        }),
      );
    }
    if (name === "recreate_project_database") {
      return Promise.resolve({
        project: testProject(),
        workspace: recreatedWorkspace,
        layout: "direct",
        data_path: "/tmp/fixture-game/data",
        plugin_path: "/tmp/fixture-game/js/plugins.js",
        database_missing: false,
        manifest_created: false,
      });
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });
  invokeMock.mockImplementationOnce((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve({
        workspace: missingWorkspace,
        projects: [],
        selected_project_id: null,
        settings: {
          selected_project_id: null,
          source_language: "en",
          target_language: "ko",
          provider_base_url: "",
          provider_model: "auto",
          system_prompt: "prompt",
          export_dir: missingWorkspace.exports_path,
          active_tab: "scan",
          show_hover_help: true,
        },
        dashboard: null,
        review_counts: null,
        checkpoint: null,
        latest_job: null,
        stale_runs_interrupted: 0,
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect(await screen.findByText(/Project DB is missing/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Scan" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Create new DB" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("recreate_project_database", {
      request: { project_file_path: testProjectFilePath },
    }),
  );
  await waitFor(() => expect(screen.queryByText(/Project DB is missing/)).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "Scan" })).not.toBeDisabled();
});

test("windows extended project paths render as normal user-facing paths", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const projectFilePath =
    "///?/C:/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator/City_Of_Secrets.rpgmakers";
  const dbPath =
    "file:///C:/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator/db/City_Of_Secrets.sqlite";
  const artifactRoot = "/mnt/c/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator";
  const gameRoot = "/mnt/c/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets";
  const displayProjectFilePath =
    "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\City_Of_Secrets.rpgmakers";
  const displayDbPath =
    "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\db\\City_Of_Secrets.sqlite";
  const displayArtifactRoot = "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator";
  localStorage.setItem("rpg-translator-project-file", projectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(
        hydratedWorkbench({
          project: testProject({
            display_name: "City_Of_Secrets",
            game_root: gameRoot,
          }),
          workspace: testWorkspace({
            project_file_path: projectFilePath,
            db_path: dbPath,
            artifact_root: artifactRoot,
            game_root: gameRoot,
            display_name: "City_Of_Secrets",
            exports_path: "/mnt/c/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator/exports",
          }),
        }),
      );
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect(await screen.findAllByText(displayProjectFilePath)).not.toHaveLength(0);
  expect(screen.getByText(displayDbPath)).toBeInTheDocument();
  expect(screen.getByText(displayArtifactRoot)).toBeInTheDocument();
  expect(screen.getByLabelText("Project file / game folder")).toHaveValue(
    "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets",
  );
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("hydrate_workbench", {
      request: {
        project_file_path: displayProjectFilePath,
      },
    }),
  );
  expect(localStorage.getItem("rpg-translator-project-file")).toBe(displayProjectFilePath);
  expect(screen.queryByText(projectFilePath)).not.toBeInTheDocument();
  expect(screen.queryByText(artifactRoot)).not.toBeInTheDocument();
});

test("manual project path input is normalized before opening the project", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const typedPath = "///?/C:/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets";
  const windowsGameRoot = "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets";
  const windowsProjectFile =
    "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\City_Of_Secrets.rpgmakers";
  invokeMock.mockImplementation((name: string) => {
    if (name === "open_project") {
      return Promise.resolve({
        project: testProject({
          id: 44,
          display_name: "City_Of_Secrets",
          game_root: windowsGameRoot,
        }),
        layout: "direct",
        data_path: `${windowsGameRoot}\\data`,
        plugin_path: `${windowsGameRoot}\\js\\plugins.js`,
        workspace: testWorkspace({
          project_file_path: windowsProjectFile,
          artifact_root: `${windowsGameRoot}\\rpg-translator`,
          db_path: `${windowsGameRoot}\\rpg-translator\\db\\City_Of_Secrets.sqlite`,
          game_root: windowsGameRoot,
          display_name: "City_Of_Secrets",
          exports_path: `${windowsGameRoot}\\rpg-translator\\exports`,
        }),
        database_missing: false,
        manifest_created: false,
      });
    }
    if (name === "hydrate_workbench") {
      return Promise.resolve(
        hydratedWorkbench({
          project: testProject({
            id: 44,
            display_name: "City_Of_Secrets",
            game_root: windowsGameRoot,
          }),
          workspace: testWorkspace({
            project_file_path: windowsProjectFile,
            artifact_root: `${windowsGameRoot}\\rpg-translator`,
            db_path: `${windowsGameRoot}\\rpg-translator\\db\\City_Of_Secrets.sqlite`,
            game_root: windowsGameRoot,
            display_name: "City_Of_Secrets",
            exports_path: `${windowsGameRoot}\\rpg-translator\\exports`,
          }),
        }),
      );
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.change(await screen.findByLabelText("Project file / game folder"), {
    target: { value: typedPath },
  });
  expect(screen.getByLabelText("Project file / game folder")).toHaveValue(windowsGameRoot);
  fireEvent.click(screen.getByRole("button", { name: "Open project" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("open_project", {
      request: {
        game_root: windowsGameRoot,
      },
    }),
  );
  await waitFor(() => expect(localStorage.getItem("rpg-translator-project-file")).toBe(windowsProjectFile));
});

test("duplicate canonical projects render as one row and reopening selects the existing project", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  const windowsGameRoot = "C:\\Users\\pjjpj\\Desktop\\City_Of_Secrets";
  const projectFilePath = `${windowsGameRoot}\\rpg-translator\\City_Of_Secrets.rpgmakers`;
  localStorage.setItem("rpg-translator-project-file", projectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve({
        ...hydratedWorkbench({
          project: testProject({
            id: 3,
            display_name: "City_Of_Secrets",
            game_root: windowsGameRoot,
          }),
          workspace: testWorkspace({
            project_file_path: projectFilePath,
            artifact_root: `${windowsGameRoot}\\rpg-translator`,
            db_path: `${windowsGameRoot}\\rpg-translator\\db\\City_Of_Secrets.sqlite`,
            game_root: windowsGameRoot,
            display_name: "City_Of_Secrets",
          }),
        }),
        projects: [
          {
            id: 3,
            display_name: "City_Of_Secrets",
            game_root: windowsGameRoot,
            engine: "mz",
          },
          {
            id: 8,
            display_name: "City_Of_Secrets",
            game_root: "///?/C:/Users/pjjpj/Desktop/City_Of_Secrets",
            engine: "mz",
          },
        ],
        selected_project_id: 8,
      });
    }
    if (name === "open_project_file") {
      return Promise.resolve({
        project: {
          id: 3,
          display_name: "City_Of_Secrets",
          game_root: "///?/C:/Users/pjjpj/Desktop/City_Of_Secrets",
          engine: "mz",
        },
        workspace: testWorkspace({
          project_file_path: projectFilePath,
          artifact_root: `${windowsGameRoot}\\rpg-translator`,
          db_path: `${windowsGameRoot}\\rpg-translator\\db\\City_Of_Secrets.sqlite`,
          game_root: windowsGameRoot,
          display_name: "City_Of_Secrets",
        }),
        layout: "direct",
        data_path: `${windowsGameRoot}\\data`,
        plugin_path: `${windowsGameRoot}\\js\\plugins.js`,
        database_missing: false,
        manifest_created: false,
      });
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("City_Of_Secrets")).length).toBeGreaterThan(0);
  expect(document.querySelectorAll(".project-list .project-row")).toHaveLength(1);
  expect(document.querySelector(".project-list .project-row")).toHaveClass("selected");

  openDialogMock.mockResolvedValue(projectFilePath);
  fireEvent.click(screen.getByRole("button", { name: "Open .rpgmakers" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("open_project_file", {
      request: { project_file_path: projectFilePath },
    }),
  );
  expect(document.querySelectorAll(".project-list .project-row")).toHaveLength(1);
});

test("custom app context menus replace the browser menu for projects, paths, inputs, and empty space", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench());
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "reveal_path_in_explorer" || name === "open_folder_in_explorer" || name === "copy_path_to_clipboard") {
      return Promise.resolve({ path: testProjectFilePath });
    }
    if (name === "cleanup_duplicate_projects") {
      return Promise.resolve({
        report: { merged_project_count: 1, survivor_project_ids: [7], removed_project_ids: [8] },
      });
    }
    if (name === "save_workbench_settings") {
      return Promise.resolve({ settings: hydratedWorkbench().settings });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("Fixture Game")).length).toBeGreaterThan(0);
  const appShell = document.querySelector(".app-shell")!;
  fireEvent.contextMenu(appShell);
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();

  fireEvent.contextMenu(screen.getByLabelText("Project file / game folder"));
  let menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Cut" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Paste" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Select all" })).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole("button", { name: "Project management" }));
  menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Show project file" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Open DB folder" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Open artifact folder" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitem", { name: "Clean duplicate projects" })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Show project file" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("reveal_path_in_explorer", {
      request: { project_file_path: testProjectFilePath, target_path: testProjectFilePath },
    }),
  );

  const projectRow = document.querySelector(".project-list .project-row")!;
  fireEvent.contextMenu(projectRow);
  menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Open this project" })).toBeInTheDocument();
});

test("project file actions hide backend invalid-input details from user alerts", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench());
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "open_folder_in_explorer") {
      return Promise.reject(new Error("invalid input: open folder in file manager exited with exit code: 1"));
    }
    if (name === "save_workbench_settings") {
      return Promise.resolve({ settings: hydratedWorkbench().settings });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("Fixture Game")).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Project management" }));
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open DB folder" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not open the folder in Explorer");
  expect(alert).not.toHaveTextContent(/invalid input/i);
  expect(alert).not.toHaveTextContent(/file manager exited/i);
});

test("review row context menu exposes only row-specific review actions", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "review" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({
        rows: [
          reviewRow({
            source_text_id: 10,
            visible_text: "Emma",
            translated_text: "엠마",
            first_file_path: "data/Actors.json",
            first_json_path: "$.actors[0].name",
          }),
        ],
        total_count: 1,
        next_offset: null,
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  const row = (await screen.findByText("Emma")).closest("tr");
  expect(row).not.toBeNull();
  fireEvent.contextMenu(row!);

  const menu = await screen.findByRole("menu");
  for (const label of ["Copy source text", "Copy translation", "Copy location", "Save and check", "Approve", "Problem"]) {
    expect(within(menu).getByRole("menuitem", { name: label })).toBeInTheDocument();
  }
  expect(within(menu).queryByRole("menuitem", { name: "Save" })).not.toBeInTheDocument();
});

test("desktop language settings persist and drive scan and translate payloads", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "scan",
        project: testProject({ display_name: "English Game", game_root: "/tmp/english-game" }),
        workspace: testWorkspace({
          project_file_path: "/tmp/english-game/rpg-translator/English_Game.rpgmakers",
          artifact_root: "/tmp/english-game/rpg-translator",
          db_path: "/tmp/english-game/rpg-translator/db/English_Game.sqlite",
          game_root: "/tmp/english-game",
          display_name: "English Game",
          exports_path: "/tmp/english-game/rpg-translator/exports",
        }),
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "scan_game") {
      return Promise.resolve({
        report: {
          project_id: 7,
          snapshot_id: 70,
          source_text_count: 12,
          occurrence_count: 14,
          added_source_text_count: 12,
          removed_occurrence_count: 0,
          unchanged_source_text_count: 0,
          rejected_count: 3,
          skipped_count: 0,
        },
      });
    }
    if (name === "translate_with_local_provider") {
      return Promise.resolve({
        status: "completed",
        accepted_count: 2,
        failed_count: 0,
        provider_run_id: 22,
        split_batches: 0,
        failures: [],
        completed_items: 2,
        failed_items: 0,
        total_items: 2,
        processed_batches: 1,
        total_batches: 1,
        elapsed_ms: 1000,
        eta_ms: null,
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Scan" }));
  const sourceLanguage = await screen.findByLabelText("Source language");
  const targetLanguage = screen.getByLabelText("Target language");
  expect(sourceLanguage).toHaveValue("en");
  expect(targetLanguage).toHaveValue("ko");
  expect(screen.getByRole("option", { name: "Vietnamese" })).toBeInTheDocument();

  fireEvent.change(sourceLanguage, { target: { value: "ja" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Scan" }).at(-1)!);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("scan_game", {
      request: {
        db_path: "/tmp/english-game/rpg-translator/db/English_Game.sqlite",
        game_root: "/tmp/english-game",
        source_language: "ja",
      },
    }),
  );

  fireEvent.change(sourceLanguage, { target: { value: "zh" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Scan" }).at(-1)!);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("scan_game", {
      request: {
        db_path: "/tmp/english-game/rpg-translator/db/English_Game.sqlite",
        game_root: "/tmp/english-game",
        source_language: "zh",
      },
    }),
  );

  expect(localStorage.getItem("rpg-translator-source-language")).toBe("zh");

  fireEvent.change(targetLanguage, { target: { value: "vi" } });
  expect(localStorage.getItem("rpg-translator-target-language")).toBe("vi");
  fireEvent.click(screen.getByRole("tab", { name: "Translate" }));
  fireEvent.click(screen.getByRole("button", { name: "Prompt settings" }));
  const defaultUiPrompt = (await screen.findByLabelText("System prompt") as HTMLTextAreaElement).value;
  expect(defaultUiPrompt.trim().length).toBeGreaterThan(0);
  fireEvent.click(screen.getAllByRole("button", { name: "Cancel" }).at(-1)!);
  fireEvent.change(screen.getByLabelText("Provider endpoint"), { target: { value: "http://127.0.0.1:11434" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gemma-local" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Translate" }).at(-1)!);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("translate_with_local_provider", {
      request: expect.objectContaining({
        db_path: "/tmp/english-game/rpg-translator/db/English_Game.sqlite",
        project_id: 7,
        source_language: "zh",
        target_language: "vi",
        base_url: "http://127.0.0.1:11434",
        model: "gemma-local",
        system_prompt: defaultUiPrompt,
      }),
    }),
  );
});

test("translate tab runs a read-only real prompt speed benchmark and renders warmup-separated results", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "translate" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "benchmark_provider_translation_speed") {
      return Promise.resolve({
        warmup_ms: 4000,
        runs: [
          { run_index: 1, latency_ms: 1000, item_count: 16, char_count: 320 },
          { run_index: 2, latency_ms: 1100, item_count: 16, char_count: 320 },
          { run_index: 3, latency_ms: 900, item_count: 16, char_count: 320 },
          { run_index: 4, latency_ms: 1000, item_count: 16, char_count: 320 },
          { run_index: 5, latency_ms: 1000, item_count: 16, char_count: 320 },
        ],
        average_ms: 1000,
        median_ms: 1000,
        p95_ms: 1100,
        items_per_minute: 960,
        chars_per_second: 320,
        estimated_paced_items_per_minute: 384,
        resolved_model: "gemma-local",
      });
    }
    if (name === "save_workbench_settings") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "translate" }).settings });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Real prompt speed test" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("benchmark_provider_translation_speed", {
      request: expect.objectContaining({
        db_path: testDbPath,
        project_id: 7,
        source_language: "en",
        target_language: "ko",
        batch_size: 16,
        base_url: "http://127.0.0.1:18080",
        model: "auto",
        system_prompt: "prompt",
        warmup_runs: 1,
        measured_runs: 5,
      }),
    }),
  );
  expect(await screen.findByText("Real prompt speed result")).toBeInTheDocument();
  expect(screen.getByText("First request")).toBeInTheDocument();
  expect(screen.getAllByText("00:00:01 (1,000 ms)").length).toBeGreaterThan(0);
  expect(screen.getByText(/Estimated throughput with current pacing/)).toBeInTheDocument();
  expect(screen.getByText(/gemma-local/)).toBeInTheDocument();
});

test("real prompt speed benchmark is disabled while translation is running", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "translate" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "save_workbench_settings") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "translate" }).settings });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  const button = await screen.findByRole("button", { name: "Real prompt speed test" });
  expect(button).not.toBeDisabled();

  act(() => {
    eventHandlers.translateProgress?.({
      payload: {
        Started: {
          provider_run_id: 88,
          target_language: "ko",
          model: "gemma-local",
          total_batches: 10,
          processed_batches: 1,
          total_items: 160,
          completed_items: 16,
          failed_items: 0,
          split_batches: 0,
          elapsed_ms: 1000,
          eta_ms: 9000,
          item_eta_ms: 9000,
          batch_eta_ms: 9000,
          last_batch_elapsed_ms: 1000,
          avg_batch_elapsed_ms: 1000,
          recent_p50_batch_elapsed_ms: 900,
          recent_p95_batch_elapsed_ms: 1300,
          best_items_per_minute: 1200,
          current_batch_items: 16,
          started_completed_items: 0,
          parse_failed_items: 0,
          validation_failed_items: 0,
          skipped_items: 0,
          censored_retry_count: 0,
          retry_pending_items: 0,
          recoverable_provider_failures: 0,
          final_failed_items: 0,
          provider_backoff_ms: null,
          effective_batch_size: 16,
          next_experiment_batch_size: 24,
          input_token_budget: 4096,
          speed_mode: "accelerating",
          success_streak: 4,
          success_delay_floor_ms: 1250,
          next_delay_ms: 1250,
          failure_reason_counts: {},
          adaptive_decision_reason: "adaptive: steady from test",
          legacy_checkpoint_only: false,
        },
      },
    });
  });

  expect(screen.getByRole("button", { name: "Real prompt speed test" })).toBeDisabled();
  expect(screen.getByText("Speed mode: Reducing wait")).toBeInTheDocument();
  expect(screen.getByText("Success streak: 4")).toBeInTheDocument();
  expect(screen.getByText("Text ETA 00:00:09")).toBeInTheDocument();
  expect(screen.getByText("Batch ETA 00:00:09")).toBeInTheDocument();
  expect(screen.getByText("Recent p50 batch 00:00:00")).toBeInTheDocument();
  expect(screen.getByText("Recent p95 batch 00:00:01")).toBeInTheDocument();
  expect(screen.getByText("Best speed: 1,200 Items/min")).toBeInTheDocument();
  expect(screen.getByText("Effective batch: 16")).toBeInTheDocument();
  expect(screen.getByText("Next experiment batch: 24")).toBeInTheDocument();
  expect(screen.getByText("Input token budget: 4,096")).toBeInTheDocument();
  expect(screen.getByText("Speed tuning reason: adaptive: steady from test")).toBeInTheDocument();
});

test("review queue paginates rows and appends the next page", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string, payload: { request?: Record<string, unknown> }) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        project: testProject({ display_name: "Paged Game", game_root: "/tmp/paged-game" }),
        workspace: testWorkspace({
          project_file_path: "/tmp/paged-game/rpg-translator/Paged_Game.rpgmakers",
          artifact_root: "/tmp/paged-game/rpg-translator",
          db_path: "/tmp/paged-game/rpg-translator/db/Paged_Game.sqlite",
          game_root: "/tmp/paged-game",
          display_name: "Paged Game",
          exports_path: "/tmp/paged-game/rpg-translator/exports",
        }),
      }));
    }
    if (name === "review_queue") {
      const offset = payload.request?.offset ?? 0;
      return Promise.resolve(
        offset === 0
          ? {
              rows: [
                reviewRow({
                  source_text_id: 1,
                  visible_text: "Alpha",
                  first_file_path: "data/Actors.json",
                }),
              ],
              total_count: 3,
              next_offset: 1,
            }
          : {
              rows: [
                reviewRow({
                  source_text_id: 2,
                  visible_text: "Beta",
                  first_file_path: "data/Map001.json",
                }),
              ],
              total_count: 3,
              next_offset: 2,
            },
      );
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect(await screen.findByText("Alpha")).toBeInTheDocument();
  expect(screen.getByText("1-1 / 3 rows")).toBeInTheDocument();
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("review_queue", {
      request: expect.objectContaining({
        limit: 200,
        offset: 0,
      }),
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Load more" }));

  expect(await screen.findByText("Beta")).toBeInTheDocument();
  expect(screen.getByText("1-2 / 3 rows")).toBeInTheDocument();
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("review_queue", {
      request: expect.objectContaining({
        limit: 200,
        offset: 1,
      }),
    }),
  );
});

test("review queue uses easy Korean labels, a bulk menu, confirmation, and simplified row actions", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  localStorage.setItem("rpg-translator-language", "ko");
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "review",
        show_hover_help: true,
        dashboard: {
          source_text_count: 20_774,
          translated_count: 200,
          accepted_count: 0,
          reviewed_count: 0,
          review_queue_count: 20_774,
        },
        review_counts: {
          all: 20_774,
          missing: 20_574,
          pending: 200,
          accepted: 0,
          reviewed: 0,
          attention: 4,
          exportable: 0,
          open_issues: 12,
          json_parse: 10,
          validation: 2,
          final_failed: 0,
          clean_approvable: 188,
        },
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({
        rows: [
          reviewRow({
            source_text_id: 107,
            visible_text: "Emma",
            translated_text: "엠마",
            translation_id: 11,
            provider: "local-openai-compatible",
            review_state: "pending",
            qa_state: "unchecked",
            qa_findings: [
              {
                id: 44,
                source_text_id: 107,
                target_language: "ko",
                provider_run_id: 22,
                finding_type: "provider-json-parse",
                severity: "error",
                message: "Provider returned markdown instead of JSON",
                status: "open",
                resolved_at: null,
                details_json: "{\"kind\":\"json\"}",
                created_at: "2026-06-08T00:00:00Z",
              },
            ],
            issue_badges: ["json-parse"],
            first_file_path: "data/Actors.json",
            first_json_path: "$.events[107].pages[0].list[116].parameters[4]",
          }),
        ],
        total_count: 20_774,
        next_offset: null,
      });
    }
    if (name === "bulk_approve_review_rows") {
      return Promise.resolve({
        updated_count: 188,
        skipped_missing_count: 20_574,
        skipped_finding_count: 12,
        skipped_attention_count: 4,
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("검토 대기열")).length).toBeGreaterThan(0);
  for (const label of ["전체 보기", "번역 없음", "검토 필요", "내보내기 가능", "직접 확인 필요"]) {
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  }
  for (const label of ["문제 전체", "문제만 보기", "JSON 형식 깨짐", "게임문법 깨짐", "끝까지 실패", "문제 없음"]) {
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  }
  expect(await screen.findByText("Emma")).toBeInTheDocument();
  expect(screen.getAllByText("검토 필요").length).toBeGreaterThan(0);
  expect(screen.getByText("Provider 답안지 형식이 깨졌습니다")).toBeInTheDocument();
  expect(screen.getByText("Provider returned markdown instead of JSON")).toBeInTheDocument();
  expect(screen.getByText("직접 번역문을 넣거나, 배치를 줄이고 프롬프트를 강화한 뒤 이 행만 다시 번역하세요.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "저장 후 검사" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "문제 있음" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "선택 문제 행 재번역" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "현재 문제 필터 재번역" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "문제 없는 행 안전 승인" })).toBeInTheDocument();
  const directRowActions = Array.from(document.querySelector(".row-actions")?.children ?? [])
    .filter((element) => element.tagName === "BUTTON")
    .map((element) => element.textContent?.trim());
  expect(directRowActions).toEqual(["저장 후 검사", "승인", "문제 있음"]);

  fireEvent.click(screen.getByText("더보기"));
  expect(screen.getByRole("button", { name: "원문 그대로 사용" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "수정 취소" })).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "대량 작업" }));
  const menu = screen.getByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "선택 행 승인" })).toBeDisabled();
  expect(within(menu).getByRole("menuitem", { name: "현재 페이지 승인" })).toBeInTheDocument();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "현재 필터 전체 승인" }));

  const dialog = await screen.findByRole("dialog", { name: "현재 필터 전체를 승인할까요?" });
  expect(within(dialog).getByText(/화면에 아직 불러오지 않은 행까지 포함/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "현재 필터 전체 승인" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("bulk_approve_review_rows", {
      request: {
        db_path: testDbPath,
        project_id: 7,
        target_language: "ko",
        source_text_ids: null,
      },
    }),
  );
});

test("review rows expose RPG Maker syntax and source action preserves it", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  localStorage.setItem("rpg-translator-language", "ko");
  const sourceWithSyntax = "\\c[26]*Sigh* Whatever. ";
  const rowWithSyntax = reviewRow({
    source_text_id: 26,
    visible_text: "*Sigh* Whatever.",
    normalized_text: sourceWithSyntax,
    control_code_signature: "\\c[26]",
    translated_text: "*Sigh* Whatever.",
    translation_id: 26,
    provider: "manual-review",
    review_state: "pending",
    qa_state: "needs-review",
    qa_finding_count: 1,
    qa_findings: [
      {
        id: 126,
        source_text_id: 26,
        target_language: "ko",
        provider_run_id: null,
        finding_type: "translation-validation",
        severity: "error",
        message: "제어코드가 원문과 다릅니다. 원문 문법 포함 `\\c[26]*Sigh* Whatever. `, 번역 `*Sigh* Whatever.`.",
        status: "open",
        resolved_at: null,
        details_json: "{}",
        created_at: "2026-06-08T00:00:00Z",
      },
    ],
    issue_badges: ["validation"],
    first_file_path: "data/Map082.json",
    first_json_path: "$.events[8].pages[0].list[4111].parameters[0]",
  });
  invokeMock.mockImplementation((name: string, args?: { request?: Record<string, unknown> }) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "review",
        review_counts: {
          all: 1,
          missing: 0,
          pending: 1,
          accepted: 0,
          reviewed: 0,
          attention: 0,
          exportable: 0,
          open_issues: 1,
          json_parse: 0,
          validation: 1,
          final_failed: 0,
          clean_approvable: 0,
        },
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({
        rows: [rowWithSyntax],
        total_count: 1,
        next_offset: null,
      });
    }
    if (name === "update_review_row") {
      expect(args?.request).toEqual(expect.objectContaining({
        db_path: testDbPath,
        source_text_id: 26,
        target_language: "ko",
        translated_text: sourceWithSyntax,
        provider: "manual-review",
        review_state: "accepted",
        qa_state: "passed",
      }));
      return Promise.resolve({
        row: {
          ...rowWithSyntax,
          translated_text: sourceWithSyntax,
          review_state: "accepted",
          qa_state: "passed",
          qa_finding_count: 0,
          qa_findings: [],
          issue_badges: [],
          translation_updated_at: "2026-06-08T00:01:00Z",
        },
      });
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench().settings, saved_drafts: 0, saved_at: "1" });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("*Sigh* Whatever.")).length).toBeGreaterThan(0);
  expect(screen.getByText("게임문법 포함 원문")).toBeInTheDocument();
  expect(screen.getAllByText(/\\c\[26\]\*Sigh\* Whatever\./).length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText(/원문 문법 포함 `\\c\[26\]\*Sigh\* Whatever\./)).toBeInTheDocument();

  fireEvent.click(screen.getByText("더보기"));
  fireEvent.click(screen.getByRole("button", { name: "원문 그대로 사용" }));

  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("update_review_row", expect.any(Object)));
});

test("review drafts restore into the editor and autosave changed text", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "review" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({
        rows: [
          reviewRow({
            source_text_id: 501,
            visible_text: "Nora",
            translated_text: "노라",
            draft_text: "노라 초안",
            has_unapplied_draft: true,
            translation_updated_at: "2026-06-08T00:00:00Z",
            provider: "manual-review",
          }),
        ],
        total_count: 1,
        next_offset: null,
        page: 1,
        page_size: 200,
        total_pages: 1,
        range_start: 1,
        range_end: 1,
      });
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench().settings, saved_drafts: 1, saved_at: "1" });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  const editor = (await screen.findByDisplayValue("노라 초안")) as HTMLTextAreaElement;
  expect(screen.getByText("Saved draft restored. Press Save and check to apply it to the DB.")).toBeInTheDocument();

  fireEvent.change(editor, { target: { value: "노라 수정" } });

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("save_workbench_state", {
      request: expect.objectContaining({
        review_drafts: [
          {
            source_text_id: 501,
            target_language: "ko",
            draft_text: "노라 수정",
            base_translation_updated_at: "2026-06-08T00:00:00Z",
          },
        ],
      }),
    }),
  );
  expect(await screen.findByText("Draft saved")).toBeInTheDocument();
});

test("translate panel shows provider examples, tests the endpoint, and persists a custom prompt", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "translate",
        project: testProject({ display_name: "Provider Game", game_root: "/tmp/provider-game" }),
        workspace: testWorkspace({
          project_file_path: "/tmp/provider-game/rpg-translator/Provider_Game.rpgmakers",
          artifact_root: "/tmp/provider-game/rpg-translator",
          db_path: "/tmp/provider-game/rpg-translator/db/Provider_Game.sqlite",
          game_root: "/tmp/provider-game",
          display_name: "Provider Game",
          exports_path: "/tmp/provider-game/rpg-translator/exports",
        }),
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "test_local_provider") {
      return Promise.resolve({
        ok: true,
        latency_ms: 15,
        raw_output: "{\"id\":1,\"translation\":\"안녕\"}",
        message: "Provider responded",
      });
    }
    if (name === "translate_with_local_provider") {
      return Promise.resolve({
        status: "completed",
        accepted_count: 1,
        failed_count: 0,
        provider_run_id: 22,
        split_batches: 0,
        failures: [],
        completed_items: 1,
        failed_items: 0,
        total_items: 1,
        processed_batches: 1,
        total_batches: 1,
        elapsed_ms: 1000,
        eta_ms: null,
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Translate" }));
  expect(screen.getByText(/LM Studio: http:\/\/127\.0\.0\.1:1234/)).toBeInTheDocument();
  expect(screen.getByText(/Ollama OpenAI compatible API: http:\/\/127\.0\.0\.1:11434/)).toBeInTheDocument();
  expect(screen.getByText(/Gemma compose presets: http:\/\/127\.0\.0\.1:18080/)).toBeInTheDocument();
  expect(screen.getByLabelText("Model")).toHaveValue("auto");
  expect(screen.getByText(/Use auto to pick the first model/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Prompt settings" }));
  const promptEditor = await screen.findByLabelText("System prompt");
  expect((promptEditor as HTMLTextAreaElement).value.trim().length).toBeGreaterThan(0);
  fireEvent.change(promptEditor, {
    target: { value: "Custom RPG translation prompt. Return JSONL only." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(localStorage.getItem("rpg-translator-system-prompt")).toBe(
    "Custom RPG translation prompt. Return JSONL only.",
  );

  fireEvent.change(screen.getByLabelText("Provider endpoint"), { target: { value: "http://127.0.0.1:11434" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gemma-local" } });
  fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

  expect(await screen.findByText(/Provider responded/)).toBeInTheDocument();
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("test_local_provider", {
      request: expect.objectContaining({
        base_url: "http://127.0.0.1:11434",
        model: "gemma-local",
        system_prompt: "Custom RPG translation prompt. Return JSONL only.",
      }),
    }),
  );

  fireEvent.click(screen.getAllByRole("button", { name: "Translate" }).at(-1)!);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("translate_with_local_provider", {
      request: expect.objectContaining({
        base_url: "http://127.0.0.1:11434",
        model: "gemma-local",
        system_prompt: "Custom RPG translation prompt. Return JSONL only.",
      }),
    }),
  );
});

test("desktop hydration restores checkpoint and latest job metrics after restart", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  localStorage.setItem("rpg-translator-language", "ko");
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve({
        projects: [
          {
            id: 7,
            display_name: "Restored Game",
            game_root: "/tmp/restored-game",
            engine: "mz",
          },
        ],
        selected_project_id: 7,
        settings: {
          selected_project_id: 7,
          source_language: "en",
          target_language: "ko",
          provider_base_url: "http://127.0.0.1:18080",
          provider_model: "auto",
          system_prompt: "restore prompt",
          export_dir: "/tmp/export",
          active_tab: "translate",
          show_hover_help: true,
        },
        dashboard: {
          project_id: 7,
          target_language: "ko",
          source_text_count: 20_774,
          occurrence_count: 141_201,
          translated_count: 3_975,
          accepted_count: 0,
          reviewed_count: 0,
          review_queue_count: 20_774,
          qa_finding_count: 0,
          latest_export: null,
          latest_install: null,
          latest_provider_run: {
            id: 4,
            provider: "local-openai-compatible",
            model: "gemma-4-26B-IQ4_NL.gguf",
            status: "paused",
            failure_detail: null,
          },
        },
        review_counts: {
          all: 20_774,
          missing: 16_799,
          pending: 3_975,
          accepted: 0,
          reviewed: 0,
          attention: 0,
          exportable: 0,
        },
        checkpoint: {
          path: "/tmp/workbench.sqlite.translation-ko.checkpoint.json",
          exists: true,
          provider_run_id: 4,
          target_language: "ko",
          completed_count: 3_831,
          failed_count: 11_841,
          failure_type_counts: {
            "recoverable-provider": 11_813,
            "provider-json-parse": 22,
            "translation-validation": 6,
          },
        },
        latest_job: {
          id: 4,
          provider_run_id: 4,
          project_id: 7,
          source_language: "en",
          target_language: "ko",
          checkpoint_path: "/tmp/workbench.sqlite.translation-ko.checkpoint.json",
          status: "paused",
          completed_items: 3_831,
          failed_items: 16,
          total_items: 20_630,
          processed_batches: 952,
          total_batches: 1_290,
          split_batches: 7,
          parse_failed_items: 14,
          validation_failed_items: 2,
          skipped_items: 2,
          censored_retry_count: 1,
          retry_pending_items: 0,
          recoverable_provider_failures: 0,
	          final_failed_items: 16,
	          provider_backoff_ms: null,
	          effective_batch_size: 8,
          next_experiment_batch_size: 12,
          input_token_budget: 6144,
	          speed_mode: "steady",
	          success_streak: 4,
	          success_delay_floor_ms: 1250,
	          next_delay_ms: 1250,
	          failure_reason_counts_json: "{\"provider-503\":6351,\"provider-connection\":5462}",
          adaptive_decision_reason: "adaptive: backoff from test",
          legacy_checkpoint_only: false,
          item_eta_ms: 26_880_000,
          batch_eta_ms: 1_880_000,
          last_batch_elapsed_ms: 17_000,
          avg_batch_elapsed_ms: 11_000,
          recent_p50_batch_elapsed_ms: 9_000,
          recent_p95_batch_elapsed_ms: 15_000,
          best_items_per_minute: 320,
          current_batch_items: 16,
          elapsed_ms: 5_298_000,
          model: "gemma-4-26B-IQ4_NL.gguf",
        },
        stale_runs_interrupted: 0,
      });
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 20_774, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("Restored Game")).length).toBeGreaterThan(0);
  expect(await screen.findByText("3,831 / 20,774")).toBeInTheDocument();
  expect(screen.getByText("배치 952 / 1,290")).toBeInTheDocument();
  expect(screen.getByText("텍스트 기준 ETA 07:28:00")).toBeInTheDocument();
  expect(screen.getByText("배치 기준 ETA 00:31:20")).toBeInTheDocument();
  expect(screen.getByText("JSON 파싱 오류: 22")).toBeInTheDocument();
  expect(screen.getByText("번역 검증 오류: 6")).toBeInTheDocument();
  expect(screen.getByText("건너뜀: 2")).toBeInTheDocument();
  expect(screen.getByText("별표 재시도: 1")).toBeInTheDocument();
  expect(screen.getByText("다음 실험 배치: 12")).toBeInTheDocument();
  expect(screen.getByText("입력 토큰 예산: 6,144")).toBeInTheDocument();
  expect(screen.getByText("최근 p50 배치 00:00:09")).toBeInTheDocument();
  expect(screen.getByText("최근 p95 배치 00:00:15")).toBeInTheDocument();
  const restoredBestSpeedRow = screen.getByText(/최고 속도:/).closest("span");
  expect(restoredBestSpeedRow).not.toBeNull();
  expect(restoredBestSpeedRow).toHaveTextContent("320");
  expect(restoredBestSpeedRow).toHaveTextContent("분당 항목 수");
  expect(screen.getByText("DB 저장 완료")).toBeInTheDocument();
  expect(screen.getByText("번역 DB에 저장된 행 수입니다. 검토 승인 수가 아닙니다.")).toBeInTheDocument();
  expect(screen.getByText("이어하기 때 재시도")).toBeInTheDocument();
  expect(screen.getByText("503/연결 실패나 중단으로 남은 항목입니다. 이어하기를 누르면 다시 시도합니다.")).toBeInTheDocument();
  expect(screen.getByText("11,813")).toBeInTheDocument();
  expect(screen.getByText("재시도 소진 후 최종 실패")).toBeInTheDocument();
  expect(screen.getByText("retry/backoff를 모두 소진한 뒤에만 최종 실패로 확정된 행입니다.")).toBeInTheDocument();
  const finalFailureMetric = screen.getByText("재시도 소진 후 최종 실패").closest(".metric");
  expect(finalFailureMetric).not.toBeNull();
  expect(finalFailureMetric).toHaveTextContent("16");
  expect(screen.getByText("재시도 가능 Provider 장애: 11,813")).toBeInTheDocument();
  expect(screen.getByText("Provider가 503 Service Unavailable을 반환했습니다. 이어하기 때 backoff 후 재시도합니다.")).toBeInTheDocument();
  expect(screen.getByText("6,351")).toBeInTheDocument();
  expect(screen.getByText("Provider 연결 또는 전송에 실패했습니다. 이어하기 때 backoff 후 재시도합니다.")).toBeInTheDocument();
  expect(screen.getByText("5,462")).toBeInTheDocument();
  expect(screen.queryByText("실패")).not.toBeInTheDocument();
  expect(screen.getByText("Provider 실행 ID")).toBeInTheDocument();
  expect(screen.getByText("최신 provider 실행의 DB ID입니다. 실패 수가 아닙니다.")).toBeInTheDocument();
  expect(screen.getByText("4")).toBeInTheDocument();
  expect(screen.getByText("분할 재시도 배치")).toBeInTheDocument();
  expect(screen.getByText("7")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "번역완료 후 할 일 분석" }));
  const analysisPanel = await screen.findByRole("region", { name: "번역완료 후 할 일 분석" });
  expect(within(analysisPanel).getByRole("button", { name: "이어하기" })).toBeInTheDocument();
  expect(screen.getByText("이어하기 때 재시도할 항목이 있습니다")).toBeInTheDocument();
  expect(screen.getByText("이 숫자는 최종 실패가 아니라 provider 장애나 중단 때문에 다시 시도할 대상입니다.")).toBeInTheDocument();
});

test("after-translation analysis decision tree covers every next-action state", () => {
  const t = text.ko;
  const cases = [
    {
      name: "project missing",
      input: { selectedProject: null },
      expected: { title: t.analysisNoProjectTitle, action: "scan" },
    },
    {
      name: "scan missing",
      input: { dashboard: testDashboard({ source_text_count: 0 }) },
      expected: { title: t.analysisNoScanTitle, action: "scan" },
    },
    {
      name: "job missing",
      input: { latestJob: null },
      expected: { title: t.analysisNoJobTitle, action: "translate" },
    },
    {
      name: "translation running",
      input: { translationInFlight: true },
      expected: { title: t.analysisRunningTitle, action: "none" },
    },
    {
      name: "retry pending",
      input: { latestJob: testJob({ retry_pending_items: 11_841, recoverable_provider_failures: 11_841 }) },
      expected: { title: t.analysisRetryTitle, action: "translate" },
    },
    {
      name: "final failed",
      input: { latestJob: testJob({ failed_items: 2, final_failed_items: 2 }) },
      expected: { title: t.analysisFinalFailedTitle, action: "review-final-failed" },
    },
    {
      name: "parse failed",
      input: { latestJob: testJob({ parse_failed_items: 3 }) },
      expected: { title: t.analysisParseTitle, action: "review-json-parse" },
    },
    {
      name: "validation failed",
      input: { latestJob: testJob({ validation_failed_items: 4 }) },
      expected: { title: t.analysisValidationTitle, action: "review-validation" },
    },
    {
      name: "safe clean approval",
      input: { reviewCounts: testReviewCounts({ clean_approvable: 6, exportable: 0 }) },
      expected: { title: t.analysisPendingTitle, action: "review-clean" },
    },
    {
      name: "missing translations",
      input: { reviewCounts: testReviewCounts({ missing: 7 }) },
      expected: { title: t.analysisMissingTitle, action: "review-missing" },
    },
    {
      name: "pending review",
      input: { reviewCounts: testReviewCounts({ pending: 5 }) },
      expected: { title: t.analysisPendingTitle, action: "review-pending" },
    },
    {
      name: "manual attention",
      input: { reviewCounts: testReviewCounts({ attention: 2 }) },
      expected: { title: t.analysisAttentionTitle, action: "review-attention" },
    },
    {
      name: "exportable",
      input: { reviewCounts: testReviewCounts({ accepted: 2, reviewed: 1, exportable: 3 }) },
      expected: { title: t.analysisExportTitle, action: "export" },
    },
    {
      name: "nothing exportable",
      input: { reviewCounts: testReviewCounts() },
      expected: { title: t.analysisNoExportTitle, action: "review-pending" },
    },
  ] satisfies Array<{
    name: string;
    input: Partial<Parameters<typeof buildAfterTranslationAnalysis>[0]>;
    expected: { title: string; action: string };
  }>;

  for (const item of cases) {
    const analysis = buildAfterTranslationAnalysis({
      t,
      selectedProject: testProject(),
      dashboard: testDashboard(),
      reviewCounts: testReviewCounts(),
      latestJob: testJob(),
      checkpoint: null,
      progress: null,
      report: null,
      translationInFlight: false,
      ...item.input,
    });

    expect(analysis.title, item.name).toBe(item.expected.title);
    expect(analysis.action, item.name).toBe(item.expected.action);
  }
});

test("settings tab toggles detailed hover help", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "settings", show_hover_help: true }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({
        settings: {
          selected_project_id: 7,
          source_language: "en",
          target_language: "ko",
          provider_base_url: "",
          provider_model: "auto",
          system_prompt: "prompt",
          export_dir: "",
          active_tab: "settings",
          show_hover_help: false,
        },
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect(await screen.findByRole("tab", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByText("Show detailed hover help")).toBeInTheDocument();
  expect(screen.getByText(/Shows detailed usage guidance/)).toBeInTheDocument();
  const toggle = screen.getByLabelText("Show detailed hover help");
  expect(toggle).toBeChecked();

  fireEvent.click(toggle);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("save_workbench_state", {
      request: expect.objectContaining({ show_hover_help: false }),
    }),
  );
  expect(screen.queryByText(/Shows detailed usage guidance/)).not.toBeInTheDocument();
});

test("settings tab persists a global UI font size", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "settings", ui_font_size: "medium" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({
        settings: {
          ...hydratedWorkbench({ active_tab: "settings" }).settings,
          ui_font_size: "large",
        },
        saved_drafts: 0,
        saved_at: "1",
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect(await screen.findByRole("tab", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByText("Global font size")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Large" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("save_workbench_state", {
      request: expect.objectContaining({ ui_font_size: "large" }),
    }),
  );
  expect(document.querySelector(".app-shell")).toHaveAttribute("data-ui-font-size", "large");
});

test("hover help renders in a body portal and clamps inside the viewport", async () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect;
  const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 360 });
  HTMLElement.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 760,
    y: 14,
    width: 96,
    height: 32,
    top: 14,
    right: 856,
    bottom: 46,
    left: 760,
    toJSON: () => ({}),
  }));
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 360 });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 88 });

  try {
    render(<App />);

    const translateButton = await screen.findByRole("button", { name: "Translate" });
    const target = translateButton.closest(".help-target");
    expect(target).not.toBeNull();
    fireEvent.mouseEnter(target!);

    const tooltip = await screen.findByRole("tooltip");
    await waitFor(() => expect(tooltip).toHaveStyle({ visibility: "visible" }));
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip).toHaveTextContent("Translate remaining rows");
    expect(parseFloat(tooltip.style.left)).toBeLessThanOrEqual(628);
    expect(tooltip.dataset.placement).toBe("bottom");

    fireEvent.mouseLeave(target!);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  } finally {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (originalWidth) {
      Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalWidth);
    }
    if (originalHeight) {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalHeight);
    }
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: originalInnerHeight });
  }
});

test("every visible hover help target opens a non-empty tooltip", async () => {
  render(<App />);

  await screen.findByText("No project selected");
  const targets = Array.from(document.querySelectorAll<HTMLElement>(".help-target"));
  expect(targets.length).toBeGreaterThan(0);

  for (const target of targets) {
    fireEvent.mouseEnter(target);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent?.trim().length).toBeGreaterThan(12);
    expect(tooltip.parentElement).toBe(document.body);
    fireEvent.mouseLeave(target);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
  }
});

test("export install panel uses a folder picker, real exportable counts, and no local write checkbox", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  openDialogMock.mockResolvedValue("/tmp/selected-export");
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "exportInstall",
        project: testProject({ display_name: "Export Game", game_root: "/tmp/export-game" }),
        workspace: testWorkspace({
          project_file_path: "/tmp/export-game/rpg-translator/Export_Game.rpgmakers",
          artifact_root: "/tmp/export-game/rpg-translator",
          db_path: "/tmp/export-game/rpg-translator/db/Export_Game.sqlite",
          game_root: "/tmp/export-game",
          display_name: "Export Game",
          exports_path: "/tmp/export-game/rpg-translator/exports",
        }),
        dashboard: {
          source_text_count: 10,
          occurrence_count: 10,
          translated_count: 4,
          accepted_count: 2,
          reviewed_count: 1,
          review_queue_count: 7,
        },
        review_counts: {
          all: 10,
          missing: 6,
          pending: 1,
          accepted: 2,
          reviewed: 1,
          attention: 0,
          exportable: 3,
          open_issues: 0,
          json_parse: 0,
          validation: 0,
          final_failed: 0,
          clean_approvable: 0,
        },
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 7, next_offset: null });
    }
    if (name === "export_bundle") {
      return Promise.resolve({
        export_id: 9,
        output_dir: "/tmp/selected-export",
        included_count: 3,
        skipped_count: 7,
        manifest_hash: "hash",
      });
    }
    if (name === "install_overlay") {
      return Promise.resolve({
        install_id: 5,
        install_manifest_path: "/tmp/export-game/js/plugins/rpg-translator/install-manifest.json",
        plugins_file: "/tmp/export-game/js/plugins.js",
        plugins_backup_path: "/tmp/export-game/js/plugins/rpg-translator/plugins.backup.js",
        installed_files: [],
      });
    }
    if (name === "save_workbench_settings") {
      return Promise.resolve({
        settings: {
          selected_project_id: 7,
          source_language: "en",
          target_language: "ko",
          provider_base_url: "",
          provider_model: "auto",
          system_prompt: "prompt",
          export_dir: "/tmp/selected-export",
          active_tab: "exportInstall",
          show_hover_help: true,
        },
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Export/Install" }));
  expect(screen.queryByLabelText("Allow local test game writes")).not.toBeInTheDocument();
  expect(screen.getByText("Exportable")).toBeInTheDocument();
  expect(screen.getByText("3")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Select export folder" }));

  await waitFor(() =>
    expect(openDialogMock).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: "Select export folder",
    }),
  );
  expect(screen.getByLabelText("Export folder")).toHaveValue("/tmp/selected-export");

  fireEvent.click(screen.getByRole("button", { name: "Export bundle" }));

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("export_bundle", {
      request: {
        db_path: "/tmp/export-game/rpg-translator/db/Export_Game.sqlite",
        project_id: 7,
        target_language: "ko",
        output_dir: "/tmp/selected-export",
      },
    }),
  );

  fireEvent.click(screen.getAllByRole("button", { name: "Install" })[0]);

  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("install_overlay", {
      request: {
        db_path: "/tmp/export-game/rpg-translator/db/Export_Game.sqlite",
        game_root: "/tmp/export-game",
        export_dir: "/tmp/selected-export",
        project_id: 7,
        export_id: 9,
      },
    }),
  );
});

test("export install actions show temporary operation progress under the buttons", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  let resolveExport: ((value: unknown) => void) | undefined;
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "exportInstall",
        dashboard: {
          source_text_count: 3,
          translated_count: 3,
          accepted_count: 3,
          review_queue_count: 0,
        },
        review_counts: testReviewCounts({ all: 3, accepted: 3, exportable: 3 }),
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "export_bundle") {
      return new Promise((resolve) => {
        resolveExport = resolve;
      });
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "exportInstall" }).settings, saved_drafts: 0, saved_at: "1" });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Export/Install" }));
  fireEvent.click(screen.getByRole("button", { name: "Export bundle" }));

  const progress = await screen.findByRole("status");
  expect(progress).toHaveTextContent("Export bundle");
  expect(progress).toHaveTextContent("Working");

  act(() => {
    resolveExport?.({
      export_id: 9,
      output_dir: testWorkspace().exports_path,
      included_count: 3,
      skipped_count: 0,
      manifest_hash: "hash",
    });
  });

  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Completed"));
});

test("diagnostics panel shows coverage audit counts and samples", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "diagnostics" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "diagnostics_summary") {
      return Promise.resolve({
        dashboard: testDashboard({ source_text_count: 10, translated_count: 10 }),
        runtime_provider_surface: "not-present",
        runtime_ui_surface: "startup-toast-only",
        integrity_check: "ok",
        foreign_key_violations: 0,
        journal_mode: "wal",
        busy_timeout_ms: 10_000,
        stale_running_provider_runs: 0,
        checkpoint_completed_count: 0,
        checkpoint_failed_count: 0,
        exportable_count: 8,
        unscanned_runtime_candidate_count: 1,
        unscanned_unique_source_count: 1,
        unscanned_occurrence_count: 1,
        export_missing_count: 2,
        unsupported_string_candidate_count: 3,
        coverage_samples: [
          {
            category: "unscanned-static-accepted",
            text: "Do you have something you need... err... Elly?",
            file_path: "data/CommonEvents.json",
            json_path: "$[1].list[1].parameters[0]",
            reason: null,
          },
        ],
        latest_job: null,
      });
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "diagnostics" }).settings, saved_drafts: 0, saved_at: "1" });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Diagnostics" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh diagnostics" }));

  expect(await screen.findByText("Unscanned runtime candidates")).toBeInTheDocument();
  expect(screen.getByText("Unscanned unique sources")).toBeInTheDocument();
  expect(screen.getByText("Unscanned occurrences")).toBeInTheDocument();
  expect(screen.getByText("Export missing")).toBeInTheDocument();
  expect(screen.getByText("Unsupported string candidates")).toBeInTheDocument();
  expect(screen.getByText(/Do you have something you need/)).toBeInTheDocument();
});

test("desktop scan progress events update the scan panel before the command resolves", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  let resolveScan: ((value: unknown) => void) | undefined;
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "scan",
        project: testProject({ display_name: "English Game", game_root: "/tmp/english-game" }),
        workspace: testWorkspace({
          project_file_path: "/tmp/english-game/rpg-translator/English_Game.rpgmakers",
          artifact_root: "/tmp/english-game/rpg-translator",
          db_path: "/tmp/english-game/rpg-translator/db/English_Game.sqlite",
          game_root: "/tmp/english-game",
          display_name: "English Game",
          exports_path: "/tmp/english-game/rpg-translator/exports",
        }),
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "scan_game") {
      return new Promise((resolve) => {
        resolveScan = resolve;
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Scan" }));
  await waitFor(() => expect(eventHandlers.scanProgress).toBeDefined());
  fireEvent.click(screen.getAllByRole("button", { name: "Scan" }).at(-1)!);
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("scan_game", expect.any(Object)));

  act(() => {
    eventHandlers.scanProgress?.({
      payload: {
        FileFinished: {
          index: 0,
          file_path: "data/Map001.json",
          accepted_delta: 7,
          rejected_delta: 2,
          skipped: false,
        },
      },
    });
  });

  expect(await screen.findByText("Files scanned: 1")).toBeInTheDocument();
  expect(screen.getByText("Current file: data/Map001.json")).toBeInTheDocument();
  expect(screen.getAllByText("7").length).toBeGreaterThanOrEqual(2);
  expect(screen.getByText("2")).toBeInTheDocument();

  act(() => {
    resolveScan?.({
      report: {
        project_id: 7,
        snapshot_id: 70,
        source_text_count: 6,
        occurrence_count: 7,
        added_source_text_count: 2,
        removed_occurrence_count: 1,
        unchanged_source_text_count: 4,
        rejected_count: 2,
        skipped_count: 0,
      },
    });
  });

  await waitFor(() => expect(screen.getByText("Scan complete")).toBeInTheDocument());
});

test("scan completion releases the UI even when post-scan hydration is still pending", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  let resolvePostScanHydration: ((value: unknown) => void) | undefined;
  let hydrateCalls = 0;
  const hydrationResponse = {
    workspace: testWorkspace({
      project_file_path: "/tmp/english-game/rpg-translator/English_Game.rpgmakers",
      artifact_root: "/tmp/english-game/rpg-translator",
      db_path: "/tmp/english-game/rpg-translator/db/English_Game.sqlite",
      game_root: "/tmp/english-game",
      display_name: "English Game",
      exports_path: "/tmp/english-game/rpg-translator/exports",
    }),
    projects: [
      {
        id: 7,
        display_name: "English Game",
        game_root: "/tmp/english-game",
        engine: "mz",
      },
    ],
    selected_project_id: 7,
    settings: {
      selected_project_id: 7,
      source_language: "en",
      target_language: "ko",
      provider_base_url: "",
      provider_model: "auto",
      system_prompt: "prompt",
      export_dir: "",
      active_tab: "scan",
      show_hover_help: true,
    },
    dashboard: {
      project_id: 7,
      target_language: "ko",
      source_text_count: 0,
      occurrence_count: 0,
      translated_count: 0,
      accepted_count: 0,
      reviewed_count: 0,
      review_queue_count: 0,
      qa_finding_count: 0,
      latest_export: null,
      latest_install: null,
      latest_provider_run: null,
    },
    review_counts: {
      all: 0,
      missing: 0,
      pending: 0,
      accepted: 0,
      reviewed: 0,
      attention: 0,
      exportable: 0,
    },
    checkpoint: null,
    latest_job: null,
    stale_runs_interrupted: 0,
  };
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      hydrateCalls += 1;
      if (hydrateCalls === 1) {
        return Promise.resolve(hydrationResponse);
      }
      return new Promise((resolve) => {
        resolvePostScanHydration = resolve;
      });
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "scan_game") {
      return Promise.resolve({
        report: {
          project_id: 7,
          snapshot_id: 70,
          source_text_count: 20_774,
          occurrence_count: 47_067,
          added_source_text_count: 20_774,
          removed_occurrence_count: 0,
          unchanged_source_text_count: 0,
          rejected_count: 14_766,
          skipped_count: 0,
        },
      });
    }
    if (name === "save_workbench_settings") {
      return Promise.resolve({ settings: hydrationResponse.settings });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await screen.findByRole("tab", { name: "Scan" });
  fireEvent.click(screen.getAllByRole("button", { name: "Scan" }).at(-1)!);

  await waitFor(() => expect(screen.getByText("Scan complete")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  expect(await screen.findByRole("heading", { name: "Review queue" })).toBeInTheDocument();

  act(() => {
    resolvePostScanHydration?.(hydrationResponse);
  });

  await waitFor(() => expect(screen.getByRole("tab", { name: "Review" })).toHaveAttribute("aria-selected", "true"));
});

test("hydrate reports stale translation recovery in desktop status", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({
        active_tab: "translate",
        stale_runs_interrupted: 3,
      }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect(await screen.findByText("Recovered interrupted translation jobs: 3")).toBeInTheDocument();
});

test("desktop translate progress events update progress and pause resumes later", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  let resolveTranslate: ((value: unknown) => void) | undefined;
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "translate" }));
    }
    if (name === "review_queue") {
      return Promise.resolve({ rows: [], total_count: 0, next_offset: null });
    }
    if (name === "pause_translation") {
      return Promise.resolve({ requested: true, provider_run_id: 22 });
    }
    if (name === "translate_with_local_provider") {
      return new Promise((resolve) => {
        resolveTranslate = resolve;
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  fireEvent.click(await screen.findByRole("tab", { name: "Translate" }));
  fireEvent.change(screen.getByLabelText("Provider endpoint"), { target: { value: "http://127.0.0.1:18080" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Translate" }).at(-1)!);

  await waitFor(() => expect(eventHandlers.translateProgress).toBeDefined());
  act(() => {
    eventHandlers.translateProgress?.({
      payload: {
        Started: {
          provider_run_id: 22,
          target_language: "ko",
          model: "gemma.gguf",
          total_batches: 100,
          processed_batches: 0,
          total_items: 1600,
          completed_items: 0,
          failed_items: 0,
          split_batches: 0,
          elapsed_ms: 0,
          eta_ms: null,
        },
      },
    });
    eventHandlers.translateProgress?.({
      payload: {
        BatchFinished: {
          provider_run_id: 22,
          target_language: "ko",
          model: "gemma.gguf",
          total_batches: 100,
          processed_batches: 2,
          total_items: 1600,
          completed_items: 32,
          failed_items: 0,
          split_batches: 0,
          elapsed_ms: 64_000,
          eta_ms: 3_136_000,
          recent_p50_batch_elapsed_ms: 9_000,
          recent_p95_batch_elapsed_ms: 12_000,
          best_items_per_minute: 240,
        },
      },
    });
  });

  expect(await screen.findByText("32 / 1,600")).toBeInTheDocument();
  expect(screen.getByText("Batch 2 / 100")).toBeInTheDocument();
  expect(screen.getByText("Text ETA 00:52:16")).toBeInTheDocument();
  expect(screen.getByText("Recent p50 batch 00:00:09")).toBeInTheDocument();
  expect(screen.getByText("Recent p95 batch 00:00:12")).toBeInTheDocument();
  const bestSpeedRow = screen.getByText(/Best speed:/).closest("span");
  expect(bestSpeedRow).not.toBeNull();
  expect(bestSpeedRow).toHaveTextContent("240");
  expect(bestSpeedRow).toHaveTextContent("Items/min");

  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("pause_translation", {
      request: {},
    }),
  );
  expect(await screen.findByText("Pause requested; finishing current batch")).toBeInTheDocument();

  act(() => {
    eventHandlers.translateProgress?.({
      payload: {
        Paused: {
          provider_run_id: 22,
          target_language: "ko",
          model: "gemma.gguf",
          total_batches: 100,
          processed_batches: 2,
          total_items: 1600,
          completed_items: 32,
          failed_items: 0,
          split_batches: 0,
          elapsed_ms: 65_000,
          eta_ms: 3_185_000,
        },
      },
    });
    resolveTranslate?.({
      status: "paused",
      provider_run_id: 22,
      accepted_count: 32,
      failed_count: 0,
      split_batches: 0,
      failures: [],
      completed_items: 32,
      failed_items: 0,
      total_items: 1600,
      processed_batches: 2,
      total_batches: 100,
      elapsed_ms: 65_000,
      eta_ms: 3_185_000,
      model: "gemma.gguf",
    });
  });

  expect(await screen.findByRole("button", { name: "Resume" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("translate_with_local_provider", {
      request: expect.objectContaining({
        base_url: "http://127.0.0.1:18080",
      }),
    }),
  );
});

test("desktop mode renders command responses without browser fallback data", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench());
    }
    if (name === "review_queue") {
      return Promise.resolve({
        rows: [
          {
            source_text_id: 71,
            source_language: "ja",
            normalized_text: "こんにちは",
            visible_text: "こんにちは",
            control_code_signature: "",
            occurrence_count: 1,
            first_file_path: "data/Map001.json",
            first_json_path: "$.events[1].pages[0].list[0].parameters[0]",
            translation_id: null,
            target_language: "ko",
            translated_text: null,
            provider: null,
            model: null,
            review_state: "missing",
            qa_state: "unchecked",
            qa_finding_count: 0,
          },
        ],
        total_count: 1,
        next_offset: null,
      });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  expect((await screen.findAllByText("Fixture Game")).length).toBeGreaterThan(0);
  expect(await screen.findByText("こんにちは")).toBeInTheDocument();
  expect(screen.queryByText("Synthetic Workbench")).not.toBeInTheDocument();
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("hydrate_workbench", expect.any(Object)));
  await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("review_queue", expect.any(Object)));
});

test("desktop window close destroys the window after bounded safe shutdown attempts", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "scan" }).settings, saved_drafts: 0, saved_at: "1" });
    }
    if (name === "prepare_safe_shutdown") {
      return Promise.reject(new Error("database is locked"));
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  const event = { preventDefault: vi.fn() };
  await act(async () => {
    await appWindowHandlers.closeRequested?.(event);
  });

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(invokeMock).toHaveBeenCalledWith("save_workbench_state", {
    request: expect.objectContaining({
      db_path: testDbPath,
      active_tab: "scan",
    }),
  });
  expect(invokeMock).toHaveBeenCalledWith("prepare_safe_shutdown", {
    request: { db_path: testDbPath },
  });
  expect(appWindowDestroyMock).toHaveBeenCalledOnce();
  expect(appWindowCloseMock).toHaveBeenCalledOnce();
});

test("desktop window close still fires native close fallback after destroy resolves", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "scan" }).settings, saved_drafts: 0, saved_at: "1" });
    }
    if (name === "prepare_safe_shutdown") {
      return Promise.resolve({ pause_requested: false, provider_run_id: null, mode: "no-active-run", stale_runs_interrupted: 0 });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  const event = { preventDefault: vi.fn() };
  await act(async () => {
    await appWindowHandlers.closeRequested?.(event);
  });

  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(appWindowDestroyMock).toHaveBeenCalledOnce();
  expect(appWindowCloseMock).toHaveBeenCalledOnce();
  expect(appWindowDestroyMock.mock.invocationCallOrder[0]).toBeLessThan(appWindowCloseMock.mock.invocationCallOrder[0]);
});

test("desktop repeated window close allows native close without restarting safe shutdown", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  const never = new Promise<never>(() => {});
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return never;
    }
    if (name === "prepare_safe_shutdown") {
      return never;
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  vi.useFakeTimers();
  try {
    const firstEvent = { preventDefault: vi.fn() };
    const firstClose = appWindowHandlers.closeRequested?.(firstEvent);
    const secondEvent = { preventDefault: vi.fn() };
    await act(async () => {
      await appWindowHandlers.closeRequested?.(secondEvent);
    });

    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).not.toHaveBeenCalled();
    expect(invokeMock.mock.calls.filter(([name]) => name === "save_workbench_state")).toHaveLength(1);
    expect(invokeMock.mock.calls.filter(([name]) => name === "prepare_safe_shutdown")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2000);
    await firstClose;

    expect(appWindowDestroyMock).toHaveBeenCalledOnce();
    expect(appWindowCloseMock).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("desktop window close does not wait beyond the total safe close budget", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  const never = new Promise<never>(() => {});
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return never;
    }
    if (name === "prepare_safe_shutdown") {
      return never;
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  vi.useFakeTimers();
  try {
    const event = { preventDefault: vi.fn() };
    const closePromise = appWindowHandlers.closeRequested?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(invokeMock).toHaveBeenCalledWith("save_workbench_state", expect.any(Object));
    expect(invokeMock).toHaveBeenCalledWith("prepare_safe_shutdown", {
      request: { db_path: testDbPath },
    });
    expect(appWindowDestroyMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    await closePromise;

    expect(appWindowDestroyMock).toHaveBeenCalledOnce();
    expect(appWindowCloseMock).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("desktop window close does not spend fallback time after the safe close budget is exhausted", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  const never = new Promise<never>(() => {});
  appWindowDestroyMock.mockReturnValue(never);
  appWindowCloseMock.mockReturnValue(never);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return never;
    }
    if (name === "prepare_safe_shutdown") {
      return never;
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  vi.useFakeTimers();
  try {
    const event = { preventDefault: vi.fn() };
    let settled = false;
    const closePromise = appWindowHandlers.closeRequested?.(event);
    void closePromise?.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(appWindowDestroyMock).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("desktop window close fires close fallback even when shutdown work exhausts the safe close budget", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  const never = new Promise<never>(() => {});
  appWindowDestroyMock.mockReturnValue(never);
  appWindowCloseMock.mockReturnValue(never);
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return never;
    }
    if (name === "prepare_safe_shutdown") {
      return never;
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  vi.useFakeTimers();
  try {
    const event = { preventDefault: vi.fn() };
    let settled = false;
    const closePromise = appWindowHandlers.closeRequested?.(event);
    void closePromise?.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(appWindowDestroyMock).toHaveBeenCalledOnce();
    expect(appWindowCloseMock).toHaveBeenCalledOnce();
    expect(settled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

test("desktop window close falls back when destroy does not settle", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  appWindowDestroyMock.mockReturnValue(new Promise<never>(() => {}));
  invokeMock.mockImplementation((name: string) => {
    if (name === "hydrate_workbench") {
      return Promise.resolve(hydratedWorkbench({ active_tab: "scan" }));
    }
    if (name === "save_workbench_state") {
      return Promise.resolve({ settings: hydratedWorkbench({ active_tab: "scan" }).settings, saved_drafts: 0, saved_at: "1" });
    }
    if (name === "prepare_safe_shutdown") {
      return Promise.resolve({ pause_requested: false, provider_run_id: null, mode: "no-active-run", stale_runs_interrupted: 0 });
    }
    throw new Error(`unexpected command ${name}`);
  });

  render(<App />);

  await waitFor(() => expect(appWindowHandlers.closeRequested).toBeTypeOf("function"));

  vi.useFakeTimers();
  try {
    const event = { preventDefault: vi.fn() };
    const closePromise = appWindowHandlers.closeRequested?.(event);

    await vi.advanceTimersByTimeAsync(500);
    await closePromise;

    expect(appWindowDestroyMock).toHaveBeenCalledOnce();
    expect(appWindowCloseMock).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});

test("web command API rejects desktop commands instead of returning mock data", async () => {
  await expect(callCommand("list_projects", { db_path: "workbench.sqlite" })).rejects.toThrow(
    "desktop runtime is required",
  );

  expect(invokeMock).not.toHaveBeenCalled();
});

test("desktop command API unwraps Tauri command error objects", async () => {
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  localStorage.setItem("rpg-translator-project-file", testProjectFilePath);
  invokeMock.mockRejectedValue({ message: "local provider model lookup failed: connection refused" });

  await expect(callCommand("list_projects", { db_path: "workbench.sqlite" })).rejects.toThrow(
    "local provider model lookup failed: connection refused",
  );
});

function hydratedWorkbench(overrides: {
  active_tab?: string;
  show_hover_help?: boolean;
  ui_font_size?: "small" | "medium" | "large";
  project?: ProjectSummary;
  workspace?: ProjectWorkspaceSummary;
  dashboard?: Partial<DashboardSummary>;
  review_counts?: ReviewCounts | null;
  latest_job?: TranslationJobSummary | null;
  checkpoint?: CheckpointSummary | null;
  stale_runs_interrupted?: number;
} = {}) {
  const project = overrides.project ?? testProject();
  const workspace = overrides.workspace ?? testWorkspace({
    game_root: project.game_root,
    display_name: project.display_name,
  });
  return {
    workspace,
    projects: [project],
    selected_project_id: project.id,
    settings: {
      selected_project_id: project.id,
      source_language: "en",
      target_language: "ko",
      provider_base_url: "http://127.0.0.1:18080",
      provider_model: "auto",
      system_prompt: "prompt",
      export_dir: workspace.exports_path,
      active_tab: overrides.active_tab ?? "review",
      show_hover_help: overrides.show_hover_help ?? true,
      ui_font_size: overrides.ui_font_size ?? "medium",
    },
    dashboard: testDashboard(overrides.dashboard),
    review_counts: overrides.review_counts ?? testReviewCounts(),
    checkpoint: overrides.checkpoint ?? null,
    latest_job: overrides.latest_job ?? null,
    stale_runs_interrupted: overrides.stale_runs_interrupted ?? 0,
  };
}

function testWorkspace(overrides: Partial<ProjectWorkspaceSummary> = {}): ProjectWorkspaceSummary {
  return {
    project_file_path: testProjectFilePath,
    artifact_root: "/tmp/fixture-game/rpg-translator",
    db_path: testDbPath,
    game_root: "/tmp/fixture-game",
    display_name: "Fixture Game",
    engine: "mz",
    database_missing: false,
    checkpoints_path: "/tmp/fixture-game/rpg-translator/checkpoints",
    exports_path: "/tmp/fixture-game/rpg-translator/exports",
    installs_path: "/tmp/fixture-game/rpg-translator/installs",
    logs_path: "/tmp/fixture-game/rpg-translator/logs",
    temp_path: "/tmp/fixture-game/rpg-translator/temp",
    ...overrides,
  };
}

function testProject(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    id: 7,
    display_name: "Fixture Game",
    game_root: "/tmp/fixture-game",
    engine: "mz",
    ...overrides,
  };
}

function testDashboard(overrides: Partial<DashboardSummary> = {}): DashboardSummary {
  return {
    project_id: 7,
    target_language: "ko",
    source_text_count: 10,
    occurrence_count: 10,
    translated_count: 0,
    accepted_count: 0,
    reviewed_count: 0,
    review_queue_count: 10,
    qa_finding_count: 0,
    latest_export: null,
    latest_install: null,
    latest_provider_run: null,
    ...overrides,
  };
}

function testReviewCounts(overrides: Partial<ReviewCounts> = {}): ReviewCounts {
  return {
    all: 10,
    missing: 0,
    pending: 0,
    accepted: 0,
    reviewed: 0,
    attention: 0,
    exportable: 0,
    open_issues: 0,
    json_parse: 0,
    validation: 0,
    final_failed: 0,
    clean_approvable: 0,
    ...overrides,
  };
}

function testJob(overrides: Partial<TranslationJobSummary> = {}): TranslationJobSummary {
  return {
    id: 4,
    provider_run_id: 4,
    project_id: 7,
    source_language: "en",
    target_language: "ko",
    checkpoint_path: "/tmp/workbench.sqlite.translation-ko.checkpoint.json",
    status: "completed",
    completed_items: 10,
    failed_items: 0,
    total_items: 10,
    processed_batches: 1,
    total_batches: 1,
    split_batches: 0,
    parse_failed_items: 0,
    validation_failed_items: 0,
    skipped_items: 0,
    censored_retry_count: 0,
    retry_pending_items: 0,
    recoverable_provider_failures: 0,
    final_failed_items: 0,
	    provider_backoff_ms: null,
	    effective_batch_size: 10,
	    speed_mode: "steady",
	    success_streak: 0,
	    success_delay_floor_ms: 1500,
	    next_delay_ms: null,
	    failure_reason_counts_json: "{}",
    adaptive_decision_reason: "adaptive: test",
    legacy_checkpoint_only: false,
    item_eta_ms: null,
    batch_eta_ms: null,
    last_batch_elapsed_ms: null,
    avg_batch_elapsed_ms: null,
    current_batch_items: 0,
    elapsed_ms: 1000,
    model: "auto",
    ...overrides,
  };
}

function reviewRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    source_text_id: 1,
    source_language: "en",
    normalized_text: "Alpha",
    visible_text: "Alpha",
    control_code_signature: "",
    occurrence_count: 1,
    first_file_path: "data/Map001.json",
    first_json_path: "$.events[1].pages[0].list[0].parameters[0]",
    translation_id: null,
    target_language: "ko",
    translated_text: null,
    provider: null,
    model: null,
    review_state: "missing",
    qa_state: "unchecked",
    qa_finding_count: 0,
    ...overrides,
  };
}
