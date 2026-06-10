use std::collections::HashMap;
use std::path::PathBuf;

use rpg_translator_core::{
    InstallOptions, Installer, Result, RollbackManager, RollbackOptions, ScanOptions,
    TranslationDb, WorkbenchService,
};

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
