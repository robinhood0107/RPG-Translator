use rpg_translator_core::{
    CacheKeyBuilder, CacheKeyParts, Engine, NewOccurrence, NewProject, NewSourceText,
    NewTranslation, Result, TextCodec, TranslationDb,
};
use rusqlite::Connection;
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

    let source = NewSourceText {
        source_language: "ja".to_string(),
        normalized_text: "\\C[2]Hello".to_string(),
        visible_text: "Hello".to_string(),
        control_code_signature: "\\C[2]".to_string(),
    };
    let source_id = db.upsert_source_text(&source)?;
    let duplicate_id = db.upsert_source_text(&source)?;
    let different_signature_id = db.upsert_source_text(&NewSourceText {
        control_code_signature: "\\N[1]".to_string(),
        ..source
    })?;

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
fn translation_upsert_updates_existing_target_language() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;

    let source_id = db.upsert_source_text(&NewSourceText {
        source_language: "ja".to_string(),
        normalized_text: "Hello".to_string(),
        visible_text: "Hello".to_string(),
        control_code_signature: String::new(),
    })?;
    let first_id = db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "hello-ko-v1".to_string(),
        provider: "fake".to_string(),
        model: Some("synthetic".to_string()),
        review_state: "pending".to_string(),
        qa_state: "unchecked".to_string(),
    })?;
    let second_id = db.upsert_translation(&NewTranslation {
        source_text_id: source_id,
        target_language: "ko".to_string(),
        translated_text: "hello-ko-v2".to_string(),
        provider: "fake".to_string(),
        model: Some("synthetic-v2".to_string()),
        review_state: "accepted".to_string(),
        qa_state: "passed".to_string(),
    })?;
    let saved = db.get_translation(source_id, "ko")?;

    assert_eq!(first_id, second_id);
    assert!(saved.is_some());
    if let Some(record) = saved {
        assert_eq!(record.translated_text, "hello-ko-v2");
        assert_eq!(record.review_state, "accepted");
        assert_eq!(record.qa_state, "passed");
    }

    Ok(())
}
