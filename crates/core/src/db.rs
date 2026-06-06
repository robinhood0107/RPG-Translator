use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    Engine, ExportStatusRecord, ExportableTranslationRecord, GameSnapshotRecord, InstallRecord,
    InstallStatusRecord, NewInstallRecord, NewOccurrence, NewProject, NewProviderRun, NewQaFinding,
    NewSourceText, NewTranslation, ProjectRecord, ProviderRunStatusRecord, QaFindingRecord, Result,
    ReviewQueueRow, SourceTextRecord, TranslationRecord, WorkbenchDashboardSummary,
};

pub struct TranslationDb {
    conn: Connection,
}

impl TranslationDb {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let conn = Connection::open(path)?;
        enable_foreign_keys(&conn)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        enable_foreign_keys(&conn)?;
        Ok(Self { conn })
    }

    pub fn migrate(&mut self) -> Result<()> {
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
                normalized_text TEXT NOT NULL,
                visible_text TEXT NOT NULL,
                control_code_signature TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(source_language, normalized_text, control_code_signature)
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
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS translations (
                id INTEGER PRIMARY KEY,
                source_text_id INTEGER NOT NULL REFERENCES source_texts(id) ON DELETE CASCADE,
                target_language TEXT NOT NULL,
                translated_text TEXT NOT NULL,
                provider TEXT NOT NULL,
                model TEXT,
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
                finding_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                message TEXT NOT NULL,
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

            PRAGMA user_version = 1;
            ",
        )?;
        self.ensure_exports_included_count_column()?;
        self.ensure_installs_export_id_column()?;
        self.ensure_occurrences_project_id_column()?;
        Ok(())
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
        let mut statement = self.conn.prepare("PRAGMA table_info(occurrences)")?;
        let columns = statement.query_map([], |row| row.get::<_, String>(1))?;
        let mut has_project_id = false;
        for column in columns {
            if column? == "project_id" {
                has_project_id = true;
                break;
            }
        }
        if !has_project_id {
            self.conn.execute(
                "ALTER TABLE occurrences ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE",
                [],
            )?;
        }
        Ok(())
    }

    pub fn upsert_project(&mut self, input: &NewProject) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO projects (game_root, display_name, engine)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(game_root) DO UPDATE SET
                display_name = excluded.display_name,
                engine = excluded.engine,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![input.game_root, input.display_name, input.engine.as_key()],
        )?;
        let id = tx.query_row(
            "SELECT id FROM projects WHERE game_root = ?1",
            params![input.game_root],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(id)
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
        tx.execute(
            "
            INSERT INTO source_texts (
                source_language,
                normalized_text,
                visible_text,
                control_code_signature
            )
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(source_language, normalized_text, control_code_signature)
            DO UPDATE SET
                visible_text = excluded.visible_text,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![
                input.source_language,
                input.normalized_text,
                input.visible_text,
                input.control_code_signature
            ],
        )?;
        let id = tx.query_row(
            "
            SELECT id FROM source_texts
            WHERE source_language = ?1
              AND normalized_text = ?2
              AND control_code_signature = ?3
            ",
            params![
                input.source_language,
                input.normalized_text,
                input.control_code_signature
            ],
            |row| row.get(0),
        )?;
        tx.commit()?;
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
                extraction_rule_id
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                input.extraction_rule_id
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
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
                translations.qa_state
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
                qa_finding_count: row.get(14)?,
            })
        })?;
        let mut records = Vec::new();
        for row in rows {
            let record = row?;
            if review_state_filter.is_none_or(|filter| record.review_state == filter) {
                records.push(record);
            }
        }
        Ok(records)
    }

    pub fn upsert_translation(&mut self, input: &NewTranslation) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO translations (
                source_text_id,
                target_language,
                translated_text,
                provider,
                model,
                review_state,
                qa_state
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(source_text_id, target_language)
            DO UPDATE SET
                translated_text = excluded.translated_text,
                provider = excluded.provider,
                model = excluded.model,
                review_state = excluded.review_state,
                qa_state = excluded.qa_state,
                updated_at = CURRENT_TIMESTAMP
            ",
            params![
                input.source_text_id,
                input.target_language,
                input.translated_text,
                input.provider,
                input.model,
                input.review_state,
                input.qa_state
            ],
        )?;
        let id = tx.query_row(
            "
            SELECT id FROM translations
            WHERE source_text_id = ?1
              AND target_language = ?2
            ",
            params![input.source_text_id, input.target_language],
            |row| row.get(0),
        )?;
        tx.commit()?;
        Ok(id)
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
                        review_state: row.get(6)?,
                        qa_state: row.get(7)?,
                    })
                },
            )
            .optional()?;
        Ok(record)
    }

    pub fn pending_source_texts(&self, target_language: &str) -> Result<Vec<SourceTextRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                source_language,
                normalized_text,
                visible_text,
                control_code_signature
            FROM source_texts
            WHERE NOT EXISTS (
                SELECT 1
                FROM translations
                WHERE translations.source_text_id = source_texts.id
                  AND translations.target_language = ?1
            )
            ORDER BY id
            ",
        )?;
        let rows = statement.query_map(params![target_language], |row| {
            Ok(SourceTextRecord {
                id: row.get(0)?,
                source_language: row.get(1)?,
                normalized_text: row.get(2)?,
                visible_text: row.get(3)?,
                control_code_signature: row.get(4)?,
            })
        })?;

        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    pub fn exportable_translations(
        &self,
        target_language: &str,
        review_states: &[&str],
    ) -> Result<Vec<ExportableTranslationRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                source_texts.id,
                source_texts.source_language,
                translations.target_language,
                source_texts.normalized_text,
                source_texts.visible_text,
                source_texts.control_code_signature,
                translations.translated_text,
                translations.review_state,
                translations.qa_state
            FROM translations
            INNER JOIN source_texts ON source_texts.id = translations.source_text_id
            WHERE translations.target_language = ?1
            ORDER BY source_texts.id
            ",
        )?;
        let rows = statement.query_map(params![target_language], |row| {
            Ok(ExportableTranslationRecord {
                source_text_id: row.get(0)?,
                source_language: row.get(1)?,
                target_language: row.get(2)?,
                normalized_text: row.get(3)?,
                visible_text: row.get(4)?,
                control_code_signature: row.get(5)?,
                translated_text: row.get(6)?,
                review_state: row.get(7)?,
                qa_state: row.get(8)?,
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

    pub fn insert_qa_finding(&mut self, input: &NewQaFinding) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO qa_findings (
                source_text_id,
                translation_id,
                finding_type,
                severity,
                message
            )
            VALUES (?1, ?2, ?3, ?4, ?5)
            ",
            params![
                input.source_text_id,
                input.translation_id,
                input.finding_type,
                input.severity,
                input.message
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    pub fn qa_findings_for_source(&self, source_text_id: i64) -> Result<Vec<QaFindingRecord>> {
        let mut statement = self.conn.prepare(
            "
            SELECT
                id,
                source_text_id,
                translation_id,
                finding_type,
                severity,
                message
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
                finding_type: row.get(3)?,
                severity: row.get(4)?,
                message: row.get(5)?,
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

    fn count_project_source_texts(&self, project_id: i64) -> Result<i64> {
        Ok(self.conn.query_row(
            "
            SELECT COUNT(DISTINCT source_text_id)
            FROM occurrences
            WHERE project_id = ?1
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

    fn count_project_review_queue(&self, project_id: i64, target_language: &str) -> Result<i64> {
        let mut count = 0;
        for row in self.review_queue_rows(project_id, target_language, None)? {
            if row.review_state != "accepted" && row.review_state != "reviewed" {
                count += 1;
            }
        }
        Ok(count)
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
}

fn enable_foreign_keys(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    Ok(())
}
