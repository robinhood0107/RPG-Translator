use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    CacheKeyBuilder, CacheKeyParts, Error, ExportableTranslationRecord, Result, TranslationDb,
};

const EXPORT_SCHEMA_VERSION: u32 = 1;
const KEY_SCHEMA_VERSION: &str = "v1";
const CACHE_FILE: &str = "cache.jsonl";
const MANIFEST_FILE: &str = "manifest.json";
const OVERLAY_CONFIG_FILE: &str = "overlay-config.json";
const STARTUP_TOAST_TEXT: &str = "RPG-Translator 작동중";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportPolicy {
    pub include_review_states: Vec<String>,
}

impl ExportPolicy {
    #[must_use]
    pub fn accepted_and_reviewed() -> Self {
        Self {
            include_review_states: vec!["accepted".to_string(), "reviewed".to_string()],
        }
    }

    fn review_state_refs(&self) -> Vec<&str> {
        self.include_review_states
            .iter()
            .map(String::as_str)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeExportManifest {
    pub schema_version: u32,
    pub project_id: i64,
    pub source_language: String,
    pub target_language: String,
    pub created_timestamp: String,
    pub key_schema_version: String,
    pub cache_files: Vec<String>,
    pub record_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeCacheRecord {
    pub cache_key: String,
    pub source_text_id: i64,
    pub source_hash: String,
    pub source_language: String,
    pub target_language: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub translation: String,
    pub control_code_signature: String,
    pub context_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverlayConfig {
    pub schema_version: u32,
    pub diagnostics_enabled: bool,
    pub startup_toast_enabled: bool,
    pub startup_toast_text: String,
}

impl OverlayConfig {
    #[must_use]
    pub fn runtime_default() -> Self {
        Self {
            schema_version: EXPORT_SCHEMA_VERSION,
            diagnostics_enabled: false,
            startup_toast_enabled: true,
            startup_toast_text: STARTUP_TOAST_TEXT.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportReport {
    pub export_id: i64,
    pub output_dir: PathBuf,
    pub included_count: usize,
    pub skipped_count: usize,
    pub manifest_hash: String,
}

pub struct ExportBuilder;

impl ExportBuilder {
    pub fn export_project(
        db: &mut TranslationDb,
        project_id: i64,
        target_language: &str,
        output_dir: impl AsRef<Path>,
        policy: ExportPolicy,
    ) -> Result<ExportReport> {
        let output_dir = output_dir.as_ref();
        let project = db
            .get_project(project_id)?
            .ok_or_else(|| Error::invalid_input(format!("project {project_id} not found")))?;
        let review_states = policy.review_state_refs();
        let rows = db.exportable_translations(project_id, target_language, &review_states)?;
        if rows.is_empty() {
            return Err(Error::invalid_input(format!(
                "no exportable translations for target language {target_language}"
            )));
        }
        let total_count = db
            .workbench_dashboard_summary(project_id, target_language)?
            .source_text_count as usize;
        let source_language = single_source_language(&rows)?;

        fs::create_dir_all(output_dir).map_err(|error| {
            Error::invalid_input(format!(
                "failed to create export directory {}: {error}",
                output_dir.display()
            ))
        })?;

        let records = rows
            .iter()
            .map(|row| runtime_cache_record(row, &project.engine))
            .collect::<Vec<_>>();
        let manifest = RuntimeExportManifest {
            schema_version: EXPORT_SCHEMA_VERSION,
            project_id,
            source_language,
            target_language: target_language.to_string(),
            created_timestamp: created_timestamp()?,
            key_schema_version: KEY_SCHEMA_VERSION.to_string(),
            cache_files: vec![CACHE_FILE.to_string()],
            record_count: records.len(),
        };
        let config = OverlayConfig::runtime_default();

        write_json_pretty(&output_dir.join(MANIFEST_FILE), &manifest)?;
        write_json_pretty(&output_dir.join(OVERLAY_CONFIG_FILE), &config)?;
        write_jsonl(&output_dir.join(CACHE_FILE), &records)?;
        Self::verify_bundle(output_dir)?;

        let manifest_text =
            fs::read_to_string(output_dir.join(MANIFEST_FILE)).map_err(|error| {
                Error::invalid_input(format!("failed to read written manifest: {error}"))
            })?;
        let manifest_hash = sha256_hex(manifest_text.as_bytes());
        let export_id = db.record_export(
            project_id,
            target_language,
            &output_dir.to_string_lossy(),
            &manifest_hash,
            records.len() as i64,
        )?;

        Ok(ExportReport {
            export_id,
            output_dir: output_dir.to_path_buf(),
            included_count: records.len(),
            skipped_count: total_count.saturating_sub(records.len()),
            manifest_hash,
        })
    }

    pub fn verify_bundle(output_dir: impl AsRef<Path>) -> Result<ExportReport> {
        let output_dir = output_dir.as_ref();
        let manifest: RuntimeExportManifest = read_json(&output_dir.join(MANIFEST_FILE))?;
        let config: OverlayConfig = read_json(&output_dir.join(OVERLAY_CONFIG_FILE))?;
        if manifest.schema_version != EXPORT_SCHEMA_VERSION {
            return Err(Error::invalid_input(format!(
                "unsupported export schema version {}",
                manifest.schema_version
            )));
        }
        if manifest.key_schema_version != KEY_SCHEMA_VERSION {
            return Err(Error::invalid_input(format!(
                "unsupported key schema version {}",
                manifest.key_schema_version
            )));
        }
        if config.schema_version != EXPORT_SCHEMA_VERSION {
            return Err(Error::invalid_input(format!(
                "unsupported overlay config schema version {}",
                config.schema_version
            )));
        }

        let mut record_count = 0usize;
        for cache_file in &manifest.cache_files {
            let path = output_dir.join(cache_file);
            let text = fs::read_to_string(&path).map_err(|error| {
                Error::invalid_input(format!(
                    "failed to read cache file {}: {error}",
                    path.display()
                ))
            })?;
            for (line_index, line) in text.lines().enumerate() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let record: RuntimeCacheRecord =
                    serde_json::from_str(trimmed).map_err(|error| {
                        Error::invalid_input(format!(
                            "failed to parse cache record {}:{}: {error}",
                            path.display(),
                            line_index + 1
                        ))
                    })?;
                validate_cache_record(&record)?;
                record_count += 1;
            }
        }
        if record_count != manifest.record_count {
            return Err(Error::invalid_input(format!(
                "manifest record_count {} does not match cache records {record_count}",
                manifest.record_count
            )));
        }

        let manifest_text =
            fs::read_to_string(output_dir.join(MANIFEST_FILE)).map_err(|error| {
                Error::invalid_input(format!("failed to read manifest for hashing: {error}"))
            })?;
        Ok(ExportReport {
            export_id: 0,
            output_dir: output_dir.to_path_buf(),
            included_count: record_count,
            skipped_count: 0,
            manifest_hash: sha256_hex(manifest_text.as_bytes()),
        })
    }
}

fn runtime_cache_record(
    row: &ExportableTranslationRecord,
    engine: &crate::Engine,
) -> RuntimeCacheRecord {
    let context_hash = None;
    RuntimeCacheRecord {
        cache_key: CacheKeyBuilder::build(&CacheKeyParts {
            engine: engine.clone(),
            source_language: row.source_language.clone(),
            target_language: row.target_language.clone(),
            normalized_text: row.normalized_text.clone(),
            control_code_signature: row.control_code_signature.clone(),
            context_hash: context_hash.clone(),
        }),
        source_text_id: row.source_text_id,
        source_hash: sha256_hex(row.normalized_text.as_bytes()),
        source_language: row.source_language.clone(),
        target_language: row.target_language.clone(),
        normalized_text: row.normalized_text.clone(),
        visible_text: row.visible_text.clone(),
        translation: row.translated_text.clone(),
        control_code_signature: row.control_code_signature.clone(),
        context_hash,
    }
}

fn single_source_language(rows: &[ExportableTranslationRecord]) -> Result<String> {
    let Some(first) = rows.first() else {
        return Err(Error::invalid_input("no rows to export"));
    };
    for row in rows {
        if row.source_language != first.source_language {
            return Err(Error::invalid_input(
                "runtime export cannot mix source languages in one bundle",
            ));
        }
    }
    Ok(first.source_language.clone())
}

fn validate_cache_record(record: &RuntimeCacheRecord) -> Result<()> {
    if !record.cache_key.starts_with("ck:v1:") {
        return Err(Error::invalid_input("cache_key must use ck:v1 schema"));
    }
    if record.translation.trim().is_empty() {
        return Err(Error::invalid_input("cache record translation is empty"));
    }
    if record.source_hash.len() != 64 {
        return Err(Error::invalid_input(
            "source_hash must be a sha256 hex digest",
        ));
    }
    Ok(())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    let text = fs::read_to_string(path).map_err(|error| {
        Error::invalid_input(format!("failed to read {}: {error}", path.display()))
    })?;
    serde_json::from_str(&text).map_err(|error| {
        Error::invalid_input(format!("failed to parse {}: {error}", path.display()))
    })
}

fn write_json_pretty<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|error| Error::invalid_input(format!("failed to encode JSON: {error}")))?;
    fs::write(path, format!("{text}\n")).map_err(|error| {
        Error::invalid_input(format!("failed to write {}: {error}", path.display()))
    })?;
    Ok(())
}

fn write_jsonl<T: Serialize>(path: &Path, values: &[T]) -> Result<()> {
    let mut output = String::new();
    for value in values {
        let line = serde_json::to_string(value)
            .map_err(|error| Error::invalid_input(format!("failed to encode JSONL: {error}")))?;
        output.push_str(&line);
        output.push('\n');
    }
    fs::write(path, output).map_err(|error| {
        Error::invalid_input(format!("failed to write {}: {error}", path.display()))
    })?;
    Ok(())
}

fn created_timestamp() -> Result<String> {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| Error::invalid_input(format!("system clock before unix epoch: {error}")))?
        .as_secs();
    Ok(seconds.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}
