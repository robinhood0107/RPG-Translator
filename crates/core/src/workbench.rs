use std::path::Path;

use sha2::{Digest, Sha256};

use crate::{
    Error, NewProject, Result, ScanOptions, ScanPersistenceReport, ScanProgressEvent, TranslationDb,
};

pub struct WorkbenchService;

impl WorkbenchService {
    pub fn scan_game(
        db: &mut TranslationDb,
        game_root: impl AsRef<Path>,
        options: ScanOptions,
    ) -> Result<ScanPersistenceReport> {
        Self::scan_game_with_progress(db, game_root, options, |_| {})
    }

    pub fn scan_game_with_progress<F>(
        db: &mut TranslationDb,
        game_root: impl AsRef<Path>,
        options: ScanOptions,
        on_progress: F,
    ) -> Result<ScanPersistenceReport>
    where
        F: FnMut(&ScanProgressEvent),
    {
        let game_root = game_root.as_ref();
        let mut on_progress = on_progress;
        let report = crate::GameScanner::scan_with_progress(game_root, options, &mut on_progress)?;
        let project_id = db.upsert_project(&NewProject {
            game_root: game_root.to_string_lossy().into_owned(),
            display_name: display_name(game_root)?,
            engine: report.detected_game.engine.clone(),
        })?;
        let snapshot_id = db.record_game_snapshot(
            project_id,
            &snapshot_hash(&report)?,
            &data_root_hash(&report)?,
        )?;

        on_progress(&ScanProgressEvent::Persisting {
            occurrence_count: report.accepted.len(),
        });
        let persistence_stats =
            db.persist_project_scan_occurrences(project_id, snapshot_id, &report.accepted)?;

        let persistence = ScanPersistenceReport {
            project_id,
            snapshot_id,
            source_text_count: persistence_stats.source_text_count,
            occurrence_count: persistence_stats.occurrence_count,
            added_source_text_count: persistence_stats.added_source_text_count,
            removed_occurrence_count: persistence_stats.removed_occurrence_count,
            unchanged_source_text_count: persistence_stats.unchanged_source_text_count,
            rejected_count: report.rejected.len() as i64,
            skipped_count: report.skipped.len() as i64,
        };
        on_progress(&ScanProgressEvent::Persisted {
            project_id: persistence.project_id,
            snapshot_id: persistence.snapshot_id,
            source_text_count: persistence.source_text_count,
            occurrence_count: persistence.occurrence_count,
            added_source_text_count: persistence.added_source_text_count,
            removed_occurrence_count: persistence.removed_occurrence_count,
            unchanged_source_text_count: persistence.unchanged_source_text_count,
            rejected_count: persistence.rejected_count,
            skipped_count: persistence.skipped_count,
        });
        Ok(persistence)
    }
}

fn display_name(game_root: &Path) -> Result<String> {
    let name = game_root
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| Error::invalid_input("game root has no display name"))?;
    Ok(name.to_string())
}

fn snapshot_hash(report: &crate::ScanReport) -> Result<String> {
    let payload = serde_json::to_vec(&report.accepted).map_err(|error| {
        Error::invalid_input(format!("failed to encode scan snapshot: {error}"))
    })?;
    Ok(sha256_hex(&payload))
}

fn data_root_hash(report: &crate::ScanReport) -> Result<String> {
    let payload = serde_json::to_vec(&report.files).map_err(|error| {
        Error::invalid_input(format!("failed to encode file inventory: {error}"))
    })?;
    Ok(sha256_hex(&payload))
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
