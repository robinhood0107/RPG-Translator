use rpg_translator_core::{
    CacheKeyBuilder, CacheKeyParts, Engine, ExtractedOccurrence, NewOccurrence, NewProject,
    NewProviderRun, NewQaFinding, NewSourceText, NewTranslation, NewTranslationSpeedSample,
    OccurrenceContext, OccurrenceSegment, Result, ReviewUpdateRequest, TextCodec, TranslationDb,
    TranslationJobProgressUpdate, WorkbenchSettingsUpdate,
};
use rusqlite::{Connection, OpenFlags, params};
use tempfile::NamedTempFile;

#[test]
fn text_codec_normalizes_lines_and_signs_control_codes() {
    let analysis = TextCodec::analyze("\\C[2]Hello\\N[1]\r\nWorld\\G");

    assert_eq!(analysis.normalized_text, "\\C[2]Hello\\N[1]\nWorld\\G");
    assert_eq!(analysis.visible_text, "Hello\nWorld");
    assert_eq!(analysis.control_code_signature, "\\C[2]|\\N[1]|\\G");
    assert_eq!(
        analysis.control_codes,
        vec![
            "\\C[2]".to_string(),
            "\\N[1]".to_string(),
            "\\G".to_string()
        ]
    );
}

#[test]
fn cache_key_includes_language_engine_signature_and_context() {
    let parts = CacheKeyParts {
        engine: Engine::Mv,
        source_language: "ja".to_string(),
        target_language: "ko".to_string(),
        normalized_text: "\\C[1]Hello".to_string(),
        control_code_signature: "\\C[1]".to_string(),
        context_hash: Some("map001-event003".to_string()),
    };

    let first = CacheKeyBuilder::build(&parts);
    let second = CacheKeyBuilder::build(&parts);
    let changed_context = CacheKeyBuilder::build(&CacheKeyParts {
        context_hash: Some("map001-event004".to_string()),
        ..parts.clone()
    });
    let changed_signature = CacheKeyBuilder::build(&CacheKeyParts {
        control_code_signature: "\\N[1]".to_string(),
        ..parts
    });

    assert!(first.starts_with("ck:v1:"));
    assert_eq!(first, second);
    assert_ne!(first, changed_context);
    assert_ne!(first, changed_signature);
}

#[test]
fn migrations_are_idempotent_and_source_texts_dedupe() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    db.migrate()?;

    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let same_project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game Renamed".to_string(),
        engine: Engine::Mz,
    })?;
    assert_eq!(project_id, same_project_id);

    let source = source_text_with_signature("ja", "\\C[2]Hello", "Hello", "\\C[2]");
    let source_id = db.upsert_source_text(&source)?;
    let duplicate_id = db.upsert_source_text(&source)?;
    let different_signature_id = db.upsert_source_text(&source_text_with_signature(
        "ja",
        "\\C[2]Hello",
        "Hello",
        "\\N[1]",
    ))?;

    assert_eq!(source_id, duplicate_id);
    assert_ne!(source_id, different_signature_id);
    assert_eq!(db.source_text_count()?, 2);

    db.insert_occurrence(&NewOccurrence {
        project_id: None,
        source_text_id: source_id,
        file_path: "data/Map001.json".to_string(),
        json_path: "$.events[3].pages[0].list[1].parameters[0]".to_string(),
        entity_type: "event_command".to_string(),
        event_id: Some(3),
        page_index: Some(0),
        command_index: Some(1),
        command_code: Some(401),
        parameter_index: Some(0),
        object_key: None,
        extraction_rule_id: "event.message.line".to_string(),
    })?;
    assert_eq!(db.occurrence_count()?, 1);

    Ok(())
}

#[test]
fn cleanup_duplicate_projects_merges_references_by_canonical_windows_path() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    let survivor_id = {
        let mut db = TranslationDb::open(file.path())?;
        db.migrate()?;
        db.upsert_project(&NewProject {
            game_root: "C:\\Users\\pjjpj\\Desktop\\City_Of_Secrets".to_string(),
            display_name: "City Of Secrets".to_string(),
            engine: Engine::Mz,
        })?
    };
    let duplicate_id = {
        let conn = Connection::open(file.path()).expect("open temp sqlite");
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable fks");
        conn.execute(
            "
            INSERT INTO projects (game_root, display_name, engine)
            VALUES (?1, 'City Of Secrets duplicate', 'mz')
            ",
            params!["/mnt/c/Users/pjjpj/Desktop/City_Of_Secrets"],
        )
        .expect("insert duplicate project");
        let duplicate_id = conn.last_insert_rowid();
        conn.execute(
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
            VALUES ('en', 'text', hex(zeroblob(32)), 'Emma', 'Emma', 'Emma', '', 1, 0, 0)
            ",
            [],
        )
        .expect("insert source");
        let source_text_id = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO game_snapshots (project_id, snapshot_hash, data_root) VALUES (?1, 'same-hash', 'data')",
            params![survivor_id],
        )
        .expect("insert survivor snapshot");
        conn.execute(
            "INSERT INTO game_snapshots (project_id, snapshot_hash, data_root) VALUES (?1, 'same-hash', 'data')",
            params![duplicate_id],
        )
        .expect("insert duplicate colliding snapshot");
        conn.execute(
            "INSERT INTO game_snapshots (project_id, snapshot_hash, data_root) VALUES (?1, 'unique-hash', 'data')",
            params![duplicate_id],
        )
        .expect("insert duplicate unique snapshot");
        conn.execute(
            "
            INSERT INTO occurrences (
                project_id, source_text_id, file_path, json_path, entity_type,
                extraction_rule_id
            )
            VALUES (?1, ?2, 'data/Actors.json', '$.actors[0].name', 'actor', 'actor.name')
            ",
            params![duplicate_id, source_text_id],
        )
        .expect("insert duplicate occurrence");
        conn.execute(
            "
            INSERT INTO exports (project_id, target_language, export_path, manifest_hash, included_count)
            VALUES (?1, 'ko', 'exports/ko', 'hash', 1)
            ",
            params![duplicate_id],
        )
        .expect("insert duplicate export");
        conn.execute(
            "
            INSERT INTO installs (project_id, game_root, export_id, backup_manifest_path, status)
            VALUES (?1, 'C:\\Users\\pjjpj\\Desktop\\City_Of_Secrets', NULL, 'backup.json', 'installed')
            ",
            params![duplicate_id],
        )
        .expect("insert duplicate install");
        conn.execute(
            "
            INSERT INTO translation_jobs (project_id, source_language, target_language, checkpoint_path, status)
            VALUES (?1, 'en', 'ko', 'checkpoint.json', 'paused')
            ",
            params![duplicate_id],
        )
        .expect("insert duplicate job");
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value) VALUES (?1, 'provider_model', 'survivor')",
            params![survivor_id],
        )
        .expect("insert survivor setting");
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value) VALUES (?1, 'provider_model', 'duplicate')",
            params![duplicate_id],
        )
        .expect("insert duplicate colliding setting");
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value) VALUES (?1, 'export_dir', 'exports')",
            params![duplicate_id],
        )
        .expect("insert duplicate unique setting");
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('selected_project_id', ?1)",
            params![duplicate_id.to_string()],
        )
        .expect("insert selected duplicate setting");
        duplicate_id
    };

    let mut db = TranslationDb::open(file.path())?;
    let report = db.cleanup_duplicate_projects()?;
    assert_eq!(report.merged_project_count, 1);
    assert_eq!(report.survivor_project_ids, vec![survivor_id]);
    assert_eq!(report.removed_project_ids, vec![duplicate_id]);

    let conn = Connection::open(file.path()).expect("reopen temp sqlite");
    let project_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))?;
    assert_eq!(project_count, 1);
    let stored_root: String = conn.query_row(
        "SELECT game_root FROM projects WHERE id = ?1",
        params![survivor_id],
        |row| row.get(0),
    )?;
    assert_eq!(stored_root, "C:\\Users\\pjjpj\\Desktop\\City_Of_Secrets");
    for table in [
        "game_snapshots",
        "occurrences",
        "exports",
        "installs",
        "translation_jobs",
    ] {
        let duplicate_refs: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE project_id = ?1"),
            params![duplicate_id],
            |row| row.get(0),
        )?;
        assert_eq!(
            duplicate_refs, 0,
            "{table} still points at duplicate project"
        );
    }
    let snapshot_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM game_snapshots WHERE project_id = ?1",
        params![survivor_id],
        |row| row.get(0),
    )?;
    assert_eq!(snapshot_count, 2);
    let survivor_setting: String = conn.query_row(
        "SELECT value FROM project_settings WHERE project_id = ?1 AND key = 'provider_model'",
        params![survivor_id],
        |row| row.get(0),
    )?;
    assert_eq!(survivor_setting, "survivor");
    let copied_setting: String = conn.query_row(
        "SELECT value FROM project_settings WHERE project_id = ?1 AND key = 'export_dir'",
        params![survivor_id],
        |row| row.get(0),
    )?;
    assert_eq!(copied_setting, "exports");
    let selected_project_id: String = conn.query_row(
        "SELECT value FROM app_settings WHERE key = 'selected_project_id'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(selected_project_id, survivor_id.to_string());

    Ok(())
}

