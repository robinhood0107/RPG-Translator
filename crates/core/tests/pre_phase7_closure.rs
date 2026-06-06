use rpg_translator_core::{Engine, NewInstallRecord, NewProject, Result, TranslationDb};
use rusqlite::Connection;
use tempfile::NamedTempFile;

#[test]
fn install_records_persist_export_id_and_status_updates() -> Result<()> {
    let mut db = TranslationDb::open_in_memory()?;
    db.migrate()?;
    let project_id = db.upsert_project(&NewProject {
        game_root: "/synthetic/game".to_string(),
        display_name: "Synthetic Game".to_string(),
        engine: Engine::Mz,
    })?;
    let export_id = db.record_export(project_id, "ko", "/synthetic/export", "hash", 2)?;

    let install_id = db.record_install(&NewInstallRecord {
        project_id: Some(project_id),
        game_root: "/synthetic/game".to_string(),
        export_id: Some(export_id),
        backup_manifest_path: "/synthetic/game/js/plugins/rpg-translator/install-manifest.json"
            .to_string(),
        status: "installed".to_string(),
    })?;
    let installed = db
        .get_install_record(install_id)?
        .expect("install record exists");

    assert_eq!(installed.project_id, Some(project_id));
    assert_eq!(installed.export_id, Some(export_id));
    assert_eq!(installed.game_root, "/synthetic/game");
    assert_eq!(
        installed.backup_manifest_path,
        "/synthetic/game/js/plugins/rpg-translator/install-manifest.json"
    );
    assert_eq!(installed.status, "installed");

    db.update_install_status(install_id, "rolled-back")?;
    let rolled_back = db
        .get_install_record(install_id)?
        .expect("updated install record exists");

    assert_eq!(rolled_back.status, "rolled-back");

    Ok(())
}

#[test]
fn migration_adds_export_id_to_existing_installs_table() -> Result<()> {
    let file = NamedTempFile::new().expect("create temp db");
    {
        let conn = Connection::open(file.path()).expect("open temp sqlite");
        conn.execute_batch(
            "
            CREATE TABLE installs (
                id INTEGER PRIMARY KEY,
                project_id INTEGER,
                game_root TEXT NOT NULL,
                backup_manifest_path TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )
        .expect("create legacy installs table");
    }

    let mut db = TranslationDb::open(file.path())?;
    db.migrate()?;
    let install_id = db.record_install(&NewInstallRecord {
        project_id: None,
        game_root: "/synthetic/game".to_string(),
        export_id: Some(99),
        backup_manifest_path: "/synthetic/game/js/plugins/rpg-translator/install-manifest.json"
            .to_string(),
        status: "installed".to_string(),
    })?;
    let installed = db
        .get_install_record(install_id)?
        .expect("install record exists after migration");

    assert_eq!(installed.export_id, Some(99));

    Ok(())
}
