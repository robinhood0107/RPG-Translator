use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, params};
use sha2::{Digest, Sha256};

use crate::{
    BulkReviewApproveReport, DuplicateProjectCleanupReport, Engine, ExportStatusRecord,
    ExportableTranslationRecord, ExtractedOccurrence, GameSnapshotRecord, InstallRecord,
    InstallStatusRecord, NewInstallRecord, NewOccurrence, NewProject, NewProviderRun, NewQaFinding,
    NewSourceText, NewTranslation, NewTranslationSpeedSample, OccurrenceContext, OccurrenceSegment,
    ProjectRecord, ProviderRunStatusRecord, QaFindingRecord, Result, ReviewCounts, ReviewQueueRow,
    ReviewUpdateRequest, ScanPersistenceStats, SourceTextRecord, TextCodec,
    TranslationJobProgressUpdate, TranslationJobSummary, TranslationRecord, TranslationSpeedSample,
    WorkbenchDashboardSummary, WorkbenchSettingsRecord, WorkbenchSettingsUpdate,
};

pub struct TranslationDb {
    conn: Connection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaMigrationReport {
    pub backup_path: Option<PathBuf>,
}

impl TranslationDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        configure_connection(&conn, true)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        configure_connection(&conn, false)?;
        Ok(Self { conn })
    }

    pub fn open_with_schema_guard(path: impl AsRef<Path>) -> Result<Self> {
        Ok(Self::open_with_schema_guard_report(path)?.0)
    }

    pub fn open_with_schema_guard_report(
        path: impl AsRef<Path>,
    ) -> Result<(Self, SchemaMigrationReport)> {
        let path = path.as_ref();
        let existed_before_open = path.exists();
        let mut db = Self::open(path)?;
        let mut report = SchemaMigrationReport { backup_path: None };
        if existed_before_open && db.needs_schema_upgrade()? {
            db.checkpoint_wal()?;
            db.verify_integrity()?;
            let backup_path = db.backup_before_schema_upgrade(path)?;
            verify_database_file(&backup_path)?;
            report.backup_path = Some(backup_path);
        }
        db.migrate()?;
        db.verify_integrity()?;
        Ok((db, report))
    }

    pub fn migrate(&mut self) -> Result<()> {
        self.recreate_translation_units_if_incompatible()?;
        self.conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY,
                game_root TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                engine TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS game_snapshots (
                id INTEGER PRIMARY KEY,
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                snapshot_hash TEXT NOT NULL,
                data_root TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(project_id, snapshot_hash)
            );

            CREATE TABLE IF NOT EXISTS source_texts (
                id INTEGER PRIMARY KEY,
                source_language TEXT NOT NULL,
                unit_kind TEXT NOT NULL,
                normalized_hash TEXT NOT NULL,
                normalized_text TEXT NOT NULL,
                visible_text TEXT NOT NULL,
                codec_text TEXT NOT NULL,
                control_code_signature TEXT NOT NULL,
                line_count INTEGER NOT NULL DEFAULT 1,
                newline_count INTEGER NOT NULL DEFAULT 0,
                placeholder_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS occurrences (
                id INTEGER PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
                source_text_id INTEGER NOT NULL REFERENCES source_texts(id) ON DELETE CASCADE,
                file_path TEXT NOT NULL,
                json_path TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                event_id INTEGER,
                page_index INTEGER,
                command_index INTEGER,
                command_code INTEGER,
                parameter_index INTEGER,
                object_key TEXT,
                extraction_rule_id TEXT NOT NULL,
                snapshot_id INTEGER,
                occurrence_identity TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS occurrence_segments (
                occurrence_id INTEGER NOT NULL REFERENCES occurrences(id) ON DELETE CASCADE,
                segment_index INTEGER NOT NULL,
                command_code INTEGER,
                json_path TEXT NOT NULL,
                raw_text TEXT NOT NULL,
                line_index INTEGER NOT NULL,
                PRIMARY KEY(occurrence_id, segment_index)
            ) WITHOUT ROWID;

            CREATE TABLE IF NOT EXISTS translations (
                id INTEGER PRIMARY KEY,
                source_text_id INTEGER NOT NULL REFERENCES source_texts(id) ON DELETE CASCADE,
                target_language TEXT NOT NULL,
                translated_text TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT,
                provider_run_id INTEGER REFERENCES provider_runs(id) ON DELETE SET NULL,
                review_state TEXT NOT NULL,
                qa_state TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(source_text_id, target_language)
            );

            CREATE TABLE IF NOT EXISTS provider_runs (
                id INTEGER PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT,
                request_settings_json TEXT NOT NULL DEFAULT '{}',
                status TEXT NOT NULL,
                started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                finished_at TEXT,
                failure_detail TEXT
            );

            CREATE TABLE IF NOT EXISTS qa_findings (
                id INTEGER PRIMARY KEY,
                source_text_id INTEGER NOT NULL REFERENCES source_texts(id) ON DELETE CASCADE,
                translation_id INTEGER REFERENCES translations(id) ON DELETE CASCADE,
                target_language TEXT,
                provider_run_id INTEGER REFERENCES provider_runs(id) ON DELETE SET NULL,
                finding_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'open',
                resolved_at TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS exports (
                id INTEGER PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                target_language TEXT NOT NULL,
                export_path TEXT NOT NULL,
                manifest_hash TEXT NOT NULL DEFAULT '',
                included_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS installs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                game_root TEXT NOT NULL,
                export_id INTEGER,
                backup_manifest_path TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS project_settings (
                project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(project_id, key)
            );

            CREATE TABLE IF NOT EXISTS translation_jobs (
                id INTEGER PRIMARY KEY,
                provider_run_id INTEGER REFERENCES provider_runs(id) ON DELETE SET NULL,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                source_language TEXT NOT NULL DEFAULT '',
                target_language TEXT NOT NULL,
                checkpoint_path TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL,
                completed_items INTEGER NOT NULL DEFAULT 0,
                failed_items INTEGER NOT NULL DEFAULT 0,
                total_items INTEGER NOT NULL DEFAULT 0,
                processed_batches INTEGER NOT NULL DEFAULT 0,
                total_batches INTEGER NOT NULL DEFAULT 0,
                split_batches INTEGER NOT NULL DEFAULT 0,
                parse_failed_items INTEGER NOT NULL DEFAULT 0,
                validation_failed_items INTEGER NOT NULL DEFAULT 0,
                skipped_items INTEGER NOT NULL DEFAULT 0,
                censored_retry_count INTEGER NOT NULL DEFAULT 0,
                item_eta_ms INTEGER,
                batch_eta_ms INTEGER,
                last_batch_elapsed_ms INTEGER,
                avg_batch_elapsed_ms INTEGER,
                current_batch_items INTEGER NOT NULL DEFAULT 0,
                elapsed_ms INTEGER NOT NULL DEFAULT 0,
                retry_pending_items INTEGER NOT NULL DEFAULT 0,
                recoverable_provider_failures INTEGER NOT NULL DEFAULT 0,
                final_failed_items INTEGER NOT NULL DEFAULT 0,
                provider_backoff_ms INTEGER,
                effective_batch_size INTEGER NOT NULL DEFAULT 0,
                speed_mode TEXT NOT NULL DEFAULT 'steady',
                success_streak INTEGER NOT NULL DEFAULT 0,
                success_delay_floor_ms INTEGER NOT NULL DEFAULT 1500,
                next_delay_ms INTEGER,
                failure_reason_counts_json TEXT NOT NULL DEFAULT '{}',
                legacy_checkpoint_only INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS job_events (
                id INTEGER PRIMARY KEY,
                translation_job_id INTEGER REFERENCES translation_jobs(id) ON DELETE CASCADE,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS translation_speed_samples (
                id INTEGER PRIMARY KEY,
                provider_run_id INTEGER NOT NULL REFERENCES provider_runs(id) ON DELETE CASCADE,
                batch_index INTEGER NOT NULL DEFAULT 0,
                lane TEXT NOT NULL DEFAULT 'unknown',
                item_count INTEGER NOT NULL DEFAULT 0,
                char_count INTEGER NOT NULL DEFAULT 0,
                estimated_token_count INTEGER NOT NULL DEFAULT 0,
                request_elapsed_ms INTEGER NOT NULL DEFAULT 0,
                success_delay_ms INTEGER NOT NULL DEFAULT 0,
                total_elapsed_ms INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'success',
                failure_type TEXT,
                effective_batch_size INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                prompt_hash TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS review_drafts (
                source_text_id INTEGER NOT NULL REFERENCES source_texts(id) ON DELETE CASCADE,
                target_language TEXT NOT NULL,
                draft_text TEXT NOT NULL,
                base_translation_updated_at TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (source_text_id, target_language)
            );

            PRAGMA user_version = 1;
            ",
        )?;
        self.ensure_exports_included_count_column()?;
        self.ensure_installs_export_id_column()?;
        self.ensure_occurrences_project_id_column()?;
        self.ensure_occurrences_scan_state_columns()?;
        self.ensure_translations_provider_run_id_column()?;
        self.ensure_qa_findings_columns()?;
        self.normalize_legacy_qa_findings()?;
        self.ensure_translation_jobs_columns()?;
        self.ensure_translation_speed_samples_table()?;
        self.ensure_review_drafts_table()?;
        self.ensure_required_indexes()?;
        self.cleanup_duplicate_projects()?;
        self.optimize()?;
        Ok(())
    }

    pub fn needs_schema_upgrade(&self) -> Result<bool> {
        let tables = self.table_names()?;
        if tables.contains("translation_jobs") {
            let columns = self.table_columns("translation_jobs")?;
            for column in [
                "processed_batches",
                "total_batches",
                "split_batches",
                "parse_failed_items",
                "validation_failed_items",
                "retry_pending_items",
                "recoverable_provider_failures",
                "final_failed_items",
                "effective_batch_size",
                "speed_mode",
                "success_streak",
                "success_delay_floor_ms",
                "next_delay_ms",
                "failure_reason_counts_json",
                "legacy_checkpoint_only",
            ] {
                if !columns.contains(column) {
                    return Ok(true);
                }
            }
        }
        if !tables.is_empty() && !tables.contains("translation_speed_samples") {
            return Ok(true);
        }
        if tables.contains("qa_findings") {
            let columns = self.table_columns("qa_findings")?;
            for column in [
                "target_language",
                "provider_run_id",
                "status",
                "resolved_at",
                "details_json",
            ] {
                if !columns.contains(column) {
                    return Ok(true);
                }
            }
        }
        if tables.contains("occurrences") {
            let columns = self.table_columns("occurrences")?;
            for column in ["snapshot_id", "occurrence_identity", "active", "updated_at"] {
                if !columns.contains(column) {
                    return Ok(true);
                }
            }
        }
        if tables.contains("source_texts") {
            let columns = self.table_columns("source_texts")?;
            for column in [
                "unit_kind",
                "normalized_hash",
                "codec_text",
                "line_count",
                "newline_count",
                "placeholder_count",
            ] {
                if !columns.contains(column) {
                    return Ok(true);
                }
            }
        }
        if tables.contains("occurrences") && !tables.contains("occurrence_segments") {
            return Ok(true);
        }
        if !tables.contains("review_drafts") {
            return Ok(true);
        }
        let indexes = self.index_names()?;
        Ok(required_index_names()
            .iter()
            .any(|index| !indexes.contains(*index)))
    }

    pub fn checkpoint_wal(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(FULL);")?;
        Ok(())
    }

    pub fn optimize(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA optimize;")?;
        Ok(())
    }

    fn verify_integrity(&self) -> Result<()> {
        let quick_check: String = self
            .conn
            .query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        if quick_check != "ok" {
            return Err(crate::Error::invalid_input(format!(
                "database quick_check failed: {quick_check}"
            )));
        }
        let foreign_key_violations = self.foreign_key_violation_count()?;
        if foreign_key_violations != 0 {
            return Err(crate::Error::invalid_input(format!(
                "database has {foreign_key_violations} foreign key violation(s)"
            )));
        }
        Ok(())
    }

    fn backup_before_schema_upgrade(&self, db_path: &Path) -> Result<PathBuf> {
        let backup_path = schema_backup_path(db_path)?;
        let backup_path_text = backup_path.to_string_lossy().to_string();
        self.conn
            .execute("VACUUM INTO ?1", params![backup_path_text])?;
        Ok(backup_path)
    }

    fn recreate_translation_units_if_incompatible(&self) -> Result<()> {
        let tables = self.table_names()?;
        if !tables.contains("source_texts") {
            return Ok(());
        }
        let source_columns = self.table_columns("source_texts")?;
        let has_block_columns = [
            "unit_kind",
            "normalized_hash",
            "codec_text",
            "line_count",
            "newline_count",
            "placeholder_count",
        ]
        .iter()
        .all(|column| source_columns.contains(*column));
        let has_segments =
            !tables.contains("occurrences") || tables.contains("occurrence_segments");
        if has_block_columns && has_segments {
            return Ok(());
        }

        self.conn.execute_batch(
            "
            PRAGMA foreign_keys = OFF;
            DROP TABLE IF EXISTS review_drafts;
            DROP TABLE IF EXISTS qa_findings;
            DROP TABLE IF EXISTS translations;
            DROP TABLE IF EXISTS occurrence_segments;
            DROP TABLE IF EXISTS occurrences;
            DROP TABLE IF EXISTS source_texts;
            PRAGMA foreign_keys = ON;
            ",
        )?;
        Ok(())
    }

    fn ensure_qa_findings_columns(&self) -> Result<()> {
        let columns = self.table_columns("qa_findings")?;
        for (column, definition) in [
            ("target_language", "TEXT"),
            (
                "provider_run_id",
                "INTEGER REFERENCES provider_runs(id) ON DELETE SET NULL",
            ),
            ("status", "TEXT NOT NULL DEFAULT 'open'"),
            ("resolved_at", "TEXT"),
            ("details_json", "TEXT NOT NULL DEFAULT '{}'"),
        ] {
            if !columns.contains(column) {
                self.conn.execute(
                    &format!("ALTER TABLE qa_findings ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        Ok(())
    }

    fn normalize_legacy_qa_findings(&self) -> Result<()> {
        if self
            .table_columns("translation_jobs")?
            .contains("target_language")
        {
            self.conn.execute(
                "
                UPDATE qa_findings
                SET target_language = (
                    SELECT CASE
                        WHEN COUNT(DISTINCT target_language) = 1 THEN MAX(target_language)
                        ELSE NULL
                    END
                    FROM translation_jobs
                )
                WHERE target_language IS NULL
                  AND EXISTS (SELECT 1 FROM translation_jobs)
                ",
                [],
            )?;
        }
        self.conn.execute(
            "
            UPDATE qa_findings
            SET finding_type = 'provider-json-parse',
                details_json = '{\"legacy_finding_type\":\"batch-validation\",\"legacy_classification\":\"provider-json-parse\"}'
            WHERE finding_type = 'batch-validation'
              AND (
                message LIKE '%invalid provider output JSON%'
                OR message LIKE '%provider returned markdown fence%'
                OR message LIKE '%provider returned think tag%'
                OR message LIKE '%provider returned empty output%'
                OR message LIKE '%provider output%'
              )
            ",
            [],
        )?;
        self.conn.execute(
            "
            UPDATE qa_findings
            SET finding_type = 'recoverable-provider',
                details_json = '{\"legacy_finding_type\":\"batch-validation\",\"legacy_classification\":\"recoverable-provider\"}'
            WHERE finding_type = 'batch-validation'
              AND (
                message LIKE '%local provider request failed%'
                OR message LIKE '%error sending request%'
                OR message LIKE '%503%'
                OR message LIKE '%Service Unavailable%'
                OR message LIKE '%connection refused%'
                OR message LIKE '%connection reset%'
                OR message LIKE '%operation timed out%'
              )
            ",
            [],
        )?;
        self.conn.execute(
            "
            UPDATE qa_findings
            SET finding_type = 'translation-validation',
                details_json = '{\"legacy_finding_type\":\"batch-validation\",\"legacy_classification\":\"translation-validation\"}'
            WHERE finding_type = 'batch-validation'
            ",
            [],
        )?;
        Ok(())
    }

    fn ensure_translation_jobs_columns(&self) -> Result<()> {
        let columns = self.table_columns("translation_jobs")?;
        let mut added_columns = Vec::new();
        for (column, definition) in [
            ("processed_batches", "INTEGER NOT NULL DEFAULT 0"),
            ("total_batches", "INTEGER NOT NULL DEFAULT 0"),
            ("split_batches", "INTEGER NOT NULL DEFAULT 0"),
            ("parse_failed_items", "INTEGER NOT NULL DEFAULT 0"),
            ("validation_failed_items", "INTEGER NOT NULL DEFAULT 0"),
            ("skipped_items", "INTEGER NOT NULL DEFAULT 0"),
            ("censored_retry_count", "INTEGER NOT NULL DEFAULT 0"),
            ("item_eta_ms", "INTEGER"),
            ("batch_eta_ms", "INTEGER"),
            ("last_batch_elapsed_ms", "INTEGER"),
            ("avg_batch_elapsed_ms", "INTEGER"),
            ("current_batch_items", "INTEGER NOT NULL DEFAULT 0"),
            ("elapsed_ms", "INTEGER NOT NULL DEFAULT 0"),
            ("retry_pending_items", "INTEGER NOT NULL DEFAULT 0"),
            (
                "recoverable_provider_failures",
                "INTEGER NOT NULL DEFAULT 0",
            ),
            ("final_failed_items", "INTEGER NOT NULL DEFAULT 0"),
            ("provider_backoff_ms", "INTEGER"),
            ("effective_batch_size", "INTEGER NOT NULL DEFAULT 0"),
            ("speed_mode", "TEXT NOT NULL DEFAULT 'steady'"),
            ("success_streak", "INTEGER NOT NULL DEFAULT 0"),
            ("success_delay_floor_ms", "INTEGER NOT NULL DEFAULT 1500"),
            ("next_delay_ms", "INTEGER"),
            ("failure_reason_counts_json", "TEXT NOT NULL DEFAULT '{}'"),
            ("legacy_checkpoint_only", "INTEGER NOT NULL DEFAULT 0"),
        ] {
            if !columns.contains(column) {
                self.conn.execute(
                    &format!("ALTER TABLE translation_jobs ADD COLUMN {column} {definition}"),
                    [],
                )?;
                added_columns.push(column);
            }
        }
        if !added_columns.is_empty() {
            self.backfill_translation_job_speed_columns()?;
        }
        Ok(())
    }

    fn backfill_translation_job_speed_columns(&self) -> Result<()> {
        self.conn.execute(
            "
            UPDATE translation_jobs
            SET speed_mode = CASE
                    WHEN provider_backoff_ms IS NOT NULL AND provider_backoff_ms > 0 THEN 'backoff'
                    WHEN effective_batch_size > 0 AND total_items > 0 THEN 'steady'
                    ELSE COALESCE(NULLIF(speed_mode, ''), 'steady')
                END,
                success_streak = COALESCE(success_streak, 0),
                success_delay_floor_ms = CASE
                    WHEN success_delay_floor_ms IS NULL OR success_delay_floor_ms <= 0 THEN 1500
                    ELSE success_delay_floor_ms
                END,
                next_delay_ms = COALESCE(next_delay_ms, provider_backoff_ms),
                effective_batch_size = CASE
                    WHEN effective_batch_size IS NULL OR effective_batch_size <= 0 THEN
                        CASE
                            WHEN current_batch_items > 0 THEN current_batch_items
                            ELSE 16
                        END
                    ELSE effective_batch_size
                END,
                failure_reason_counts_json = COALESCE(NULLIF(failure_reason_counts_json, ''), '{}'),
                legacy_checkpoint_only = COALESCE(legacy_checkpoint_only, 0)
            ",
            [],
        )?;
        Ok(())
    }

    fn ensure_translation_speed_samples_table(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS translation_speed_samples (
                id INTEGER PRIMARY KEY,
                provider_run_id INTEGER NOT NULL REFERENCES provider_runs(id) ON DELETE CASCADE,
                batch_index INTEGER NOT NULL DEFAULT 0,
                lane TEXT NOT NULL DEFAULT 'unknown',
                item_count INTEGER NOT NULL DEFAULT 0,
                char_count INTEGER NOT NULL DEFAULT 0,
                estimated_token_count INTEGER NOT NULL DEFAULT 0,
                request_elapsed_ms INTEGER NOT NULL DEFAULT 0,
                success_delay_ms INTEGER NOT NULL DEFAULT 0,
                total_elapsed_ms INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'success',
                failure_type TEXT,
                effective_batch_size INTEGER NOT NULL DEFAULT 0,
                model TEXT,
                prompt_hash TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )?;
        Ok(())
    }

    fn ensure_review_drafts_table(&self) -> Result<()> {
        self.conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS review_drafts (
                source_text_id INTEGER NOT NULL REFERENCES source_texts(id) ON DELETE CASCADE,
                target_language TEXT NOT NULL,
                draft_text TEXT NOT NULL,
                base_translation_updated_at TEXT,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (source_text_id, target_language)
            );
            ",
        )?;
        Ok(())
    }

    fn table_names(&self) -> Result<BTreeSet<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let tables = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut names = BTreeSet::new();
        for table in tables {
            names.insert(table?);
        }
        Ok(names)
    }

    fn table_columns(&self, table: &str) -> Result<BTreeSet<String>> {
        let mut statement = self.conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        let mut names = BTreeSet::new();
        for column in columns {
            names.insert(column?);
        }
        Ok(names)
    }

    fn index_names(&self) -> Result<BTreeSet<String>> {
        let mut statement = self
            .conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")?;
        let indexes = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut names = BTreeSet::new();
        for index in indexes {
            names.insert(index?);
        }
        Ok(names)
    }

    fn ensure_exports_included_count_column(&self) -> Result<()> {
        let mut statement = self.conn.prepare("PRAGMA table_info(exports)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        let mut has_included_count = false;
        for column in columns {
            if column? == "included_count" {
                has_included_count = true;
                break;
            }
        }
        if !has_included_count {
            self.conn.execute(
                "ALTER TABLE exports ADD COLUMN included_count INTEGER NOT NULL DEFAULT 0",
                [],
            )?;
        }
        Ok(())
    }

    fn ensure_installs_export_id_column(&self) -> Result<()> {
        let mut statement = self.conn.prepare("PRAGMA table_info(installs)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        let mut has_export_id = false;
        for column in columns {
            if column? == "export_id" {
                has_export_id = true;
                break;
            }
        }
        if !has_export_id {
            self.conn
                .execute("ALTER TABLE installs ADD COLUMN export_id INTEGER", [])?;
        }
        Ok(())
    }

    fn ensure_occurrences_project_id_column(&self) -> Result<()> {
        let columns = self.table_columns("occurrences")?;
        if !columns.contains("project_id") {
            self.conn.execute(
                "ALTER TABLE occurrences ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE",
                [],
            )?;
        }
        Ok(())
    }

    fn ensure_occurrences_scan_state_columns(&self) -> Result<()> {
        let columns = self.table_columns("occurrences")?;
        for (column, definition) in [
            ("snapshot_id", "INTEGER"),
            ("occurrence_identity", "TEXT NOT NULL DEFAULT ''"),
            ("active", "INTEGER NOT NULL DEFAULT 1"),
        ] {
            if !columns.contains(column) {
                self.conn.execute(
                    &format!("ALTER TABLE occurrences ADD COLUMN {column} {definition}"),
                    [],
                )?;
            }
        }
        if !columns.contains("updated_at") {
            self.conn
                .execute("ALTER TABLE occurrences ADD COLUMN updated_at TEXT", [])?;
            self.conn.execute(
                "UPDATE occurrences SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL",
                [],
            )?;
        }
        Ok(())
    }

    fn ensure_required_indexes(&self) -> Result<()> {
        self.deduplicate_occurrence_identities()?;
        self.conn.execute_batch(
            "
            CREATE UNIQUE INDEX IF NOT EXISTS idx_source_texts_language_kind_hash_unique
                ON source_texts(source_language, unit_kind, normalized_hash);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_occurrences_project_identity_unique
                ON occurrences(project_id, occurrence_identity)
                WHERE project_id IS NOT NULL AND occurrence_identity <> '';
            CREATE INDEX IF NOT EXISTS idx_occurrences_project_active_source
                ON occurrences(project_id, active, source_text_id);
            CREATE INDEX IF NOT EXISTS idx_occurrences_source_project_active
                ON occurrences(source_text_id, project_id, active);
            CREATE INDEX IF NOT EXISTS idx_occurrence_segments_occurrence_order
                ON occurrence_segments(occurrence_id, segment_index);
            CREATE INDEX IF NOT EXISTS idx_translations_target_review_qa_source
                ON translations(target_language, review_state, qa_state, source_text_id);
            CREATE INDEX IF NOT EXISTS idx_qa_findings_source_target_status_type
                ON qa_findings(source_text_id, target_language, status, finding_type);
            CREATE INDEX IF NOT EXISTS idx_exports_project_latest
                ON exports(project_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_installs_project_latest
                ON installs(project_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_translation_jobs_target_latest
                ON translation_jobs(target_language, updated_at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS idx_translation_speed_samples_run_batch
                ON translation_speed_samples(provider_run_id, batch_index);
            CREATE INDEX IF NOT EXISTS idx_translation_speed_samples_model_prompt_latest
                ON translation_speed_samples(model, prompt_hash, lane, status, created_at DESC);
            ",
        )?;
        Ok(())
    }

    fn deduplicate_occurrence_identities(&self) -> Result<()> {
        self.conn.execute(
            "
            UPDATE occurrences
            SET occurrence_identity = occurrence_identity || char(31) || 'duplicate:' || id,
                active = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE project_id IS NOT NULL
              AND occurrence_identity <> ''
              AND id NOT IN (
                  SELECT MIN(id)
                  FROM occurrences
                  WHERE project_id IS NOT NULL
                    AND occurrence_identity <> ''
                  GROUP BY project_id, occurrence_identity
              )
            ",
            [],
        )?;
        Ok(())
    }

    fn ensure_translations_provider_run_id_column(&self) -> Result<()> {
        let mut statement = self.conn.prepare("PRAGMA table_info(translations)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        let mut has_provider_run_id = false;
        for column in columns {
            if column? == "provider_run_id" {
                has_provider_run_id = true;
                break;
            }
        }
        if !has_provider_run_id {
            self.conn.execute(
                "ALTER TABLE translations ADD COLUMN provider_run_id INTEGER REFERENCES provider_runs(id) ON DELETE SET NULL",
                [],
            )?;
        }
        Ok(())
    }

    pub fn upsert_project(&mut self, input: &NewProject) -> Result<i64> {
        self.cleanup_duplicate_projects()?;
        if let Some(id) = self.project_id_by_canonical_game_root(&input.game_root)? {
            self.conn.execute(
                "
                UPDATE projects
                SET game_root = ?2,
                    display_name = ?3,
                    engine = ?4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?1
                ",
                params![
                    id,
                    normalize_project_path_for_storage(&input.game_root),
                    input.display_name,
                    input.engine.as_key()
                ],
            )?;
            return Ok(id);
        }
        let tx = self.conn.transaction()?;
        let game_root = normalize_project_path_for_storage(&input.game_root);
        tx.execute(
            "
            INSERT INTO projects (game_root, display_name, engine)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(game_root) DO UPDATE SET
                display_name = excluded.display_name,
                engine = excluded.engine,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![game_root, input.display_name, input.engine.as_key()],
        )?;
        let id = tx.query_row(
            "SELECT id FROM projects WHERE game_root = ?1",
            params![game_root],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn cleanup_duplicate_projects(&mut self) -> Result<DuplicateProjectCleanupReport> {
        let projects = self.list_projects()?;
        let mut groups: BTreeMap<String, Vec<ProjectRecord>> = BTreeMap::new();
        for project in projects {
            let key = canonical_project_path_key(&project.game_root);
            if !key.is_empty() {
                groups.entry(key).or_default().push(project);
            }
        }

        let tx = self.conn.transaction()?;
        let mut report = DuplicateProjectCleanupReport::default();
        for projects in groups.values_mut() {
            projects.sort_by_key(|project| project.id);
            let Some(survivor) = projects.first().cloned() else {
                continue;
            };
            let canonical_game_root = normalize_project_path_for_storage(&survivor.game_root);
            for duplicate in projects.iter().skip(1) {
                merge_project_rows(&tx, duplicate.id, survivor.id)?;
                report.merged_project_count += 1;
                report.removed_project_ids.push(duplicate.id);
            }
            tx.execute(
                "
                UPDATE projects
                SET game_root = ?2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?1
                ",
                params![survivor.id, canonical_game_root],
            )?;
            if projects.len() > 1 {
                report.survivor_project_ids.push(survivor.id);
            }
        }
        tx.commit()?;
        report.survivor_project_ids.sort_unstable();
        report.survivor_project_ids.dedup();
        report.removed_project_ids.sort_unstable();
        report.removed_project_ids.dedup();
        Ok(report)
    }

    fn project_id_by_canonical_game_root(&self, game_root: &str) -> Result<Option<i64>> {
        let needle = canonical_project_path_key(game_root);
        for project in self.list_projects()? {
            if canonical_project_path_key(&project.game_root) == needle {
                return Ok(Some(project.id));
            }
        }
        Ok(None)
    }

    pub fn get_project(&self, project_id: i64) -> Result<Option<ProjectRecord>> {
        let record = self
            .conn
            .query_row(
                "
                SELECT id, game_root, display_name, engine
                FROM projects
                WHERE id = ?1
                ",
                params![project_id],
                |row| {
                    let engine: String = row.get(3)?;
                    Ok(ProjectRecord {
                        id: row.get(0)?,
                        game_root: row.get(1)?,
                        display_name: row.get(2)?,
                        engine: Engine::from_key(&engine),
                    })
                },
            )
            .optional()?;
        Ok(record)
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT id, game_root, display_name, engine
            FROM projects
            ORDER BY display_name, id
            ",
        )?;
        let rows = statement.query_map([], |row| {
            let engine: String = row.get(3)?;
            Ok(ProjectRecord {
                id: row.get(0)?,
                game_root: row.get(1)?,
                display_name: row.get(2)?,
                engine: Engine::from_key(&engine),
            })
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    pub fn record_game_snapshot(
        &mut self,
        project_id: i64,
        snapshot_hash: &str,
        data_root_hash: &str,
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO game_snapshots (project_id, snapshot_hash, data_root)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(project_id, snapshot_hash) DO UPDATE SET
                data_root = excluded.data_root
            ",
            params![project_id, snapshot_hash, data_root_hash],
        )?;
        let id = tx.query_row(
            "
            SELECT id
            FROM game_snapshots
            WHERE project_id = ?1
              AND snapshot_hash = ?2
            ",
            params![project_id, snapshot_hash],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn get_game_snapshot(&self, snapshot_id: i64) -> Result<Option<GameSnapshotRecord>> {
        let record = self
            .conn
            .query_row(
                "
                SELECT id, project_id, snapshot_hash, data_root
                FROM game_snapshots
                WHERE id = ?1
                ",
                params![snapshot_id],
                |row| {
                    Ok(GameSnapshotRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        snapshot_hash: row.get(2)?,
                        data_root_hash: row.get(3)?,
                    })
                },
            )
            .optional()?;
        Ok(record)
    }

    pub fn upsert_source_text(&mut self, input: &NewSourceText) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let id = Self::upsert_source_text_in_tx(&tx, input)?;
        tx.commit()?;
        Ok(id)
    }

    fn upsert_source_text_in_tx(tx: &Transaction<'_>, input: &NewSourceText) -> Result<i64> {
        let normalized_hash = source_text_hash(input);
        tx.execute(
            "
            INSERT INTO source_texts (
                source_language,
                unit_kind,
                normalized_hash,
                normalized_text,
                visible_text,
                codec_text,
                control_code_signature,
                line_count,
                newline_count,
                placeholder_count
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(source_language, unit_kind, normalized_hash)
            DO UPDATE SET
                normalized_text = excluded.normalized_text,
                visible_text = excluded.visible_text,
                codec_text = excluded.codec_text,
                control_code_signature = excluded.control_code_signature,
                line_count = excluded.line_count,
                newline_count = excluded.newline_count,
                placeholder_count = excluded.placeholder_count,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![
                input.source_language,
                input.unit_kind,
                normalized_hash,
                input.normalized_text,
                input.visible_text,
                input.codec_text,
                input.control_code_signature,
                input.line_count,
                input.newline_count,
                input.placeholder_count
            ],
        )?;
        let id = tx.query_row(
            "
            SELECT id FROM source_texts
            WHERE source_language = ?1
              AND unit_kind = ?2
              AND normalized_hash = ?3
            ",
            params![input.source_language, input.unit_kind, normalized_hash],
            |row| row.get(0),
        )?;
        Ok(id)
    }

    pub fn insert_occurrence(&mut self, input: &NewOccurrence) -> Result<i64> {
        self.insert_occurrence_with_project(input.project_id, input)
    }

    pub fn insert_project_occurrence(
        &mut self,
        project_id: i64,
        input: &NewOccurrence,
    ) -> Result<i64> {
        self.insert_occurrence_with_project(Some(project_id), input)
    }

    fn insert_occurrence_with_project(
        &mut self,
        project_id: Option<i64>,
        input: &NewOccurrence,
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let id = Self::insert_occurrence_with_project_in_tx(&tx, project_id, input)?;
        tx.commit()?;
        Ok(id)
    }

    fn insert_occurrence_with_project_in_tx(
        tx: &Transaction<'_>,
        project_id: Option<i64>,
        input: &NewOccurrence,
    ) -> Result<i64> {
        tx.execute(
            "
            INSERT INTO occurrences (
                project_id,
                source_text_id,
                file_path,
                json_path,
                entity_type,
                event_id,
                page_index,
                command_index,
                command_code,
                parameter_index,
                object_key,
                extraction_rule_id,
                occurrence_identity,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, CURRENT_TIMESTAMP)
            ",
            params![
                project_id,
                input.source_text_id,
                input.file_path,
                input.json_path,
                input.entity_type,
                input.event_id,
                input.page_index,
                input.command_index,
                input.command_code,
                input.parameter_index,
                input.object_key,
                input.extraction_rule_id,
                occurrence_identity_from_new(input)
            ],
        )?;
        let id = tx.last_insert_rowid();
        Ok(id)
    }

    pub fn persist_project_scan_occurrences(
        &mut self,
        project_id: i64,
        snapshot_id: i64,
        occurrences: &[ExtractedOccurrence],
    ) -> Result<ScanPersistenceStats> {
        let tx = self.conn.transaction()?;
        let previous_source_text_ids = active_project_source_text_ids_tx(&tx, project_id)?;
        let existing_identity_ids = active_project_occurrence_identity_ids_tx(&tx, project_id)?;
        let previous_identities = existing_identity_ids
            .keys()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut source_text_ids = BTreeSet::new();
        let mut current_identities = BTreeSet::new();
        let mut source_text_ids_by_key: BTreeMap<(String, String, String), i64> = BTreeMap::new();

        for occurrence in occurrences {
            let key = source_text_key(&occurrence.source_text);
            if source_text_ids_by_key.contains_key(&key) {
                continue;
            }
            let source_text_id = Self::upsert_source_text_in_tx(&tx, &occurrence.source_text)?;
            source_text_ids_by_key.insert(key, source_text_id);
            source_text_ids.insert(source_text_id);
        }

        tx.execute(
            "
            UPDATE occurrences
            SET active = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE project_id = ?1
              AND active = 1
            ",
            params![project_id],
        )?;

        let mut update_occurrence = tx.prepare(
            "
            UPDATE occurrences
            SET source_text_id = ?2,
                file_path = ?3,
                json_path = ?4,
                entity_type = ?5,
                event_id = ?6,
                page_index = ?7,
                command_index = ?8,
                command_code = ?9,
                parameter_index = ?10,
                object_key = ?11,
                extraction_rule_id = ?12,
                snapshot_id = ?13,
                active = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?1
            ",
        )?;
        let mut insert_occurrence = tx.prepare(
            "
            INSERT INTO occurrences (
                project_id,
                source_text_id,
                file_path,
                json_path,
                entity_type,
                event_id,
                page_index,
                command_index,
                command_code,
                parameter_index,
                object_key,
                extraction_rule_id,
                snapshot_id,
                occurrence_identity,
                active,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, CURRENT_TIMESTAMP)
            ",
        )?;
        let mut delete_segments =
            tx.prepare("DELETE FROM occurrence_segments WHERE occurrence_id = ?1")?;
        let mut insert_segment = tx.prepare(
            "
            INSERT INTO occurrence_segments (
                occurrence_id,
                segment_index,
                command_code,
                json_path,
                raw_text,
                line_index
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ",
        )?;

        for occurrence in occurrences {
            let source_text_id = source_text_ids_by_key
                .get(&source_text_key(&occurrence.source_text))
                .copied()
                .ok_or_else(|| crate::Error::invalid_input("scan source text id preload failed"))?;
            source_text_ids.insert(source_text_id);
            let identity = occurrence_identity_from_context(&occurrence.context);
            current_identities.insert(identity.clone());
            let occurrence_id = if let Some(id) = existing_identity_ids.get(&identity) {
                update_occurrence.execute(params![
                    id,
                    source_text_id,
                    occurrence.context.file_path,
                    occurrence.context.json_path,
                    occurrence.context.entity_type,
                    occurrence.context.event_id,
                    occurrence.context.page_index,
                    occurrence.context.command_index,
                    occurrence.context.command_code,
                    occurrence.context.parameter_index,
                    occurrence.context.object_key,
                    occurrence.context.extraction_rule_id,
                    snapshot_id,
                ])?;
                *id
            } else {
                insert_occurrence.execute(params![
                    project_id,
                    source_text_id,
                    occurrence.context.file_path,
                    occurrence.context.json_path,
                    occurrence.context.entity_type,
                    occurrence.context.event_id,
                    occurrence.context.page_index,
                    occurrence.context.command_index,
                    occurrence.context.command_code,
                    occurrence.context.parameter_index,
                    occurrence.context.object_key,
                    occurrence.context.extraction_rule_id,
                    snapshot_id,
                    identity,
                ])?;
                tx.last_insert_rowid()
            };
            delete_segments.execute(params![occurrence_id])?;
            for segment in &occurrence.segments {
                insert_segment.execute(params![
                    occurrence_id,
                    segment.segment_index,
                    segment.command_code,
                    segment.json_path,
                    segment.raw_text,
                    segment.line_index,
                ])?;
            }
        }

        let added_source_text_count = source_text_ids
            .difference(&previous_source_text_ids)
            .count() as i64;
        let unchanged_source_text_count = source_text_ids
            .intersection(&previous_source_text_ids)
            .count() as i64;
        let removed_occurrence_count =
            previous_identities.difference(&current_identities).count() as i64;
        let stats = ScanPersistenceStats {
            source_text_count: source_text_ids.len() as i64,
            occurrence_count: current_identities.len() as i64,
            added_source_text_count,
            removed_occurrence_count,
            unchanged_source_text_count,
        };
        drop(insert_occurrence);
        drop(update_occurrence);
        drop(insert_segment);
        drop(delete_segments);
        tx.commit()?;
        Ok(stats)
    }

    pub fn workbench_dashboard_summary(
        &self,
        project_id: i64,
        target_language: &str,
    ) -> Result<WorkbenchDashboardSummary> {
        let source_text_count = self.count_project_source_texts(project_id)?;
        let occurrence_count = self.count_project_occurrences(project_id)?;
        let translated_count =
            self.count_project_translations(project_id, target_language, None)?;
        let accepted_count =
            self.count_project_translations(project_id, target_language, Some("accepted"))?;
        let reviewed_count =
            self.count_project_translations(project_id, target_language, Some("reviewed"))?;
        let review_queue_count = self.count_project_review_queue(project_id, target_language)?;
        let qa_finding_count = self.count_project_qa_findings(project_id)?;
        Ok(WorkbenchDashboardSummary {
            project_id,
            target_language: target_language.to_string(),
            source_text_count,
            occurrence_count,
            translated_count,
            accepted_count,
            reviewed_count,
            review_queue_count,
            qa_finding_count,
            latest_export: self.latest_export_status(project_id)?,
            latest_install: self.latest_install_status(project_id)?,
            latest_provider_run: self.latest_provider_run_status()?,
        })
    }

    pub fn review_queue_rows(
        &self,
        project_id: i64,
        target_language: &str,
        review_state_filter: Option<&str>,
    ) -> Result<Vec<ReviewQueueRow>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                source_texts.id,
                source_texts.source_language,
                source_texts.normalized_text,
                source_texts.visible_text,
                source_texts.control_code_signature,
                COUNT(occurrences.id) AS occurrence_count,
                MIN(occurrences.file_path) AS first_file_path,
                MIN(occurrences.json_path) AS first_json_path,
                translations.id,
                translations.translated_text,
                translations.provider,
                translations.model,
                translations.review_state,
                translations.qa_state,
                translations.updated_at,
                (
                    SELECT COUNT(*)
                    FROM qa_findings
                    WHERE qa_findings.source_text_id = source_texts.id
                ) AS qa_finding_count
            FROM source_texts
            INNER JOIN occurrences ON occurrences.source_text_id = source_texts.id
            LEFT JOIN translations
                ON translations.source_text_id = source_texts.id
               AND translations.target_language = ?2
            WHERE occurrences.project_id = ?1
              AND occurrences.active = 1
            GROUP BY
                source_texts.id,
                source_texts.source_language,
                source_texts.normalized_text,
                source_texts.visible_text,
                source_texts.control_code_signature,
                translations.id,
                translations.translated_text,
                translations.provider,
                translations.model,
                translations.review_state,
                translations.qa_state,
                translations.updated_at
            ORDER BY source_texts.id
            ",
        )?;
        let rows = statement.query_map(params![project_id, target_language], |row| {
            let review_state = row
                .get::<_, Option<String>>(12)?
                .unwrap_or_else(|| "missing".to_string());
            let qa_state = row
                .get::<_, Option<String>>(13)?
                .unwrap_or_else(|| "unchecked".to_string());
            Ok(ReviewQueueRow {
                source_text_id: row.get(0)?,
                source_language: row.get(1)?,
                normalized_text: row.get(2)?,
                visible_text: row.get(3)?,
                control_code_signature: row.get(4)?,
                occurrence_count: row.get(5)?,
                first_file_path: row.get(6)?,
                first_json_path: row.get(7)?,
                translation_id: row.get(8)?,
                target_language: target_language.to_string(),
                translated_text: row.get(9)?,
                provider: row.get(10)?,
                model: row.get(11)?,
                review_state,
                qa_state,
                qa_finding_count: row.get(15)?,
                qa_findings: Vec::new(),
                issue_badges: Vec::new(),
                translation_updated_at: row.get(14)?,
                draft_text: None,
                draft_updated_at: None,
                has_unapplied_draft: false,
            })
        })?;
        let mut records = Vec::new();
        for row in rows {
            let record = row?;
            if review_state_filter.is_none_or(|filter| record.review_state == filter) {
                records.push(self.hydrate_review_row(record)?);
            }
        }
        Ok(records)
    }

    pub fn review_queue_page(
        &self,
        project_id: i64,
        target_language: &str,
        review_state_filter: Option<&str>,
        issue_filter: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<(Vec<ReviewQueueRow>, i64)> {
        let issue_clause = review_issue_filter_clause(issue_filter)?;
        let total_count = self.review_queue_total_count(
            project_id,
            target_language,
            &format!("WHERE (?3 IS NULL OR review_state = ?3) AND {issue_clause}"),
            review_state_filter,
        )?;
        let sql = format!(
            "
            WITH review_rows AS (
                SELECT
                    source_texts.id AS source_text_id,
                    source_texts.source_language AS source_language,
                    source_texts.normalized_text AS normalized_text,
                    source_texts.visible_text AS visible_text,
                    source_texts.control_code_signature AS control_code_signature,
                    COUNT(occurrences.id) AS occurrence_count,
                    MIN(occurrences.file_path) AS first_file_path,
                    MIN(occurrences.json_path) AS first_json_path,
                    translations.id AS translation_id,
                    translations.translated_text AS translated_text,
                    translations.provider AS provider,
                    translations.model AS model,
                    COALESCE(translations.review_state, 'missing') AS review_state,
                    COALESCE(translations.qa_state, 'unchecked') AS qa_state,
                    translations.updated_at AS translation_updated_at,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                    ) AS qa_finding_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'provider-json-parse'
                    ) AS json_parse_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'translation-validation'
                    ) AS validation_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'final-failed'
                    ) AS final_failed_count
                FROM source_texts
                INNER JOIN occurrences ON occurrences.source_text_id = source_texts.id
                LEFT JOIN translations
                    ON translations.source_text_id = source_texts.id
                   AND translations.target_language = ?2
                WHERE occurrences.project_id = ?1
                  AND occurrences.active = 1
                GROUP BY
                    source_texts.id,
                    source_texts.source_language,
                    source_texts.normalized_text,
                    source_texts.visible_text,
                    source_texts.control_code_signature,
                    translations.id,
                    translations.translated_text,
                    translations.provider,
                    translations.model,
                    translations.review_state,
                    translations.qa_state,
                    translations.updated_at
            )
            SELECT
                source_text_id,
                source_language,
                normalized_text,
                visible_text,
                control_code_signature,
                occurrence_count,
                first_file_path,
                first_json_path,
                translation_id,
                translated_text,
                provider,
                model,
                review_state,
                qa_state,
                translation_updated_at,
                qa_finding_count
            FROM review_rows
            WHERE (?3 IS NULL OR review_state = ?3) AND {issue_clause}
            ORDER BY source_text_id
            LIMIT ?4 OFFSET ?5
            "
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(
            params![
                project_id,
                target_language,
                review_state_filter,
                limit as i64,
                offset as i64
            ],
            |row| {
                Ok(ReviewQueueRow {
                    source_text_id: row.get(0)?,
                    source_language: row.get(1)?,
                    normalized_text: row.get(2)?,
                    visible_text: row.get(3)?,
                    control_code_signature: row.get(4)?,
                    occurrence_count: row.get(5)?,
                    first_file_path: row.get(6)?,
                    first_json_path: row.get(7)?,
                    translation_id: row.get(8)?,
                    target_language: target_language.to_string(),
                    translated_text: row.get(9)?,
                    provider: row.get(10)?,
                    model: row.get(11)?,
                    review_state: row.get(12)?,
                    qa_state: row.get(13)?,
                    translation_updated_at: row.get(14)?,
                    qa_finding_count: row.get(15)?,
                    qa_findings: Vec::new(),
                    issue_badges: Vec::new(),
                    draft_text: None,
                    draft_updated_at: None,
                    has_unapplied_draft: false,
                })
            },
        )?;
        let records = rows
            .collect::<std::result::Result<Vec<_>, _>>()?
            .into_iter()
            .map(|row| self.hydrate_review_row(row))
            .collect::<Result<Vec<_>>>()?;
        Ok((records, total_count))
    }

    pub fn upsert_translation(&mut self, input: &NewTranslation) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let id = upsert_translation_tx(&tx, input)?;
        tx.commit()?;
        Ok(id)
    }

    pub fn upsert_translations_in_transaction(
        &mut self,
        inputs: &[NewTranslation],
    ) -> Result<Vec<i64>> {
        let tx = self.conn.transaction()?;
        let mut ids = Vec::with_capacity(inputs.len());
        for input in inputs {
            ids.push(upsert_translation_tx(&tx, input)?);
        }
        tx.commit()?;
        Ok(ids)
    }

    pub fn get_translation(
        &self,
        source_text_id: i64,
        target_language: &str,
    ) -> Result<Option<TranslationRecord>> {
        let record = self
            .conn
            .query_row(
                "
                SELECT
                    id,
                    source_text_id,
                    target_language,
                    translated_text,
                    provider,
                    model,
                    provider_run_id,
                    review_state,
                    qa_state
                FROM translations
                WHERE source_text_id = ?1
                  AND target_language = ?2
                ",
                params![source_text_id, target_language],
                |row| {
                    Ok(TranslationRecord {
                        id: row.get(0)?,
                        source_text_id: row.get(1)?,
                        target_language: row.get(2)?,
                        translated_text: row.get(3)?,
                        provider: row.get(4)?,
                        model: row.get(5)?,
                        provider_run_id: row.get(6)?,
                        review_state: row.get(7)?,
                        qa_state: row.get(8)?,
                    })
                },
            )
            .optional()?;
        Ok(record)
    }

    pub fn update_review_row(&mut self, input: &ReviewUpdateRequest) -> Result<ReviewQueueRow> {
        let tx = self.conn.transaction()?;
        let existing_updated_at = tx
            .query_row(
                "
                SELECT updated_at
                FROM translations
                WHERE source_text_id = ?1
                  AND target_language = ?2
                ",
                params![input.source_text_id, input.target_language],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if let (Some(expected), Some(existing)) = (
            input.expected_updated_at.as_deref(),
            existing_updated_at.as_deref(),
        ) && expected != existing
        {
            return Err(crate::Error::invalid_input(
                "review row was changed by another operation; reload and try again",
            ));
        }
        let validation_messages = review_translation_validation_messages_tx(
            &tx,
            input.source_text_id,
            &input.translated_text,
        )?;
        let requested_approval = input.review_state == "accepted" || input.qa_state == "passed";
        let (review_state, qa_state) = if input.translated_text.trim().is_empty() {
            ("missing".to_string(), "unchecked".to_string())
        } else if validation_messages.is_empty() {
            (
                input.review_state.clone(),
                if input.review_state == "attention" {
                    "needs-review".to_string()
                } else {
                    "passed".to_string()
                },
            )
        } else {
            tx.execute(
                "
                UPDATE qa_findings
                SET status = 'resolved',
                    resolved_at = CURRENT_TIMESTAMP
                WHERE source_text_id = ?1
                  AND (target_language IS NULL OR target_language = ?2)
                  AND finding_type = 'translation-validation'
                  AND status = 'open'
                ",
                params![input.source_text_id, input.target_language],
            )?;
            insert_qa_finding_tx(
                &tx,
                &NewQaFinding {
                    source_text_id: input.source_text_id,
                    translation_id: None,
                    target_language: Some(input.target_language.clone()),
                    provider_run_id: None,
                    finding_type: "translation-validation".to_string(),
                    severity: "error".to_string(),
                    message: validation_messages.join("; "),
                    status: "open".to_string(),
                    details_json: "{}".to_string(),
                },
            )?;
            (
                if requested_approval {
                    "pending".to_string()
                } else {
                    input.review_state.clone()
                },
                "needs-review".to_string(),
            )
        };
        let translation_id = upsert_translation_tx(
            &tx,
            &NewTranslation {
                source_text_id: input.source_text_id,
                target_language: input.target_language.clone(),
                translated_text: input.translated_text.clone(),
                provider: input.provider.clone(),
                model: input.model.clone(),
                provider_run_id: None,
                review_state,
                qa_state,
            },
        )?;
        if validation_messages.is_empty() && !input.translated_text.trim().is_empty() {
            tx.execute(
                "
                UPDATE qa_findings
                SET status = 'resolved',
                    resolved_at = CURRENT_TIMESTAMP
                WHERE source_text_id = ?1
                  AND (target_language IS NULL OR target_language = ?2)
                  AND status = 'open'
                ",
                params![input.source_text_id, input.target_language],
            )?;
            tx.execute(
                "
                UPDATE qa_findings
                SET translation_id = ?1
                WHERE source_text_id = ?2
                  AND (target_language IS NULL OR target_language = ?3)
                  AND translation_id IS NULL
                ",
                params![translation_id, input.source_text_id, input.target_language],
            )?;
        }
        tx.execute(
            "
            DELETE FROM review_drafts
            WHERE source_text_id = ?1
              AND target_language = ?2
            ",
            params![input.source_text_id, input.target_language],
        )?;
        tx.commit()?;
        self.review_row_for_source(input.source_text_id, &input.target_language)
    }

    pub fn review_row_for_source(
        &self,
        source_text_id: i64,
        target_language: &str,
    ) -> Result<ReviewQueueRow> {
        let mut statement = self.conn.prepare(
            "
            WITH review_rows AS (
                SELECT
                    source_texts.id AS source_text_id,
                    source_texts.source_language AS source_language,
                    source_texts.normalized_text AS normalized_text,
                    source_texts.visible_text AS visible_text,
                    source_texts.control_code_signature AS control_code_signature,
                    COUNT(occurrences.id) AS occurrence_count,
                    MIN(occurrences.file_path) AS first_file_path,
                    MIN(occurrences.json_path) AS first_json_path,
                    translations.id AS translation_id,
                    translations.translated_text AS translated_text,
                    translations.provider AS provider,
                    translations.model AS model,
                    COALESCE(translations.review_state, 'missing') AS review_state,
                    COALESCE(translations.qa_state, 'unchecked') AS qa_state,
                    translations.updated_at AS translation_updated_at,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                    ) AS qa_finding_count
                FROM source_texts
                LEFT JOIN occurrences
                    ON occurrences.source_text_id = source_texts.id
                   AND occurrences.active = 1
                LEFT JOIN translations
                    ON translations.source_text_id = source_texts.id
                   AND translations.target_language = ?2
                WHERE source_texts.id = ?1
                GROUP BY
                    source_texts.id,
                    source_texts.source_language,
                    source_texts.normalized_text,
                    source_texts.visible_text,
                    source_texts.control_code_signature,
                    translations.id,
                    translations.translated_text,
                    translations.provider,
                    translations.model,
                    translations.review_state,
                    translations.qa_state,
                    translations.updated_at
            )
            SELECT
                source_text_id,
                source_language,
                normalized_text,
                visible_text,
                control_code_signature,
                occurrence_count,
                COALESCE(first_file_path, ''),
                COALESCE(first_json_path, ''),
                translation_id,
                translated_text,
                provider,
                model,
                review_state,
                qa_state,
                translation_updated_at,
                qa_finding_count
            FROM review_rows
            ",
        )?;
        let row = statement.query_row(params![source_text_id, target_language], |row| {
            Ok(ReviewQueueRow {
                source_text_id: row.get(0)?,
                source_language: row.get(1)?,
                normalized_text: row.get(2)?,
                visible_text: row.get(3)?,
                control_code_signature: row.get(4)?,
                occurrence_count: row.get(5)?,
                first_file_path: row.get(6)?,
                first_json_path: row.get(7)?,
                translation_id: row.get(8)?,
                target_language: target_language.to_string(),
                translated_text: row.get(9)?,
                provider: row.get(10)?,
                model: row.get(11)?,
                review_state: row.get(12)?,
                qa_state: row.get(13)?,
                translation_updated_at: row.get(14)?,
                qa_finding_count: row.get(15)?,
                qa_findings: Vec::new(),
                issue_badges: Vec::new(),
                draft_text: None,
                draft_updated_at: None,
                has_unapplied_draft: false,
            })
        })?;
        self.hydrate_review_row(row)
    }

    fn hydrate_review_row(&self, mut row: ReviewQueueRow) -> Result<ReviewQueueRow> {
        row.qa_findings =
            self.open_qa_findings_for_source_target(row.source_text_id, &row.target_language)?;
        row.qa_finding_count = i64::try_from(row.qa_findings.len()).unwrap_or(i64::MAX);
        row.issue_badges = issue_badges_for_findings(&row.qa_findings);
        if let Some((draft_text, draft_updated_at, base_translation_updated_at)) =
            self.review_draft_for_source(row.source_text_id, &row.target_language)?
        {
            row.has_unapplied_draft = row.translated_text.as_deref() != Some(draft_text.as_str())
                || base_translation_updated_at != row.translation_updated_at;
            row.draft_text = Some(draft_text);
            row.draft_updated_at = Some(draft_updated_at);
        }
        Ok(row)
    }

    pub fn upsert_review_draft(
        &mut self,
        source_text_id: i64,
        target_language: &str,
        draft_text: &str,
        base_translation_updated_at: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "
            INSERT INTO review_drafts (
                source_text_id,
                target_language,
                draft_text,
                base_translation_updated_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, CURRENT_TIMESTAMP)
            ON CONFLICT(source_text_id, target_language) DO UPDATE SET
                draft_text = excluded.draft_text,
                base_translation_updated_at = excluded.base_translation_updated_at,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![
                source_text_id,
                target_language,
                draft_text,
                base_translation_updated_at
            ],
        )?;
        Ok(())
    }

    fn review_draft_for_source(
        &self,
        source_text_id: i64,
        target_language: &str,
    ) -> Result<Option<(String, String, Option<String>)>> {
        Ok(self
            .conn
            .query_row(
                "
                SELECT draft_text, updated_at, base_translation_updated_at
                FROM review_drafts
                WHERE source_text_id = ?1
                  AND target_language = ?2
                ",
                params![source_text_id, target_language],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()?)
    }

    pub fn bulk_approve_pending_review_rows(
        &mut self,
        project_id: i64,
        target_language: &str,
        source_text_ids: Option<&[i64]>,
    ) -> Result<BulkReviewApproveReport> {
        let tx = self.conn.transaction()?;
        let candidates = if let Some(source_text_ids) = source_text_ids {
            source_text_ids.to_vec()
        } else {
            let mut statement = tx.prepare(
                "
                SELECT DISTINCT translations.source_text_id
                FROM translations
                INNER JOIN occurrences ON occurrences.source_text_id = translations.source_text_id
                WHERE occurrences.project_id = ?1
                  AND occurrences.active = 1
                  AND translations.target_language = ?2
                  AND translations.review_state = 'pending'
                  AND translations.translated_text <> ''
                  AND NOT EXISTS (
                    SELECT 1
                    FROM qa_findings
                    WHERE qa_findings.source_text_id = translations.source_text_id
                      AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                      AND qa_findings.status = 'open'
                  )
                ORDER BY translations.source_text_id
                ",
            )?;
            let rows = statement.query_map(params![project_id, target_language], |row| {
                row.get::<_, i64>(0)
            })?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };

        let mut updated_count = 0i64;
        let mut skipped_missing_count = 0i64;
        let mut skipped_finding_count = 0i64;
        let mut skipped_attention_count = 0i64;
        let mut skipped_validation_count = 0i64;
        for source_text_id in candidates {
            let state = tx
                .query_row(
                    "
                    SELECT
                        translations.review_state,
                        translations.translated_text,
                        (
                            SELECT COUNT(*)
                            FROM qa_findings
                            WHERE qa_findings.source_text_id = translations.source_text_id
                              AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                              AND qa_findings.status = 'open'
                        ) AS open_finding_count
                    FROM translations
                    WHERE translations.source_text_id = ?1
                      AND translations.target_language = ?2
                    ",
                    params![source_text_id, target_language],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )
                .optional()?;
            let Some((review_state, translated_text, open_finding_count)) = state else {
                skipped_missing_count += 1;
                continue;
            };
            if translated_text.trim().is_empty() {
                skipped_missing_count += 1;
                continue;
            }
            if review_state == "attention" {
                skipped_attention_count += 1;
                continue;
            }
            if open_finding_count > 0 {
                skipped_finding_count += 1;
                continue;
            }
            let validation_messages =
                review_translation_validation_messages_tx(&tx, source_text_id, &translated_text)?;
            if !validation_messages.is_empty() {
                tx.execute(
                    "
                    UPDATE qa_findings
                    SET status = 'resolved',
                        resolved_at = CURRENT_TIMESTAMP
                    WHERE source_text_id = ?1
                      AND (target_language IS NULL OR target_language = ?2)
                      AND finding_type = 'translation-validation'
                      AND status = 'open'
                    ",
                    params![source_text_id, target_language],
                )?;
                insert_qa_finding_tx(
                    &tx,
                    &NewQaFinding {
                        source_text_id,
                        translation_id: None,
                        target_language: Some(target_language.to_string()),
                        provider_run_id: None,
                        finding_type: "translation-validation".to_string(),
                        severity: "error".to_string(),
                        message: validation_messages.join("; "),
                        status: "open".to_string(),
                        details_json: "{}".to_string(),
                    },
                )?;
                skipped_validation_count += 1;
                continue;
            }
            let changed = tx.execute(
                "
                UPDATE translations
                SET review_state = 'accepted',
                    qa_state = 'passed',
                    updated_at = CURRENT_TIMESTAMP
                WHERE source_text_id = ?1
                  AND target_language = ?2
                  AND review_state = 'pending'
                  AND translated_text <> ''
                  AND NOT EXISTS (
                    SELECT 1
                    FROM qa_findings
                    WHERE qa_findings.source_text_id = translations.source_text_id
                      AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                      AND qa_findings.status = 'open'
                  )
                ",
                params![source_text_id, target_language],
            )?;
            updated_count += i64::try_from(changed).unwrap_or(i64::MAX);
        }
        tx.commit()?;
        Ok(BulkReviewApproveReport {
            updated_count,
            skipped_missing_count,
            skipped_finding_count,
            skipped_attention_count,
            skipped_validation_count,
        })
    }

    pub fn pending_source_texts(&self, target_language: &str) -> Result<Vec<SourceTextRecord>> {
        self.translation_source_texts(target_language, None, false)
    }

    pub fn translation_source_texts(
        &self,
        target_language: &str,
        source_text_ids: Option<&BTreeSet<i64>>,
        include_existing_translations: bool,
    ) -> Result<Vec<SourceTextRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                source_language,
                unit_kind,
                normalized_hash,
                normalized_text,
                visible_text,
                codec_text,
                control_code_signature,
                line_count,
                newline_count,
                placeholder_count
            FROM source_texts
            WHERE (?2 = 1 OR NOT EXISTS (
                SELECT 1
                FROM translations
                WHERE translations.source_text_id = source_texts.id
                  AND translations.target_language = ?1
            ))
            ORDER BY id
            ",
        )?;
        let rows = statement.query_map(
            params![
                target_language,
                if include_existing_translations { 1 } else { 0 }
            ],
            source_text_record_from_row,
        )?;
        let mut records = Vec::new();
        for row in rows {
            let record = row?;
            if source_text_ids.is_none_or(|ids| ids.contains(&record.id)) {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn benchmark_source_texts(
        &self,
        project_id: Option<i64>,
        source_language: &str,
        limit: usize,
    ) -> Result<Vec<SourceTextRecord>> {
        let limit = i64::try_from(limit.max(1)).unwrap_or(i64::MAX);
        if let Some(project_id) = project_id {
            let mut statement = self.conn.prepare(
                "
                SELECT DISTINCT
                    source_texts.id,
                    source_texts.source_language,
                    source_texts.unit_kind,
                    source_texts.normalized_hash,
                    source_texts.normalized_text,
                    source_texts.visible_text,
                    source_texts.codec_text,
                    source_texts.control_code_signature,
                    source_texts.line_count,
                    source_texts.newline_count,
                    source_texts.placeholder_count
                FROM source_texts
                INNER JOIN occurrences ON occurrences.source_text_id = source_texts.id
                WHERE occurrences.project_id = ?1
                  AND occurrences.active = 1
                  AND source_texts.source_language = ?2
                ORDER BY source_texts.id
                LIMIT ?3
                ",
            )?;
            let rows = statement.query_map(params![project_id, source_language, limit], |row| {
                source_text_record_from_row(row)
            })?;
            let mut records = Vec::new();
            for row in rows {
                records.push(row?);
            }
            return Ok(records);
        }

        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                source_language,
                unit_kind,
                normalized_hash,
                normalized_text,
                visible_text,
                codec_text,
                control_code_signature,
                line_count,
                newline_count,
                placeholder_count
            FROM source_texts
            WHERE source_language = ?1
            ORDER BY id
            LIMIT ?2
            ",
        )?;
        let rows = statement.query_map(params![source_language, limit], |row| {
            source_text_record_from_row(row)
        })?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    pub fn review_issue_source_text_ids(
        &self,
        project_id: i64,
        target_language: &str,
        issue_filter: &str,
    ) -> Result<Vec<i64>> {
        let issue_clause = review_issue_filter_clause(Some(issue_filter))?;
        let sql = format!(
            "
            WITH review_rows AS (
                SELECT
                    source_texts.id AS source_text_id,
                    translations.translated_text AS translated_text,
                    COALESCE(translations.review_state, 'missing') AS review_state,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                    ) AS qa_finding_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'provider-json-parse'
                    ) AS json_parse_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'translation-validation'
                    ) AS validation_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'final-failed'
                    ) AS final_failed_count
                FROM source_texts
                INNER JOIN occurrences ON occurrences.source_text_id = source_texts.id
                LEFT JOIN translations
                    ON translations.source_text_id = source_texts.id
                   AND translations.target_language = ?2
                WHERE occurrences.project_id = ?1
                  AND occurrences.active = 1
                GROUP BY
                    source_texts.id,
                    translations.translated_text,
                    translations.review_state
            )
            SELECT source_text_id
            FROM review_rows
            WHERE {issue_clause}
            ORDER BY source_text_id
            "
        );
        let mut statement = self.conn.prepare(&sql)?;
        let rows = statement.query_map(params![project_id, target_language], |row| {
            row.get::<_, i64>(0)
        })?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    pub fn exportable_translations(
        &self,
        project_id: i64,
        target_language: &str,
        review_states: &[&str],
    ) -> Result<Vec<ExportableTranslationRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                source_texts.id,
                source_texts.source_language,
                translations.target_language,
                source_texts.unit_kind,
                source_texts.normalized_hash,
                source_texts.normalized_text,
                source_texts.visible_text,
                source_texts.codec_text,
                source_texts.control_code_signature,
                source_texts.line_count,
                source_texts.newline_count,
                source_texts.placeholder_count,
                translations.translated_text,
                translations.review_state,
                translations.qa_state
            FROM translations
            INNER JOIN source_texts ON source_texts.id = translations.source_text_id
            INNER JOIN occurrences ON occurrences.source_text_id = source_texts.id
            WHERE occurrences.project_id = ?1
              AND occurrences.active = 1
              AND translations.target_language = ?2
            GROUP BY
                source_texts.id,
                source_texts.source_language,
                translations.target_language,
                source_texts.unit_kind,
                source_texts.normalized_hash,
                source_texts.normalized_text,
                source_texts.visible_text,
                source_texts.codec_text,
                source_texts.control_code_signature,
                source_texts.line_count,
                source_texts.newline_count,
                source_texts.placeholder_count,
                translations.translated_text,
                translations.review_state,
                translations.qa_state
            ORDER BY source_texts.id
            ",
        )?;
        let rows = statement.query_map(params![project_id, target_language], |row| {
            Ok(ExportableTranslationRecord {
                source_text_id: row.get(0)?,
                source_language: row.get(1)?,
                target_language: row.get(2)?,
                unit_kind: row.get(3)?,
                normalized_hash: row.get(4)?,
                normalized_text: row.get(5)?,
                visible_text: row.get(6)?,
                codec_text: row.get(7)?,
                control_code_signature: row.get(8)?,
                line_count: row.get(9)?,
                newline_count: row.get(10)?,
                placeholder_count: row.get(11)?,
                translated_text: row.get(12)?,
                review_state: row.get(13)?,
                qa_state: row.get(14)?,
            })
        })?;

        let mut records = Vec::new();
        for row in rows {
            let record = row?;
            if review_states.contains(&record.review_state.as_str()) {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn start_provider_run(&mut self, input: &NewProviderRun) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO provider_runs (
                provider,
                model,
                request_settings_json,
                status
            )
            VALUES (?1, ?2, ?3, 'running')
            ",
            params![input.provider, input.model, input.request_settings_json],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    pub fn finish_provider_run(
        &mut self,
        provider_run_id: i64,
        status: &str,
        failure_detail: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "
            UPDATE provider_runs
            SET status = ?2,
                finished_at = CURRENT_TIMESTAMP,
                failure_detail = ?3
            WHERE id = ?1
            ",
            params![provider_run_id, status, failure_detail],
        )?;
        Ok(())
    }

    pub fn upsert_translation_job_progress(
        &mut self,
        input: &TranslationJobProgressUpdate,
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let existing_id = tx
            .query_row(
                "SELECT id FROM translation_jobs WHERE provider_run_id = ?1",
                params![input.provider_run_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let id = if let Some(id) = existing_id {
            tx.execute(
                "
                UPDATE translation_jobs
                SET project_id = ?2,
                    source_language = ?3,
                    target_language = ?4,
                    checkpoint_path = ?5,
                    status = ?6,
                    completed_items = ?7,
                    failed_items = ?8,
                    total_items = ?9,
                    processed_batches = ?10,
                    total_batches = ?11,
                    split_batches = ?12,
                    parse_failed_items = ?13,
                    validation_failed_items = ?14,
                    skipped_items = ?15,
                    censored_retry_count = ?16,
                    item_eta_ms = ?17,
                    batch_eta_ms = ?18,
                    last_batch_elapsed_ms = ?19,
                    avg_batch_elapsed_ms = ?20,
                    current_batch_items = ?21,
                    elapsed_ms = ?22,
                    retry_pending_items = ?23,
                    recoverable_provider_failures = ?24,
                    final_failed_items = ?25,
                    provider_backoff_ms = ?26,
                    effective_batch_size = ?27,
                    speed_mode = ?28,
                    success_streak = ?29,
                    success_delay_floor_ms = ?30,
                    next_delay_ms = ?31,
                    failure_reason_counts_json = ?32,
                    legacy_checkpoint_only = ?33,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?1
                ",
                params![
                    id,
                    input.project_id,
                    input.source_language,
                    input.target_language,
                    input.checkpoint_path,
                    input.status,
                    input.completed_items,
                    input.failed_items,
                    input.total_items,
                    input.processed_batches,
                    input.total_batches,
                    input.split_batches,
                    input.parse_failed_items,
                    input.validation_failed_items,
                    input.skipped_items,
                    input.censored_retry_count,
                    input.item_eta_ms,
                    input.batch_eta_ms,
                    input.last_batch_elapsed_ms,
                    input.avg_batch_elapsed_ms,
                    input.current_batch_items,
                    input.elapsed_ms,
                    input.retry_pending_items,
                    input.recoverable_provider_failures,
                    input.final_failed_items,
                    input.provider_backoff_ms,
                    input.effective_batch_size,
                    input.speed_mode,
                    input.success_streak,
                    input.success_delay_floor_ms,
                    input.next_delay_ms,
                    input.failure_reason_counts_json,
                    input.legacy_checkpoint_only
                ],
            )?;
            id
        } else {
            tx.execute(
                "
                INSERT INTO translation_jobs (
                    provider_run_id,
                    project_id,
                    source_language,
                    target_language,
                    checkpoint_path,
                    status,
                    completed_items,
                    failed_items,
                    total_items,
                    processed_batches,
                    total_batches,
                    split_batches,
                    parse_failed_items,
                    validation_failed_items,
                    skipped_items,
                    censored_retry_count,
                    item_eta_ms,
                    batch_eta_ms,
                    last_batch_elapsed_ms,
                    avg_batch_elapsed_ms,
                    current_batch_items,
                    elapsed_ms,
                    retry_pending_items,
                    recoverable_provider_failures,
                    final_failed_items,
                    provider_backoff_ms,
                    effective_batch_size,
                    speed_mode,
                    success_streak,
                    success_delay_floor_ms,
                    next_delay_ms,
                    failure_reason_counts_json,
                    legacy_checkpoint_only
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33)
                ",
                params![
                    input.provider_run_id,
                    input.project_id,
                    input.source_language,
                    input.target_language,
                    input.checkpoint_path,
                    input.status,
                    input.completed_items,
                    input.failed_items,
                    input.total_items,
                    input.processed_batches,
                    input.total_batches,
                    input.split_batches,
                    input.parse_failed_items,
                    input.validation_failed_items,
                    input.skipped_items,
                    input.censored_retry_count,
                    input.item_eta_ms,
                    input.batch_eta_ms,
                    input.last_batch_elapsed_ms,
                    input.avg_batch_elapsed_ms,
                    input.current_batch_items,
                    input.elapsed_ms,
                    input.retry_pending_items,
                    input.recoverable_provider_failures,
                    input.final_failed_items,
                    input.provider_backoff_ms,
                    input.effective_batch_size,
                    input.speed_mode,
                    input.success_streak,
                    input.success_delay_floor_ms,
                    input.next_delay_ms,
                    input.failure_reason_counts_json,
                    input.legacy_checkpoint_only
                ],
            )?;
            tx.last_insert_rowid()
        };
        tx.execute(
            "
            INSERT INTO job_events (translation_job_id, event_type, payload_json)
            VALUES (?1, ?2, ?3)
            ",
            params![id, input.status, "{}"],
        )?;
        tx.commit()?;
        Ok(id)
    }

    pub fn insert_translation_speed_sample(
        &mut self,
        input: &NewTranslationSpeedSample,
    ) -> Result<i64> {
        self.conn.execute(
            "
            INSERT INTO translation_speed_samples (
                provider_run_id,
                batch_index,
                lane,
                item_count,
                char_count,
                estimated_token_count,
                request_elapsed_ms,
                success_delay_ms,
                total_elapsed_ms,
                status,
                failure_type,
                effective_batch_size,
                model,
                prompt_hash
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ",
            params![
                input.provider_run_id,
                input.batch_index,
                input.lane,
                input.item_count,
                input.char_count,
                input.estimated_token_count,
                input.request_elapsed_ms,
                input.success_delay_ms,
                input.total_elapsed_ms,
                input.status,
                input.failure_type,
                input.effective_batch_size,
                input.model,
                input.prompt_hash
            ],
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn recent_translation_speed_samples(
        &self,
        model: Option<&str>,
        prompt_hash: Option<&str>,
        limit: i64,
    ) -> Result<Vec<TranslationSpeedSample>> {
        let limit = limit.clamp(1, 500);
        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                provider_run_id,
                batch_index,
                lane,
                item_count,
                char_count,
                estimated_token_count,
                request_elapsed_ms,
                success_delay_ms,
                total_elapsed_ms,
                status,
                failure_type,
                effective_batch_size,
                model,
                prompt_hash,
                created_at
            FROM translation_speed_samples
            WHERE (?1 IS NULL OR model = ?1)
              AND (?2 IS NULL OR prompt_hash = ?2)
            ORDER BY created_at DESC, id DESC
            LIMIT ?3
            ",
        )?;
        let rows = statement.query_map(params![model, prompt_hash, limit], |row| {
            Ok(TranslationSpeedSample {
                id: row.get(0)?,
                provider_run_id: row.get(1)?,
                batch_index: row.get(2)?,
                lane: row.get(3)?,
                item_count: row.get(4)?,
                char_count: row.get(5)?,
                estimated_token_count: row.get(6)?,
                request_elapsed_ms: row.get(7)?,
                success_delay_ms: row.get(8)?,
                total_elapsed_ms: row.get(9)?,
                status: row.get(10)?,
                failure_type: row.get(11)?,
                effective_batch_size: row.get(12)?,
                model: row.get(13)?,
                prompt_hash: row.get(14)?,
                created_at: row.get(15)?,
            })
        })?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn latest_translation_job_summary(
        &self,
        target_language: Option<&str>,
    ) -> Result<Option<TranslationJobSummary>> {
        let sql = if target_language.is_some() {
            "
            SELECT
                translation_jobs.id,
                translation_jobs.provider_run_id,
                translation_jobs.project_id,
                translation_jobs.source_language,
                translation_jobs.target_language,
                translation_jobs.checkpoint_path,
                translation_jobs.status,
                translation_jobs.completed_items,
                translation_jobs.failed_items,
                translation_jobs.total_items,
                translation_jobs.processed_batches,
                translation_jobs.total_batches,
                translation_jobs.split_batches,
                translation_jobs.parse_failed_items,
                translation_jobs.validation_failed_items,
                translation_jobs.skipped_items,
                translation_jobs.censored_retry_count,
                translation_jobs.item_eta_ms,
                translation_jobs.batch_eta_ms,
                translation_jobs.last_batch_elapsed_ms,
                translation_jobs.avg_batch_elapsed_ms,
                translation_jobs.current_batch_items,
                translation_jobs.elapsed_ms,
                translation_jobs.retry_pending_items,
                translation_jobs.recoverable_provider_failures,
                translation_jobs.final_failed_items,
                translation_jobs.provider_backoff_ms,
                translation_jobs.effective_batch_size,
                translation_jobs.speed_mode,
                translation_jobs.success_streak,
                translation_jobs.success_delay_floor_ms,
                translation_jobs.next_delay_ms,
                translation_jobs.failure_reason_counts_json,
                translation_jobs.legacy_checkpoint_only,
                provider_runs.model
            FROM translation_jobs
            LEFT JOIN provider_runs ON provider_runs.id = translation_jobs.provider_run_id
            WHERE translation_jobs.target_language = ?1
            ORDER BY translation_jobs.updated_at DESC, translation_jobs.id DESC
            LIMIT 1
            "
        } else {
            "
            SELECT
                translation_jobs.id,
                translation_jobs.provider_run_id,
                translation_jobs.project_id,
                translation_jobs.source_language,
                translation_jobs.target_language,
                translation_jobs.checkpoint_path,
                translation_jobs.status,
                translation_jobs.completed_items,
                translation_jobs.failed_items,
                translation_jobs.total_items,
                translation_jobs.processed_batches,
                translation_jobs.total_batches,
                translation_jobs.split_batches,
                translation_jobs.parse_failed_items,
                translation_jobs.validation_failed_items,
                translation_jobs.skipped_items,
                translation_jobs.censored_retry_count,
                translation_jobs.item_eta_ms,
                translation_jobs.batch_eta_ms,
                translation_jobs.last_batch_elapsed_ms,
                translation_jobs.avg_batch_elapsed_ms,
                translation_jobs.current_batch_items,
                translation_jobs.elapsed_ms,
                translation_jobs.retry_pending_items,
                translation_jobs.recoverable_provider_failures,
                translation_jobs.final_failed_items,
                translation_jobs.provider_backoff_ms,
                translation_jobs.effective_batch_size,
                translation_jobs.speed_mode,
                translation_jobs.success_streak,
                translation_jobs.success_delay_floor_ms,
                translation_jobs.next_delay_ms,
                translation_jobs.failure_reason_counts_json,
                translation_jobs.legacy_checkpoint_only,
                provider_runs.model
            FROM translation_jobs
            LEFT JOIN provider_runs ON provider_runs.id = translation_jobs.provider_run_id
            ORDER BY translation_jobs.updated_at DESC, translation_jobs.id DESC
            LIMIT 1
            "
        };
        let mut statement = self.conn.prepare(sql)?;
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(TranslationJobSummary {
                id: row.get(0)?,
                provider_run_id: row.get(1)?,
                project_id: row.get(2)?,
                source_language: row.get(3)?,
                target_language: row.get(4)?,
                checkpoint_path: row.get(5)?,
                status: row.get(6)?,
                completed_items: row.get(7)?,
                failed_items: row.get(8)?,
                total_items: row.get(9)?,
                processed_batches: row.get(10)?,
                total_batches: row.get(11)?,
                split_batches: row.get(12)?,
                parse_failed_items: row.get(13)?,
                validation_failed_items: row.get(14)?,
                skipped_items: row.get(15)?,
                censored_retry_count: row.get(16)?,
                item_eta_ms: row.get(17)?,
                batch_eta_ms: row.get(18)?,
                last_batch_elapsed_ms: row.get(19)?,
                avg_batch_elapsed_ms: row.get(20)?,
                current_batch_items: row.get(21)?,
                elapsed_ms: row.get(22)?,
                retry_pending_items: row.get(23)?,
                recoverable_provider_failures: row.get(24)?,
                final_failed_items: row.get(25)?,
                provider_backoff_ms: row.get(26)?,
                effective_batch_size: row.get(27)?,
                speed_mode: row.get(28)?,
                success_streak: row.get(29)?,
                success_delay_floor_ms: row.get(30)?,
                next_delay_ms: row.get(31)?,
                failure_reason_counts_json: row.get(32)?,
                legacy_checkpoint_only: row.get(33)?,
                model: row.get(34)?,
            })
        };
        if let Some(target_language) = target_language {
            Ok(statement
                .query_row(params![target_language], map_row)
                .optional()?)
        } else {
            Ok(statement.query_row([], map_row).optional()?)
        }
    }

    pub fn count_running_provider_runs(&self) -> Result<i64> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM provider_runs WHERE status = 'running'",
            [],
            |row| row.get(0),
        )?)
    }

    pub fn foreign_key_violation_count(&self) -> Result<i64> {
        let mut statement = self.conn.prepare("PRAGMA foreign_key_check")?;
        let mut rows = statement.query([])?;
        let mut count = 0i64;
        while rows.next()?.is_some() {
            count += 1;
        }
        Ok(count)
    }

    pub fn insert_qa_finding(&mut self, input: &NewQaFinding) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let id = insert_qa_finding_tx(&tx, input)?;
        tx.commit()?;
        Ok(id)
    }

    pub fn resolve_open_qa_findings_for_sources(
        &mut self,
        source_text_ids: &[i64],
        target_language: &str,
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        let mut changed = 0i64;
        for source_text_id in source_text_ids {
            let count = tx.execute(
                "
                UPDATE qa_findings
                SET status = 'resolved',
                    resolved_at = CURRENT_TIMESTAMP
                WHERE source_text_id = ?1
                  AND (target_language IS NULL OR target_language = ?2)
                  AND status = 'open'
                ",
                params![source_text_id, target_language],
            )?;
            changed += i64::try_from(count).unwrap_or(i64::MAX);
        }
        tx.commit()?;
        Ok(changed)
    }

    pub fn qa_findings_for_source(&self, source_text_id: i64) -> Result<Vec<QaFindingRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                source_text_id,
                translation_id,
                target_language,
                provider_run_id,
                finding_type,
                severity,
                message,
                status,
                resolved_at,
                details_json
            FROM qa_findings
            WHERE source_text_id = ?1
            ORDER BY id
            ",
        )?;
        let rows = statement.query_map(params![source_text_id], |row| {
            Ok(QaFindingRecord {
                id: row.get(0)?,
                source_text_id: row.get(1)?,
                translation_id: row.get(2)?,
                target_language: row.get(3)?,
                provider_run_id: row.get(4)?,
                finding_type: row.get(5)?,
                severity: row.get(6)?,
                message: row.get(7)?,
                status: row.get(8)?,
                resolved_at: row.get(9)?,
                details_json: row.get(10)?,
            })
        })?;

        let mut findings = Vec::new();
        for row in rows {
            findings.push(row?);
        }
        Ok(findings)
    }

    fn open_qa_findings_for_source_target(
        &self,
        source_text_id: i64,
        target_language: &str,
    ) -> Result<Vec<QaFindingRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                source_text_id,
                translation_id,
                target_language,
                provider_run_id,
                finding_type,
                severity,
                message,
                status,
                resolved_at,
                details_json
            FROM qa_findings
            WHERE source_text_id = ?1
              AND (target_language IS NULL OR target_language = ?2)
              AND status = 'open'
            ORDER BY id
            ",
        )?;
        let rows = statement.query_map(params![source_text_id, target_language], |row| {
            Ok(QaFindingRecord {
                id: row.get(0)?,
                source_text_id: row.get(1)?,
                translation_id: row.get(2)?,
                target_language: row.get(3)?,
                provider_run_id: row.get(4)?,
                finding_type: row.get(5)?,
                severity: row.get(6)?,
                message: row.get(7)?,
                status: row.get(8)?,
                resolved_at: row.get(9)?,
                details_json: row.get(10)?,
            })
        })?;

        let mut findings = Vec::new();
        for row in rows {
            findings.push(row?);
        }
        Ok(findings)
    }

    pub fn qa_finding_count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM qa_findings", [], |row| row.get(0))?)
    }

    pub fn record_export(
        &mut self,
        project_id: i64,
        target_language: &str,
        export_path: &str,
        manifest_hash: &str,
        included_count: i64,
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO exports (
                project_id,
                target_language,
                export_path,
                manifest_hash,
                included_count
            )
            VALUES (?1, ?2, ?3, ?4, ?5)
            ",
            params![
                project_id,
                target_language,
                export_path,
                manifest_hash,
                included_count
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    pub fn export_count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM exports", [], |row| row.get(0))?)
    }

    pub fn last_export_included_count(&self) -> Result<Option<i64>> {
        Ok(self
            .conn
            .query_row(
                "
                SELECT included_count
                FROM exports
                ORDER BY id DESC
                LIMIT 1
                ",
                [],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn translation_count_for_target(&self, target_language: &str) -> Result<i64> {
        Ok(self.conn.query_row(
            "
            SELECT COUNT(*)
            FROM translations
            WHERE target_language = ?1
            ",
            params![target_language],
            |row| row.get(0),
        )?)
    }

    pub fn record_install(&mut self, input: &NewInstallRecord) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO installs (
                project_id,
                game_root,
                export_id,
                backup_manifest_path,
                status
            )
            VALUES (?1, ?2, ?3, ?4, ?5)
            ",
            params![
                input.project_id,
                input.game_root,
                input.export_id,
                input.backup_manifest_path,
                input.status
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    pub fn update_install_status(&mut self, install_id: i64, status: &str) -> Result<()> {
        self.conn.execute(
            "
            UPDATE installs
            SET status = ?2
            WHERE id = ?1
            ",
            params![install_id, status],
        )?;
        Ok(())
    }

    pub fn get_install_record(&self, install_id: i64) -> Result<Option<InstallRecord>> {
        Ok(self
            .conn
            .query_row(
                "
                SELECT
                    id,
                    project_id,
                    game_root,
                    export_id,
                    backup_manifest_path,
                    status
                FROM installs
                WHERE id = ?1
                ",
                params![install_id],
                |row| {
                    Ok(InstallRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        game_root: row.get(2)?,
                        export_id: row.get(3)?,
                        backup_manifest_path: row.get(4)?,
                        status: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn load_workbench_settings(&self) -> Result<WorkbenchSettingsRecord> {
        Ok(WorkbenchSettingsRecord {
            selected_project_id: self
                .get_app_setting("selected_project_id")?
                .and_then(|value| value.parse::<i64>().ok()),
            source_language: self
                .get_app_setting("source_language")?
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "en".to_string()),
            target_language: self
                .get_app_setting("target_language")?
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "ko".to_string()),
            provider_base_url: self
                .get_app_setting("provider_base_url")?
                .unwrap_or_default(),
            provider_model: self
                .get_app_setting("provider_model")?
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "auto".to_string()),
            system_prompt: self.get_app_setting("system_prompt")?.unwrap_or_default(),
            export_dir: self.get_app_setting("export_dir")?.unwrap_or_default(),
            active_tab: self
                .get_app_setting("active_tab")?
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "review".to_string()),
            show_hover_help: self
                .get_app_setting("show_hover_help")?
                .map(|value| value != "0" && !value.eq_ignore_ascii_case("false"))
                .unwrap_or(true),
            ui_font_size: normalize_ui_font_size(self.get_app_setting("ui_font_size")?.as_deref())
                .to_string(),
        })
    }

    pub fn save_workbench_settings(&mut self, update: &WorkbenchSettingsUpdate) -> Result<()> {
        let tx = self.conn.transaction()?;
        if let Some(selected_project_id) = update.selected_project_id {
            match selected_project_id {
                Some(project_id) => {
                    set_app_setting_tx(&tx, "selected_project_id", &project_id.to_string())?
                }
                None => delete_app_setting_tx(&tx, "selected_project_id")?,
            }
        }
        if let Some(value) = update.source_language.as_deref() {
            set_app_setting_tx(&tx, "source_language", value)?;
        }
        if let Some(value) = update.target_language.as_deref() {
            set_app_setting_tx(&tx, "target_language", value)?;
        }
        if let Some(value) = update.provider_base_url.as_deref() {
            set_app_setting_tx(&tx, "provider_base_url", value)?;
        }
        if let Some(value) = update.provider_model.as_deref() {
            set_app_setting_tx(&tx, "provider_model", value)?;
        }
        if let Some(value) = update.system_prompt.as_deref() {
            set_app_setting_tx(&tx, "system_prompt", value)?;
        }
        if let Some(value) = update.export_dir.as_deref() {
            set_app_setting_tx(&tx, "export_dir", value)?;
        }
        if let Some(value) = update.active_tab.as_deref() {
            set_app_setting_tx(&tx, "active_tab", value)?;
        }
        if let Some(value) = update.show_hover_help {
            set_app_setting_tx(&tx, "show_hover_help", if value { "1" } else { "0" })?;
        }
        if let Some(value) = update.ui_font_size.as_deref() {
            set_app_setting_tx(&tx, "ui_font_size", normalize_ui_font_size(Some(value)))?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_app_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn pragma_string(&self, pragma: &str) -> Result<String> {
        if !pragma
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return Err(crate::Error::invalid_input("invalid pragma name"));
        }
        Ok(self
            .conn
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))?)
    }

    pub fn pragma_i64(&self, pragma: &str) -> Result<i64> {
        if !pragma
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            return Err(crate::Error::invalid_input("invalid pragma name"));
        }
        Ok(self
            .conn
            .query_row(&format!("PRAGMA {pragma}"), [], |row| row.get(0))?)
    }

    pub fn interrupt_stale_provider_runs(&mut self) -> Result<i64> {
        let changed = self.conn.execute(
            "
            UPDATE provider_runs
            SET status = 'interrupted',
                finished_at = CURRENT_TIMESTAMP,
                failure_detail = COALESCE(failure_detail, 'interrupted during app restart')
            WHERE status = 'running'
            ",
            [],
        )?;
        Ok(i64::try_from(changed).unwrap_or(i64::MAX))
    }

    pub fn interrupt_stale_translation_jobs(&mut self) -> Result<i64> {
        let changed = self.conn.execute(
            "
            UPDATE translation_jobs
            SET status = CASE
                    WHEN processed_batches >= total_batches
                         AND total_batches > 0
                         AND (failed_items > 0 OR final_failed_items > 0 OR parse_failed_items > 0 OR validation_failed_items > 0)
                        THEN 'completed_with_failures'
                    ELSE 'interrupted'
                END,
                provider_backoff_ms = NULL,
                next_delay_ms = NULL,
                speed_mode = CASE
                    WHEN processed_batches >= total_batches
                         AND total_batches > 0
                         AND (failed_items > 0 OR final_failed_items > 0 OR parse_failed_items > 0 OR validation_failed_items > 0)
                        THEN 'steady'
                    ELSE 'interrupted'
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE status = 'running'
            ",
            [],
        )?;
        Ok(i64::try_from(changed).unwrap_or(i64::MAX))
    }

    pub fn review_counts(&self, project_id: i64, target_language: &str) -> Result<ReviewCounts> {
        Ok(ReviewCounts {
            all: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE ?3 IS NULL",
                None,
            )?,
            missing: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state = 'missing' AND ?3 IS NULL",
                None,
            )?,
            pending: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state = 'pending' AND ?3 IS NULL",
                None,
            )?,
            accepted: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state = 'accepted' AND ?3 IS NULL",
                None,
            )?,
            reviewed: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state = 'reviewed' AND ?3 IS NULL",
                None,
            )?,
            attention: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state = 'attention' AND ?3 IS NULL",
                None,
            )?,
            exportable: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state IN ('accepted', 'reviewed') AND ?3 IS NULL",
                None,
            )?,
            open_issues: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE qa_finding_count > 0 AND ?3 IS NULL",
                None,
            )?,
            json_parse: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE json_parse_count > 0 AND ?3 IS NULL",
                None,
            )?,
            validation: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE validation_count > 0 AND ?3 IS NULL",
                None,
            )?,
            final_failed: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE final_failed_count > 0 AND ?3 IS NULL",
                None,
            )?,
            clean_approvable: self.review_queue_total_count(
                project_id,
                target_language,
                "WHERE review_state = 'pending' AND translated_text <> '' AND qa_finding_count = 0 AND ?3 IS NULL",
                None,
            )?,
        })
    }

    fn count_project_source_texts(&self, project_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "
            SELECT COUNT(DISTINCT source_text_id)
            FROM occurrences
            WHERE project_id = ?1
              AND active = 1
            ",
            params![project_id],
            |row| row.get(0),
        )?)
    }

    fn count_project_occurrences(&self, project_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "
            SELECT COUNT(*)
            FROM occurrences
            WHERE project_id = ?1
              AND active = 1
            ",
            params![project_id],
            |row| row.get(0),
        )?)
    }

    fn count_project_translations(
        &self,
        project_id: i64,
        target_language: &str,
        review_state: Option<&str>,
    ) -> Result<i64> {
        let mut count = 0;
        let mut statement = self.conn.prepare(
            "
            SELECT DISTINCT translations.source_text_id, translations.review_state
            FROM translations
            INNER JOIN occurrences ON occurrences.source_text_id = translations.source_text_id
            WHERE occurrences.project_id = ?1
              AND occurrences.active = 1
              AND translations.target_language = ?2
            ",
        )?;
        let rows = statement.query_map(params![project_id, target_language], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (_, state) = row?;
            if review_state.is_none_or(|expected| state == expected) {
                count += 1;
            }
        }
        Ok(count)
    }

    fn review_queue_total_count(
        &self,
        project_id: i64,
        target_language: &str,
        filter_clause: &str,
        review_state_filter: Option<&str>,
    ) -> Result<i64> {
        let sql = format!(
            "
            WITH review_rows AS (
                SELECT
                    source_texts.id AS source_text_id,
                    translations.translated_text AS translated_text,
                    COALESCE(translations.review_state, 'missing') AS review_state,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                    ) AS qa_finding_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'provider-json-parse'
                    ) AS json_parse_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'translation-validation'
                    ) AS validation_count,
                    (
                        SELECT COUNT(*)
                        FROM qa_findings
                        WHERE qa_findings.source_text_id = source_texts.id
                          AND (qa_findings.target_language IS NULL OR qa_findings.target_language = ?2)
                          AND qa_findings.status = 'open'
                          AND qa_findings.finding_type = 'final-failed'
                    ) AS final_failed_count
                FROM source_texts
                INNER JOIN occurrences ON occurrences.source_text_id = source_texts.id
                LEFT JOIN translations
                    ON translations.source_text_id = source_texts.id
                   AND translations.target_language = ?2
                WHERE occurrences.project_id = ?1
                  AND occurrences.active = 1
                GROUP BY
                    source_texts.id,
                    translations.translated_text,
                    translations.review_state
            )
            SELECT COUNT(*)
            FROM review_rows
            {filter_clause}
            "
        );
        Ok(self.conn.query_row(
            &sql,
            params![project_id, target_language, review_state_filter],
            |row| row.get(0),
        )?)
    }

    fn count_project_review_queue(&self, project_id: i64, target_language: &str) -> Result<i64> {
        self.review_queue_total_count(
            project_id,
            target_language,
            "WHERE review_state NOT IN ('accepted', 'reviewed') AND ?3 IS NULL",
            None,
        )
    }

    fn count_project_qa_findings(&self, project_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "
            SELECT COUNT(*)
            FROM qa_findings
            WHERE source_text_id IN (
                SELECT DISTINCT source_text_id
                FROM occurrences
                WHERE project_id = ?1
                  AND active = 1
            )
            ",
            params![project_id],
            |row| row.get(0),
        )?)
    }

    fn latest_export_status(&self, project_id: i64) -> Result<Option<ExportStatusRecord>> {
        Ok(self
            .conn
            .query_row(
                "
                SELECT id, project_id, target_language, export_path, manifest_hash, included_count
                FROM exports
                WHERE project_id = ?1
                ORDER BY id DESC
                LIMIT 1
                ",
                params![project_id],
                |row| {
                    Ok(ExportStatusRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        target_language: row.get(2)?,
                        export_path: row.get(3)?,
                        manifest_hash: row.get(4)?,
                        included_count: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    fn latest_install_status(&self, project_id: i64) -> Result<Option<InstallStatusRecord>> {
        Ok(self
            .conn
            .query_row(
                "
                SELECT id, project_id, game_root, export_id, backup_manifest_path, status
                FROM installs
                WHERE project_id = ?1
                ORDER BY id DESC
                LIMIT 1
                ",
                params![project_id],
                |row| {
                    Ok(InstallStatusRecord {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        game_root: row.get(2)?,
                        export_id: row.get(3)?,
                        backup_manifest_path: row.get(4)?,
                        status: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    fn latest_provider_run_status(&self) -> Result<Option<ProviderRunStatusRecord>> {
        Ok(self
            .conn
            .query_row(
                "
                SELECT id, provider, model, status, failure_detail
                FROM provider_runs
                ORDER BY id DESC
                LIMIT 1
                ",
                [],
                |row| {
                    Ok(ProviderRunStatusRecord {
                        id: row.get(0)?,
                        provider: row.get(1)?,
                        model: row.get(2)?,
                        status: row.get(3)?,
                        failure_detail: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn source_text_count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM source_texts", [], |row| row.get(0))?)
    }

    pub fn occurrence_count(&self) -> Result<i64> {
        Ok(self
            .conn
            .query_row("SELECT COUNT(*) FROM occurrences", [], |row| row.get(0))?)
    }

    pub fn occurrence_segments_for_source_text(
        &self,
        project_id: i64,
        normalized_text: &str,
    ) -> Result<Vec<OccurrenceSegment>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                occurrence_segments.segment_index,
                occurrence_segments.command_code,
                occurrence_segments.json_path,
                occurrence_segments.raw_text,
                occurrence_segments.line_index
            FROM occurrence_segments
            INNER JOIN occurrences ON occurrences.id = occurrence_segments.occurrence_id
            INNER JOIN source_texts ON source_texts.id = occurrences.source_text_id
            WHERE occurrences.project_id = ?1
              AND source_texts.normalized_text = ?2
            ORDER BY occurrence_segments.segment_index
            ",
        )?;
        let rows = statement.query_map(params![project_id, normalized_text], |row| {
            Ok(OccurrenceSegment {
                segment_index: row.get(0)?,
                command_code: row.get(1)?,
                json_path: row.get(2)?,
                raw_text: row.get(3)?,
                line_index: row.get(4)?,
            })
        })?;
        let mut segments = Vec::new();
        for row in rows {
            segments.push(row?);
        }
        Ok(segments)
    }
}

fn review_issue_filter_clause(issue_filter: Option<&str>) -> Result<&'static str> {
    Ok(match issue_filter {
        None | Some("all") => "1 = 1",
        Some("open") => "qa_finding_count > 0",
        Some("json_parse") => "json_parse_count > 0",
        Some("validation") => "validation_count > 0",
        Some("final_failed") => "final_failed_count > 0",
        Some("clean") => {
            "translated_text IS NOT NULL AND translated_text <> '' AND qa_finding_count = 0"
        }
        Some(other) => {
            return Err(crate::Error::invalid_input(format!(
                "unknown review issue filter {other}"
            )));
        }
    })
}

fn issue_badges_for_findings(findings: &[QaFindingRecord]) -> Vec<String> {
    let mut badges = Vec::new();
    for finding in findings {
        let badge = match finding.finding_type.as_str() {
            "provider-json-parse" => "json-parse",
            "batch-validation" if finding.message.contains("provider output") => "json-parse",
            "translation-validation" | "batch-validation" => "validation",
            "final-failed" | "censored-output" => "final-failed",
            "recoverable-provider" => "retry-pending",
            "manual-attention" => "manual-attention",
            _ => "issue",
        };
        if !badges.iter().any(|existing| existing == badge) {
            badges.push(badge.to_string());
        }
    }
    badges
}

fn review_translation_validation_messages_tx(
    tx: &Transaction<'_>,
    source_text_id: i64,
    translated_text: &str,
) -> Result<Vec<String>> {
    if translated_text.trim().is_empty() {
        return Ok(vec!["번역문이 비어 있습니다.".to_string()]);
    }
    let (source_normalized, source_signature): (String, String) = tx.query_row(
        "
        SELECT normalized_text, control_code_signature
        FROM source_texts
        WHERE id = ?1
        ",
        params![source_text_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let translated = TextCodec::analyze(translated_text);
    let mut messages = Vec::new();
    if translated.control_code_signature != source_signature {
        messages.push(format!(
            "제어코드가 원문과 다릅니다. 원문 문법 포함 `{source_normalized}`, 번역 `{}`. 원문 제어코드 `{source_signature}`, 번역 제어코드 `{}`",
            translated.normalized_text,
            translated.control_code_signature
        ));
    }
    let source_line_breaks = source_normalized.matches('\n').count();
    let translated_line_breaks = translated.normalized_text.matches('\n').count();
    if source_line_breaks != translated_line_breaks {
        messages.push(format!(
            "줄바꿈 수가 원문과 다릅니다. 원문 {source_line_breaks}개, 번역 {translated_line_breaks}개"
        ));
    }
    Ok(messages)
}

fn insert_qa_finding_tx(tx: &Transaction<'_>, input: &NewQaFinding) -> Result<i64> {
    tx.execute(
        "
        INSERT INTO qa_findings (
            source_text_id,
            translation_id,
            target_language,
            provider_run_id,
            finding_type,
            severity,
            message,
            status,
            details_json
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ",
        params![
            input.source_text_id,
            input.translation_id,
            input.target_language,
            input.provider_run_id,
            input.finding_type,
            input.severity,
            input.message,
            input.status,
            input.details_json
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

fn upsert_translation_tx(tx: &Transaction<'_>, input: &NewTranslation) -> Result<i64> {
    tx.execute(
        "
        INSERT INTO translations (
            source_text_id,
            target_language,
            translated_text,
            provider,
            model,
            provider_run_id,
            review_state,
            qa_state
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(source_text_id, target_language)
        DO UPDATE SET
            translated_text = excluded.translated_text,
            provider = excluded.provider,
            model = excluded.model,
            provider_run_id = excluded.provider_run_id,
            review_state = excluded.review_state,
            qa_state = excluded.qa_state,
            updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') || ':' || lower(hex(randomblob(4)))
        ",
        params![
            input.source_text_id,
            input.target_language,
            input.translated_text,
            input.provider,
            input.model,
            input.provider_run_id,
            input.review_state,
            input.qa_state
        ],
    )?;
    Ok(tx.query_row(
        "
        SELECT id FROM translations
        WHERE source_text_id = ?1
          AND target_language = ?2
        ",
        params![input.source_text_id, input.target_language],
        |row| row.get(0),
    )?)
}

fn set_app_setting_tx(tx: &Transaction<'_>, key: &str, value: &str) -> Result<()> {
    tx.execute(
        "
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?1, ?2, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = CURRENT_TIMESTAMP
        ",
        params![key, value],
    )?;
    Ok(())
}

fn delete_app_setting_tx(tx: &Transaction<'_>, key: &str) -> Result<()> {
    tx.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    Ok(())
}

fn normalize_ui_font_size(value: Option<&str>) -> &'static str {
    match value.map(str::trim) {
        Some("small") => "small",
        Some("large") => "large",
        _ => "medium",
    }
}

fn merge_project_rows(tx: &Transaction<'_>, duplicate_id: i64, survivor_id: i64) -> Result<()> {
    tx.execute(
        "
        DELETE FROM game_snapshots
        WHERE project_id = ?1
          AND EXISTS (
              SELECT 1
              FROM game_snapshots survivor
              WHERE survivor.project_id = ?2
                AND survivor.snapshot_hash = game_snapshots.snapshot_hash
          )
        ",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "UPDATE game_snapshots SET project_id = ?2 WHERE project_id = ?1",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "UPDATE occurrences SET project_id = ?2 WHERE project_id = ?1",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "UPDATE exports SET project_id = ?2 WHERE project_id = ?1",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "UPDATE installs SET project_id = ?2 WHERE project_id = ?1",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "UPDATE translation_jobs SET project_id = ?2 WHERE project_id = ?1",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "
        INSERT OR IGNORE INTO project_settings (project_id, key, value, updated_at)
        SELECT ?2, key, value, updated_at
        FROM project_settings
        WHERE project_id = ?1
        ",
        params![duplicate_id, survivor_id],
    )?;
    tx.execute(
        "DELETE FROM project_settings WHERE project_id = ?1",
        params![duplicate_id],
    )?;
    tx.execute(
        "
        UPDATE app_settings
        SET value = ?2,
            updated_at = CURRENT_TIMESTAMP
        WHERE key = 'selected_project_id'
          AND value = ?1
        ",
        params![duplicate_id.to_string(), survivor_id.to_string()],
    )?;
    tx.execute("DELETE FROM projects WHERE id = ?1", params![duplicate_id])?;
    Ok(())
}

fn active_project_source_text_ids_tx(
    tx: &Transaction<'_>,
    project_id: i64,
) -> Result<BTreeSet<i64>> {
    let mut statement = tx.prepare(
        "
        SELECT DISTINCT source_text_id
        FROM occurrences
        WHERE project_id = ?1
          AND active = 1
        ",
    )?;
    let rows = statement.query_map(params![project_id], |row| row.get::<_, i64>(0))?;
    let mut ids = BTreeSet::new();
    for row in rows {
        ids.insert(row?);
    }
    Ok(ids)
}

fn source_text_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SourceTextRecord> {
    Ok(SourceTextRecord {
        id: row.get(0)?,
        source_language: row.get(1)?,
        unit_kind: row.get(2)?,
        normalized_hash: row.get(3)?,
        normalized_text: row.get(4)?,
        visible_text: row.get(5)?,
        codec_text: row.get(6)?,
        control_code_signature: row.get(7)?,
        line_count: row.get(8)?,
        newline_count: row.get(9)?,
        placeholder_count: row.get(10)?,
    })
}

fn active_project_occurrence_identity_ids_tx(
    tx: &Transaction<'_>,
    project_id: i64,
) -> Result<BTreeMap<String, i64>> {
    let mut statement = tx.prepare(
        "
        SELECT occurrence_identity, id
        FROM occurrences
        WHERE project_id = ?1
          AND active = 1
          AND occurrence_identity <> ''
        ",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut identities = BTreeMap::new();
    for row in rows {
        let (identity, id) = row?;
        identities.entry(identity).or_insert(id);
    }
    Ok(identities)
}

fn source_text_key(input: &NewSourceText) -> (String, String, String) {
    (
        input.source_language.clone(),
        input.unit_kind.clone(),
        source_text_hash(input),
    )
}

fn source_text_hash(input: &NewSourceText) -> String {
    if input.normalized_hash.len() == 64
        && input
            .normalized_hash
            .chars()
            .all(|ch| ch.is_ascii_hexdigit())
    {
        return input.normalized_hash.clone();
    }
    let mut hasher = Sha256::new();
    for (name, value) in [
        ("source_language", input.source_language.as_str()),
        ("unit_kind", input.unit_kind.as_str()),
        ("normalized_text", input.normalized_text.as_str()),
        (
            "control_code_signature",
            input.control_code_signature.as_str(),
        ),
    ] {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(value.len().to_string().as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0xff]);
    }
    hex::encode(hasher.finalize())
}

fn occurrence_identity_from_new(input: &NewOccurrence) -> String {
    let context = OccurrenceContext {
        file_path: input.file_path.clone(),
        json_path: input.json_path.clone(),
        entity_type: input.entity_type.clone(),
        event_id: input.event_id,
        page_index: input.page_index,
        command_index: input.command_index,
        command_code: input.command_code,
        parameter_index: input.parameter_index,
        object_key: input.object_key.clone(),
        extraction_rule_id: input.extraction_rule_id.clone(),
    };
    occurrence_identity_from_context(&context)
}

fn occurrence_identity_from_context(context: &OccurrenceContext) -> String {
    [
        "v1".to_string(),
        escape_identity_part(&context.file_path),
        escape_identity_part(&context.json_path),
        escape_identity_part(&context.entity_type),
        option_i64_identity(context.event_id),
        option_i64_identity(context.page_index),
        option_i64_identity(context.command_index),
        option_i64_identity(context.command_code),
        option_i64_identity(context.parameter_index),
        context
            .object_key
            .as_ref()
            .map_or_else(|| "-".to_string(), |value| escape_identity_part(value)),
        escape_identity_part(&context.extraction_rule_id),
    ]
    .join("\u{1f}")
}

fn option_i64_identity(value: Option<i64>) -> String {
    value.map_or_else(|| "-".to_string(), |value| value.to_string())
}

fn escape_identity_part(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('\u{1f}', "\\u001f")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
}

fn canonical_project_path_key(path: &str) -> String {
    normalize_project_path_for_storage(path)
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn normalize_project_path_for_storage(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_file_url = strip_file_url_prefix(trimmed);
    let slash_path = without_file_url.replace('\\', "/");
    let lower = slash_path.to_ascii_lowercase();
    if let Some(rest) = strip_prefix_by_lower(&slash_path, &lower, "///?/unc/")
        .or_else(|| strip_prefix_by_lower(&slash_path, &lower, "//?/unc/"))
    {
        return format!("\\\\{}", rest.replace('/', "\\"));
    }
    if let Some(rest) = strip_prefix_by_lower(&slash_path, &lower, "///?/")
        .or_else(|| strip_prefix_by_lower(&slash_path, &lower, "//?/"))
    {
        return normalize_drive_path(rest);
    }
    if let Some(rest) = strip_prefix_by_lower(&slash_path, &lower, "/mnt/") {
        let mut chars = rest.chars();
        let Some(drive) = chars.next() else {
            return slash_path;
        };
        if drive.is_ascii_alphabetic() && chars.next() == Some('/') {
            let remainder = chars.collect::<String>().replace('/', "\\");
            return format!("{}:\\{}", drive.to_ascii_uppercase(), remainder);
        }
    }
    normalize_drive_path(&slash_path)
}

fn strip_file_url_prefix(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    strip_prefix_by_lower(value, &lower, "file:///")
        .or_else(|| strip_prefix_by_lower(value, &lower, "file://"))
        .unwrap_or(value)
}

fn strip_prefix_by_lower<'a>(original: &'a str, lower: &str, prefix: &str) -> Option<&'a str> {
    lower.starts_with(prefix).then(|| &original[prefix.len()..])
}

fn normalize_drive_path(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

fn required_index_names() -> &'static [&'static str] {
    &[
        "idx_occurrences_project_identity_unique",
        "idx_source_texts_language_kind_hash_unique",
        "idx_occurrences_project_active_source",
        "idx_occurrences_source_project_active",
        "idx_occurrence_segments_occurrence_order",
        "idx_translations_target_review_qa_source",
        "idx_qa_findings_source_target_status_type",
        "idx_exports_project_latest",
        "idx_installs_project_latest",
        "idx_translation_jobs_target_latest",
    ]
}

fn schema_backup_path(db_path: &Path) -> Result<PathBuf> {
    let parent = db_path.parent().unwrap_or_else(|| Path::new("."));
    let artifact_root = if parent.file_name().and_then(|value| value.to_str()) == Some("db") {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    let backup_dir = artifact_root.join("backups");
    std::fs::create_dir_all(&backup_dir).map_err(|error| {
        crate::Error::invalid_input(format!(
            "failed to create schema backup directory {}: {error}",
            backup_dir.display()
        ))
    })?;
    let stem = db_path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("workbench");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            crate::Error::invalid_input(format!("system clock before epoch: {error}"))
        })?
        .as_nanos();
    let mut counter = 0u32;
    loop {
        let suffix = if counter == 0 {
            String::new()
        } else {
            format!("-{counter}")
        };
        let candidate =
            backup_dir.join(format!("schema-upgrade-{timestamp}-{stem}{suffix}.sqlite"));
        if !candidate.exists() {
            return Ok(candidate);
        }
        counter += 1;
    }
}

fn verify_database_file(path: &Path) -> Result<()> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    let quick_check: String = conn.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if quick_check != "ok" {
        return Err(crate::Error::invalid_input(format!(
            "database backup quick_check failed for {}: {quick_check}",
            path.display()
        )));
    }
    let mut statement = conn.prepare("PRAGMA foreign_key_check")?;
    let mut rows = statement.query([])?;
    if rows.next()?.is_some() {
        return Err(crate::Error::invalid_input(format!(
            "database backup has foreign key violations: {}",
            path.display()
        )));
    }
    Ok(())
}

fn configure_connection(conn: &Connection, file_db: bool) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA foreign_keys = ON;
        PRAGMA busy_timeout = 10000;
        ",
    )?;
    if file_db {
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            ",
        )?;
    }
    Ok(())
}
