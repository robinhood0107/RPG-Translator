use std::fs;
use std::path::Path;

use rpg_translator_core::{
    Engine, GameLayoutKind, GameScanner, RpgMakerDetector, ScanOptions, ScanProgressEvent,
};
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
    assert!(rejected_reasons.contains(&"wrong-source-language"));
}

#[test]
fn scanner_visits_unhandled_nested_json_strings_without_duplicating_schema_hits() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture", "advanced": {}, "optAutosave": true }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/Map001.json"),
        json!({
            "events": [
                null,
                {
                    "id": 1,
                    "name": "EditorOnlyName",
                    "pages": [
                        {
                            "list": [
                                { "code": 401, "parameters": ["Hello there."] }
                            ]
                        }
                    ]
                }
            ]
        }),
    );
    write_json(
        &temp.path().join("data/PluginConfig.json"),
        json!({
            "menu": {
                "caption": "Secret door",
                "nested": ["Inspect the wall"]
            }
        }),
    );

    let report = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "en".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan generic fallback fixture");
    let accepted_raw = accepted_raw(&report);

    assert_eq!(
        report
            .accepted
            .iter()
            .filter(|item| item.raw_text == "Hello there.")
            .count(),
        1
    );
    assert!(accepted_raw.contains(&"Secret door"));
    assert!(accepted_raw.contains(&"Inspect the wall"));

    let fallback = report
        .accepted
        .iter()
        .find(|item| item.raw_text == "Secret door")
        .expect("generic string fallback occurrence");
    assert_eq!(fallback.context.file_path, "data/PluginConfig.json");
    assert_eq!(fallback.context.json_path, "$.menu.caption");
    assert_eq!(fallback.context.entity_type, "generic.string");
    assert_eq!(fallback.context.extraction_rule_id, "generic.string");
}

#[test]
fn scanner_rejects_generic_comment_like_strings_like_reference_precacher() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture", "advanced": {}, "optAutosave": true }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/PluginConfig.json"),
        json!({ "line": "Use // to comment" }),
    );

    let report = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "en".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan comment fixture");

    assert!(
        report
            .accepted
            .iter()
            .all(|item| item.raw_text != "Use // to comment")
    );
    assert!(
        report
            .rejected
            .iter()
            .any(|item| { item.raw_text == "Use // to comment" && item.reason == "comment" })
    );
}

#[test]
fn scanner_extracts_common_event_commands_with_event_metadata() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture", "advanced": {}, "optAutosave": true }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/CommonEvents.json"),
        json!([
            null,
            {
                "id": 103,
                "name": "Nico_Handler",
                "list": [
                    { "code": 101, "parameters": ["", 0, 0, 2, "Nico"] },
                    { "code": 401, "parameters": ["Do you have something you need... err... Elly? "] },
                    { "code": 102, "parameters": [["Yes", "No"], 0, 0, 2, 0] },
                    { "code": 405, "parameters": ["Scrolling common event text."] }
                ]
            }
        ]),
    );

    let report = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "en".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan common events fixture");
    let accepted_raw = accepted_raw(&report);

    assert!(accepted_raw.contains(&"Nico"));
    assert!(accepted_raw.contains(&"Do you have something you need... err... Elly? "));
    assert!(accepted_raw.contains(&"Yes"));
    assert!(accepted_raw.contains(&"No"));
    assert!(accepted_raw.contains(&"Scrolling common event text."));

    let line = report
        .accepted
        .iter()
        .find(|item| item.raw_text == "Do you have something you need... err... Elly? ")
        .expect("common event message line occurrence");
    assert_eq!(line.context.file_path, "data/CommonEvents.json");
    assert_eq!(line.context.json_path, "$[1].list[1].parameters[0]");
    assert_eq!(line.context.entity_type, "event.command");
    assert_eq!(line.context.event_id, Some(103));
    assert_eq!(line.context.page_index, None);
    assert_eq!(line.context.command_index, Some(1));
    assert_eq!(line.context.command_code, Some(401));
    assert_eq!(line.context.parameter_index, Some(0));
    assert_eq!(line.context.extraction_rule_id, "event.message.line");
}

