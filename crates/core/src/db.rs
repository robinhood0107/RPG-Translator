use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::{NewOccurrence, NewProject, NewSourceText, NewTranslation, Result, TranslationRecord};

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
