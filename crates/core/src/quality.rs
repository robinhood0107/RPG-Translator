use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationQualityIssue {
    pub source_text_id: Option<i64>,
    pub translation_id: Option<i64>,
    pub unit_kind: Option<String>,
    pub code: String,
    pub severity: String,
    pub classification: String,
    pub message: String,
    pub source_text: String,
    pub translated_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationQualityAuditReport {
    pub total_rows: i64,
    pub issue_count: i64,
    pub high_severity_count: i64,
    pub retranslation_candidate_count: i64,
    pub high_risk_source_count: i64,
    pub quality_retry_source_count: i64,
    pub allowlisted_technical_count: i64,
    pub issues: Vec<TranslationQualityIssue>,
}

pub struct TranslationQualityAuditor;

impl TranslationQualityAuditor {
    #[must_use]
    pub fn audit_text(
        source_text: &str,
        translated_text: &str,
        target_language: &str,
    ) -> Vec<TranslationQualityIssue> {
        let mut issues = Vec::new();
        let source = source_text.trim();
        let translation = translated_text.trim();
        if translation.is_empty() {
            push_issue(
                &mut issues,
                "empty_translation",
                "error",
                "translation is empty",
                source_text,
                translated_text,
            );
            return issues;
        }
        if is_allowed_technical_token(source) && source == translation {
            return issues;
        }
        let linguistic_source = strip_protected_metadata(source);
        if contains_chatter_or_model_markup(translation) {
            push_issue(
                &mut issues,
                "model_chatter",
                "error",
                "translation contains model chatter or markdown markup",
                source_text,
                translated_text,
            );
        }
        if contains_literal_backslash_n(translation) {
            push_issue(
                &mut issues,
                "literal_backslash_n",
                "error",
                "translation contains literal backslash-n instead of a real line break",
                source_text,
                translated_text,
            );
        }
        if protected_angle_tags(source) != protected_angle_tags(translation) {
            push_issue(
                &mut issues,
                "protected_tag_mismatch",
                "error",
                "translation changed a protected angle-bracket metadata tag",
                source_text,
                translated_text,
            );
        }
        if is_korean_target(target_language) {
            if contains_embedded_ascii_in_hangul(translation) {
                push_issue(
                    &mut issues,
                    "embedded_ascii_in_hangul",
                    "error",
                    "translation contains an ASCII letter embedded inside Korean text",
                    source_text,
                    translated_text,
                );
            }
            if contains_foreign_connector(translation) {
                push_issue(
                    &mut issues,
                    "foreign_connector",
                    "error",
                    "translation contains a foreign connector word",
                    source_text,
                    translated_text,
                );
            }
            if !contains_hangul(translation)
                && !is_allowed_technical_token(source)
                && !linguistic_source.trim().is_empty()
            {
                push_issue(
                    &mut issues,
                    "target_language_absent",
                    "error",
                    "Korean target translation contains no Korean text",
                    source_text,
                    translated_text,
                );
            }
            if contains_raw_source_token(&linguistic_source, translation) {
                push_issue(
                    &mut issues,
                    "raw_source_token",
                    "warning",
                    "translation still contains a raw source-language name or word",
                    source_text,
                    translated_text,
                );
            }
            if contains_source_english_fragment(&linguistic_source, translation) {
                push_issue(
                    &mut issues,
                    "source_english_fragment",
                    "warning",
                    "translation still contains a source-language phrase fragment",
                    source_text,
                    translated_text,
                );
            }
        }
        issues
    }

    #[must_use]
    pub fn report_from_issues(
        total_rows: i64,
        issues: Vec<TranslationQualityIssue>,
        issue_limit: usize,
    ) -> TranslationQualityAuditReport {
        Self::report_from_issues_with_allowlist(total_rows, issues, issue_limit, 0)
    }

    #[must_use]
    pub fn report_from_issues_with_allowlist(
        total_rows: i64,
        issues: Vec<TranslationQualityIssue>,
        issue_limit: usize,
        allowlisted_technical_count: i64,
    ) -> TranslationQualityAuditReport {
        let issue_count = i64::try_from(issues.len()).unwrap_or(i64::MAX);
        let high_severity_count = i64::try_from(
            issues
                .iter()
                .filter(|issue| issue.severity == "error")
                .count(),
        )
        .unwrap_or(i64::MAX);
        let retranslation_candidate_count = i64::try_from(
            issues
                .iter()
                .filter_map(|issue| issue.source_text_id)
                .collect::<BTreeSet<_>>()
                .len(),
        )
        .unwrap_or(i64::MAX);
        let high_risk_source_count = classified_source_count(&issues, "high_risk");
        let quality_retry_source_count = classified_source_count(&issues, "quality_retry");
        let limited_issues = if issue_limit == 0 {
            issues
        } else {
            issues.into_iter().take(issue_limit).collect()
        };
        TranslationQualityAuditReport {
            total_rows,
            issue_count,
            high_severity_count,
            retranslation_candidate_count,
            high_risk_source_count,
            quality_retry_source_count,
            allowlisted_technical_count,
            issues: limited_issues,
        }
    }
}

#[must_use]
pub fn is_allowed_technical_token(source: &str) -> bool {
    let source = source.trim();
    if source.is_empty() || source.len() > 32 {
        return false;
    }
    if source
        .chars()
        .all(|ch| ch == '\u{00a4}' || ch.is_whitespace())
    {
        return true;
    }
    if source.len() == 1 && source.chars().all(|ch| ch.is_ascii_alphabetic()) {
        return true;
    }
    if source.starts_with("${") && source.ends_with('}') {
        return source[2..source.len() - 1]
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'));
    }
    if source.starts_with('[') && source.ends_with(']') {
        let inner = &source[1..source.len() - 1];
        return matches!(
            inner.to_ascii_lowercase().as_str(),
            "space"
                | "escape"
                | "esc"
                | "enter"
                | "return"
                | "shift"
                | "ctrl"
                | "control"
                | "alt"
                | "tab"
                | "pageup"
                | "pagedown"
                | "up"
                | "down"
                | "left"
                | "right"
        );
    }
    if matches!(source, "Lv" | "HP" | "MP" | "TP" | "EXP") {
        return true;
    }
    if source.contains('_')
        && !source.chars().any(char::is_whitespace)
        && source
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        return true;
    }
    if source.starts_with('\u{25ba}')
        && source
            .chars()
            .skip(1)
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || matches!(ch, '-' | '_'))
    {
        return true;
    }
    let uppercase_count = source.chars().filter(|ch| ch.is_ascii_uppercase()).count();
    if uppercase_count < 2 {
        return false;
    }
    if source.chars().any(|ch| ch.is_ascii_lowercase()) {
        return source.len() <= 12
            && !source.chars().any(char::is_whitespace)
            && source
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'));
    }
    source.chars().all(|ch| {
        ch.is_ascii_uppercase()
            || ch.is_ascii_digit()
            || matches!(ch, ' ' | '_' | '-' | '+' | '.' | '%' | '/')
    })
}

