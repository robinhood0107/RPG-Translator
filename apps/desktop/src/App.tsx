import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  Database,
  Download,
  FolderOpen,
  Gauge,
  History,
  Languages,
  ListFilter,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Table2,
  TerminalSquare,
  Upload,
} from "lucide-react";
import { callCommand } from "./api";
import { mockDashboard, mockRows } from "./mockData";
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

const tabs = ["Scan", "Translate", "Review", "Glossary", "Export/Install", "Diagnostics"] as const;
type Tab = (typeof tabs)[number];
type ReviewFilter = "all" | "missing" | "pending" | "accepted" | "attention";

const dbPath = "workbench.sqlite";
const targetLanguage = "ko";

export default function App() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState(1);
  const [gameRoot, setGameRoot] = useState("C:/Games/SyntheticWorkbench");
  const [activeTab, setActiveTab] = useState<Tab>("Review");
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [dashboard, setDashboard] = useState<DashboardSummary>(mockDashboard);
  const [reviewRows, setReviewRows] = useState<ReviewQueueRow[]>(mockRows);
  const [scanReport, setScanReport] = useState<ScanPersistenceReport | null>(null);
  const [translateReport, setTranslateReport] = useState<TranslateResponse | null>(null);
  const [exportReport, setExportReport] = useState<ExportBundleResponse | null>(null);
  const [installReport, setInstallReport] = useState<InstallOverlayResponse | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsResponse | null>(null);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    void runCommand("Loading projects", async () => {
      const response = await callCommand("list_projects", { db_path: dbPath });
      setProjects(response.projects);
      if (response.projects[0]) {
        setSelectedProjectId(response.projects[0].id);
      }
    });
  }, []);

  useEffect(() => {
    void runCommand("Loading review queue", async () => {
      const response = await callCommand("review_queue", {
        db_path: dbPath,
        project_id: selectedProjectId,
        target_language: targetLanguage,
        review_state: reviewFilter === "all" ? null : reviewFilter,
      });
      setReviewRows(response.rows);
    });
  }, [reviewFilter, selectedProjectId]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? projects[0];
  const coverage = dashboard.source_text_count
    ? Math.round((dashboard.translated_count / dashboard.source_text_count) * 100)
    : 0;
  const filteredRows = useMemo(() => reviewRows, [reviewRows]);

  async function runCommand(label: string, work: () => Promise<void>) {
    setError(null);
    setPendingLabel(label);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingLabel(null);
    }
  }

  function runTransition(label: string, work: () => Promise<void>) {
    startTransition(() => {
      void runCommand(label, work);
    });
  }

  const openProject = () =>
    runTransition("Opening project", async () => {
      const response = await callCommand("open_project", { db_path: dbPath, game_root: gameRoot });
      setProjects((current) => upsertProject(current, response.project));
      setSelectedProjectId(response.project.id);
    });

  const scanGame = () =>
    runTransition("Scanning game", async () => {
      const response = await callCommand("scan_game", {
        db_path: dbPath,
        game_root: gameRoot,
        source_language: "ja",
      });
      setScanReport(response.report);
      setDashboard((current) => ({
        ...current,
        project_id: response.report.project_id,
        source_text_count: response.report.source_text_count,
        occurrence_count: response.report.occurrence_count,
        review_queue_count: response.report.source_text_count,
      }));
    });

  const translate = () =>
    runTransition("Translating batch", async () => {
      const response = await callCommand("translate_with_fake_provider", {
        db_path: dbPath,
        target_language: targetLanguage,
        batch_size: 16,
      });
      setTranslateReport(response);
      setDashboard((current) => ({
        ...current,
        translated_count: current.translated_count + response.accepted_count,
        latest_provider_run: {
          id: response.provider_run_id,
          provider: "desktop-fake",
          model: "synthetic-workbench",
          status: response.failed_count ? "completed_with_failures" : "completed",
          failure_detail: response.failures[0]?.message ?? null,
        },
      }));
    });

  const acceptFirstRow = () =>
    runTransition("Accepting row", async () => {
      const row = reviewRows[0];
      if (!row?.translated_text || !row.provider) {
        return;
      }
      const response = await callCommand("update_review_state", {
        db_path: dbPath,
        source_text_id: row.source_text_id,
        target_language: targetLanguage,
        translated_text: row.translated_text,
        provider: row.provider,
        model: row.model,
        review_state: "accepted",
        qa_state: "passed",
      });
      setReviewRows((rows) =>
        rows.map((candidate) =>
          candidate.source_text_id === row.source_text_id
            ? { ...candidate, review_state: response.translation.review_state, qa_state: "passed" }
            : candidate,
        ),
      );
      setDashboard((current) => ({
        ...current,
        accepted_count: current.accepted_count + 1,
        review_queue_count: Math.max(0, current.review_queue_count - 1),
      }));
    });

  const exportBundle = () =>
    runTransition("Exporting bundle", async () => {
      const response = await callCommand("export_bundle", {
        db_path: dbPath,
        project_id: selectedProjectId,
        target_language: targetLanguage,
        output_dir: "exports/synthetic-ko",
      });
      setExportReport(response);
      setDashboard((current) => ({
        ...current,
        latest_export: {
          id: response.export_id,
          project_id: selectedProjectId,
          target_language: targetLanguage,
          export_path: response.output_dir,
          manifest_hash: response.manifest_hash,
          included_count: response.included_count,
        },
      }));
    });

  const installOverlay = () =>
    runTransition("Installing overlay", async () => {
      const response = await callCommand("install_overlay", {
        db_path: dbPath,
        game_root: gameRoot,
        export_dir: exportReport?.output_dir ?? "exports/synthetic-ko",
        project_id: selectedProjectId,
        export_id: exportReport?.export_id ?? dashboard.latest_export?.id ?? null,
      });
      setInstallReport(response);
      setDashboard((current) => ({
        ...current,
        latest_install: {
          id: response.install_id ?? 0,
          project_id: selectedProjectId,
          game_root: gameRoot,
          export_id: exportReport?.export_id ?? dashboard.latest_export?.id ?? null,
          backup_manifest_path: response.install_manifest_path,
          status: "installed",
        },
      }));
    });

  const rollbackOverlay = () =>
    runTransition("Rolling back", async () => {
      if (!installReport?.install_id) {
        return;
      }
      await callCommand("rollback_overlay", {
        db_path: dbPath,
        manifest_path: installReport.install_manifest_path,
        install_id: installReport.install_id,
      });
      setDashboard((current) => ({
        ...current,
        latest_install: current.latest_install
          ? { ...current.latest_install, status: "rolled-back" }
          : current.latest_install,
      }));
    });

  const loadDiagnostics = () =>
    runTransition("Loading diagnostics", async () => {
      const response = await callCommand("diagnostics_summary", {
        db_path: dbPath,
        project_id: selectedProjectId,
        target_language: targetLanguage,
      });
      setDiagnostics(response);
      setDashboard(response.dashboard);
    });

  return (
    <main className="app-shell">
      <aside className="project-rail" aria-label="Projects">
        <div className="brand-row">
          <div className="brand-mark">RT</div>
          <div>
            <h1>RPG-Translator</h1>
            <p>Developer Workbench</p>
          </div>
        </div>

        <label className="field-label" htmlFor="game-root">
          Selected game path
        </label>
        <div className="path-control">
          <input
            id="game-root"
            value={gameRoot}
            onChange={(event) => setGameRoot(event.target.value)}
          />
          <button className="icon-button" type="button" onClick={openProject} aria-label="Open project">
            <FolderOpen size={17} />
          </button>
        </div>

        <div className="project-list">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              className={project.id === selectedProjectId ? "project-row selected" : "project-row"}
              onClick={() => setSelectedProjectId(project.id)}
            >
              <span>{project.display_name}</span>
              <small>{project.engine.toUpperCase()}</small>
            </button>
          ))}
        </div>
      </aside>

      <section className="workbench">
        <header className="topbar">
          <div>
            <p className="eyeline">{selectedProject?.game_root ?? gameRoot}</p>
            <h2>{selectedProject?.display_name ?? "No project selected"}</h2>
          </div>
          <div className="command-strip">
            <button type="button" onClick={scanGame}>
              <Search size={16} />
              Scan
            </button>
            <button type="button" onClick={translate}>
              <Languages size={16} />
              Translate
            </button>
            <button type="button" onClick={exportBundle}>
              <Upload size={16} />
              Export
            </button>
          </div>
        </header>

        <section className="status-strip" aria-label="Project status">
          <StatusCell icon={<Database size={17} />} label="Scan status" value={scanReport ? "Scan complete" : "Ready"} />
          <StatusCell icon={<Gauge size={17} />} label="Translation coverage" value={`${coverage}%`} />
          <StatusCell icon={<Table2 size={17} />} label="Review queue" value={dashboard.review_queue_count.toString()} />
          <StatusCell
            icon={<ShieldCheck size={17} />}
            label="Export/install"
            value={dashboard.latest_install?.status ?? "not installed"}
          />
          <StatusCell
            icon={<TerminalSquare size={17} />}
            label="Provider"
            value={dashboard.latest_provider_run?.status ?? "idle"}
          />
        </section>

        {error ? (
          <div className="error-banner" role="alert">
            <AlertTriangle size={17} />
            {error}
          </div>
        ) : null}

        <nav className="tabs" aria-label="Workbench tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={tab === activeTab}
              className={tab === activeTab ? "active" : ""}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </nav>

        <div className="workspace-grid">
          <section className="primary-panel">
            {activeTab === "Scan" ? (
              <ScanPanel report={scanReport} onScan={scanGame} pending={pendingLabel === "Scanning game"} />
            ) : null}
            {activeTab === "Translate" ? (
              <TranslatePanel report={translateReport} onTranslate={translate} pending={pendingLabel === "Translating batch"} />
            ) : null}
            {activeTab === "Review" ? (
              <ReviewPanel
                rows={filteredRows}
                filter={reviewFilter}
                onFilter={setReviewFilter}
                onAccept={acceptFirstRow}
              />
            ) : null}
            {activeTab === "Glossary" ? <GlossaryPanel /> : null}
            {activeTab === "Export/Install" ? (
              <ExportInstallPanel
                dashboard={dashboard}
                exportReport={exportReport}
                installReport={installReport}
                onExport={exportBundle}
                onInstall={installOverlay}
                onRollback={rollbackOverlay}
              />
            ) : null}
            {activeTab === "Diagnostics" ? (
              <DiagnosticsPanel diagnostics={diagnostics} onLoad={loadDiagnostics} />
            ) : null}
          </section>

          <aside className="right-rail" aria-label="Export and install summary">
            <h3>Export/Install</h3>
            <RailRow label="Latest export" value={dashboard.latest_export?.export_path ?? "none"} />
            <RailRow label="Included" value={(dashboard.latest_export?.included_count ?? 0).toLocaleString()} />
            <RailRow label="Install status" value={dashboard.latest_install?.status ?? "not installed"} />
            <RailRow label="Runtime UI" value="startup toast only" />
            <div className="rail-actions">
              <button type="button" onClick={installOverlay}>
                <Download size={15} />
                Install
              </button>
              <button type="button" onClick={rollbackOverlay}>
                <RotateCcw size={15} />
                Rollback
              </button>
            </div>
          </aside>
        </div>

        <footer className="statusbar">
          <span>{pendingLabel ?? (isPending ? "Working" : "Idle")}</span>
          <span>{dashboard.qa_finding_count} QA findings</span>
          <span>Runtime provider surface: none</span>
        </footer>
      </section>
    </main>
  );
}