#[test]
fn bulk_scan_persistence_dedupes_sources_and_keeps_all_occurrences() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let source = source_text("Hello");
    let occurrences = vec![
        ExtractedOccurrence {
            raw_text: "Hello".to_string(),
            source_text: source.clone(),
            context: scan_context("data/Map001.json", 0),
            segments: Vec::new(),
        },
        ExtractedOccurrence {
            raw_text: "Hello".to_string(),
            source_text: source,
            context: scan_context("data/Map002.json", 1),
            segments: Vec::new(),
        },
    ];

    let persistence = db.persist_project_scan_occurrences(project_id, 1, &occurrences)?;
    let dashboard = db.workbench_dashboard_summary(project_id, "ko")?;

    assert_eq!(persistence.source_text_count, 1);
    assert_eq!(persistence.occurrence_count, 2);
    assert_eq!(persistence.added_source_text_count, 1);
    assert_eq!(persistence.unchanged_source_text_count, 0);
    assert_eq!(persistence.removed_occurrence_count, 0);
    assert_eq!(dashboard.source_text_count, 1);
    assert_eq!(dashboard.occurrence_count, 2);

    Ok(())
}

#[test]
fn scan_persistence_stores_ordered_occurrence_segments_for_block_units() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let source = NewSourceText {
        source_language: "en".to_string(),
        normalized_text: "Line one\nLine two".to_string(),
        visible_text: "Line one\nLine two".to_string(),
        control_code_signature: String::new(),
        unit_kind: "message_block".to_string(),
        normalized_hash: "fixture-hash".to_string(),
        codec_text: "Line one\nLine two".to_string(),
        line_count: 2,
        newline_count: 1,
        placeholder_count: 0,
    };
    let occurrence = ExtractedOccurrence {
        raw_text: "Line one\nLine two".to_string(),
        source_text: source,
        context: OccurrenceContext {
            file_path: "data/Map001.json".to_string(),
            json_path: "$.events[1].pages[0].list[0]".to_string(),
            entity_type: "event.command".to_string(),
            event_id: Some(1),
            page_index: Some(0),
            command_index: Some(0),
            command_code: Some(101),
            parameter_index: None,
            object_key: None,
            extraction_rule_id: "event.message.block".to_string(),
        },
        segments: vec![
            OccurrenceSegment {
                segment_index: 0,
                command_code: Some(401),
                json_path: "$.events[1].pages[0].list[1].parameters[0]".to_string(),
                raw_text: "Line one".to_string(),
                line_index: 0,
            },
            OccurrenceSegment {
                segment_index: 1,
                command_code: Some(401),
                json_path: "$.events[1].pages[0].list[2].parameters[0]".to_string(),
                raw_text: "Line two".to_string(),
                line_index: 1,
            },
        ],
    };

    db.persist_project_scan_occurrences(project_id, 1, &[occurrence])?;
    let rows = db.occurrence_segments_for_source_text(project_id, "Line one\nLine two")?;

    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].segment_index, 0);
    assert_eq!(
        rows[0].json_path,
        "$.events[1].pages[0].list[1].parameters[0]"
    );
    assert_eq!(rows[1].segment_index, 1);
    assert_eq!(
        rows[1].json_path,
        "$.events[1].pages[0].list[2].parameters[0]"
    );

    Ok(())
}

#[test]
fn project_rescan_keeps_translations_and_only_counts_active_occurrences() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let hello = source_text("Hello");
    let removed = source_text("Bye");
    let added = source_text("New");
    let first_scan = vec![
        extracted("Hello", hello.clone(), scan_context("data/Map001.json", 0)),
        extracted("Bye", removed.clone(), scan_context("data/Map001.json", 1)),
    ];

    let first_report = db.persist_project_scan_occurrences(project_id, 1, &first_scan)?;
    assert_eq!(first_report.source_text_count, 2);
    assert_eq!(first_report.occurrence_count, 2);
    assert_eq!(first_report.added_source_text_count, 2);
    assert_eq!(first_report.unchanged_source_text_count, 0);
    assert_eq!(first_report.removed_occurrence_count, 0);

    let hello_id = db.upsert_source_text(&hello)?;
    let removed_id = db.upsert_source_text(&removed)?;
    db.upsert_translation(&NewTranslation {
        source_text_id: hello_id,
        target_language: "ko".to_string(),
        translated_text: "안녕".to_string(),
        provider: "manual".to_string(),
        model: None,
        provider_run_id: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
    })?;
    db.upsert_translation(&NewTranslation {
        source_text_id: removed_id,
        target_language: "ko".to_string(),
        translated_text: "잘가".to_string(),
        provider: "manual".to_string(),
        model: None,
        provider_run_id: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
    })?;

    let second_scan = vec![
        extracted("Hello", hello, scan_context("data/Map001.json", 0)),
        extracted("New", added, scan_context("data/Map001.json", 2)),
    ];
    let second_report = db.persist_project_scan_occurrences(project_id, 2, &second_scan)?;
    let dashboard = db.workbench_dashboard_summary(project_id, "ko")?;
    let (missing_rows, missing_total) =
        db.review_queue_page(project_id, "ko", Some("missing"), None, 20, 0)?;
    let all_rows = db.review_queue_rows(project_id, "ko", None)?;

    assert_eq!(second_report.source_text_count, 2);
    assert_eq!(second_report.occurrence_count, 2);
    assert_eq!(second_report.added_source_text_count, 1);
    assert_eq!(second_report.unchanged_source_text_count, 1);
    assert_eq!(second_report.removed_occurrence_count, 1);
    assert_eq!(dashboard.source_text_count, 2);
    assert_eq!(dashboard.occurrence_count, 2);
    assert_eq!(dashboard.accepted_count, 1);
    assert_eq!(dashboard.review_queue_count, 1);
    assert_eq!(missing_total, 1);
    assert_eq!(missing_rows.len(), 1);
    assert_eq!(missing_rows[0].visible_text, "New");
    assert!(all_rows.iter().any(|row| row.visible_text == "Hello"));
    assert!(!all_rows.iter().any(|row| row.visible_text == "Bye"));
    assert!(db.get_translation(removed_id, "ko")?.is_some());

    Ok(())
}

