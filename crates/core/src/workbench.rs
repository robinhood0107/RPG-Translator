use std::collections::BTreeSet;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::{
    Error, NewOccurrence, NewProject, Result, ScanOptions, ScanPersistenceReport, TranslationDb,
};

pub struct WorkbenchService;

impl WorkbenchService {
    pub fn scan_game(
        db: &mut TranslationDb,
        game_root: impl AsRef<Path>,
        options: ScanOptions,
    ) -> Result<ScanPersistenceReport> {
        let game_root = game_root.as_ref();
        let report = crate::GameScanner::scan(game_root, options)?;
        let project_id = db.upsert_project(&NewProject {
            game_root: report.detected_game.game_root.clone(),
            display_name: display_name(game_root)?,
            engine: report.detected_game.engine.clone(),
        })?;
        let snapshot_id = db.record_game_snapshot(
            project_id,
            &snapshot_hash(&report)?,
            &data_root_hash(&report)?,
        )?;

        let mut source_text_ids = BTreeSet::new();
        let mut occurrence_count = 0i64;
        for occurrence in &report.accepted {
            let source_text_id = db.upsert_source_text(&occurrence.source_text)?;
            source_text_ids.insert(source_text_id);
            db.insert_project_occurrence(
                project_id,
                &NewOccurrence {
                    project_id: Some(project_id),
                    source_text_id,
                    file_path: occurrence.context.file_path.clone(),
                    json_path: occurrence.context.json_path.clone(),
                    entity_type: occurrence.context.entity_type.clone(),
                    event_id: occurrence.context.event_id,
                    page_index: occurrence.context.page_index,
                    command_index: occurrence.context.command_index,
                    command_code: occurrence.context.command_code,
                    parameter_index: occurrence.context.parameter_index,
                    object_key: occurrence.context.object_key.clone(),
                    extraction_rule_id: occurrence.context.extraction_rule_id.clone(),
                },
            )?;
            occurrence_count += 1;
        }

        Ok(ScanPersistenceReport {
            project_id,
            snapshot_id,
            source_text_count: source_text_ids.len() as i64,
            occurrence_count,
            rejected_count: report.rejected.len() as i64,
            skipped_count: report.skipped.len() as i64,
        })
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