fn push_issue(
    issues: &mut Vec<TranslationQualityIssue>,
    code: &str,
    severity: &str,
    message: &str,
    source_text: &str,
    translated_text: &str,
) {
    if issues.iter().any(|issue| issue.code == code) {
        return;
    }
    issues.push(TranslationQualityIssue {
        source_text_id: None,
        translation_id: None,
        unit_kind: None,
        code: code.to_string(),
        severity: severity.to_string(),
        classification: issue_classification(code, severity).to_string(),
        message: message.to_string(),
        source_text: source_text.to_string(),
        translated_text: translated_text.to_string(),
    });
}

fn issue_classification(code: &str, severity: &str) -> &'static str {
    match code {
        "raw_source_token" | "source_english_fragment" => "quality_retry",
        _ if severity == "error" => "high_risk",
        _ => "quality_retry",
    }
}

fn classified_source_count(issues: &[TranslationQualityIssue], classification: &str) -> i64 {
    let matching = issues
        .iter()
        .filter(|issue| issue.classification == classification)
        .collect::<Vec<_>>();
    if matching.is_empty() {
        return 0;
    }
    let source_ids = matching
        .iter()
        .filter_map(|issue| issue.source_text_id)
        .collect::<BTreeSet<_>>();
    if source_ids.is_empty() {
        i64::try_from(matching.len()).unwrap_or(i64::MAX)
    } else {
        i64::try_from(source_ids.len()).unwrap_or(i64::MAX)
    }
}

fn is_korean_target(target_language: &str) -> bool {
    let lower = target_language.to_lowercase();
    lower == "ko" || lower.contains("korean") || target_language.contains("한국")
}

fn contains_hangul(input: &str) -> bool {
    input.chars().any(is_hangul)
}

fn is_hangul(ch: char) -> bool {
    matches!(ch, '\u{ac00}'..='\u{d7a3}' | '\u{1100}'..='\u{11ff}' | '\u{3130}'..='\u{318f}')
}

fn contains_chatter_or_model_markup(input: &str) -> bool {
    let lower = input.to_lowercase();
    input.contains("```") || lower.contains("<think") || lower.contains("</think")
}

fn contains_literal_backslash_n(input: &str) -> bool {
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' && matches!(chars.peek(), Some('n')) {
            return true;
        }
    }
    false
}

