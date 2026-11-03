use rpg_translator_core::{
    CacheKeyBuilder, CacheKeyParts, Engine, FakeProvider, NewProject, RuntimeMailbox,
    RuntimeRequest, RuntimeSession, TextCodec, TranslationDb, translate_runtime_request,
};

fn session(db: &mut TranslationDb) -> RuntimeSession {
    db.migrate().expect("migrate");
    let project_id = db
        .upsert_project(&NewProject {
            game_root: "/tmp/game".into(),
            display_name: "Game".into(),
            engine: Engine::Mz,
        })
        .expect("project");
    RuntimeSession {
        project_id,
        engine: Engine::Mz,
        source_language: "en".into(),
        target_language: "ko".into(),
    }
}

fn request(text: &str) -> RuntimeRequest {
    let analysis = TextCodec::analyze(text);
    RuntimeRequest {
        schema_version: 1,
        cache_key: CacheKeyBuilder::build(&CacheKeyParts {
            engine: Engine::Mz,
            source_language: "en".into(),
            target_language: "ko".into(),
            normalized_text: analysis.normalized_text,
            control_code_signature: analysis.control_code_signature,
            context_hash: None,
        }),
        text: text.into(),
        engine: "mz".into(),
        source_language: "en".into(),
        target_language: "ko".into(),
        context_hash: None,
        adapter: "window-text".into(),
        kind: "drawTextEx".into(),
        priority: 750,
        window_type: None,
    }
}

#[test]
fn runtime_miss_is_translated_validated_and_reused_without_a_second_model_call() {
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let mut provider = FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"¤설정"}"#.into()]);
    let request = request("\\C[1]CONFIG");
    let first =
        translate_runtime_request(&mut db, &mut provider, &session, &request).expect("translate");
    assert_eq!(first.translation.as_deref(), Some("\\C[1]설정"));
    let second =
        translate_runtime_request(&mut db, &mut provider, &session, &request).expect("cached");
    assert_eq!(first.translation, second.translation);
    assert_eq!(provider.requests().len(), 1);
    assert!(
        provider.requests()[0]
            .instruction
            .as_deref()
            .expect("context")
            .contains("game interface")
    );
    assert_eq!(
        db.review_queue_rows(session.project_id, "ko", None)
            .expect("review")
            .len(),
        1
    );
}

#[test]
fn runtime_request_rejects_key_and_language_mismatch_before_writing_the_database() {
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let mut provider = FakeProvider::from_outputs(vec![]);
    let mut bad = request("CONFIG");
    bad.cache_key = "../../outside".into();
    assert!(translate_runtime_request(&mut db, &mut provider, &session, &bad).is_err());
    let mut bad = request("CONFIG");
    bad.target_language = "ja".into();
    assert!(translate_runtime_request(&mut db, &mut provider, &session, &bad).is_err());
    assert!(provider.requests().is_empty());
    assert!(
        db.review_queue_rows(session.project_id, "ko", None)
            .expect("review")
            .is_empty()
    );
}

#[test]
fn mailbox_releases_its_os_lock_and_writes_only_validated_replies() {
    let temp = tempfile::tempdir().expect("temp");
    let mut mailbox = RuntimeMailbox::open(temp.path()).expect("worker");
    assert!(RuntimeMailbox::open(temp.path()).is_err());
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let request = request("CONFIG");
    let name = format!(
        "{}.json",
        request.cache_key.strip_prefix("ck:v1:").expect("key")
    );
    std::fs::write(
        temp.path().join("requests").join(&name),
        serde_json::to_vec(&request).expect("json"),
    )
    .expect("request");
    let mut provider = FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"설정"}"#.into()]);
    assert_eq!(
        mailbox
            .process_pending(&mut db, &mut provider, &session)
            .expect("process"),
        1
    );
    let reply: serde_json::Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("responses").join(&name)).expect("reply"),
    )
    .expect("json");
    assert_eq!(reply["translation"], "설정");
    assert!(!temp.path().join("requests").join(name).exists());
    drop(mailbox);
    assert!(RuntimeMailbox::open(temp.path()).is_ok());
}

