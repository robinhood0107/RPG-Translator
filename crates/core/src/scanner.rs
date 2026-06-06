use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{
    DataFileRecord, DetectedGame, Engine, Error, ExtractedOccurrence, GameLayoutKind,
    NewSourceText, OccurrenceContext, RejectedCandidate, Result, ScanReport, SkippedDataFile,
    TextCodec,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOptions {
    pub source_language: String,
    pub disable_cjk_filter: bool,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            source_language: "ja".to_string(),
            disable_cjk_filter: false,
        }
    }
}

pub struct RpgMakerDetector;

impl RpgMakerDetector {
    pub fn detect(game_root: impl AsRef<Path>) -> Result<DetectedGame> {
        let game_root = game_root.as_ref();
        let direct_data = game_root.join("data");
        let direct_plugin = game_root.join("js").join("plugins.js");
        let www_data = game_root.join("www").join("data");
        let www_plugin = game_root.join("www").join("js").join("plugins.js");

        let (layout, data_path, plugin_path) = if direct_data.is_dir() && direct_plugin.is_file() {
            (GameLayoutKind::Direct, direct_data, direct_plugin)
        } else if www_data.is_dir() && www_plugin.is_file() {
            (GameLayoutKind::Www, www_data, www_plugin)
        } else {
            return Err(Error::invalid_input(format!(
                "RPG Maker layout not found under {}. Expected data plus js/plugins.js, or www/data plus www/js/plugins.js.",
                game_root.display()
            )));
        };

        let engine = detect_engine(&data_path);

        Ok(DetectedGame {
            game_root: normalize_path(game_root),
            engine,
            layout,
            data_path: normalize_path(&data_path),
            plugin_path: normalize_path(&plugin_path),
        })
    }
}

pub struct GameScanner;

impl GameScanner {
    pub fn scan(game_root: impl AsRef<Path>, options: ScanOptions) -> Result<ScanReport> {
        let game_root = game_root.as_ref();
        let detected_game = RpgMakerDetector::detect(game_root)?;
        let data_path = PathBuf::from(&detected_game.data_path);
        let mut files = Vec::new();
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        let mut skipped = Vec::new();

        for file_path in list_json_files(&data_path)? {
            let relative_path = relative_path(game_root, &file_path);
            files.push(DataFileRecord {
                file_path: relative_path.clone(),
            });

            let parsed = match read_json_value(&file_path) {
                Ok(value) => value,
                Err(error) => {
                    skipped.push(SkippedDataFile {
                        file_path: relative_path,
                        reason: "invalid-json".to_string(),
                        error,
                    });
                    continue;
                }
            };

            ExtractionRuleSet::extract_file(
                &relative_path,
                &file_path,
                &parsed,
                &options,
                &mut accepted,
                &mut rejected,
            );
        }

        Ok(ScanReport {
            detected_game,
            files,
            accepted,
            rejected,
            skipped,
        })
    }
}

pub struct ExtractionRuleSet;

impl ExtractionRuleSet {
    fn extract_file(
        relative_path: &str,
        file_path: &Path,
        value: &Value,
        options: &ScanOptions,
        accepted: &mut Vec<ExtractedOccurrence>,
        rejected: &mut Vec<RejectedCandidate>,
    ) {
        let file_name = file_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();

        if is_map_file(file_name) {
            extract_map(relative_path, value, options, accepted, rejected);
            return;
        }

        if file_name.eq_ignore_ascii_case("System.json") {
            extract_terms(
                relative_path,
                "$.terms",
                value.get("terms"),
                options,
                accepted,
                rejected,
            );
            return;
        }

        extract_database_file(relative_path, value, options, accepted, rejected);
    }
}

fn detect_engine(data_path: &Path) -> Engine {
    let system_path = data_path.join("System.json");
    let Ok(value) = read_json_value(&system_path) else {
        return Engine::Unknown;
    };
    if value.get("advanced").is_some()
        || value.get("optAutosave").is_some()
        || value.get("locale").is_some()
    {
        Engine::Mz
    } else {
        Engine::Mv
    }
}

