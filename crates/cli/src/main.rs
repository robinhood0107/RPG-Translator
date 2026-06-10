use std::collections::HashMap;
use std::path::PathBuf;

use rpg_translator_core::{
    BatchTranslator, BatchTranslatorConfig, DEFAULT_SYSTEM_PROMPT, ExportBuilder, ExportPolicy,
    InstallOptions, Installer, LocalOpenAiConfig, LocalOpenAiProvider, LocalProviderTransport,
    ProviderRequestSpacingConfig, Result, RollbackManager, RollbackOptions, ScanOptions,
    TranslationDb, WorkbenchService, translation_prompt_hash,
};
use serde_json::Value;

fn main() {
    if let Err(error) = run(std::env::args().skip(1).collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<()> {
    if args.is_empty() {
        println!("{}", rpg_translator_core::workspace_ready_message());
        return Ok(());
    }

    match args[0].as_str() {
        "scan-game" => scan_game(&args[1..]),
        "translate-local" => translate_local(&args[1..]),
        "export-bundle" => export_bundle(&args[1..]),
        "install-overlay" => install_overlay(&args[1..]),
        "rollback-overlay" => rollback_overlay(&args[1..]),
        command => Err(rpg_translator_core::Error::invalid_input(format!(
            "unknown command {command}"
        ))),
    }
}

fn scan_game(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let game_root = required_path(&parsed, "--game-root")?;
    let db_path = required_path(&parsed, "--db")?;
    let source_language = parsed
        .get("--source-language")
        .cloned()
        .unwrap_or_else(|| "ja".to_string());
    let mut db = TranslationDb::open_with_schema_guard(&db_path)?;
    let report = WorkbenchService::scan_game(
        &mut db,
        &game_root,
        ScanOptions {
            source_language,
            ..ScanOptions::default()
        },
    )?;
    println!(
        "scanned project_id={} snapshot_id={} source_texts={} occurrences={} added_sources={} unchanged_sources={} removed_occurrences={} rejected={} skipped={}",
        report.project_id,
        report.snapshot_id,
        report.source_text_count,
        report.occurrence_count,
        report.added_source_text_count,
        report.unchanged_source_text_count,
        report.removed_occurrence_count,
        report.rejected_count,
        report.skipped_count
    );
    Ok(())
}

fn translate_local(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let db_path = required_path(&parsed, "--db")?;
    let project_id = required_i64(&parsed, "--project-id")?;
    let source_language = parsed
        .get("--source-language")
        .cloned()
        .unwrap_or_else(|| "ja".to_string());
    let target_language = parsed.get("--target-language").ok_or_else(|| {
        rpg_translator_core::Error::invalid_input("--target-language is required")
    })?;
    let base_url = parsed
        .get("--base-url")
        .ok_or_else(|| rpg_translator_core::Error::invalid_input("--base-url is required"))?;
    let model = parsed
        .get("--model")
        .ok_or_else(|| rpg_translator_core::Error::invalid_input("--model is required"))?;
    let batch_size = optional_usize(&parsed, "--batch-size")?.unwrap_or(16);
    let token_budget = optional_usize(&parsed, "--token-budget")?.unwrap_or(4096);
    let system_prompt = parsed
        .get("--system-prompt")
        .cloned()
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string());
    let prompt_hash = translation_prompt_hash(&source_language, target_language, &system_prompt);

    let mut db = TranslationDb::open_with_schema_guard(&db_path)?;
    let mut provider = LocalOpenAiProvider::new(
        LocalOpenAiConfig {
            base_url: base_url.clone(),
            model: model.clone(),
            source_language: source_language.clone(),
            target_language: target_language.clone(),
            system_prompt,
            temperature: optional_f64(&parsed, "--temperature")?,
            top_p: optional_f64(&parsed, "--top-p")?,
            max_output_tokens: optional_usize(&parsed, "--max-output-tokens")?,
        },
        BlockingHttpTransport::new()?,
    )?;
    let report = BatchTranslator::run(
        &mut db,
        &mut provider,
        target_language,
        BatchTranslatorConfig {
            project_id: Some(project_id),
            source_language,
            max_items_per_batch: batch_size.max(1),
            input_token_budget: token_budget.max(1),
            retry_attempts: 0,
            provider_spacing: ProviderRequestSpacingConfig::disabled(),
            source_text_ids: None,
            include_existing_translations: false,
            prompt_hash,
            adaptive_decision_reason: "cli translate-local fixed batch settings".to_string(),
        },
    )?;
    let approved_count = match parsed.get("--review-state").map(String::as_str) {
        Some("accepted") => {
            db.bulk_approve_pending_review_rows(project_id, target_language, None)?
                .updated_count
        }
        Some(value) => {
            return Err(rpg_translator_core::Error::invalid_input(format!(
                "--review-state only supports accepted for translate-local, got {value}"
            )));
        }
        None => 0,
    };
    println!(
        "translated status={} provider_run_id={} accepted={} failed={} batches={}/{} elapsed_ms={}",
        report.status.as_key(),
        report.provider_run_id,
        approved_count,
        report.failed_source_text_ids.len(),
        report.processed_batches,
        report.total_batches,
        report.elapsed_ms
    );
    Ok(())
}

fn export_bundle(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let db_path = required_path(&parsed, "--db")?;
    let project_id = required_i64(&parsed, "--project-id")?;
    let target_language = parsed.get("--target-language").ok_or_else(|| {
        rpg_translator_core::Error::invalid_input("--target-language is required")
    })?;
    let export_dir = required_path(&parsed, "--export-dir")?;
    let mut db = TranslationDb::open_with_schema_guard(&db_path)?;
    let report = ExportBuilder::export_project(
        &mut db,
        project_id,
        target_language,
        &export_dir,
        ExportPolicy::accepted_and_reviewed(),
    )?;
    println!(
        "exported export_id={} included={} skipped={} manifest_hash={} output={}",
        report.export_id,
        report.included_count,
        report.skipped_count,
        report.manifest_hash,
        report.output_dir.display()
    );
    Ok(())
}

struct BlockingHttpTransport {
    client: reqwest::blocking::Client,
}

impl BlockingHttpTransport {
    fn new() -> Result<Self> {
        let client = reqwest::blocking::Client::builder()
            .build()
            .map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "failed to create local provider HTTP client: {error}"
                ))
            })?;
        Ok(Self { client })
    }
}