#[test]
fn runtime_export_can_install_before_any_translation_is_cached() {
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let temp = tempfile::tempdir().expect("temp");
    let report = rpg_translator_core::ExportBuilder::export_runtime_project(
        &mut db,
        session.project_id,
        "en",
        "ko",
        temp.path(),
    )
    .expect("runtime bundle");
    assert_eq!(report.included_count, 0);
    rpg_translator_core::ExportBuilder::verify_bundle(temp.path()).expect("valid bundle");
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("manifest.json")).expect("manifest"),
    )
    .expect("json");
    assert_eq!(manifest["source_language"], "en");
    assert_eq!(manifest["record_count"], 0);
    let config: serde_json::Value = serde_json::from_slice(
        &std::fs::read(temp.path().join("overlay-config.json")).expect("config"),
    )
    .expect("json");
    assert_eq!(config["runtime_translation_enabled"], true);
}

#[test]
fn uppercase_ui_labels_are_not_misclassified_as_technical_tokens() {
    for label in ["ON", "OFF", "SAVE", "LOAD", "CONFIG", "NEW QUEST", "BATTLE"] {
        assert!(
            !rpg_translator_core::is_allowed_technical_token(label),
            "{label}"
        );
    }
    for token in ["HP", "ATK", "DEF", "BGM", "GPU", "[Enter]", "actor_id"] {
        assert!(
            rpg_translator_core::is_allowed_technical_token(token),
            "{token}"
        );
    }
}

#[test]
fn stopping_during_processing_keeps_request_for_resume_without_a_second_model_call() {
    let temp = tempfile::tempdir().expect("temp");
    let mut mailbox = RuntimeMailbox::open(temp.path()).expect("worker");
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let request = request("CONFIG");
    let name = format!(
        "{}.json",
        request.cache_key.strip_prefix("ck:v1:").expect("key")
    );
    let file = temp.path().join("requests").join(&name);
    std::fs::write(&file, serde_json::to_vec(&request).expect("json")).expect("request");
    let mut provider = FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"설정"}"#.into()]);
    let checks = std::cell::Cell::new(0);
    assert_eq!(
        mailbox
            .process_pending_with_control(&mut db, &mut provider, &session, || {
                let count = checks.get();
                checks.set(count + 1);
                count > 0
            })
            .expect("stop"),
        0
    );
    assert!(file.exists());
    assert!(!temp.path().join("responses").join(&name).exists());
    assert_eq!(
        mailbox
            .process_pending(&mut db, &mut provider, &session)
            .expect("resume"),
        1
    );
    assert!(!file.exists());
    assert_eq!(provider.requests().len(), 1);
}

#[test]
fn rescanning_static_files_keeps_runtime_observations_visible_for_review_and_export() {
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let mut provider = FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"설정"}"#.into()]);
    translate_runtime_request(&mut db, &mut provider, &session, &request("CONFIG"))
        .expect("translate");
    db.persist_project_scan_occurrences(session.project_id, 0, &[])
        .expect("rescan");
    assert_eq!(
        db.review_queue_rows(session.project_id, "ko", None)
            .expect("review")
            .len(),
        1
    );
    assert_eq!(
        db.translation_scope_source_text_ids(Some(session.project_id), "en")
            .expect("scope")
            .len(),
        1
    );
}

#[test]
fn mailbox_can_resume_after_a_temporary_directory_io_failure() {
    let temp = tempfile::tempdir().expect("temp");
    let mut mailbox = RuntimeMailbox::open(temp.path()).expect("worker");
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let mut provider = FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"설정"}"#.into()]);
    std::fs::remove_dir(temp.path().join("requests")).expect("remove empty requests");
    assert!(
        mailbox
            .process_pending(&mut db, &mut provider, &session)
            .is_err()
    );
    std::fs::create_dir(temp.path().join("requests")).expect("restore requests");
    let request = request("CONFIG");
    let name = format!(
        "{}.json",
        request.cache_key.strip_prefix("ck:v1:").expect("key")
    );
    std::fs::write(
        temp.path().join("requests").join(name),
        serde_json::to_vec(&request).expect("json"),
    )
    .expect("request");
    assert_eq!(
        mailbox
            .process_pending(&mut db, &mut provider, &session)
            .expect("resume"),
        1
    );
}