fn list_json_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = fs::read_dir(dir).map_err(|error| {
        Error::invalid_input(format!(
            "failed to read data directory {}: {error}",
            dir.display()
        ))
    })?;
    let mut paths = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| {
            Error::invalid_input(format!(
                "failed to read data directory entry under {}: {error}",
                dir.display()
            ))
        })?;
        let path = entry.path();
        if path.is_dir() {
            paths.extend(list_json_files(&path)?);
        } else if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            paths.push(path);
        }
    }

    paths.sort_by_key(|path| normalize_path(path));
    Ok(paths)
}

fn read_json_value(path: &Path) -> std::result::Result<Value, String> {
    let text = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))
}

fn extract_map(
    relative_path: &str,
    value: &Value,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let Some(events) = value.get("events").and_then(Value::as_array) else {
        return;
    };

    for (event_index, event) in events.iter().enumerate() {
        let Some(event) = event.as_object() else {
            continue;
        };
        let event_id = event.get("id").and_then(Value::as_i64);
        let Some(pages) = event.get("pages").and_then(Value::as_array) else {
            continue;
        };

        for (page_index, page) in pages.iter().enumerate() {
            let Some(commands) = page.get("list").and_then(Value::as_array) else {
                continue;
            };

            for (command_index, command) in commands.iter().enumerate() {
                let code = command.get("code").and_then(Value::as_i64);
                let parameters = command.get("parameters").and_then(Value::as_array);
                let context = EventContext {
                    relative_path,
                    event_index,
                    event_id,
                    page_index,
                    command_index,
                    command_code: code,
                };

                match code {
                    Some(101) => accept_event_parameter(
                        parameters,
                        4,
                        "event.message.speaker",
                        &context,
                        options,
                        accepted,
                        rejected,
                    ),
                    Some(401) => accept_event_parameter(
                        parameters,
                        0,
                        "event.message.line",
                        &context,
                        options,
                        accepted,
                        rejected,
                    ),
                    Some(405) => accept_event_parameter(
                        parameters,
                        0,
                        "event.scroll.line",
                        &context,
                        options,
                        accepted,
                        rejected,
                    ),
                    Some(102) => accept_choices(parameters, &context, options, accepted, rejected),
                    Some(108 | 408) => {
                        reject_event_strings(parameters, "comment", &context, rejected)
                    }
                    Some(355 | 655) => {
                        reject_event_strings(parameters, "script", &context, rejected)
                    }
                    Some(118) => reject_event_strings(parameters, "label", &context, rejected),
                    _ => {}
                }
            }
        }
    }
}

fn accept_event_parameter(
    parameters: Option<&Vec<Value>>,
    parameter_index: usize,
    rule_id: &str,
    context: &EventContext<'_>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let Some(raw) = parameters
        .and_then(|items| items.get(parameter_index))
        .and_then(Value::as_str)
    else {
        return;
    };

    let occurrence = context.to_occurrence(
        format!(
            "$.events[{}].pages[{}].list[{}].parameters[{parameter_index}]",
            context.event_index, context.page_index, context.command_index
        ),
        Some(parameter_index),
        None,
        rule_id,
    );
    classify_and_push(raw, occurrence, options, accepted, rejected);
}

fn accept_choices(
    parameters: Option<&Vec<Value>>,
    context: &EventContext<'_>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let Some(choices) = parameters
        .and_then(|items| items.first())
        .and_then(Value::as_array)
    else {
        return;
    };

    for (choice_index, choice) in choices.iter().enumerate() {
        let Some(raw) = choice.as_str() else {
            continue;
        };
        let occurrence = context.to_occurrence(
            format!(
                "$.events[{}].pages[{}].list[{}].parameters[0][{choice_index}]",
                context.event_index, context.page_index, context.command_index
            ),
            Some(0),
            Some(format!("choice[{choice_index}]")),
            "event.choice.option",
        );
        classify_and_push(raw, occurrence, options, accepted, rejected);
    }
}

