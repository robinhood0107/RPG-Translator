use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::TextCodec;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxRepairInput {
    pub source_text_id: i64,
    pub unit_kind: String,
    pub source_text: String,
    pub source_control_code_signature: String,
    pub translated_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxRepairOutcome {
    pub source_text_id: i64,
    pub original_text: String,
    pub repaired_text: String,
    pub actions: Vec<String>,
    pub safe_to_apply: bool,
    pub validation_messages: Vec<String>,
    pub unsafe_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxRepairSample {
    pub source_text_id: i64,
    pub safe_to_apply: bool,
    pub actions: Vec<String>,
    pub original_text: String,
    pub repaired_text: String,
    pub validation_messages: Vec<String>,
    pub unsafe_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyntaxRepairReport {
    pub target_language: String,
    pub total_open_validation_count: i64,
    pub unique_source_count: i64,
    pub safe_candidate_count: i64,
    pub unsafe_count: i64,
    pub applied_count: i64,
    pub resolved_finding_count: i64,
    pub backup_path: Option<String>,
    pub action_counts: BTreeMap<String, i64>,
    pub samples: Vec<SyntaxRepairSample>,
}

pub struct SyntaxRepair;

impl SyntaxRepair {
    #[must_use]
    pub fn repair(input: &SyntaxRepairInput) -> SyntaxRepairOutcome {
        let source_controls = signature_counts(&input.source_control_code_signature);
        let mut remaining_source_controls = source_controls.clone();
        let mut output = String::with_capacity(input.translated_text.len());
        let mut actions = Vec::new();
        let mut unsafe_reason = None;
        let mut index = 0usize;

        while index < input.translated_text.len() {
            let Some(end) = control_code_end(&input.translated_text, index) else {
                let Some(ch) = input.translated_text[index..].chars().next() else {
                    break;
                };
                if ch == '\\'
                    && next_char(&input.translated_text, index + ch.len_utf8())
                        .is_none_or(char::is_whitespace)
                {
                    actions.push("remove-stray-backslash".to_string());
                } else if ch == '＼' && !input.source_text.contains('＼') {
                    actions.push("remove-fullwidth-stray-backslash".to_string());
                } else {
                    output.push(ch);
                }
                index += ch.len_utf8();
                continue;
            };

            let token = &input.translated_text[index..end];
            if let Some(count) = remaining_source_controls.get_mut(token)
                && *count > 0
            {
                output.push_str(token);
                *count -= 1;
                index = end;
                continue;
            }

            let (repair, extra_consumed) = repair_inserted_token(
                token,
                &input.translated_text[end..],
                &input.source_text,
                &input.unit_kind,
                &mut actions,
            );
            match repair {
                TokenRepair::Replace(replacement) => output.push_str(&replacement),
                TokenRepair::Unsafe(reason) => {
                    if unsafe_reason.is_none() {
                        unsafe_reason = Some(reason);
                    }
                    output.push_str(token);
                }
            }
            index = end + extra_consumed;
        }

        if !is_wrapped_runtime_unit(&input.unit_kind)
            && !input.source_text.contains('\n')
            && output.contains('\n')
        {
            output = output
                .split('\n')
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            actions.push("hard-newline-to-space".to_string());
        }
        if !is_wrapped_runtime_unit(&input.unit_kind)
            && input.source_text.contains('\n')
            && output.matches('\n').count() > input.source_text.matches('\n').count()
        {
            output = collapse_extra_leading_line_breaks(
                &output,
                input.source_text.matches('\n').count() + 1,
            );
            actions.push("extra-hard-newline-to-space".to_string());
        }
        if actions
            .iter()
            .any(|action| action == "repair-slurp-marker-escape")
        {
            output = collapse_marker_spacing_before_korean(&output);
        }

        actions.sort();
        actions.dedup();
        let validation_messages = Self::validation_messages(
            &input.source_text,
            &input.source_control_code_signature,
            &input.unit_kind,
            &output,
        );
        let safe_to_apply =
            unsafe_reason.is_none() && !actions.is_empty() && validation_messages.is_empty();

        SyntaxRepairOutcome {
            source_text_id: input.source_text_id,
            original_text: input.translated_text.clone(),
            repaired_text: output,
            actions,
            safe_to_apply,
            validation_messages,
            unsafe_reason,
        }
    }

    #[must_use]
    pub fn validation_messages(
        source_text: &str,
        source_control_code_signature: &str,
        unit_kind: &str,
        translated_text: &str,
    ) -> Vec<String> {
        if translated_text.trim().is_empty() {
            return vec!["번역문이 비어 있습니다.".to_string()];
        }
        let translated = TextCodec::analyze(translated_text);
        let mut messages = Vec::new();
        if translated.control_code_signature != source_control_code_signature {
            messages.push(format!(
                "제어코드가 원문과 다릅니다. 원문 제어코드 `{source_control_code_signature}`, 번역 제어코드 `{}`",
                translated.control_code_signature
            ));
        }
        let source_line_breaks = source_text.matches('\n').count();
        let translated_line_breaks = translated.normalized_text.matches('\n').count();
        if source_line_breaks != translated_line_breaks && !is_wrapped_runtime_unit(unit_kind) {
            messages.push(format!(
                "줄바꿈 수가 원문과 다릅니다. 원문 {source_line_breaks}개, 번역 {translated_line_breaks}개"
            ));
        }
        if source_line_breaks == translated_line_breaks {
            let source_line_placeholders = TextCodec::control_code_counts_by_line(source_text);
            let translated_line_placeholders =
                TextCodec::control_code_counts_by_line(&translated.normalized_text);
            for (index, (source_count, translated_count)) in source_line_placeholders
                .iter()
                .zip(translated_line_placeholders.iter())
                .enumerate()
            {
                if source_count != translated_count {
                    messages.push(format!(
                        "줄별 제어코드 수가 원문과 다릅니다. {}번째 줄 원문 {source_count}개, 번역 {translated_count}개",
                        index + 1
                    ));
                }
            }
        }
        messages
    }
}

enum TokenRepair {
    Replace(String),
    Unsafe(String),
}

fn repair_inserted_token(
    token: &str,
    rest_after_token: &str,
    source_text: &str,
    unit_kind: &str,
    actions: &mut Vec<String>,
) -> (TokenRepair, usize) {
    if token == "\\n" {
        if is_wrapped_runtime_unit(unit_kind) || source_text.contains('\n') {
            actions.push("literal-backslash-n-to-newline".to_string());
            return (TokenRepair::Replace("\n".to_string()), 0);
        }
        actions.push("literal-backslash-n-to-space".to_string());
        return (TokenRepair::Replace(" ".to_string()), 0);
    }

    if let Some(rest) = token.strip_prefix("\\n")
        && !rest.is_empty()
        && rest
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        if is_wrapped_runtime_unit(unit_kind) || source_text.contains('\n') {
            actions.push("literal-backslash-n-prefix-to-newline".to_string());
            return (TokenRepair::Replace(format!("\n{rest}")), 0);
        }
        actions.push("literal-backslash-n-prefix-to-space".to_string());
        return (TokenRepair::Replace(format!(" {rest}")), 0);
    }

    if token == "\\s" && rest_after_token.starts_with("$*$") {
        actions.push("repair-slurp-marker-escape".to_string());
        return (TokenRepair::Replace("*".to_string()), "$*$".len());
    }

    if token == "\\u20" {
        if let Some(extra_consumed) = adjacent_ascii_noise_after_broken_u20(rest_after_token) {
            actions.push("remove-broken-u20-ascii-noise".to_string());
            return (TokenRepair::Replace(String::new()), extra_consumed);
        }
        if rest_after_token
            .chars()
            .next()
            .is_none_or(|ch| ch == '*' || is_korean(ch))
        {
            actions.push("remove-broken-u20".to_string());
            return (TokenRepair::Replace(String::new()), 0);
        }
        return (
            TokenRepair::Unsafe(format!("broken or semantic escape `{token}`")),
            0,
        );
    }

    if is_broken_unicode_escape(token) || token.starts_with("\\s") {
        return (
            TokenRepair::Unsafe(format!("broken or semantic escape `{token}`")),
            0,
        );
    }

    if is_name_control(token) {
        if let Some(count) = name_control_count(token)
            && source_text.contains(&format!("*{count}"))
        {
            actions.push("inserted-name-control-to-star-count".to_string());
            return (TokenRepair::Replace(format!("*{count}")), 0);
        }
        actions.push("remove-inserted-name-control".to_string());
        return (TokenRepair::Replace(String::new()), 0);
    }

    if is_color_control(token) {
        actions.push("remove-inserted-color-control".to_string());
        return (TokenRepair::Replace(String::new()), 0);
    }

    if matches!(token, "\\H" | "\\h") {
        actions.push("remove-inserted-h-control".to_string());
        return (TokenRepair::Replace(String::new()), 0);
    }

    if token == "\\?" {
        actions.push("remove-escaped-question".to_string());
        return (TokenRepair::Replace("?".to_string()), 0);
    }

    if token == "\\-" {
        actions.push("remove-escaped-minus".to_string());
        return (TokenRepair::Replace("-".to_string()), 0);
    }

    if let Some(ch) = token.strip_prefix('\\').and_then(single_char)
        && (ch.is_alphabetic() || ch.is_ascii_punctuation() || is_korean(ch))
    {
        actions.push("remove-stray-backslash".to_string());
        return (TokenRepair::Replace(ch.to_string()), 0);
    }

    if let Some(rest) = token.strip_prefix('\\')
        && !rest.is_empty()
        && rest
            .chars()
            .all(|ch| ch.is_ascii_alphabetic() || ch == '_' || ch == '#')
    {
        actions.push("remove-stray-backslash-word".to_string());
        return (TokenRepair::Replace(rest.to_string()), 0);
    }

    (
        TokenRepair::Unsafe(format!("unknown inserted escape `{token}`")),
        0,
    )
}

fn adjacent_ascii_noise_after_broken_u20(rest: &str) -> Option<usize> {
    let mut consumed = 0usize;
    let mut chars = rest[consumed..].chars();
    while let Some(ch) = chars.next() {
        if !ch.is_whitespace() {
            break;
        }
        consumed += ch.len_utf8();
        chars = rest[consumed..].chars();
    }

    let word_start = consumed;
    while let Some(ch) = rest[consumed..].chars().next() {
        if !ch.is_ascii_alphabetic() {
            break;
        }
        consumed += ch.len_utf8();
    }
    if consumed == word_start {
        return None;
    }

    let next = rest[consumed..].chars().next();
    if next.is_some_and(|ch| is_korean(ch) || ch == '*') {
        Some(consumed)
    } else {
        None
    }
}

fn is_broken_unicode_escape(token: &str) -> bool {
    let Some(rest) = token.strip_prefix("\\u") else {
        return false;
    };
    !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_hexdigit())
}

fn signature_counts(signature: &str) -> BTreeMap<String, i64> {
    let mut counts = BTreeMap::new();
    for token in signature.split('|').filter(|token| !token.is_empty()) {
        *counts.entry(token.to_string()).or_insert(0) += 1;
    }
    counts
}

fn is_name_control(token: &str) -> bool {
    token.starts_with("\\N[") || token.starts_with("\\n[")
}

fn name_control_count(token: &str) -> Option<String> {
    let open = token.find('[')?;
    let close = token[open + 1..].find(']')? + open + 1;
    let value = &token[open + 1..close];
    if value.chars().all(|ch| ch.is_ascii_digit()) {
        Some(value.to_string())
    } else {
        None
    }
}

fn is_color_control(token: &str) -> bool {
    token.starts_with("\\C[") || token.starts_with("\\c[")
}

fn is_wrapped_runtime_unit(unit_kind: &str) -> bool {
    matches!(unit_kind, "message_block" | "scroll_block")
}

fn single_char(input: &str) -> Option<char> {
    let mut chars = input.chars();
    let ch = chars.next()?;
    if chars.next().is_none() {
        Some(ch)
    } else {
        None
    }
}

fn next_char(input: &str, index: usize) -> Option<char> {
    if index >= input.len() {
        return None;
    }
    input[index..].chars().next()
}

fn collapse_extra_leading_line_breaks(input: &str, target_line_count: usize) -> String {
    let mut lines = input.split('\n').map(str::to_string).collect::<Vec<_>>();
    while lines.len() > target_line_count && lines.len() >= 2 {
        let merged = format!("{} {}", lines[0].trim_end(), lines[1].trim_start());
        lines.splice(0..2, [merged]);
    }
    lines.join("\n")
}

fn collapse_marker_spacing_before_korean(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0usize;
    while index < input.len() {
        if input[index..].starts_with("* ") {
            let after_space = index + "* ".len();
            if next_char(input, after_space).is_some_and(is_korean)
                && prev_char(input, index).is_none_or(|ch| !is_korean(ch))
            {
                output.push('*');
                index = after_space;
                continue;
            }
        }
        let Some(ch) = input[index..].chars().next() else {
            break;
        };
        output.push(ch);
        index += ch.len_utf8();
    }
    output
}

fn is_korean(ch: char) -> bool {
    ('\u{ac00}'..='\u{d7a3}').contains(&ch)
        || ('\u{3130}'..='\u{318f}').contains(&ch)
        || ('\u{1100}'..='\u{11ff}').contains(&ch)
}

fn prev_char(input: &str, index: usize) -> Option<char> {
    input.get(..index)?.chars().next_back()
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