#[test]
fn dashboard_and_review_counts_split_total_candidates_from_translatable_units() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;

    let mut sources = Vec::new();
    for (index, (text, unit_kind)) in [
        ("Line one", "message_block"),
        ("Line two", "message_block"),
        ("Line three", "message_block"),
        ("Darkness One 2", "db_field"),
        ("GALV_MapTravelMZ", "generic_candidate"),
        ("SomePluginInternalFlag", "generic_candidate"),
    ]
    .into_iter()
    .enumerate()
    {
        let mut source = source_text(text);
        source.unit_kind = unit_kind.to_string();
        let source_id = db.upsert_source_text(&source)?;
        db.insert_project_occurrence(
            project_id,
            &NewOccurrence {
                project_id: Some(project_id),
                source_text_id: source_id,
                file_path: "data/Map001.json".to_string(),
                json_path: format!("$.events[1].pages[0].list[{index}]"),
                entity_type: "event_command".to_string(),
                event_id: Some(1),
                page_index: Some(0),
                command_index: Some(index as i64),
                command_code: Some(401),
                parameter_index: Some(0),
                object_key: None,
                extraction_rule_id: unit_kind.to_string(),
            },
        )?;
        sources.push(source_id);
    }

    for source_id in sources.iter().take(3) {
        db.upsert_translation(&NewTranslation {
            source_text_id: *source_id,
            target_language: "ko".to_string(),
            translated_text: "번역".to_string(),
            provider: "local-openai-compatible".to_string(),
            model: Some("fixture-model".to_string()),
            provider_run_id: None,
            review_state: "pending".to_string(),
            qa_state: "passed".to_string(),
        })?;
    }
    db.insert_qa_finding(&NewQaFinding {
        source_text_id: sources[3],
        translation_id: None,
        target_language: Some("ko".to_string()),
        provider_run_id: None,
        finding_type: "provider-json-parse".to_string(),
        severity: "error".to_string(),
        message: "final failed".to_string(),
        status: "open".to_string(),
        details_json: "{}".to_string(),
    })?;

    let dashboard = db.workbench_dashboard_summary(project_id, "ko")?;
    assert_eq!(dashboard.source_text_count, 6);
    assert_eq!(dashboard.translatable_source_text_count, 4);
    assert_eq!(dashboard.unsupported_candidate_count, 2);
    assert_eq!(dashboard.translated_count, 3);
    assert_eq!(dashboard.missing_translatable_count, 1);
    assert_eq!(dashboard.failed_translatable_count, 1);
    assert_eq!(dashboard.review_queue_count, 4);

    let counts = db.review_counts(project_id, "ko")?;
    assert_eq!(counts.all, 4);
    assert_eq!(counts.unsupported, 2);
    assert_eq!(counts.missing, 1);
    assert_eq!(counts.pending, 3);
    assert_eq!(counts.open_issues, 1);
    assert_eq!(counts.json_parse, 1);

    let (rows, total) = db.review_queue_page(project_id, "ko", None, None, 20, 0)?;
    assert_eq!(total, 4);
    assert_eq!(rows.len(), 4);
    assert!(rows.iter().all(|row| row.visible_text != "GALV_MapTravelMZ"
        && row.visible_text != "SomePluginInternalFlag"));

    Ok(())
}

fn source_text(text: &str) -> NewSourceText {
    source_text_with_signature("en", text, text, "")
}

fn source_text_with_signature(
    source_language: &str,
    normalized_text: &str,
    visible_text: &str,
    control_code_signature: &str,
) -> NewSourceText {
    let provider_state = TextCodec::encode_for_provider(normalized_text);
    NewSourceText {
        source_language: source_language.to_string(),
        unit_kind: "text".to_string(),
        normalized_hash: String::new(),
        normalized_text: normalized_text.to_string(),
        visible_text: visible_text.to_string(),
        codec_text: provider_state.provider_text,
        control_code_signature: control_code_signature.to_string(),
        line_count: normalized_text.matches('\n').count() as i64 + 1,
        newline_count: normalized_text.matches('\n').count() as i64,
        placeholder_count: provider_state.control_codes.len() as i64,
    }
}

fn extracted(
    raw_text: &str,
    source_text: NewSourceText,
    context: OccurrenceContext,
) -> ExtractedOccurrence {
    ExtractedOccurrence {
        raw_text: raw_text.to_string(),
        source_text,
        context,
        segments: Vec::new(),
    }
}

fn scan_context(file_path: &str, command_index: i64) -> OccurrenceContext {
    OccurrenceContext {
        file_path: file_path.to_string(),
        json_path: format!("$.events[1].pages[0].list[{command_index}].parameters[0]"),
        entity_type: "event_command".to_string(),
        event_id: Some(1),
        page_index: Some(0),
        command_index: Some(command_index),
        command_code: Some(401),
        parameter_index: Some(0),
        object_key: None,
        extraction_rule_id: "event.message.line".to_string(),
    }
}

#[test]
fn migration_adds_export_included_count_to_existing_exports_table() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    {
        let conn = Connection::open(file.path()).expect("open temp sqlite");
        conn.execute_batch(
            "
            CREATE TABLE exports (
                id INTEGER PRIMARY KEY,
                project_id INTEGER,
                target_language TEXT NOT NULL,
                export_path TEXT NOT NULL,
                manifest_hash TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO exports (target_language, export_path, manifest_hash)
            VALUES ('ko', '/tmp/export', 'hash');
            ",
        )
        .expect("create legacy exports table");
    }

    let mut db = TranslationDb::open(file.path())?;
    db.migrate()?;

    assert_eq!(db.last_export_included_count()?, Some(0));

    Ok(())
}