fn reject_event_strings(
    parameters: Option<&Vec<Value>>,
    reason: &str,
    context: &EventContext<'_>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let Some(parameters) = parameters else {
        return;
    };
    for (parameter_index, parameter) in parameters.iter().enumerate() {
        if let Some(raw) = parameter.as_str() {
            rejected.push(RejectedCandidate {
                raw_text: raw.to_string(),
                reason: reason.to_string(),
                context: context.to_occurrence(
                    format!(
                        "$.events[{}].pages[{}].list[{}].parameters[{parameter_index}]",
                        context.event_index, context.page_index, context.command_index
                    ),
                    Some(parameter_index),
                    None,
                    "event.rejected",
                ),
            });
        }
    }
}

fn extract_database_file(
    relative_path: &str,
    value: &Value,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let Some(entries) = value.as_array() else {
        return;
    };

    for (entry_index, entry) in entries.iter().enumerate() {
        let Some(object) = entry.as_object() else {
            continue;
        };
        let entity_type = database_entity_type(relative_path);

        for (key, value) in object {
            let Some(raw) = value.as_str() else {
                continue;
            };
            let occurrence = OccurrenceContext {
                file_path: relative_path.to_string(),
                json_path: format!("$[{entry_index}].{key}"),
                entity_type: entity_type.clone(),
                event_id: object.get("id").and_then(Value::as_i64),
                page_index: None,
                command_index: None,
                command_code: None,
                parameter_index: None,
                object_key: Some(key.clone()),
                extraction_rule_id: format!("database.{key}"),
            };

            if is_database_allowlisted_key(key) {
                classify_and_push(raw, occurrence, options, accepted, rejected);
            } else {
                let reason = rejected_database_reason(key, raw, options);
                rejected.push(RejectedCandidate {
                    raw_text: raw.to_string(),
                    reason,
                    context: occurrence,
                });
            }
        }
    }
}

fn extract_terms(
    relative_path: &str,
    json_path: &str,
    value: Option<&Value>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    match value {
        Some(Value::String(raw)) => {
            let occurrence = OccurrenceContext {
                file_path: relative_path.to_string(),
                json_path: json_path.to_string(),
                entity_type: "database.terms".to_string(),
                event_id: None,
                page_index: None,
                command_index: None,
                command_code: None,
                parameter_index: None,
                object_key: Some("terms".to_string()),
                extraction_rule_id: "database.terms".to_string(),
            };
            classify_and_push(raw, occurrence, options, accepted, rejected);
        }
        Some(Value::Array(items)) => {
            for (index, item) in items.iter().enumerate() {
                extract_terms(
                    relative_path,
                    &format!("{json_path}[{index}]"),
                    Some(item),
                    options,
                    accepted,
                    rejected,
                );
            }
        }
        Some(Value::Object(object)) => {
            for (key, item) in object {
                extract_terms(
                    relative_path,
                    &format!("{json_path}.{key}"),
                    Some(item),
                    options,
                    accepted,
                    rejected,
                );
            }
        }
        _ => {}
    }
}

fn classify_and_push(
    raw: &str,
    context: OccurrenceContext,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let analysis = TextCodec::analyze(raw);
    let visible = analysis.visible_text.replace('"', "").trim().to_string();

    if visible.is_empty() {
        push_rejected(raw, "empty", context, rejected);
        return;
    }
    if options.disable_cjk_filter {
        accepted.push(new_accepted(raw, analysis, visible, context, options));
        return;
    }
    if contains_korean(&visible) {
        push_rejected(raw, "korean", context, rejected);
        return;
    }
    if !contains_japanese_or_chinese(&visible) {
        push_rejected(raw, "no-cjk", context, rejected);
        return;
    }

    accepted.push(new_accepted(raw, analysis, visible, context, options));
}