impl LocalProviderTransport for BlockingHttpTransport {
    fn post_json(&mut self, url: &str, body: &Value) -> Result<Value> {
        self.client
            .post(url)
            .json(body)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "local provider POST {url} failed: {error}"
                ))
            })?
            .json::<Value>()
            .map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "local provider POST {url} returned invalid JSON: {error}"
                ))
            })
    }

    fn get_json(&mut self, url: &str) -> Result<Value> {
        self.client
            .get(url)
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "local provider GET {url} failed: {error}"
                ))
            })?
            .json::<Value>()
            .map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "local provider GET {url} returned invalid JSON: {error}"
                ))
            })
    }
}

fn install_overlay(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let game_root = required_path(&parsed, "--game-root")?;
    let export_dir = required_path(&parsed, "--export-dir")?;
    let project_id = optional_i64(&parsed, "--project-id")?;
    let export_id = optional_i64(&parsed, "--export-id")?;
    let options = InstallOptions {
        game_root,
        export_dir,
        runtime_dir: None,
        project_id,
        export_id,
    };

    let report = if let Some(db_path) = parsed.get("--db") {
        let mut db = TranslationDb::open_with_schema_guard(db_path)?;
        Installer::install_with_db(&mut db, &options)?
    } else {
        Installer::install(&options)?
    };
    println!(
        "installed overlay manifest={}",
        report.install_manifest_path.display()
    );
    Ok(())
}

fn rollback_overlay(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let manifest_path = required_path(&parsed, "--manifest")?;
    let options = RollbackOptions { manifest_path };

    let report = if let Some(db_path) = parsed.get("--db") {
        let install_id = optional_i64(&parsed, "--install-id")?.ok_or_else(|| {
            rpg_translator_core::Error::invalid_input("--install-id is required with --db")
        })?;
        let mut db = TranslationDb::open_with_schema_guard(db_path)?;
        RollbackManager::rollback_with_db(&mut db, install_id, &options)?
    } else {
        RollbackManager::rollback(&options)?
    };
    println!(
        "rolled back overlay plugins={}",
        report.restored_plugins_file.display()
    );
    Ok(())
}

fn parse_flags(args: &[String]) -> Result<HashMap<String, String>> {
    let mut parsed = HashMap::new();
    let mut index = 0;
    while index < args.len() {
        let key = &args[index];
        if !key.starts_with("--") {
            return Err(rpg_translator_core::Error::invalid_input(format!(
                "unexpected argument {key}"
            )));
        }
        let value = args.get(index + 1).ok_or_else(|| {
            rpg_translator_core::Error::invalid_input(format!("missing value for {key}"))
        })?;
        parsed.insert(key.clone(), value.clone());
        index += 2;
    }
    Ok(parsed)
}

fn required_path(parsed: &HashMap<String, String>, key: &str) -> Result<PathBuf> {
    parsed
        .get(key)
        .map(PathBuf::from)
        .ok_or_else(|| rpg_translator_core::Error::invalid_input(format!("{key} is required")))
}

fn required_i64(parsed: &HashMap<String, String>, key: &str) -> Result<i64> {
    optional_i64(parsed, key)?
        .ok_or_else(|| rpg_translator_core::Error::invalid_input(format!("{key} is required")))
}

fn optional_i64(parsed: &HashMap<String, String>, key: &str) -> Result<Option<i64>> {
    parsed
        .get(key)
        .map(|value| {
            value.parse::<i64>().map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "{key} must be an integer: {error}"
                ))
            })
        })
        .transpose()
}

fn optional_usize(parsed: &HashMap<String, String>, key: &str) -> Result<Option<usize>> {
    parsed
        .get(key)
        .map(|value| {
            value.parse::<usize>().map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "{key} must be an unsigned integer: {error}"
                ))
            })
        })
        .transpose()
}

fn optional_f64(parsed: &HashMap<String, String>, key: &str) -> Result<Option<f64>> {
    parsed
        .get(key)
        .map(|value| {
            value.parse::<f64>().map_err(|error| {
                rpg_translator_core::Error::invalid_input(format!(
                    "{key} must be a number: {error}"
                ))
            })
        })
        .transpose()
}