#[test]
fn migration_normalizes_legacy_batch_validation_findings_for_issue_filters() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let cases = [
        (
            "json",
            "invalid input: invalid provider output JSON row: invalid escape at line 1 column 27",
            "provider-json-parse",
        ),
        (
            "placeholder",
            "invalid input: placeholder mismatch: expected 0, got 1",
            "translation-validation",
        ),
        (
            "503",
            "invalid input: local provider request failed: HTTP status server error (503 Service Unavailable)",
            "recoverable-provider",
        ),
        (
            "connection",
            "invalid input: local provider request failed: error sending request for url",
            "recoverable-provider",
        ),
    ];

    for (index, (_, message, _)) in cases.iter().enumerate() {
        let source_id = db.upsert_source_text(&source_text(&format!("Line {index}")))?;
        db.insert_occurrence(&NewOccurrence {
            project_id: Some(project_id),
            source_text_id: source_id,
            file_path: "data/Map001.json".to_string(),
            json_path: format!("$.events[1].pages[0].list[{index}].parameters[0]"),
            entity_type: "event_command".to_string(),
            event_id: Some(1),
            page_index: Some(0),
            command_index: Some(index as i64),
            command_code: Some(401),
            parameter_index: Some(0),
            object_key: None,
            extraction_rule_id: "event.message.line".to_string(),
        })?;
        db.insert_qa_finding(&NewQaFinding {
            source_text_id: source_id,
            translation_id: None,
            target_language: None,
            provider_run_id: None,
            finding_type: "batch-validation".to_string(),
            severity: "error".to_string(),
            message: (*message).to_string(),
            status: "open".to_string(),
            details_json: "{}".to_string(),
        })?;
    }

    db.migrate()?;

    let rows = db.review_queue_page(project_id, "ko", None, Some("open"), 20, 0)?;
    let counts = db.review_counts(project_id, "ko")?;
    assert_eq!(rows.1, 4);
    assert_eq!(counts.open_issues, 4);
    assert_eq!(counts.json_parse, 1);
    assert_eq!(counts.validation, 1);
    assert_eq!(counts.final_failed, 0);

    for (label, _, expected_type) in cases {
        let row = rows
            .0
            .iter()
            .find(|row| row.normalized_text == format!("Line {}", label_to_index(label)))
            .expect("row should be present");
        assert_eq!(row.qa_findings[0].finding_type, expected_type);
    }

    Ok(())
}

#[test]
fn file_db_enables_wal_busy_timeout_and_normal_sync() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    let mut db = TranslationDb::open(file.path())?;
    db.migrate()?;
    let journal_mode = db.pragma_string("journal_mode")?;
    let busy_timeout = db.pragma_i64("busy_timeout")?;
    let synchronous = db.pragma_i64("synchronous")?;

    assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
    assert!(busy_timeout >= 10_000);
    assert_eq!(synchronous, 1);

    Ok(())
}

fn label_to_index(label: &str) -> usize {
    match label {
        "json" => 0,
        "placeholder" => 1,
        "503" => 2,
        "connection" => 3,
        _ => unreachable!("unknown fixture label"),
    }
}

#[test]
fn workbench_settings_and_stale_runs_survive_migration() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    let mut db = TranslationDb::open(file.path())?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    db.save_workbench_settings(&WorkbenchSettingsUpdate {
        selected_project_id: Some(Some(project_id)),
        source_language: Some("en".to_string()),
        target_language: Some("ko".to_string()),
        provider_base_url: Some("http://127.0.0.1:18080".to_string()),
        provider_model: Some("auto".to_string()),
        system_prompt: Some("prompt".to_string()),
        export_dir: Some("/tmp/export".to_string()),
        active_tab: Some("translate".to_string()),
        show_hover_help: Some(false),
        ui_font_size: Some("large".to_string()),
    })?;
    let provider_run_id = db.start_provider_run(&NewProviderRun {
        provider: "local-openai-compatible".to_string(),
        model: Some("gemma".to_string()),
        request_settings_json: "{}".to_string(),
    })?;

    assert_eq!(db.interrupt_stale_provider_runs()?, 1);
    let settings = db.load_workbench_settings()?;
    let dashboard = db.workbench_dashboard_summary(project_id, "ko")?;

    assert_eq!(settings.selected_project_id, Some(project_id));
    assert_eq!(settings.provider_base_url, "http://127.0.0.1:18080");
    assert_eq!(settings.active_tab, "translate");
    assert!(!settings.show_hover_help);
    assert_eq!(settings.ui_font_size, "large");
    let latest_provider_run = dashboard.latest_provider_run.expect("provider run");
    assert_eq!(latest_provider_run.id, provider_run_id);
    assert_eq!(latest_provider_run.status, "interrupted");

    Ok(())
}

#[test]
fn translation_speed_samples_are_indexed_and_queryable() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    let mut db = TranslationDb::open(file.path())?;
    db.migrate()?;
    let provider_run_id = db.start_provider_run(&NewProviderRun {
        provider: "local-openai-compatible".to_string(),
        model: Some("gemma".to_string()),
        request_settings_json: "{}".to_string(),
    })?;

    db.insert_translation_speed_sample(&NewTranslationSpeedSample {
        provider_run_id,
        batch_index: 7,
        lane: "plain_block".to_string(),
        item_count: 16,
        char_count: 512,
        estimated_token_count: 128,
        request_elapsed_ms: 3200,
        success_delay_ms: 750,
        total_elapsed_ms: 3950,
        status: "success".to_string(),
        failure_type: None,
        effective_batch_size: 16,
        adaptive_decision_reason: "adaptive: accelerating from test".to_string(),
        model: Some("gemma".to_string()),
        prompt_hash: "prompt-hash".to_string(),
    })?;

    let samples = db.recent_translation_speed_samples(Some("gemma"), Some("prompt-hash"), 10)?;
    assert_eq!(samples.len(), 1);
    let sample = &samples[0];
    assert_eq!(sample.provider_run_id, provider_run_id);
    assert_eq!(sample.batch_index, 7);
    assert_eq!(sample.lane, "plain_block");
    assert_eq!(sample.item_count, 16);
    assert_eq!(sample.char_count, 512);
    assert_eq!(sample.estimated_token_count, 128);
    assert_eq!(sample.request_elapsed_ms, 3200);
    assert_eq!(sample.success_delay_ms, 750);
    assert_eq!(sample.total_elapsed_ms, 3950);
    assert_eq!(sample.status, "success");
    assert_eq!(sample.effective_batch_size, 16);
    assert_eq!(
        sample.adaptive_decision_reason,
        "adaptive: accelerating from test"
    );

    let conn = Connection::open(file.path())?;
    let index_count: i64 = conn.query_row(
        "
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
              'idx_translation_speed_samples_run_batch',
              'idx_translation_speed_samples_model_prompt_latest'
          )
        ",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(index_count, 2);

    Ok(())
}

