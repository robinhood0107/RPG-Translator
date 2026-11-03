use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    DataFileRecord, DetectedGame, Engine, Error, ExtractedOccurrence, GameLayoutKind,
    NewSourceText, OccurrenceContext, OccurrenceSegment, RejectedCandidate, Result,
    ScanProgressEvent, ScanReport, SkippedDataFile, TextCodec,
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
        Self::scan_with_progress(game_root, options, |_| {})
    }

    pub fn scan_with_progress<F>(
        game_root: impl AsRef<Path>,
        options: ScanOptions,
        mut on_progress: F,
    ) -> Result<ScanReport>
    where
        F: FnMut(&ScanProgressEvent),
    {
        let game_root = game_root.as_ref();
        on_progress(&ScanProgressEvent::Started {
            game_root: normalize_path(game_root),
            source_language: options.source_language.clone(),
        });
        let detected_game = RpgMakerDetector::detect(game_root)?;
        on_progress(&ScanProgressEvent::Detected {
            engine: detected_game.engine.clone(),
            layout: detected_game.layout.clone(),
            data_path: detected_game.data_path.clone(),
        });
        let data_path = PathBuf::from(&detected_game.data_path);
        let mut files = Vec::new();
        let mut accepted = Vec::new();
        let mut rejected = Vec::new();
        let mut skipped = Vec::new();

        for (index, file_path) in list_json_files(&data_path)?.into_iter().enumerate() {
            let relative_path = relative_path(game_root, &file_path);
            on_progress(&ScanProgressEvent::FileStarted {
                index,
                file_path: relative_path.clone(),
            });
            files.push(DataFileRecord {
                file_path: relative_path.clone(),
            });

            let accepted_before = accepted.len();
            let rejected_before = rejected.len();
            let parsed = match read_json_value(&file_path) {
                Ok(value) => value,
                Err(error) => {
                    skipped.push(SkippedDataFile {
                        file_path: relative_path.clone(),
                        reason: "invalid-json".to_string(),
                        error,
                    });
                    on_progress(&ScanProgressEvent::FileFinished {
                        index,
                        file_path: relative_path,
                        accepted_delta: 0,
                        rejected_delta: 0,
                        skipped: true,
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
            let visited = accepted[accepted_before..]
                .iter()
                .flat_map(|item| {
                    std::iter::once(item.context.json_path.clone()).chain(
                        item.segments
                            .iter()
                            .map(|segment| segment.json_path.clone()),
                    )
                })
                .chain(
                    rejected[rejected_before..]
                        .iter()
                        .map(|item| item.context.json_path.clone()),
                )
                .collect::<HashSet<_>>();
            extract_unvisited_strings(
                GenericStringVisit {
                    relative_path: &relative_path,
                    json_path: "$",
                    object_key: None,
                    value: &parsed,
                    visited: &visited,
                },
                &options,
                &mut accepted,
                &mut rejected,
            );
            on_progress(&ScanProgressEvent::FileFinished {
                index,
                file_path: relative_path,
                accepted_delta: accepted.len() - accepted_before,
                rejected_delta: rejected.len() - rejected_before,
                skipped: false,
            });
        }

        on_progress(&ScanProgressEvent::Finished {
            file_count: files.len(),
            accepted_count: accepted.len(),
            rejected_count: rejected.len(),
            skipped_count: skipped.len(),
        });

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

        if is_common_events_file(file_name) {
            extract_common_events(relative_path, value, options, accepted, rejected);
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

            extract_event_commands(
                EventCommandScope {
                    relative_path,
                    event_index,
                    event_id,
                    page_index: Some(page_index),
                    commands,
                },
                options,
                accepted,
                rejected,
            );
        }
    }
}

fn extract_common_events(
    relative_path: &str,
    value: &Value,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let Some(events) = value.as_array() else {
        return;
    };

    for (event_index, event) in events.iter().enumerate() {
        let Some(event) = event.as_object() else {
            continue;
        };
        let event_id = event.get("id").and_then(Value::as_i64);
        let Some(commands) = event.get("list").and_then(Value::as_array) else {
            continue;
        };

        extract_event_commands(
            EventCommandScope {
                relative_path,
                event_index,
                event_id,
                page_index: None,
                commands,
            },
            options,
            accepted,
            rejected,
        );
    }
}

fn extract_event_commands(
    scope: EventCommandScope<'_>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    let mut command_index = 0;
    while command_index < scope.commands.len() {
        let command = &scope.commands[command_index];
        let code = command.get("code").and_then(Value::as_i64);
        let parameters = command.get("parameters").and_then(Value::as_array);
        let context = EventContext {
            relative_path: scope.relative_path,
            event_index: scope.event_index,
            event_id: scope.event_id,
            page_index: scope.page_index,
            command_index,
            command_code: code,
        };

        match code {
            Some(101) => {
                accept_event_parameter(
                    parameters,
                    4,
                    "event.message.speaker",
                    &context,
                    options,
                    accepted,
                    rejected,
                );
                if let Some(next_index) = accept_event_block(
                    &scope,
                    command_index,
                    EventBlockRule {
                        continuation_code: 401,
                        rule_id: "event.message.block",
                        unit_kind: "message_block",
                    },
                    &context,
                    options,
                    accepted,
                    rejected,
                ) {
                    command_index = next_index;
                    continue;
                }
            }
            Some(401) => accept_event_parameter(
                parameters,
                0,
                "event.message.line",
                &context,
                options,
                accepted,
                rejected,
            ),
            Some(105) => {
                if let Some(next_index) = accept_event_block(
                    &scope,
                    command_index,
                    EventBlockRule {
                        continuation_code: 405,
                        rule_id: "event.scroll.block",
                        unit_kind: "scroll_block",
                    },
                    &context,
                    options,
                    accepted,
                    rejected,
                ) {
                    command_index = next_index;
                    continue;
                }
            }
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
            Some(108 | 408) => reject_event_strings(parameters, "comment", &context, rejected),
            Some(355 | 655) => reject_event_strings(parameters, "script", &context, rejected),
            Some(118) => reject_event_strings(parameters, "label", &context, rejected),
            _ => {}
        }
        command_index += 1;
    }
}

fn accept_event_block(
    scope: &EventCommandScope<'_>,
    starter_index: usize,
    rule: EventBlockRule<'_>,
    starter_context: &EventContext<'_>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) -> Option<usize> {
    let starter_indent = scope.commands[starter_index]
        .get("indent")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut raw_lines = Vec::new();
    let mut segments = Vec::new();
    let mut index = starter_index + 1;
    while index < scope.commands.len() {
        let command = &scope.commands[index];
        let code = command.get("code").and_then(Value::as_i64);
        let indent = command.get("indent").and_then(Value::as_i64).unwrap_or(0);
        if code != Some(rule.continuation_code) || indent != starter_indent {
            break;
        }
        let Some(raw) = command
            .get("parameters")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(Value::as_str)
        else {
            break;
        };
        let segment_context = EventContext {
            relative_path: scope.relative_path,
            event_index: scope.event_index,
            event_id: scope.event_id,
            page_index: scope.page_index,
            command_index: index,
            command_code: Some(rule.continuation_code),
        };
        segments.push(OccurrenceSegment {
            segment_index: segments.len() as i64,
            command_code: Some(rule.continuation_code),
            json_path: segment_context.parameter_json_path(0),
            raw_text: raw.to_string(),
            line_index: raw_lines.len() as i64,
        });
        raw_lines.push(raw.to_string());
        index += 1;
    }

    if raw_lines.is_empty() {
        return None;
    }

    let raw_block = raw_lines.join("\n");
    let occurrence = starter_context.to_occurrence(
        starter_context.command_json_path(),
        None,
        None,
        rule.rule_id,
    );
    classify_and_push_with_unit(
        &raw_block,
        occurrence,
        rule.unit_kind,
        segments,
        options,
        accepted,
        rejected,
    );
    Some(index)
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
        context.parameter_json_path(parameter_index),
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
            context.choice_json_path(choice_index),
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
                    context.parameter_json_path(parameter_index),
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
    let unit_kind = unit_kind_for_rule(&context.extraction_rule_id).to_string();
    classify_and_push_with_unit(
        raw,
        context,
        &unit_kind,
        Vec::new(),
        options,
        accepted,
        rejected,
    );
}

fn classify_and_push_with_unit(
    raw: &str,
    context: OccurrenceContext,
    unit_kind: &str,
    segments: Vec<OccurrenceSegment>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    if raw.contains("//") {
        push_rejected(raw, "comment", context, rejected);
        return;
    }

    let analysis = TextCodec::analyze(raw);
    let visible = analysis.visible_text.replace('"', "").trim().to_string();

    if visible.is_empty() {
        push_rejected(raw, "empty", context, rejected);
        return;
    }
    if options.disable_cjk_filter {
        accepted.push(new_accepted(
            raw, analysis, visible, context, unit_kind, segments, options,
        ));
        return;
    }
    if !matches_source_language(&visible, &options.source_language) {
        push_rejected(raw, "wrong-source-language", context, rejected);
        return;
    }

    accepted.push(new_accepted(
        raw, analysis, visible, context, unit_kind, segments, options,
    ));
}

fn extract_unvisited_strings(
    visit: GenericStringVisit<'_>,
    options: &ScanOptions,
    accepted: &mut Vec<ExtractedOccurrence>,
    rejected: &mut Vec<RejectedCandidate>,
) {
    match visit.value {
        Value::String(raw) => {
            if visit.visited.contains(visit.json_path) {
                return;
            }
            let occurrence = OccurrenceContext {
                file_path: visit.relative_path.to_string(),
                json_path: visit.json_path.to_string(),
                entity_type: "generic.string".to_string(),
                event_id: None,
                page_index: None,
                command_index: None,
                command_code: None,
                parameter_index: None,
                object_key: visit.object_key.map(ToString::to_string),
                extraction_rule_id: "generic.string".to_string(),
            };
            classify_and_push(raw, occurrence, options, accepted, rejected);
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                extract_unvisited_strings(
                    GenericStringVisit {
                        relative_path: visit.relative_path,
                        json_path: &format!("{}[{index}]", visit.json_path),
                        object_key: None,
                        value: item,
                        visited: visit.visited,
                    },
                    options,
                    accepted,
                    rejected,
                );
            }
        }
        Value::Object(object) => {
            for (key, item) in object {
                let child_path = json_child_path(visit.json_path, key);
                extract_unvisited_strings(
                    GenericStringVisit {
                        relative_path: visit.relative_path,
                        json_path: &child_path,
                        object_key: Some(key),
                        value: item,
                        visited: visit.visited,
                    },
                    options,
                    accepted,
                    rejected,
                );
            }
        }
        _ => {}
    }
}

fn json_child_path(parent: &str, key: &str) -> String {
    if is_simple_json_path_key(key) {
        format!("{parent}.{key}")
    } else {
        let key = serde_json::to_string(key).unwrap_or_else(|_| format!("\"{key}\""));
        format!("{parent}[{key}]")
    }
}

fn is_simple_json_path_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn new_accepted(
    raw: &str,
    analysis: crate::TextAnalysis,
    visible: String,
    context: OccurrenceContext,
    unit_kind: &str,
    segments: Vec<OccurrenceSegment>,
    options: &ScanOptions,
) -> ExtractedOccurrence {
    let provider_state = TextCodec::encode_for_provider(&analysis.normalized_text);
    let normalized_hash = source_unit_hash(
        &options.source_language,
        unit_kind,
        &analysis.normalized_text,
        &analysis.control_code_signature,
    );
    let newline_count = analysis.normalized_text.matches('\n').count() as i64;
    ExtractedOccurrence {
        raw_text: raw.to_string(),
        source_text: NewSourceText {
            source_language: options.source_language.clone(),
            unit_kind: unit_kind.to_string(),
            normalized_hash,
            normalized_text: analysis.normalized_text,
            visible_text: visible,
            codec_text: provider_state.provider_text,
            control_code_signature: analysis.control_code_signature,
            line_count: newline_count + 1,
            newline_count,
            placeholder_count: provider_state.control_codes.len() as i64,
        },
        context,
        segments,
    }
}

fn unit_kind_for_rule(rule_id: &str) -> &str {
    match rule_id {
        "event.message.speaker" => "message_speaker",
        "event.message.line" => "message_line",
        "event.scroll.line" => "scroll_line",
        "event.choice.option" => "choice",
        "generic.string" => "generic_candidate",
        value if value.starts_with("database.") => "db_field",
        value if value.starts_with("system.") => "system_term",
        _ => "text",
    }
}

fn source_unit_hash(
    source_language: &str,
    unit_kind: &str,
    normalized_text: &str,
    control_code_signature: &str,
) -> String {
    let mut hasher = Sha256::new();
    for (name, value) in [
        ("source_language", source_language),
        ("unit_kind", unit_kind),
        ("normalized_text", normalized_text),
        ("control_code_signature", control_code_signature),
    ] {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(value.len().to_string().as_bytes());
        hasher.update([0]);
        hasher.update(value.as_bytes());
        hasher.update([0xff]);
    }
    hex::encode(hasher.finalize())
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
    } else if !options.disable_cjk_filter
        && !matches_source_language(visible, &options.source_language)
    {
        "wrong-source-language".to_string()
    } else {
        "unknown-field".to_string()
    }
}

fn is_map_file(file_name: &str) -> bool {
    file_name.starts_with("Map") && file_name.ends_with(".json")
}

fn is_common_events_file(file_name: &str) -> bool {
    file_name.eq_ignore_ascii_case("CommonEvents.json")
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

fn matches_source_language(input: &str, source_language: &str) -> bool {
    let has_latin = contains_latin_letter(input);
    let has_korean = contains_korean(input);
    let has_japanese_or_chinese = contains_japanese_or_chinese(input);

    match source_language_profile(source_language) {
        SourceLanguageProfile::English => has_latin && !has_korean && !has_japanese_or_chinese,
        SourceLanguageProfile::JapaneseChinese => has_japanese_or_chinese && !has_korean,
        SourceLanguageProfile::Korean => has_korean,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceLanguageProfile {
    English,
    JapaneseChinese,
    Korean,
}

fn source_language_profile(source_language: &str) -> SourceLanguageProfile {
    match source_language.trim().to_ascii_lowercase().as_str() {
        "en" | "eng" | "english" => SourceLanguageProfile::English,
        "ko" | "kor" | "kr" | "korean" => SourceLanguageProfile::Korean,
        _ => SourceLanguageProfile::JapaneseChinese,
    }
}

fn contains_latin_letter(input: &str) -> bool {
    input
        .chars()
        .any(|ch| ch.is_ascii_alphabetic() || ('\u{00c0}'..='\u{024f}').contains(&ch))
}

fn contains_korean(input: &str) -> bool {
    input.chars().any(|ch| {
        ('\u{1100}'..='\u{11ff}').contains(&ch)
            || ('\u{3130}'..='\u{318f}').contains(&ch)
            || ('\u{ac00}'..='\u{d7af}').contains(&ch)
            || ('\u{a960}'..='\u{a97f}').contains(&ch)
            || ('\u{d7b0}'..='\u{d7ff}').contains(&ch)
    })
}

fn contains_japanese_or_chinese(input: &str) -> bool {
    input.chars().any(|ch| {
        ('\u{3040}'..='\u{309f}').contains(&ch)
            || ('\u{30a0}'..='\u{30ff}').contains(&ch)
            || ('\u{31f0}'..='\u{31ff}').contains(&ch)
            || ('\u{3400}'..='\u{4dbf}').contains(&ch)
            || ('\u{4e00}'..='\u{9fff}').contains(&ch)
            || ('\u{f900}'..='\u{faff}').contains(&ch)
            || ('\u{ff66}'..='\u{ff9f}').contains(&ch)
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
    page_index: Option<usize>,
    command_index: usize,
    command_code: Option<i64>,
}

struct EventCommandScope<'a> {
    relative_path: &'a str,
    event_index: usize,
    event_id: Option<i64>,
    page_index: Option<usize>,
    commands: &'a [Value],
}

struct EventBlockRule<'a> {
    continuation_code: i64,
    rule_id: &'a str,
    unit_kind: &'a str,
}

struct GenericStringVisit<'a> {
    relative_path: &'a str,
    json_path: &'a str,
    object_key: Option<&'a str>,
    value: &'a Value,
    visited: &'a HashSet<String>,
}

impl EventContext<'_> {
    fn command_json_path(&self) -> String {
        match self.page_index {
            Some(page_index) => format!(
                "$.events[{}].pages[{}].list[{}]",
                self.event_index, page_index, self.command_index
            ),
            None => format!("$[{}].list[{}]", self.event_index, self.command_index),
        }
    }

    fn parameter_json_path(&self, parameter_index: usize) -> String {
        format!("{}.parameters[{parameter_index}]", self.command_json_path())
    }

    fn choice_json_path(&self, choice_index: usize) -> String {
        format!("{}.parameters[0][{choice_index}]", self.command_json_path())
    }

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
            page_index: self.page_index.map(|index| index as i64),
            command_index: Some(self.command_index as i64),
            command_code: self.command_code,
            parameter_index: parameter_index.map(|index| index as i64),
            object_key,
            extraction_rule_id: rule_id.to_string(),
        }
    }
}
