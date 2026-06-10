use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::process::Command;
use std::thread;

use rpg_translator_core::{NewTranslation, OverlayConfig, TranslationDb};
use serde_json::{Value, json};
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create parent");
    }
    fs::write(path, text).expect("write fixture");
}

fn make_game(root: &Path, plugins_js: &str) {
    write_text(
        &root.join("data/System.json"),
        r#"{"gameTitle":"Fixture","terms":{"basic":["Level","HP"]}}"#,
    );
    write_text(
        &root.join("data/Map001.json"),
        r#"{"events":[null,{"id":1,"pages":[{"list":[{"code":101,"indent":0,"parameters":["","","",0,"Emma"]},{"code":401,"indent":0,"parameters":["Emma looks at the locked gate."]},{"code":401,"indent":0,"parameters":["The city keeps its secrets."]},{"code":0,"indent":0,"parameters":[]}]}]}]}"#,
    );
    write_text(&root.join("js/plugins.js"), plugins_js);
}

fn make_export_bundle(root: &Path) {
    write_text(
        &root.join("manifest.json"),
        r#"{"schema_version":1,"project_id":1,"source_language":"ja","target_language":"ko","created_timestamp":"1","key_schema_version":"v1","cache_files":["cache.jsonl"],"record_count":1}"#,
    );
    write_text(
        &root.join("overlay-config.json"),
        &serde_json::to_string(&OverlayConfig::runtime_default()).expect("encode config"),
    );
    write_text(
        &root.join("cache.jsonl"),
        r#"{"cache_key":"ck:v1:0000000000000000000000000000000000000000000000000000000000000000","cache_aliases":["ck:v1:0000000000000000000000000000000000000000000000000000000000000000"],"source_text_id":1,"source_hash":"0000000000000000000000000000000000000000000000000000000000000000","source_language":"ja","target_language":"ko","normalized_text":"世界","visible_text":"世界","translation":"세계","control_code_signature":"","context_hash":null}"#,
    );
}

fn parse_project_id(stdout: &str) -> i64 {
    stdout
        .split_whitespace()
        .find_map(|part| part.strip_prefix("project_id="))
        .expect("project_id in output")
        .parse()
        .expect("numeric project id")
}

fn spawn_openai_fixture_server() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture provider");
    let address = listener.local_addr().expect("fixture provider address");
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            respond_to_openai_request(stream);
        }
    });
    address
}

fn respond_to_openai_request(mut stream: TcpStream) {
    let body = read_http_body(&mut stream);
    let request: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let content = request
        .pointer("/messages/1/content")
        .or_else(|| request.get("input"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let jsonl = content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|row| row.get("id").and_then(Value::as_i64))
        .map(|id| json!({ "id": id, "translation": format!("ko:{id}") }).to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let response = json!({
        "choices": [
            {
                "message": {
                    "content": jsonl
                }
            }
        ]
    })
    .to_string();
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        response.len()
    );
    stream
        .write_all(header.as_bytes())
        .and_then(|_| stream.write_all(response.as_bytes()))
        .expect("write fixture provider response");
}

fn read_http_body(stream: &mut TcpStream) -> Vec<u8> {
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk).expect("read fixture request");
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(header_end) = find_header_end(&buffer) {
            let headers = String::from_utf8_lossy(&buffer[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.strip_prefix("Content-Length:")
                        .or_else(|| line.strip_prefix("content-length:"))
                })
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or_default();
            let body_start = header_end + 4;
            if buffer.len().saturating_sub(body_start) >= content_length {
                return buffer[body_start..body_start + content_length].to_vec();
            }
        }
    }
    Vec::new()
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn approve_all_scanned_rows(db_path: &Path, project_id: i64) {
    let mut db = TranslationDb::open_with_schema_guard(db_path).expect("open scanned db");
    let rows = db
        .review_queue_rows(project_id, "ko", None)
        .expect("read review rows");
    assert!(!rows.is_empty(), "scan should create review rows");
    for row in rows {
        db.upsert_translation(&NewTranslation {
            source_text_id: row.source_text_id,
            target_language: "ko".to_string(),
            translated_text: format!("ko: {}", row.normalized_text),
            provider: "fixture".to_string(),
            model: Some("cli-test".to_string()),
            provider_run_id: None,
            review_state: "accepted".to_string(),
            qa_state: "passed".to_string(),
        })
        .expect("approve row");
    }
}

#[test]
fn cli_install_and_rollback_overlay_smoke() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_game(&game, original_plugins);
    make_export_bundle(&export);

    let install = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "install-overlay",
            "--game-root",
            game.to_str().expect("game path"),
            "--export-dir",
            export.to_str().expect("export path"),
            "--export-id",
            "7",
        ])
        .output()
        .expect("run install command");
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let manifest_path = game
        .join("js")
        .join("plugins")
        .join("rpg-translator")
        .join("install-manifest.json");
    assert!(manifest_path.is_file());
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    let rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            manifest_path.to_str().expect("manifest path"),
        ])
        .output()
        .expect("run rollback command");
    assert!(
        rollback.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
}