fn new_accepted(
    raw: &str,
    analysis: crate::TextAnalysis,
    visible: String,
    context: OccurrenceContext,
    options: &ScanOptions,
) -> ExtractedOccurrence {
    ExtractedOccurrence {
        raw_text: raw.to_string(),
        source_text: NewSourceText {
            source_language: options.source_language.clone(),
            normalized_text: analysis.normalized_text,
            visible_text: visible,
            control_code_signature: analysis.control_code_signature,
        },
        context,
    }
}

fn push_rejected(
    raw: &str,
    reason: &str,
    context: OccurrenceContext,
    rejected: &mut Vec<RejectedCandidate>,
) {
    rejected.push(RejectedCandidate {
        raw_text: raw.to_string(),
        reason: reason.to_string(),
        context,
    });
}

fn rejected_database_reason(key: &str, raw: &str, options: &ScanOptions) -> String {
    if key.eq_ignore_ascii_case("note") {
        return "note".to_string();
    }
    if is_asset_key(key) {
        return "asset".to_string();
    }

    let analysis = TextCodec::analyze(raw);
    let visible = analysis.visible_text.trim();
    if visible.is_empty() {
        "empty".to_string()
    } else if !options.disable_cjk_filter && contains_korean(visible) {
        "korean".to_string()
    } else if !options.disable_cjk_filter && !contains_japanese_or_chinese(visible) {
        "no-cjk".to_string()
    } else {
        "unknown-field".to_string()
    }
}

fn is_map_file(file_name: &str) -> bool {
    file_name.starts_with("Map") && file_name.ends_with(".json")
}

fn is_database_allowlisted_key(key: &str) -> bool {
    matches!(key, "name" | "description" | "profile") || key.starts_with("message")
}

fn is_asset_key(key: &str) -> bool {
    matches!(
        key,
        "characterName"
            | "faceName"
            | "battlerName"
            | "parallaxName"
            | "battleback1Name"
            | "battleback2Name"
            | "title1Name"
            | "title2Name"
            | "gameoverName"
            | "filename"
            | "fileName"
    )
}

fn database_entity_type(relative_path: &str) -> String {
    let file_name = relative_path
        .rsplit('/')
        .next()
        .unwrap_or(relative_path)
        .trim_end_matches(".json");
    format!("database.{}", file_name.to_ascii_lowercase())
}

fn contains_korean(input: &str) -> bool {
    input
        .chars()
        .any(|ch| ('\u{ac00}'..='\u{d7af}').contains(&ch))
}

fn contains_japanese_or_chinese(input: &str) -> bool {
    input.chars().any(|ch| {
        ('\u{3040}'..='\u{309f}').contains(&ch)
            || ('\u{30a0}'..='\u{30ff}').contains(&ch)
            || ('\u{4e00}'..='\u{9fff}').contains(&ch)
    })
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn relative_path(root: &Path, file_path: &Path) -> String {
    match file_path.strip_prefix(root) {
        Ok(relative) => normalize_path(relative),
        Err(_) => normalize_path(file_path),
    }
}

struct EventContext<'a> {
    relative_path: &'a str,
    event_index: usize,
    event_id: Option<i64>,
    page_index: usize,
    command_index: usize,
    command_code: Option<i64>,
}

impl EventContext<'_> {
    fn to_occurrence(
        &self,
        json_path: String,
        parameter_index: Option<usize>,
        object_key: Option<String>,
        rule_id: &str,
    ) -> OccurrenceContext {
        OccurrenceContext {
            file_path: self.relative_path.to_string(),
            json_path,
            entity_type: "event.command".to_string(),
            event_id: self.event_id,
            page_index: Some(self.page_index as i64),
            command_index: Some(self.command_index as i64),
            command_code: self.command_code,
            parameter_index: parameter_index.map(|index| index as i64),
            object_key,
            extraction_rule_id: rule_id.to_string(),
        }
    }
}