#[test]
fn latest_translation_job_summary_restores_recent_speed_sample_metrics() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let provider_run_id = db.start_provider_run(&NewProviderRun {
        provider: "local-openai-compatible".to_string(),
        model: Some("gemma".to_string()),
        request_settings_json: "{}".to_string(),
    })?;
    db.upsert_translation_job_progress(&TranslationJobProgressUpdate {
        provider_run_id,
        project_id: None,
        source_language: "en".to_string(),
        target_language: "ko".to_string(),
        checkpoint_path: "translation-ko.checkpoint.json".to_string(),
        status: "running".to_string(),
        completed_items: 48,
        failed_items: 0,
        total_items: 96,
        processed_batches: 3,
        total_batches: 6,
        split_batches: 0,
        parse_failed_items: 0,
        validation_failed_items: 0,
        skipped_items: 0,
        censored_retry_count: 0,
        item_eta_ms: Some(9_000),
        batch_eta_ms: Some(9_000),
        last_batch_elapsed_ms: Some(3_000),
        avg_batch_elapsed_ms: Some(3_000),
        current_batch_items: 16,
        elapsed_ms: 9_000,
        model: Some("gemma".to_string()),
        retry_pending_items: 0,
        recoverable_provider_failures: 0,
        final_failed_items: 0,
        provider_backoff_ms: None,
        effective_batch_size: 16,
        next_experiment_batch_size: 16,
        input_token_budget: 4096,
        speed_mode: "steady".to_string(),
        success_streak: 3,
        success_delay_floor_ms: 750,
        next_delay_ms: Some(750),
        failure_reason_counts_json: "{}".to_string(),
        adaptive_decision_reason: "adaptive: steady from samples".to_string(),
        legacy_checkpoint_only: false,
    })?;

    for (batch_index, elapsed_ms) in [(1, 4_000), (2, 2_000), (3, 3_000)] {
        db.insert_translation_speed_sample(&NewTranslationSpeedSample {
            provider_run_id,
            batch_index,
            lane: "message_block".to_string(),
            item_count: 16,
            char_count: 640,
            estimated_token_count: 160,
            request_elapsed_ms: elapsed_ms - 750,
            success_delay_ms: 750,
            total_elapsed_ms: elapsed_ms,
            status: "success".to_string(),
            failure_type: None,
            effective_batch_size: 16,
            adaptive_decision_reason: "adaptive: steady from samples".to_string(),
            model: Some("gemma".to_string()),
            prompt_hash: "prompt-hash".to_string(),
        })?;
    }
    db.insert_translation_speed_sample(&NewTranslationSpeedSample {
        provider_run_id,
        batch_index: 4,
        lane: "message_block".to_string(),
        item_count: 16,
        char_count: 640,
        estimated_token_count: 160,
        request_elapsed_ms: 1,
        success_delay_ms: 0,
        total_elapsed_ms: 1,
        status: "provider_failure".to_string(),
        failure_type: Some("connection".to_string()),
        effective_batch_size: 8,
        adaptive_decision_reason: "adaptive: backoff from failure".to_string(),
        model: Some("gemma".to_string()),
        prompt_hash: "prompt-hash".to_string(),
    })?;

    let latest = db
        .latest_translation_job_summary(Some("ko"))?
        .expect("latest job");

    assert_eq!(latest.recent_p50_batch_elapsed_ms, Some(3_000));
    assert_eq!(latest.recent_p95_batch_elapsed_ms, Some(4_000));
    assert_eq!(latest.best_items_per_minute, Some(480));

    Ok(())
}

#[test]
fn migrate_adds_adaptive_reason_to_legacy_speed_samples() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    {
        let conn = Connection::open(file.path())?;
        conn.execute_batch(
            "
            CREATE TABLE translation_speed_samples (
                id INTEGER PRIMARY KEY,
                provider_run_id INTEGER NOT NULL,
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
    }

    let mut db = TranslationDb::open(file.path())?;
    assert!(db.needs_schema_upgrade()?);
    db.migrate()?;
    assert!(!db.needs_schema_upgrade()?);

    let conn = Connection::open(file.path())?;
    let column_count: i64 = conn.query_row(
        "
        SELECT COUNT(*)
        FROM pragma_table_info('translation_speed_samples')
        WHERE name = 'adaptive_decision_reason'
        ",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(column_count, 1);
    Ok(())
}

#[test]
fn migration_backfills_speed_columns_and_review_drafts_for_existing_db() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    let conn = Connection::open(file.path())?;
    conn.execute_batch(
        "
        CREATE TABLE translation_jobs (
            id INTEGER PRIMARY KEY,
            provider_run_id INTEGER,
            project_id INTEGER,
            source_language TEXT NOT NULL DEFAULT 'en',
            target_language TEXT NOT NULL DEFAULT 'ko',
            checkpoint_path TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            completed_items INTEGER NOT NULL DEFAULT 0,
            failed_items INTEGER NOT NULL DEFAULT 0,
            total_items INTEGER NOT NULL DEFAULT 0,
            current_batch_items INTEGER NOT NULL DEFAULT 8,
            provider_backoff_ms INTEGER,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO translation_jobs (
            source_language,
            target_language,
            checkpoint_path,
            status,
            completed_items,
            failed_items,
            total_items,
            current_batch_items,
            provider_backoff_ms
        )
        VALUES ('en', 'ko', 'translation-ko.checkpoint.json', 'running', 10, 2, 12, 8, 10000);
        ",
    )?;
    drop(conn);

    let mut db = TranslationDb::open(file.path())?;
    assert!(db.needs_schema_upgrade()?);
    db.migrate()?;
    assert!(!db.needs_schema_upgrade()?);

    let latest = db
        .latest_translation_job_summary(Some("ko"))?
        .expect("job survives migration");
    assert_eq!(latest.completed_items, 10);
    assert_eq!(latest.failed_items, 2);
    assert_eq!(latest.effective_batch_size, 8);
    assert_eq!(latest.next_experiment_batch_size, 8);
    assert_eq!(latest.input_token_budget, 4096);
    assert_eq!(latest.success_delay_floor_ms, 1500);
    assert_eq!(latest.next_delay_ms, Some(10_000));
    assert_eq!(latest.speed_mode, "backoff");

    Ok(())
}

#[test]
fn migration_guard_treats_missing_required_indexes_as_schema_upgrade() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    {
        let mut db = TranslationDb::open(file.path())?;
        db.migrate()?;
    }
    {
        let conn = Connection::open(file.path())?;
        conn.execute("DROP INDEX idx_occurrences_project_active_source", [])?;
    }

    let mut db = TranslationDb::open(file.path())?;
    assert!(db.needs_schema_upgrade()?);
    db.migrate()?;
    assert!(!db.needs_schema_upgrade()?);

    let conn = Connection::open(file.path())?;
    for index_name in [
        "idx_occurrences_project_identity_unique",
        "idx_occurrences_project_active_source",
        "idx_occurrences_source_project_active",
        "idx_translations_target_review_qa_source",
        "idx_qa_findings_source_target_status_type",
        "idx_exports_project_latest",
        "idx_installs_project_latest",
        "idx_translation_jobs_target_latest",
    ] {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?1",
            params![index_name],
            |row| row.get(0),
        )?;
        assert_eq!(exists, 1, "missing required index {index_name}");
    }

    Ok(())
}