#[test]
fn scanner_filters_text_by_selected_source_language_profile() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture", "terms": { "basic": ["Gold", "\u{3054}\u{30fc}\u{30eb}\u{30c9}", "\u{4e16}\u{754c}", "\u{ac00}\u{b098}"] } }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/Items.json"),
        json!([
            null,
            { "id": 1, "name": "\u{ac00}\u{b098}", "description": "Potion", "message1": "" },
            { "id": 2, "name": "\u{4e16}\u{754c}", "description": "Plain English" },
            { "id": 3, "name": "\u{30c6}\u{30b9}\u{30c8}", "description": "English only" }
        ]),
    );
    write_text(
        &temp.path().join("data/Broken.json"),
        "\u{feff}{ invalid json",
    );

    let english = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "en".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan english profile");
    let english_raw = accepted_raw(&english);
    assert!(english_raw.contains(&"Gold"));
    assert!(english_raw.contains(&"Potion"));
    assert!(english_raw.contains(&"Plain English"));
    assert!(english_raw.contains(&"English only"));
    assert!(!english_raw.contains(&"\u{3054}\u{30fc}\u{30eb}\u{30c9}"));
    assert!(!english_raw.contains(&"\u{4e16}\u{754c}"));
    assert!(!english_raw.contains(&"\u{ac00}\u{b098}"));
    assert!(!english_raw.contains(&"\u{30c6}\u{30b9}\u{30c8}"));

    let japanese = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "ja".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan japanese profile");
    let japanese_raw = accepted_raw(&japanese);
    assert!(japanese_raw.contains(&"\u{3054}\u{30fc}\u{30eb}\u{30c9}"));
    assert!(japanese_raw.contains(&"\u{4e16}\u{754c}"));
    assert!(japanese_raw.contains(&"\u{30c6}\u{30b9}\u{30c8}"));
    assert!(!japanese_raw.contains(&"Gold"));
    assert!(!japanese_raw.contains(&"\u{ac00}\u{b098}"));

    let chinese = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "zh".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan chinese profile");
    let chinese_raw = accepted_raw(&chinese);
    assert!(chinese_raw.contains(&"\u{3054}\u{30fc}\u{30eb}\u{30c9}"));
    assert!(chinese_raw.contains(&"\u{4e16}\u{754c}"));
    assert!(chinese_raw.contains(&"\u{30c6}\u{30b9}\u{30c8}"));
    assert!(!chinese_raw.contains(&"Gold"));
    assert!(!chinese_raw.contains(&"\u{ac00}\u{b098}"));

    let korean = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "ko".to_string(),
            disable_cjk_filter: false,
        },
    )
    .expect("scan korean profile");
    let korean_raw = accepted_raw(&korean);
    assert!(korean_raw.contains(&"\u{ac00}\u{b098}"));
    assert!(!korean_raw.contains(&"Gold"));
    assert!(!korean_raw.contains(&"\u{3054}\u{30fc}\u{30eb}\u{30c9}"));
    assert!(!korean_raw.contains(&"\u{4e16}\u{754c}"));
    assert!(!korean_raw.contains(&"\u{30c6}\u{30b9}\u{30c8}"));

    assert_eq!(japanese.skipped.len(), 1);
    assert_eq!(japanese.skipped[0].file_path, "data/Broken.json");
    assert_eq!(japanese.skipped[0].reason, "invalid-json");

    let rejected_reasons: Vec<&str> = japanese
        .rejected
        .iter()
        .map(|item| item.reason.as_str())
        .collect();
    assert!(rejected_reasons.contains(&"wrong-source-language"));
    assert!(rejected_reasons.contains(&"empty"));
}

#[test]
fn scanner_accepts_english_text_when_cjk_filter_is_disabled() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({ "gameTitle": "Fixture", "terms": { "basic": ["Gold"] } }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/Map001.json"),
        json!({
            "events": [
                null,
                {
                    "id": 1,
                    "pages": [
                        {
                            "list": [
                                { "code": 401, "parameters": ["Hello there."] },
                                { "code": 102, "parameters": [["Yes", "No"], 0, 0, 2, 0] }
                            ]
                        }
                    ]
                }
            ]
        }),
    );

    let report = GameScanner::scan(
        temp.path(),
        ScanOptions {
            source_language: "en".to_string(),
            disable_cjk_filter: true,
        },
    )
    .expect("scan english fixture");

    let accepted_raw: Vec<&str> = report
        .accepted
        .iter()
        .map(|item| item.raw_text.as_str())
        .collect();
    assert!(accepted_raw.contains(&"Hello there."));
    assert!(accepted_raw.contains(&"Yes"));
    assert!(accepted_raw.contains(&"No"));
    assert!(
        report
            .accepted
            .iter()
            .all(|item| item.source_text.source_language == "en")
    );
}

#[test]
fn scanner_reports_file_progress_events() {
    let temp = tempdir().expect("create temp dir");
    write_json(
        &temp.path().join("data/System.json"),
        json!({
            "gameTitle": "Fixture",
            "advanced": {},
            "optAutosave": true,
            "terms": { "basic": ["\u{30b4}\u{30fc}\u{30eb}\u{30c9}"] }
        }),
    );
    write_text(&temp.path().join("js/plugins.js"), "[]");
    write_json(
        &temp.path().join("data/Map001.json"),
        json!({
            "events": [
                null,
                {
                    "id": 1,
                    "pages": [
                        {
                            "list": [
                                { "code": 401, "parameters": ["\u{3053}\u{3093}\u{306b}\u{3061}\u{306f}"] }
                            ]
                        }
                    ]
                }
            ]
        }),
    );
    write_text(&temp.path().join("data/Broken.json"), "{ invalid json");

    let mut events = Vec::new();
    let report = GameScanner::scan_with_progress(temp.path(), ScanOptions::default(), |event| {
        events.push(event.clone());
    })
    .expect("scan with progress");

    assert_eq!(report.accepted.len(), 2);
    assert!(matches!(
        events.first(),
        Some(ScanProgressEvent::Started {
            source_language,
            ..
        }) if source_language == "ja"
    ));
    assert!(events.iter().any(|event| matches!(
        event,
        ScanProgressEvent::Detected {
            engine: Engine::Mz,
            layout: GameLayoutKind::Direct,
            ..
        }
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        ScanProgressEvent::FileFinished {
            file_path,
            accepted_delta: 0,
            rejected_delta: 0,
            skipped: true,
            ..
        } if file_path == "data/Broken.json"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        ScanProgressEvent::FileFinished {
            file_path,
            accepted_delta: 1,
            rejected_delta: 0,
            skipped: false,
            ..
        } if file_path == "data/Map001.json"
    )));
    assert!(matches!(
        events.last(),
        Some(ScanProgressEvent::Finished {
            file_count: 3,
            accepted_count: 2,
            skipped_count: 1,
            ..
        })
    ));
}

fn accepted_raw(report: &rpg_translator_core::ScanReport) -> Vec<&str> {
    report
        .accepted
        .iter()
        .map(|item| item.raw_text.as_str())
        .collect()
}
