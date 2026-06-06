use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{
    Engine, ExportableTranslationRecord, GameSnapshotRecord, NewOccurrence, NewProject,
    NewProviderRun, NewQaFinding, NewSourceText, NewTranslation, ProjectRecord, QaFindingRecord,
    Result, SourceTextRecord, TranslationRecord,
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
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS installs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
                game_root TEXT NOT NULL,
                backup_manifest_path TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            PRAGMA user_version = 1;
            ",
        )?;
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
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO occurrences (
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
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ",
            params![
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
    ) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "
            INSERT INTO exports (
                project_id,
                target_language,
                export_path,
                manifest_hash
            )
            VALUES (?1, ?2, ?3, ?4)
            ",
            params![project_id, target_language, export_path, manifest_hash],
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