#[test]
fn core_query_plans_use_required_btree_indexes() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    {
        let mut db = TranslationDb::open(file.path())?;
        db.migrate()?;
    }
    let conn = Connection::open(file.path())?;

    assert_query_uses_index(
        &conn,
        "
        SELECT source_text_id
        FROM occurrences
        WHERE project_id = 1
          AND active = 1
        ",
        "idx_occurrences_project_active_source",
    )?;
    assert_query_uses_index(
        &conn,
        "
        SELECT project_id
        FROM occurrences
        WHERE source_text_id = 1
          AND project_id = 1
          AND active = 1
        ",
        "idx_occurrences_source_project_active",
    )?;
    assert_query_uses_index(
        &conn,
        "
        SELECT source_text_id
        FROM translations
        WHERE target_language = 'ko'
          AND review_state IN ('accepted', 'reviewed')
          AND qa_state = 'passed'
        ",
        "idx_translations_target_review_qa_source",
    )?;
    assert_query_uses_index(
        &conn,
        "
        SELECT id
        FROM qa_findings
        WHERE source_text_id = 1
          AND target_language = 'ko'
          AND status = 'open'
          AND finding_type = 'translation-validation'
        ",
        "idx_qa_findings_source_target_status_type",
    )?;
    assert_query_uses_index(
        &conn,
        "
        SELECT id
        FROM exports
        WHERE project_id = 1
        ORDER BY id DESC
        LIMIT 1
        ",
        "idx_exports_project_latest",
    )?;
    assert_query_uses_index(
        &conn,
        "
        SELECT id
        FROM installs
        WHERE project_id = 1
        ORDER BY id DESC
        LIMIT 1
        ",
        "idx_installs_project_latest",
    )?;
    assert_query_uses_index(
        &conn,
        "
        SELECT id
        FROM translation_jobs
        WHERE target_language = 'ko'
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
        ",
        "idx_translation_jobs_target_latest",
    )?;

    Ok(())
}

#[test]
fn guarded_open_creates_verified_backup_before_migrating_legacy_file_db() -> Result<()> {
    let temp = tempfile::tempdir().expect("create temp dir");
    let db_path = temp.path().join("workbench.sqlite");
    {
        let conn = Connection::open(&db_path)?;
        conn.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE projects (
                id INTEGER PRIMARY KEY,
                game_root TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                engine TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE source_texts (
                id INTEGER PRIMARY KEY,
                source_language TEXT NOT NULL,
                normalized_text TEXT NOT NULL,
                visible_text TEXT NOT NULL,
                control_code_signature TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(source_language, normalized_text, control_code_signature)
            );
            CREATE TABLE occurrences (
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
            INSERT INTO projects (id, game_root, display_name, engine)
            VALUES (1, '/synthetic/game', 'Synthetic Game', 'mz');
            INSERT INTO source_texts (
                id, source_language, normalized_text, visible_text, control_code_signature
            )
            VALUES (1, 'en', 'Hello', 'Hello', '');
            INSERT INTO occurrences (
                project_id, source_text_id, file_path, json_path, entity_type, extraction_rule_id
            )
            VALUES (1, 1, 'data/Map001.json', '$.events[1]', 'generic.string', 'generic.string');
            ",
        )?;
    }

    let (db, report) = TranslationDb::open_with_schema_guard_report(&db_path)?;
    assert!(
        report.backup_path.is_some(),
        "legacy migration must create a backup"
    );
    assert_eq!(db.pragma_string("integrity_check")?, "ok");
    assert_eq!(db.foreign_key_violation_count()?, 0);
    assert!(!db.needs_schema_upgrade()?);
    drop(db);

    let backup_path = report.backup_path.expect("backup path");
    assert!(backup_path.starts_with(temp.path().join("backups")));
    let backup = Connection::open_with_flags(
        &backup_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let backup_check: String = backup.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    assert_eq!(backup_check, "ok");
    let legacy_occurrence_columns: i64 = backup.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('occurrences') WHERE name = 'active'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(
        legacy_occurrence_columns, 0,
        "backup must be the pre-migration snapshot"
    );
    let migrated = Connection::open(&db_path)?;
    let migrated_occurrence_columns: i64 = migrated.query_row(
        "SELECT COUNT(*) FROM pragma_table_info('occurrences') WHERE name = 'active'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(migrated_occurrence_columns, 1);

    Ok(())
}

#[test]
fn review_drafts_restore_in_queue_and_clear_after_save() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let source_id = db.upsert_source_text(&source_text("Emma"))?;
    db.insert_project_occurrence(
        project_id,
        &NewOccurrence {
            project_id: Some(project_id),
            source_text_id: source_id,
            file_path: "data/Actors.json".to_string(),
            json_path: "$[1].name".to_string(),
            entity_type: "actor".to_string(),
            event_id: None,
            page_index: None,
            command_index: None,
            command_code: None,
            parameter_index: None,
            object_key: Some("name".to_string()),
            extraction_rule_id: "actor.name".to_string(),
        },
    )?;
    let original = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "엠마".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "pending".to_string(),
        qa_state: "unchecked".to_string(),
        expected_updated_at: None,
    })?;
    db.upsert_review_draft(
        source_id,
        "ko",
        "에마",
        original.translation_updated_at.as_deref(),
    )?;

    let draft_row = db.review_queue_page(project_id, "ko", None, None, 20, 0)?.0;
    assert_eq!(draft_row[0].translated_text.as_deref(), Some("엠마"));
    assert_eq!(draft_row[0].draft_text.as_deref(), Some("에마"));
    assert!(draft_row[0].has_unapplied_draft);

    let saved = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "에마".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "pending".to_string(),
        qa_state: "unchecked".to_string(),
        expected_updated_at: original.translation_updated_at,
    })?;
    assert_eq!(saved.draft_text, None);
    assert!(!saved.has_unapplied_draft);
    assert_eq!(saved.translated_text.as_deref(), Some("에마"));

    Ok(())
}

#[test]
fn stale_running_translation_jobs_become_terminal_on_hydrate_repair() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let provider_run_id = db.start_provider_run(&NewProviderRun {
        provider: "local-openai-compatible".to_string(),
        model: Some("gemma".to_string()),
        request_settings_json: "{}".to_string(),
    })?;
    db.upsert_translation_job_progress(&TranslationJobProgressUpdate {
        provider_run_id,
        project_id: None,
        source_language: "en".to_string(),
        target_language: "ko".to_string(),
        checkpoint_path: "translation-ko.checkpoint.json".to_string(),
        status: "running".to_string(),
        completed_items: 20,
        failed_items: 2,
        total_items: 22,
        processed_batches: 11,
        total_batches: 11,
        split_batches: 0,
        parse_failed_items: 2,
        validation_failed_items: 0,
        skipped_items: 0,
        censored_retry_count: 0,
        item_eta_ms: None,
        batch_eta_ms: None,
        last_batch_elapsed_ms: Some(1000),
        avg_batch_elapsed_ms: Some(1000),
        current_batch_items: 0,
        elapsed_ms: 11_000,
        model: Some("gemma".to_string()),
        retry_pending_items: 0,
        recoverable_provider_failures: 0,
        final_failed_items: 2,
        provider_backoff_ms: None,
        effective_batch_size: 8,
        next_experiment_batch_size: 8,
        input_token_budget: 4096,
        speed_mode: "steady".to_string(),
        success_streak: 0,
        success_delay_floor_ms: 1500,
        next_delay_ms: None,
        failure_reason_counts_json: "{}".to_string(),
        adaptive_decision_reason: "adaptive: test".to_string(),
        legacy_checkpoint_only: false,
    })?;

    assert_eq!(db.interrupt_stale_translation_jobs()?, 1);
    let latest = db
        .latest_translation_job_summary(Some("ko"))?
        .expect("job remains readable");
    assert_eq!(latest.status, "completed_with_failures");

    Ok(())
}