#[test]
fn new_request_for_a_key_is_not_removed_with_the_previous_inflight_request() {
    use rpg_translator_core::{ProviderBatchRequest, ProviderBatchResponse, ProviderClient};
    struct RacingProvider {
        inner: FakeProvider,
        path: std::path::PathBuf,
        request: Vec<u8>,
    }
    impl ProviderClient for RacingProvider {
        fn provider_name(&self) -> &str {
            "racing-fake"
        }
        fn model_name(&self) -> Option<&str> {
            None
        }
        fn translate_batch(
            &mut self,
            request: &ProviderBatchRequest,
        ) -> rpg_translator_core::Result<ProviderBatchResponse> {
            std::fs::write(&self.path, &self.request).expect("new game request");
            self.inner.translate_batch(request)
        }
    }
    let temp = tempfile::tempdir().expect("temp");
    let mut mailbox = RuntimeMailbox::open(temp.path()).expect("worker");
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let request = request("CONFIG");
    let name = format!(
        "{}.json",
        request.cache_key.strip_prefix("ck:v1:").expect("key")
    );
    let path = temp.path().join("requests").join(&name);
    let bytes = serde_json::to_vec(&request).expect("json");
    std::fs::write(&path, &bytes).expect("request");
    let mut provider = RacingProvider {
        inner: FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"설정"}"#.into()]),
        path: path.clone(),
        request: bytes,
    };
    assert_eq!(
        mailbox
            .process_pending(&mut db, &mut provider, &session)
            .expect("first"),
        1
    );
    assert!(path.exists());
    std::fs::remove_file(temp.path().join("responses").join(name))
        .expect("new game invalidates old reply");
    assert_eq!(
        mailbox
            .process_pending(&mut db, &mut provider, &session)
            .expect("second"),
        1
    );
    assert!(!path.exists());
    assert_eq!(provider.inner.requests().len(), 1);
}

#[test]
fn interrupted_processing_files_are_recovered_after_reopening_the_worker() {
    let temp = tempfile::tempdir().expect("temp");
    let worker = RuntimeMailbox::open(temp.path()).expect("worker");
    let request = request("CONFIG");
    let name = format!(
        "{}.json",
        request.cache_key.strip_prefix("ck:v1:").expect("key")
    );
    std::fs::write(
        temp.path().join("processing").join(&name),
        serde_json::to_vec(&request).expect("json"),
    )
    .expect("inflight");
    drop(worker);
    let _worker = RuntimeMailbox::open(temp.path()).expect("restart");
    assert!(temp.path().join("requests").join(&name).exists());
    assert!(!temp.path().join("processing").join(name).exists());
}

#[test]
fn runtime_counter_placeholders_are_validated_and_retried_before_persistence() {
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let mut provider = FakeProvider::from_outputs(vec![
        r#"{"id":1,"translation":"골드"}"#.into(),
        r#"{"id":1,"translation":"골드: {{RPGT_NUM_0}}"}"#.into(),
    ]);
    let reply = translate_runtime_request(
        &mut db,
        &mut provider,
        &session,
        &request("Gold: {{RPGT_NUM_0}}"),
    )
    .expect("translate");
    assert_eq!(provider.requests().len(), 2);
    assert_eq!(reply.translation.as_deref(), Some("골드: {{RPGT_NUM_0}}"));
    assert!(TextCodec::runtime_number_tokens_match(
        "{{RPGT_NUM_0}} / {{RPGT_NUM_1}}",
        "{{RPGT_NUM_1}} / {{RPGT_NUM_0}}"
    ));
    assert!(!TextCodec::runtime_number_tokens_match(
        "{{RPGT_NUM_0}}",
        "{{RPGT_NUM_0}} {{RPGT_NUM_0}}"
    ));
}

#[test]
fn technical_counter_templates_keep_identity_translations_without_retries() {
    for text in ["HP{{RPGT_NUM_0}}", "MP{{RPGT_NUM_0}}", "EXP{{RPGT_NUM_0}}"] {
        assert!(
            rpg_translator_core::is_allowed_technical_token(text),
            "{text}"
        );
    }
    assert!(!rpg_translator_core::is_allowed_technical_token(
        "SAVE {{RPGT_NUM_0}}"
    ));
    let mut db = TranslationDb::open_in_memory().expect("db");
    let session = session(&mut db);
    let mut provider =
        FakeProvider::from_outputs(vec![r#"{"id":1,"translation":"HP{{RPGT_NUM_0}}"}"#.into()]);
    let reply = translate_runtime_request(
        &mut db,
        &mut provider,
        &session,
        &request("HP{{RPGT_NUM_0}}"),
    )
    .expect("technical");
    assert!(reply.unchanged_allowed);
    assert_eq!(provider.requests().len(), 1);
}
