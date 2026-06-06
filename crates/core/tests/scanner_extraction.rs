use std::fs;
use std::path::Path;

use rpg_translator_core::{Engine, GameLayoutKind, GameScanner, RpgMakerDetector, ScanOptions};
use serde_json::json;
use tempfile::tempdir;

fn write_text(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create fixture parent");
    }
    fs::write(path, text).expect("write fixture file");
}

fn write_json(path: &Path, value: serde_json::Value) {
    write_text(path, &format!("{value}\n"));
}

#[test]
fn detector_supports_direct_data_layout_and_mv_default() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture" }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");

    let detected = RpgMakerDetector::detect(temp.path()).expect("detect direct layout");

    assert_eq!(detected.engine, Engine::Mv);
    assert_eq!(detected.layout, GameLayoutKind::Direct);
    assert!(detected.data_path.ends_with("data"));
    assert!(detected.plugin_path.ends_with("js/plugins.js"));
}

#[test]
fn detector_supports_www_data_layout_and_mz_signature() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("www/data/System.json"),
        json!({ "gameTitle": "Fixture", "advanced": {}, "optAutosave": true }),
    );
    write_text(&temp.path().join("www/js/plugins.js"), "[]");

    let detected = RpgMakerDetector::detect(temp.path()).expect("detect www layout");

    assert_eq!(detected.engine, Engine::Mz);
    assert_eq!(detected.layout, GameLayoutKind::Www);
    assert!(detected.data_path.ends_with("www/data"));
    assert!(detected.plugin_path.ends_with("www/js/plugins.js"));
}

#[test]
fn detector_reports_actionable_missing_layout_error() {
    let temp = tempdir().expect("create temp dir");
    let error = RpgMakerDetector::detect(temp.path()).expect_err("missing layout fails");
    let message = error.to_string();

    assert!(message.contains("data"));
    assert!(message.contains("js/plugins.js"));
}

#[test]
fn scanner_extracts_schema_aware_event_and_database_text() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture" }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/Map001.json"),
        json!({
            "events": [
                null,
                {
                    "id": 7,
                    "name": "EV001",
                    "pages": [
                        {
                            "list": [
                                { "code": 101, "parameters": ["", 0, 0, 2, "\u{30cf}\u{30eb}"] },
                                { "code": 401, "parameters": ["\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\\N[1]"] },
                                { "code": 102, "parameters": [["\u{306f}\u{3044}", "\u{3044}\u{3044}\u{3048}"], 0, 0, 2, 0] },
                                { "code": 405, "parameters": ["\u{65e5}\u{8a18}\u{306e}\u{884c}"] },
                                { "code": 108, "parameters": ["\u{30b3}\u{30e1}\u{30f3}\u{30c8}"] },
                                { "code": 355, "parameters": ["$gameMessage.add('\u{30b9}\u{30af}\u{30ea}\u{30d7}\u{30c8}')"] }
                            ]
                        }
                    ]
                }
            ]
        }),
    );
    write_json(
        &temp.path().join("data/Actors.json"),
        json!([
            null,
            {
                "id": 1,
                "name": "\u{30a2}\u{30ea}\u{30b9}",
                "profile": "\u{52c7}\u{8005}",
                "note": "<meta:\u{30ce}\u{30fc}\u{30c8}>",
                "characterName": "Actor1",
                "debug": "plain debug"
            }
        ]),
    );

    let report = GameScanner::scan(temp.path(), ScanOptions::default()).expect("scan fixture");

    let accepted_raw: Vec<&str> = report
        .accepted
        .iter()
        .map(|item| item.raw_text.as_str())
        .collect();
    assert!(accepted_raw.contains(&"\u{30cf}\u{30eb}"));
    assert!(accepted_raw.contains(&"\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\\N[1]"));
    assert!(accepted_raw.contains(&"\u{306f}\u{3044}"));
    assert!(accepted_raw.contains(&"\u{3044}\u{3044}\u{3048}"));
    assert!(accepted_raw.contains(&"\u{65e5}\u{8a18}\u{306e}\u{884c}"));
    assert!(accepted_raw.contains(&"\u{30a2}\u{30ea}\u{30b9}"));
    assert!(accepted_raw.contains(&"\u{52c7}\u{8005}"));

    let hello = report
        .accepted
        .iter()
        .find(|item| item.raw_text == "\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}\\N[1]")
        .expect("message line occurrence");
    assert_eq!(hello.context.file_path, "data/Map001.json");
    assert_eq!(
        hello.context.json_path,
        "$.events[1].pages[0].list[1].parameters[0]"
    );
    assert_eq!(hello.context.entity_type, "event.command");
    assert_eq!(hello.context.event_id, Some(7));
    assert_eq!(hello.context.page_index, Some(0));
    assert_eq!(hello.context.command_index, Some(1));
    assert_eq!(hello.context.command_code, Some(401));
    assert_eq!(hello.context.parameter_index, Some(0));
    assert_eq!(hello.context.extraction_rule_id, "event.message.line");

    let rejected_reasons: Vec<&str> = report
        .rejected
        .iter()
        .map(|item| item.reason.as_str())
        .collect();
    assert!(rejected_reasons.contains(&"comment"));
    assert!(rejected_reasons.contains(&"script"));
    assert!(rejected_reasons.contains(&"note"));
    assert!(rejected_reasons.contains(&"asset"));
    assert!(rejected_reasons.contains(&"no-cjk"));
}

#[test]
fn scanner_rejects_korean_no_cjk_and_empty_and_skips_invalid_json() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture", "terms": { "basic": ["\u{3054}\u{30fc}\u{30eb}\u{30c9}"] } }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/Items.json"),
        json!([
            null,
            { "id": 1, "name": "\u{ac00}\u{b098}", "description": "Potion", "message1": "" }
        ]),
    );
    write_text(
        &temp.path().join("data/Broken.json"),
        "\u{feff}{ invalid json",
    );

    let report = GameScanner::scan(temp.path(), ScanOptions::default()).expect("scan fixture");

    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].file_path, "data/Broken.json");
    assert_eq!(report.skipped[0].reason, "invalid-json");

    let rejected_reasons: Vec<&str> = report
        .rejected
        .iter()
        .map(|item| item.reason.as_str())
        .collect();
    assert!(rejected_reasons.contains(&"korean"));
    assert!(rejected_reasons.contains(&"no-cjk"));
    assert!(rejected_reasons.contains(&"empty"));

    let accepted_raw: Vec<&str> = report
        .accepted
        .iter()
        .map(|item| item.raw_text.as_str())
        .collect();
    assert!(accepted_raw.contains(&"\u{3054}\u{30fc}\u{30eb}\u{30c9}"));
}