fn strip_protected_metadata(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    let mut angle_depth = 0usize;
    let mut dollar_brace_depth = 0usize;
    while let Some(ch) = chars.next() {
        if angle_depth > 0 {
            if ch == '<' {
                angle_depth += 1;
            } else if ch == '>' {
                angle_depth = angle_depth.saturating_sub(1);
                if angle_depth == 0 {
                    output.push(' ');
                }
            }
            continue;
        }
        if dollar_brace_depth > 0 {
            if ch == '{' {
                dollar_brace_depth += 1;
            } else if ch == '}' {
                dollar_brace_depth = dollar_brace_depth.saturating_sub(1);
                if dollar_brace_depth == 0 {
                    output.push(' ');
                }
            }
            continue;
        }
        if ch == '<' {
            angle_depth = 1;
            continue;
        }
        if ch == '[' {
            let mut token = String::from("[");
            let mut found_end = false;
            for next in chars.by_ref() {
                token.push(next);
                if next == ']' {
                    found_end = true;
                    break;
                }
            }
            if found_end && is_allowed_technical_token(&token) {
                output.push(' ');
            } else {
                output.push_str(&token);
            }
            continue;
        }
        if ch == '$' && matches!(chars.peek(), Some('{')) {
            let _ = chars.next();
            dollar_brace_depth = 1;
            continue;
        }
        output.push(ch);
    }
    strip_allowed_inline_technical_tokens(&output)
}

fn strip_allowed_inline_technical_tokens(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if is_inline_ascii_token_char(ch) {
            let mut token = String::from(ch);
            while let Some(next) = chars.peek().copied() {
                if !is_inline_ascii_token_char(next) {
                    break;
                }
                token.push(next);
                let _ = chars.next();
            }
            if is_allowed_technical_token(&token) {
                output.push(' ');
            } else {
                output.push_str(&token);
            }
        } else {
            output.push(ch);
        }
    }
    output
}

fn is_inline_ascii_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '+' | '.' | '%' | '/')
}

fn protected_angle_tags(input: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let bytes = input.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'<' {
            index += 1;
            continue;
        }
        let tag_is_closing = input[index..].starts_with("</");
        if !tag_is_closing && index > 0 && is_ascii_identifier_byte(bytes[index - 1]) {
            index += 1;
            continue;
        }
        let Some(relative_end) = input[index..].find('>') else {
            break;
        };
        let end = index + relative_end + 1;
        let tag = &input[index..end];
        if tag.len() > 2 && tag.chars().any(|ch| ch.is_ascii_alphabetic()) {
            tags.push(tag.to_string());
        }
        index = end;
    }
    tags
}

fn is_ascii_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'\\'
}

fn contains_embedded_ascii_in_hangul(input: &str) -> bool {
    let chars: Vec<char> = input.chars().collect();
    chars.windows(3).any(|window| {
        is_hangul(window[0]) && window[1].is_ascii_alphabetic() && is_hangul(window[2])
    })
}

fn contains_foreign_connector(input: &str) -> bool {
    let padded = format!(" {} ", input.to_lowercase());
    [" de ", " des ", " der ", " le ", " la ", " les "]
        .iter()
        .any(|needle| padded.contains(needle))
}

fn contains_raw_source_token(source: &str, translation: &str) -> bool {
    ascii_words(source).into_iter().any(|token| {
        is_translatable_ascii_source_token(&token)
            && !is_allowed_technical_token(&token)
            && contains_ascii_word(translation, &token)
    })
}

fn contains_source_english_fragment(source: &str, translation: &str) -> bool {
    if translation
        .chars()
        .filter(|ch| ch.is_ascii_alphabetic())
        .count()
        < 4
    {
        return false;
    }
    if has_raw_stutter_fragment(translation) {
        return true;
    }
    ascii_words(source).into_iter().any(|token| {
        token.len() >= 4
            && !is_common_source_stopword(&token)
            && !is_allowed_technical_token(&token)
            && contains_ascii_word(translation, &token)
    })
}

fn has_raw_stutter_fragment(input: &str) -> bool {
    let chars: Vec<char> = input.chars().collect();
    chars.windows(3).any(|window| {
        window[0].is_ascii_alphabetic()
            && window[1] == '-'
            && (window[2].is_ascii_alphabetic() || is_hangul(window[2]))
    })
}

fn ascii_words(input: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphabetic() {
            current.push(ch);
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

fn contains_ascii_word(input: &str, word: &str) -> bool {
    ascii_words(input)
        .into_iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(word))
}

fn is_translatable_ascii_source_token(token: &str) -> bool {
    token.len() >= 3
        && token
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase())
        && token.chars().skip(1).any(|ch| ch.is_ascii_lowercase())
        && !is_common_source_stopword(token)
}

fn is_common_source_stopword(token: &str) -> bool {
    matches!(
        token.to_ascii_lowercase().as_str(),
        "the"
            | "and"
            | "that"
            | "this"
            | "with"
            | "from"
            | "into"
            | "your"
            | "you"
            | "are"
            | "has"
            | "have"
            | "had"
            | "was"
            | "were"
            | "will"
            | "would"
            | "could"
            | "should"
            | "what"
            | "when"
            | "where"
            | "why"
            | "how"
            | "not"
            | "but"
            | "for"
            | "all"
            | "only"
            | "just"
            | "like"
            | "look"
            | "looks"
            | "sorry"
            | "stop"
            | "making"
            | "words"
            | "say"
            | "those"
    )
}