#[test]
fn cli_install_and_rollback_apply_without_local_allowance_flag() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("dontupload").join("game");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_game(&game, original_plugins);
    make_export_bundle(&export);

    let install = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "install-overlay",
            "--game-root",
            game.to_str().expect("game path"),
            "--export-dir",
            export.to_str().expect("export path"),
        ])
        .output()
        .expect("run install command");
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let manifest_path = game
        .join("js")
        .join("plugins")
        .join("rpg-translator")
        .join("install-manifest.json");
    let rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            manifest_path.to_str().expect("manifest path"),
        ])
        .output()
        .expect("run rollback command");
    assert!(
        rollback.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
}

#[test]
fn cli_rollback_rejects_manifest_copied_outside_its_game_root() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let copied_game = temp.path().join("copied-game");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_game(&game, original_plugins);
    make_export_bundle(&export);

    let install = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "install-overlay",
            "--game-root",
            game.to_str().expect("game path"),
            "--export-dir",
            export.to_str().expect("export path"),
        ])
        .output()
        .expect("run install command");
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let support_dir = game.join("js").join("plugins").join("rpg-translator");
    let copied_support_dir = copied_game
        .join("js")
        .join("plugins")
        .join("rpg-translator");
    fs::create_dir_all(&copied_support_dir).expect("create copied support dir");
    fs::copy(
        support_dir.join("install-manifest.json"),
        copied_support_dir.join("install-manifest.json"),
    )
    .expect("copy manifest");

    let stale_rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            copied_support_dir
                .join("install-manifest.json")
                .to_str()
                .expect("manifest path"),
        ])
        .output()
        .expect("run stale rollback command");
    assert!(
        !stale_rollback.status.success(),
        "stale rollback unexpectedly succeeded: {}",
        String::from_utf8_lossy(&stale_rollback.stdout)
    );
    assert!(
        String::from_utf8_lossy(&stale_rollback.stderr).contains("outside game root"),
        "stale rollback should explain path mismatch: {}",
        String::from_utf8_lossy(&stale_rollback.stderr)
    );
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read original plugins")
            .contains("\"name\": \"RPGTranslator\""),
        "stale rollback must not modify the original installed game"
    );

    let rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            support_dir
                .join("install-manifest.json")
                .to_str()
                .expect("manifest path"),
        ])
        .output()
        .expect("run rollback command");
    assert!(
        rollback.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
}

#[test]
fn cli_scan_game_writes_project_db_and_reports_block_units() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let db = temp.path().join("workbench.sqlite");
    make_game(&game, "var $plugins = [];");

    let output = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "scan-game",
            "--game-root",
            game.to_str().expect("game path"),
            "--db",
            db.to_str().expect("db path"),
            "--source-language",
            "en",
        ])
        .output()
        .expect("run scan command");

    assert!(
        output.status.success(),
        "scan failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("scanned project_id="));
    assert!(stdout.contains("source_texts="));
    assert!(stdout.contains("occurrences="));
    assert!(db.is_file());
}

#[test]
fn cli_export_bundle_writes_verified_runtime_cache_bundle() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let db = temp.path().join("workbench.sqlite");
    let export = temp.path().join("export");
    make_game(&game, "var $plugins = [];");

    let scan = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "scan-game",
            "--game-root",
            game.to_str().expect("game path"),
            "--db",
            db.to_str().expect("db path"),
            "--source-language",
            "en",
        ])
        .output()
        .expect("run scan command");
    assert!(
        scan.status.success(),
        "scan failed: {}",
        String::from_utf8_lossy(&scan.stderr)
    );
    let project_id = parse_project_id(&String::from_utf8_lossy(&scan.stdout));
    approve_all_scanned_rows(&db, project_id);

    let output = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "export-bundle",
            "--db",
            db.to_str().expect("db path"),
            "--project-id",
            &project_id.to_string(),
            "--target-language",
            "ko",
            "--export-dir",
            export.to_str().expect("export path"),
        ])
        .output()
        .expect("run export command");

    assert!(
        output.status.success(),
        "export failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("exported export_id="));
    assert!(stdout.contains("included="));
    assert!(export.join("manifest.json").is_file());
    assert!(export.join("overlay-config.json").is_file());
    assert!(export.join("cache.jsonl").is_file());
}