function upsertProject(projects: ProjectSummary[], next: ProjectSummary) {
  const exists = projects.some((project) => project.id === next.id);
  return exists
    ? projects.map((project) => (project.id === next.id ? next : project))
    : [next, ...projects];
}

function StatusCell({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="status-cell">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ScanPanel({
  report,
  onScan,
  pending,
}: {
  report: ScanPersistenceReport | null;
  onScan: () => void;
  pending: boolean;
}) {
  return (
    <div className="task-panel">
      <div className="panel-heading">
        <h3>Scan</h3>
        <button type="button" onClick={onScan}>
          <RefreshCw size={15} />
          {pending ? "Scanning..." : "Run scan"}
        </button>
      </div>
      <div className="metric-grid">
        <Metric label="Source texts" value={report?.source_text_count ?? 0} />
        <Metric label="Occurrences" value={report?.occurrence_count ?? 0} />
        <Metric label="Rejected" value={report?.rejected_count ?? 0} />
        <Metric label="Skipped" value={report?.skipped_count ?? 0} />
      </div>
    </div>
  );
}

function TranslatePanel({
  report,
  onTranslate,
  pending,
}: {
  report: TranslateResponse | null;
  onTranslate: () => void;
  pending: boolean;
}) {
  return (
    <div className="task-panel">
      <div className="panel-heading">
        <h3>Translate</h3>
        <button type="button" onClick={onTranslate}>
          <Play size={15} />
          {pending ? "Translating..." : "Run fake provider"}
        </button>
      </div>
      <div className="metric-grid">
        <Metric label="Accepted" value={report?.accepted_count ?? 0} />
        <Metric label="Failed" value={report?.failed_count ?? 0} />
        <Metric label="Provider run" value={report?.provider_run_id ?? 0} />
        <Metric label="Split batches" value={report?.split_batches ?? 0} />
      </div>
    </div>
  );
}

function ReviewPanel({
  rows,
  filter,
  onFilter,
  onAccept,
}: {
  rows: ReviewQueueRow[];
  filter: ReviewFilter;
  onFilter: (filter: ReviewFilter) => void;
  onAccept: () => void;
}) {
  return (
    <div className="review-panel">
      <div className="table-toolbar">
        <div>
          <h3>Review queue</h3>
          <p>{rows.length} rows</p>
        </div>
        <div className="filter-row">
          <ListFilter size={15} />
          {(["all", "missing", "pending", "accepted", "attention"] as ReviewFilter[]).map((item) => (
            <button
              key={item}
              type="button"
              className={item === filter ? "selected" : ""}
              onClick={() => onFilter(item)}
            >
              {item}
            </button>
          ))}
          <button type="button" onClick={onAccept}>
            <Check size={15} />
            Accept first
          </button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Translation</th>
              <th>Location</th>
              <th>Placeholder</th>
              <th>Provider</th>
              <th>Review State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.source_text_id}>
                <td>
                  <strong>{row.visible_text}</strong>
                  <small>{row.source_language}</small>
                </td>
                <td>{row.translated_text ?? "—"}</td>
                <td>
                  <span>{row.first_file_path}</span>
                  <small>{row.first_json_path}</small>
                </td>
                <td>{row.control_code_signature || "none"}</td>
                <td>{row.provider ?? "none"}</td>
                <td>
                  <span className={`state ${row.review_state}`}>{row.review_state}</span>
                  {row.qa_finding_count ? <small>{row.qa_finding_count} finding</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GlossaryPanel() {
  return (
    <div className="task-panel">
      <div className="panel-heading">
        <h3>Glossary</h3>
        <button type="button">Add term</button>
      </div>
      <div className="glossary-grid">
        <span>魔法陣</span>
        <strong>마법진</strong>
        <span>古い鍵</span>
        <strong>낡은 열쇠</strong>
        <span>地下室</span>
        <strong>지하실</strong>
      </div>
    </div>
  );
}

function ExportInstallPanel({
  dashboard,
  exportReport,
  installReport,
  onExport,
  onInstall,
  onRollback,
}: {
  dashboard: DashboardSummary;
  exportReport: ExportBundleResponse | null;
  installReport: InstallOverlayResponse | null;
  onExport: () => void;
  onInstall: () => void;
  onRollback: () => void;
}) {
  return (
    <div className="task-panel">
      <div className="panel-heading">
        <h3>Export/Install</h3>
        <div className="inline-actions">
          <button type="button" onClick={onExport}>Export bundle</button>
          <button type="button" onClick={onInstall}>Install</button>
          <button type="button" onClick={onRollback}>Rollback</button>
        </div>
      </div>
      <div className="metric-grid">
        <Metric label="Export id" value={exportReport?.export_id ?? dashboard.latest_export?.id ?? 0} />
        <Metric label="Included" value={exportReport?.included_count ?? dashboard.latest_export?.included_count ?? 0} />
        <Metric label="Skipped" value={exportReport?.skipped_count ?? 0} />
        <Metric label="Install id" value={installReport?.install_id ?? dashboard.latest_install?.id ?? 0} />
      </div>
    </div>
  );
}

function DiagnosticsPanel({
  diagnostics,
  onLoad,
}: {
  diagnostics: DiagnosticsResponse | null;
  onLoad: () => void;
}) {
  return (
    <div className="task-panel">
      <div className="panel-heading">
        <h3>Diagnostics</h3>
        <button type="button" onClick={onLoad}>Refresh diagnostics</button>
      </div>
      <div className="diagnostic-lines">
        <span>Runtime provider surface</span>
        <strong>{diagnostics?.runtime_provider_surface ?? "not-present"}</strong>
        <span>Runtime UI surface</span>
        <strong>{diagnostics?.runtime_ui_surface ?? "startup-toast-only"}</strong>
        <span>Provider status</span>
        <strong>{diagnostics?.dashboard.latest_provider_run?.status ?? "idle"}</strong>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}