#[test]
fn translation_upsert_updates_existing_target_language() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;

    let source_id =
        db.upsert_source_text(&source_text_with_signature("ja", "Hello", "Hello", ""))?;
    let provider_run_id = db.start_provider_run(&rpg_translator_core::NewProviderRun {
        provider: "fake".to_string(),
        model: Some("synthetic-v2".to_string()),
        request_settings_json: "{}".to_string(),
    })?;
    let first_id = db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "hello-ko-v1".to_string(),
        provider: "fake".to_string(),
        model: Some("synthetic".to_string()),
        provider_run_id: None,
        review_state: "pending".to_string(),
        qa_state: "unchecked".to_string(),
    })?;
    let second_id = db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "hello-ko-v2".to_string(),
        provider: "fake".to_string(),
        model: Some("synthetic-v2".to_string()),
        provider_run_id: Some(provider_run_id),
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
    })?;
    let saved = db.get_translation(source_id, "ko")?;

    assert_eq!(first_id, second_id);
    assert!(saved.is_some());
    if let Some(record) = saved {
        assert_eq!(record.translated_text, "hello-ko-v2");
        assert_eq!(record.provider_run_id, Some(provider_run_id));
        assert_eq!(record.review_state, "accepted");
        assert_eq!(record.qa_state, "passed");
    }

    Ok(())
}

#[test]
fn review_update_detects_conflicts_and_bulk_approves_clean_pending_rows() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let source_id = db.upsert_source_text(&source_text("White Underwear"))?;
    db.insert_project_occurrence(
        project_id,
        &NewOccurrence {
            project_id: Some(project_id),
            source_text_id: source_id,
            file_path: "data/Armors.json".to_string(),
            json_path: "$[26].name".to_string(),
            entity_type: "armor".to_string(),
            event_id: None,
            page_index: None,
            command_index: None,
            command_code: None,
            parameter_index: None,
            object_key: Some("name".to_string()),
            extraction_rule_id: "armor.name".to_string(),
        },
    )?;
    let row = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "흰색 속옷".to_string(),
        provider: "local-openai-compatible".to_string(),
        model: Some("gemma".to_string()),
        review_state: "pending".to_string(),
        qa_state: "unchecked".to_string(),
        expected_updated_at: None,
    })?;
    let updated = db.update_review_row(&ReviewUpdateRequest {
        translated_text: "흰 속옷".to_string(),
        expected_updated_at: row.translation_updated_at.clone(),
        ..ReviewUpdateRequest {
            source_text_id: source_id,
            target_language: "ko".to_string(),
            translated_text: String::new(),
            provider: "local-openai-compatible".to_string(),
            model: Some("gemma".to_string()),
            review_state: "pending".to_string(),
            qa_state: "unchecked".to_string(),
            expected_updated_at: None,
        }
    })?;

    let stale = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "오래된 수정".to_string(),
        provider: "local-openai-compatible".to_string(),
        model: Some("gemma".to_string()),
        review_state: "pending".to_string(),
        qa_state: "unchecked".to_string(),
        expected_updated_at: row.translation_updated_at,
    });
    assert!(
        stale
            .expect_err("stale update should fail")
            .to_string()
            .contains("changed")
    );

    let approved = db.bulk_approve_pending_review_rows(project_id, "ko", None)?;
    let approved_row = db.review_row_for_source(source_id, "ko")?;
    assert_eq!(updated.translated_text.as_deref(), Some("흰 속옷"));
    assert_eq!(approved.updated_count, 1);
    assert_eq!(approved_row.review_state, "accepted");

    Ok(())
}

#[test]
fn review_update_resolves_findings_only_after_machine_validation_passes() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let source_id = db.upsert_source_text(&source_text_with_signature(
        "en",
        "Hello \\V[1]",
        "Hello ",
        "\\V[1]",
    ))?;
    db.insert_qa_finding(&NewQaFinding {
        source_text_id: source_id,
        translation_id: None,
        target_language: Some("ko".to_string()),
        provider_run_id: None,
        finding_type: "translation-validation".to_string(),
        severity: "error".to_string(),
        message: "placeholder mismatch".to_string(),
        status: "open".to_string(),
        details_json: "{}".to_string(),
    })?;

    let invalid = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "안녕".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
        expected_updated_at: None,
    })?;
    assert_eq!(invalid.review_state, "pending");
    assert_eq!(invalid.qa_state, "needs-review");
    assert!(invalid.qa_finding_count > 0);
    let open_validation_message = db
        .qa_findings_for_source(source_id)?
        .into_iter()
        .find(|finding| {
            finding.status == "open" && finding.finding_type == "translation-validation"
        })
        .expect("open validation finding after invalid review update")
        .message;
    assert!(open_validation_message.contains("Hello \\V[1]"));
    assert!(open_validation_message.contains("안녕"));
    assert!(open_validation_message.contains("원문 제어코드 `\\V[1]`"));

    let valid = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "안녕 \\V[1]".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
        expected_updated_at: invalid.translation_updated_at,
    })?;
    assert_eq!(valid.review_state, "accepted");
    assert_eq!(valid.qa_state, "passed");
    assert_eq!(valid.qa_finding_count, 0);
    assert!(
        db.qa_findings_for_source(source_id)?
            .iter()
            .all(|finding| finding.status == "resolved")
    );

    Ok(())
}

