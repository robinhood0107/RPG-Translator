use crate::TextAnalysis;

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