#[test]
fn cli_translate_local_pretranslates_scanned_rows_for_export() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let db = temp.path().join("workbench.sqlite");
    let export = temp.path().join("export");
    make_game(&game, "var $plugins = [];");
    let provider_address = spawn_openai_fixture_server();

    let scan = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "scan-game",
            "--game-root",
            game.to_str().expect("game path"),
            "--db",
            db.to_str().expect("db path"),
            "--source-language",
            "en",
        ])
        .output()
        .expect("run scan command");
    assert!(
        scan.status.success(),
        "scan failed: {}",
        String::from_utf8_lossy(&scan.stderr)
    );
    let project_id = parse_project_id(&String::from_utf8_lossy(&scan.stdout));

    let translate = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "translate-local",
            "--db",
            db.to_str().expect("db path"),
            "--project-id",
            &project_id.to_string(),
            "--source-language",
            "en",
            "--target-language",
            "ko",
            "--base-url",
            &format!("http://{provider_address}"),
            "--model",
            "fixture-model",
            "--batch-size",
            "8",
            "--review-state",
            "accepted",
        ])
        .output()
        .expect("run translate command");
    assert!(
        translate.status.success(),
        "translate failed stdout={} stderr={}",
        String::from_utf8_lossy(&translate.stdout),
        String::from_utf8_lossy(&translate.stderr)
    );
    let stdout = String::from_utf8_lossy(&translate.stdout);
    assert!(stdout.contains("translated status="));
    assert!(stdout.contains("accepted="));

    let output = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "export-bundle",
            "--db",
            db.to_str().expect("db path"),
            "--project-id",
            &project_id.to_string(),
            "--target-language",
            "ko",
            "--export-dir",
            export.to_str().expect("export path"),
        ])
        .output()
        .expect("run export command");
    assert!(
        output.status.success(),
        "export failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cache = fs::read_to_string(export.join("cache.jsonl")).expect("read cache");
    assert!(cache.contains("ko:"));
}

#[test]
fn cli_headless_usable_loop_translates_exports_installs_and_rolls_back() {
    let temp = tempdir().expect("create temp dir");
    let game = temp.path().join("game");
    let db = temp.path().join("workbench.sqlite");
    let export = temp.path().join("export");
    let original_plugins = "var $plugins = [];";
    make_game(&game, original_plugins);
    let provider_address = spawn_openai_fixture_server();

    let scan = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "scan-game",
            "--game-root",
            game.to_str().expect("game path"),
            "--db",
            db.to_str().expect("db path"),
            "--source-language",
            "en",
        ])
        .output()
        .expect("run scan command");
    assert!(
        scan.status.success(),
        "scan failed: {}",
        String::from_utf8_lossy(&scan.stderr)
    );
    let project_id = parse_project_id(&String::from_utf8_lossy(&scan.stdout));

    let translate = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "translate-local",
            "--db",
            db.to_str().expect("db path"),
            "--project-id",
            &project_id.to_string(),
            "--source-language",
            "en",
            "--target-language",
            "ko",
            "--base-url",
            &format!("http://{provider_address}"),
            "--model",
            "fixture-model",
            "--batch-size",
            "8",
            "--review-state",
            "accepted",
        ])
        .output()
        .expect("run translate command");
    assert!(
        translate.status.success(),
        "translate failed: {}",
        String::from_utf8_lossy(&translate.stderr)
    );

    let export_result = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "export-bundle",
            "--db",
            db.to_str().expect("db path"),
            "--project-id",
            &project_id.to_string(),
            "--target-language",
            "ko",
            "--export-dir",
            export.to_str().expect("export path"),
        ])
        .output()
        .expect("run export command");
    assert!(
        export_result.status.success(),
        "export failed: {}",
        String::from_utf8_lossy(&export_result.stderr)
    );

    let install = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "install-overlay",
            "--game-root",
            game.to_str().expect("game path"),
            "--export-dir",
            export.to_str().expect("export path"),
            "--project-id",
            &project_id.to_string(),
        ])
        .output()
        .expect("run install command");
    assert!(
        install.status.success(),
        "install failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );

    let support_dir = game.join("js").join("plugins").join("rpg-translator");
    let installed_cache =
        fs::read_to_string(support_dir.join("cache.jsonl")).expect("read installed cache");
    assert!(installed_cache.contains("ko:"));
    assert!(
        fs::read_to_string(game.join("js/plugins.js"))
            .expect("read plugins")
            .contains("\"name\": \"RPGTranslator\"")
    );

    let rollback = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .args([
            "rollback-overlay",
            "--manifest",
            support_dir
                .join("install-manifest.json")
                .to_str()
                .expect("manifest path"),
        ])
        .output()
        .expect("run rollback command");
    assert!(
        rollback.status.success(),
        "rollback failed: {}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        fs::read_to_string(game.join("js/plugins.js")).expect("read restored plugins"),
        original_plugins
    );
    assert!(!support_dir.join("cache.jsonl").exists());
}

#[test]
fn cli_rejects_missing_required_install_args() {
    let output = Command::new(env!("CARGO_BIN_EXE_rpg-translator"))
        .arg("install-overlay")
        .output()
        .expect("run invalid install command");

    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--game-root"));
}