#[test]
fn syntax_repair_dry_run_preserves_db_and_apply_resolves_safe_findings() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    let mut db = TranslationDb::open(file.path())?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let mut source = source_text("Line one\nLine two");
    source.unit_kind = "message_block".to_string();
    let source_id = db.upsert_source_text(&source)?;
    db.insert_occurrence(&NewOccurrence {
        project_id: Some(project_id),
        source_text_id: source_id,
        file_path: "data/CommonEvents.json".to_string(),
        json_path: "$[1].list[2]".to_string(),
        entity_type: "event_command".to_string(),
        event_id: Some(1),
        page_index: None,
        command_index: Some(2),
        command_code: Some(401),
        parameter_index: Some(0),
        object_key: None,
        extraction_rule_id: "event.message.block".to_string(),
    })?;
    let translation_id = db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "첫 줄\\n둘째 줄".to_string(),
        provider: "fake".to_string(),
        model: None,
        provider_run_id: None,
        review_state: "pending".to_string(),
        qa_state: "needs-review".to_string(),
    })?;
    db.insert_qa_finding(&NewQaFinding {
        source_text_id: source_id,
        translation_id: Some(translation_id),
        target_language: Some("ko".to_string()),
        provider_run_id: None,
        finding_type: "translation-validation".to_string(),
        severity: "error".to_string(),
        message: "제어코드가 원문과 다릅니다.".to_string(),
        status: "open".to_string(),
        details_json: "{}".to_string(),
    })?;

    let dry_run = db.repair_translation_syntax(project_id, "ko", false, None)?;
    assert_eq!(dry_run.total_open_validation_count, 1);
    assert_eq!(dry_run.safe_candidate_count, 1);
    assert_eq!(dry_run.applied_count, 0);
    assert_eq!(
        db.get_translation(source_id, "ko")?
            .expect("translation after dry-run")
            .translated_text,
        "첫 줄\\n둘째 줄"
    );
    assert_eq!(
        db.qa_findings_for_source(source_id)?
            .iter()
            .filter(|finding| finding.status == "open")
            .count(),
        1
    );

    let backup = db.create_verified_backup(file.path(), "syntax-repair")?;
    assert!(backup.exists());
    let applied = db.repair_translation_syntax(project_id, "ko", true, Some(&backup))?;
    assert_eq!(applied.applied_count, 1);
    assert_eq!(applied.resolved_finding_count, 1);
    db.verify_database_integrity()?;
    let updated = db
        .get_translation(source_id, "ko")?
        .expect("translation after apply");
    assert_eq!(updated.translated_text, "첫 줄\n둘째 줄");
    assert_eq!(updated.qa_state, "passed");
    let findings = db.qa_findings_for_source(source_id)?;
    assert!(findings.iter().any(|finding| {
        finding.finding_type == "translation-validation" && finding.status == "resolved"
    }));
    assert!(findings.iter().any(|finding| {
        finding.finding_type == "syntax-auto-repair" && finding.status == "resolved"
    }));

    Ok(())
}

#[test]
fn review_update_rejects_line_local_control_code_drift() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let source = "Hello \\V[1]\nWorld";
    let analysis = TextCodec::analyze(source);
    let source_id = db.upsert_source_text(&source_text_with_signature(
        "en",
        &analysis.normalized_text,
        &analysis.visible_text,
        &analysis.control_code_signature,
    ))?;

    let invalid = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "안녕\n세계 \\V[1]".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
        expected_updated_at: None,
    })?;

    assert_eq!(invalid.review_state, "pending");
    assert_eq!(invalid.qa_state, "needs-review");
    let messages = db
        .qa_findings_for_source(source_id)?
        .into_iter()
        .map(|finding| finding.message)
        .collect::<Vec<_>>();
    assert!(
        messages
            .iter()
            .any(|message| message.contains("줄별 제어코드 수가 원문과 다릅니다")),
        "expected line-local control-code finding, got {messages:?}"
    );

    Ok(())
}

#[test]
fn review_update_allows_message_block_control_code_line_reflow() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let source = "\\c[7]What else... Ah, how about we have \\Effect<Pulse>you get turned on by my\nvoice now?";
    let analysis = TextCodec::analyze(source);
    let mut source_row = source_text_with_signature(
        "en",
        &analysis.normalized_text,
        &analysis.visible_text,
        &analysis.control_code_signature,
    );
    source_row.unit_kind = "message_block".to_string();
    let source_id = db.upsert_source_text(&source_row)?;

    let updated = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text:
            "\\c[7]또 뭐가 있을까... 아, 내 목소리에\n\\Effect<Pulse>흥분하게 만들어볼까?"
                .to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
        expected_updated_at: None,
    })?;

    assert_eq!(updated.review_state, "accepted");
    assert_eq!(updated.qa_state, "passed");
    assert_eq!(updated.qa_finding_count, 0);
    assert!(db.qa_findings_for_source(source_id)?.is_empty());

    Ok(())
}

#[test]
fn review_update_allows_message_block_line_break_changes_for_runtime_wrapping() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let mut source = source_text("Line one\nLine two");
    source.unit_kind = "message_block".to_string();
    let source_id = db.upsert_source_text(&source)?;

    let updated = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "런타임에서 감쌀 긴 한 줄 번역".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
        expected_updated_at: None,
    })?;

    assert_eq!(updated.review_state, "accepted");
    assert_eq!(updated.qa_state, "passed");
    assert_eq!(updated.qa_finding_count, 0);
    assert!(db.qa_findings_for_source(source_id)?.is_empty());

    Ok(())
}

#[test]
fn review_update_allows_scroll_block_line_break_changes_for_runtime_wrapping() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let mut source = source_text("Line one\nLine two");
    source.unit_kind = "scroll_block".to_string();
    let source_id = db.upsert_source_text(&source)?;

    let updated = db.update_review_row(&ReviewUpdateRequest {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "런타임에서 감쌀 스크롤 번역".to_string(),
        provider: "manual-review".to_string(),
        model: None,
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
        expected_updated_at: None,
    })?;

    assert_eq!(updated.review_state, "accepted");
    assert_eq!(updated.qa_state, "passed");
    assert_eq!(updated.qa_finding_count, 0);
    assert!(db.qa_findings_for_source(source_id)?.is_empty());

    Ok(())
}

#[test]
fn batch_translation_transaction_rolls_back_when_one_row_fails() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let provider_run_id = db.start_provider_run(&rpg_translator_core::NewProviderRun {
        provider: "fake".to_string(),
        model: Some("synthetic".to_string()),
        request_settings_json: "{}".to_string(),
    })?;
    let source_id =
        db.upsert_source_text(&source_text_with_signature("ja", "Hello", "Hello", ""))?;

    let result = db.upsert_translations_in_transaction(&[
        NewTranslation {
            source_text_id: source_id,
            target_language: "ko".to_string(),
            translated_text: "valid".to_string(),
            provider: "fake".to_string(),
            model: Some("synthetic".to_string()),
            provider_run_id: Some(provider_run_id),
            review_state: "pending".to_string(),
            qa_state: "unchecked".to_string(),
        },
        NewTranslation {
            source_text_id: source_id + 999,
            target_language: "ko".to_string(),
            translated_text: "invalid".to_string(),
            provider: "fake".to_string(),
            model: Some("synthetic".to_string()),
            provider_run_id: Some(provider_run_id),
            review_state: "pending".to_string(),
            qa_state: "unchecked".to_string(),
        },
    ]);

    assert!(result.is_err());
    assert!(
        db.get_translation(source_id, "ko")?.is_none(),
        "valid row must roll back with the failed row"
    );

    Ok(())
}

fn assert_query_uses_index(conn: &Connection, sql: &str, index_name: &str) -> Result<()> {
    let mut statement = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(3))?;
    let mut plan_lines = Vec::new();
    for row in rows {
        plan_lines.push(row?);
    }
    let plan = plan_lines.join("\n");
    assert!(
        plan.contains(index_name),
        "expected query plan to use {index_name}, got:\n{plan}"
    );
    assert!(
        !plan.contains("SCAN "),
        "expected query plan to avoid a full scan, got:\n{plan}"
    );
    Ok(())
}
