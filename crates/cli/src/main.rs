use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

use rpg_translator_core::{
    BatchTranslator, BatchTranslatorConfig, DEFAULT_SYSTEM_PROMPT, ExportBuilder, ExportPolicy,
    InstallOptions, Installer, LocalOpenAiConfig, LocalOpenAiProvider, LocalProviderTransport,
    ProviderRequestSpacingConfig, Result, RollbackManager, RollbackOptions, ScanOptions,
    TranslationDb, WorkbenchService, build_quality_retry_instruction, translation_prompt_hash,
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
        "audit-quality" => audit_quality(&args[1..]),
        "repair-syntax" => repair_syntax(&args[1..]),
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
    let batch_size = optional_usize(&parsed, "--batch-size")?.unwrap_or(8);
    let token_budget = optional_usize(&parsed, "--token-budget")?.unwrap_or(3072);
    let retry_attempts = optional_usize(&parsed, "--retry-attempts")?.unwrap_or(1);
    let quality_only = parsed
        .get("--quality-only")
        .is_some_and(|value| value == "true");
    let parsed_system_prompt = parsed
        .get("--system-prompt")
        .cloned()
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string());
    let system_prompt = if quality_only {
        let quality_instruction = build_quality_retry_instruction(target_language);
        if parsed_system_prompt.trim().is_empty() || parsed_system_prompt == DEFAULT_SYSTEM_PROMPT {
            quality_instruction
        } else {
            format!("{parsed_system_prompt}\n\n{quality_instruction}")
        }
    } else {
        parsed_system_prompt
    };
    let output_review_state = match parsed.get("--review-state").map(String::as_str) {
        Some("accepted") => "accepted",
        Some(value) => {
            return Err(rpg_translator_core::Error::invalid_input(format!(
                "--review-state only supports accepted for translate-local, got {value}"
            )));
        }
        None => "pending",
    };
    let prompt_hash = translation_prompt_hash(&source_language, target_language, &system_prompt);

    let mut db = TranslationDb::open_with_schema_guard(&db_path)?;
    let quality_source_text_ids = if quality_only {
        let report = db.audit_translation_quality(project_id, target_language, 0)?;
        let ids = report
            .issues
            .iter()
            .filter(|issue| matches!(issue.classification.as_str(), "high_risk" | "quality_retry"))
            .filter_map(|issue| issue.source_text_id)
            .collect::<BTreeSet<_>>();
        if ids.is_empty() {
            println!(
                "quality_candidates=0 translated status=completed provider_run_id=0 accepted=0 failed=0 batches=0/0 elapsed_ms=0"
            );
            return Ok(());
        }
        Some(ids.into_iter().collect::<Vec<_>>())
    } else {
        None
    };
    let quality_candidate_count = quality_source_text_ids.as_ref().map_or(0usize, Vec::len);
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
            retry_attempts,
            provider_spacing: ProviderRequestSpacingConfig::failure_backoff_only(),
            source_text_ids: quality_source_text_ids,
            include_existing_translations: quality_only,
            prompt_hash,
            adaptive_decision_reason: "cli translate-local fixed batch settings".to_string(),
            output_review_state: output_review_state.to_string(),
        },
    )?;
    let approved_count = if output_review_state == "accepted" {
        report.completed_source_text_ids.len()
    } else {
        0
    };
    println!(
        "quality_candidates={} translated status={} provider_run_id={} accepted={} failed={} batches={}/{} elapsed_ms={}",
        quality_candidate_count,
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

fn audit_quality(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let db_path = required_path(&parsed, "--db")?;
    let project_id = required_i64(&parsed, "--project-id")?;
    let target_language = parsed.get("--target-language").ok_or_else(|| {
        rpg_translator_core::Error::invalid_input("--target-language is required")
    })?;
    let limit = optional_usize(&parsed, "--limit")?.unwrap_or(50);
    let db = TranslationDb::open_with_schema_guard(&db_path)?;
    let report = db.audit_translation_quality(project_id, target_language, limit)?;
    println!(
        "quality_audit total_rows={} issues={} high_severity={} retranslation_candidates={} high_risk_sources={} quality_retry_sources={} allowlisted_technical={}",
        report.total_rows,
        report.issue_count,
        report.high_severity_count,
        report.retranslation_candidate_count,
        report.high_risk_source_count,
        report.quality_retry_source_count,
        report.allowlisted_technical_count
    );
    for issue in report.issues {
        println!(
            "quality_issue source_text_id={} translation_id={} unit_kind={} code={} severity={} classification={} message={} source=\"{}\" translation=\"{}\"",
            issue.source_text_id.unwrap_or_default(),
            issue.translation_id.unwrap_or_default(),
            issue.unit_kind.unwrap_or_default(),
            issue.code,
            issue.severity,
            issue.classification,
            one_line(&issue.message),
            snippet(&issue.source_text, 80),
            snippet(&issue.translated_text, 80)
        );
    }
    Ok(())
}

fn repair_syntax(args: &[String]) -> Result<()> {
    let parsed = parse_flags(args)?;
    let db_path = required_path(&parsed, "--db")?;
    let project_id = required_i64(&parsed, "--project-id")?;
    let target_language = parsed.get("--target-language").ok_or_else(|| {
        rpg_translator_core::Error::invalid_input("--target-language is required")
    })?;
    let apply = parsed.get("--apply").is_some_and(|value| value == "true");
    let mut db = TranslationDb::open_with_schema_guard(&db_path)?;
    let backup_path = if apply {
        Some(db.create_verified_backup(&db_path, "syntax-repair")?)
    } else {
        None
    };
    let report =
        db.repair_translation_syntax(project_id, target_language, apply, backup_path.as_deref())?;
    let mode = if apply { "apply" } else { "dry-run" };
    println!(
        "syntax_repair mode={} target_language={} total_open_validation={} unique_sources={} safe_candidates={} unsafe={} applied={} resolved_findings={} backup={}",
        mode,
        report.target_language,
        report.total_open_validation_count,
        report.unique_source_count,
        report.safe_candidate_count,
        report.unsafe_count,
        report.applied_count,
        report.resolved_finding_count,
        report.backup_path.as_deref().unwrap_or("")
    );
    for (action, count) in &report.action_counts {
        println!("syntax_repair_action action={} count={}", action, count);
    }
    for sample in &report.samples {
        println!(
            "syntax_repair_sample source_text_id={} safe={} actions={} unsafe_reason={} remaining={} original=\"{}\" repaired=\"{}\"",
            sample.source_text_id,
            sample.safe_to_apply,
            sample.actions.join(","),
            sample.unsafe_reason.as_deref().unwrap_or(""),
            sample.validation_messages.join(" | "),
            snippet(&sample.original_text, 120),
            snippet(&sample.repaired_text, 120)
        );
    }
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

fn one_line(input: &str) -> String {
    input.replace(['\r', '\n'], " ")
}

fn snippet(input: &str, max_chars: usize) -> String {
    let one_line = one_line(input).replace('"', "'");
    let mut chars = one_line.chars();
    let snippet = chars.by_ref().take(max_chars).collect::<String>();
    if chars.next().is_some() {
        format!("{snippet}...")
    } else {
        snippet
    }
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
        if is_boolean_flag(key) {
            parsed.insert(key.clone(), "true".to_string());
            index += 1;
            continue;
        }
        let value = args.get(index + 1).ok_or_else(|| {
            rpg_translator_core::Error::invalid_input(format!("missing value for {key}"))
        })?;
        parsed.insert(key.clone(), value.clone());
        index += 2;
    }
    Ok(parsed)
}

fn is_boolean_flag(key: &str) -> bool {
    matches!(key, "--quality-only" | "--dry-run" | "--apply")
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
