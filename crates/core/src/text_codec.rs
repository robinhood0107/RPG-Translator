use serde::{Deserialize, Serialize};

use crate::{Error, Result, TextAnalysis};

const CONTROL_CODE_PLACEHOLDER: char = '\u{00a4}';

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderTextState {
    pub provider_text: String,
    pub control_codes: Vec<String>,
    pub control_code_signature: String,
}

pub struct TextCodec;

impl TextCodec {
    #[must_use]
    pub fn analyze(input: &str) -> TextAnalysis {
        let original_text = input.to_string();
        let normalized_text = normalize_line_endings(input);
        let control_codes = collect_control_codes(&normalized_text);
        let visible_text = strip_control_codes(&normalized_text);
        let control_code_signature = control_codes.join("|");

        TextAnalysis {
            original_text,
            normalized_text,
            visible_text,
            control_codes,
            control_code_signature,
        }
    }

    #[must_use]
    pub fn encode_for_provider(input: &str) -> ProviderTextState {
        let normalized = normalize_line_endings(input);
        let mut provider_text = String::with_capacity(normalized.len());
        let mut control_codes = Vec::new();
        let mut index = 0;

        while index < normalized.len() {
            if let Some(end) = control_code_end(&normalized, index) {
                control_codes.push(normalized[index..end].to_string());
                provider_text.push(CONTROL_CODE_PLACEHOLDER);
                index = end;
            } else if let Some(ch) = normalized[index..].chars().next() {
                provider_text.push(ch);
                index += ch.len_utf8();
            } else {
                break;
            }
        }

        ProviderTextState {
            provider_text,
            control_code_signature: control_codes.join("|"),
            control_codes,
        }
    }

    pub fn restore_provider_translation(
        translation: &str,
        state: &ProviderTextState,
    ) -> Result<String> {
        let placeholder_count = translation
            .chars()
            .filter(|ch| *ch == CONTROL_CODE_PLACEHOLDER)
            .count();
        if placeholder_count != state.control_codes.len() {
            return Err(Error::invalid_input(format!(
                "placeholder mismatch: expected {}, got {placeholder_count}",
                state.control_codes.len()
            )));
        }

        let mut restored = String::with_capacity(translation.len());
        let mut control_index = 0;
        for ch in translation.chars() {
            if ch == CONTROL_CODE_PLACEHOLDER {
                if let Some(control_code) = state.control_codes.get(control_index) {
                    restored.push_str(control_code);
                    control_index += 1;
                }
            } else {
                restored.push(ch);
            }
        }
        Ok(restored)
    }

    #[must_use]
    pub fn control_code_counts_by_line(input: &str) -> Vec<usize> {
        normalize_line_endings(input)
            .split('\n')
            .map(|line| collect_control_codes(line).len())
            .collect()
    }
}

fn normalize_line_endings(input: &str) -> String {
    input.replace("\r\n", "\n").replace('\r', "\n")
}

fn collect_control_codes(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < input.len() {
        if let Some(end) = control_code_end(input, index) {
            tokens.push(input[index..end].to_string());
            index = end;
        } else {
            index += next_char_len(input, index);
        }
    }
    tokens
}

fn strip_control_codes(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some(end) = control_code_end(input, index) {
            index = end;
        } else if let Some(ch) = input[index..].chars().next() {
            output.push(ch);
            index += ch.len_utf8();
        } else {
            break;
        }
    }
    output
}

fn control_code_end(input: &str, start: usize) -> Option<usize> {
    let marker = input[start..].chars().next()?;
    if marker != '\\' && marker != '\u{1b}' {
        return None;
    }

    let mut end = start + marker.len_utf8();
    let first = input[end..].chars().next()?;
    if is_identifier_control_char(first) {
        while let Some(ch) = input[end..].chars().next() {
            if !is_identifier_control_char(ch) {
                break;
            }
            end += ch.len_utf8();
        }
    } else if !first.is_whitespace() && !is_ascii_word_char(first) {
        end += first.len_utf8();
    } else {
        return None;
    }

    if input[end..].starts_with('[') {
        end = consume_until(input, end, ']');
    } else if input[end..].starts_with('<') {
        end = consume_until(input, end, '>');
    }

    Some(end)
}

fn consume_until(input: &str, start: usize, terminator: char) -> usize {
    let mut end = start;
    while let Some(ch) = input[end..].chars().next() {
        end += ch.len_utf8();
        if ch == terminator {
            break;
        }
    }
    end
}

fn is_identifier_control_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_' || ch == '#'
}

fn is_ascii_word_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}

fn next_char_len(input: &str, index: usize) -> usize {
    input[index..].chars().next().map_or(1, char::len_utf8)
}
