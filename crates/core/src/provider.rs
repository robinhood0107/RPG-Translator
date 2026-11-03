use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Error, ProviderBatchRequest, ProviderBatchResponse, ProviderClient, Result};

pub const DEFAULT_SYSTEM_PROMPT: &str = concat!(
    "RPG Maker localization transport contract. Keep provider input and output as JSON Lines. ",
    "The user message contains items shaped like {\"id\":123,\"text\":\"source text\"}. ",
    "The assistant response must contain items shaped like {\"id\":123,\"translation\":\"translated text\"}.",
);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalOpenAiConfig {
    pub base_url: String,
    pub model: String,
    pub source_language: String,
    pub target_language: String,
    pub system_prompt: String,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<usize>,
}

pub trait LocalProviderTransport {
    fn post_json(&mut self, url: &str, body: &Value) -> Result<Value>;

    fn get_json(&mut self, _url: &str) -> Result<Value> {
        Err(Error::invalid_input(
            "local provider model lookup is not supported by this transport",
        ))
    }
}

pub struct LocalOpenAiProvider<T> {
    config: LocalOpenAiConfig,
    transport: T,
    api_mode: LocalProviderApiMode,
}

impl<T> LocalOpenAiProvider<T> {
    #[must_use]
    pub fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: LocalProviderTransport> LocalOpenAiProvider<T> {
    pub fn new(mut config: LocalOpenAiConfig, mut transport: T) -> Result<Self> {
        if config.base_url.trim().is_empty() {
            return Err(Error::invalid_input("local provider base_url is required"));
        }
        let model = config.model.trim();
        if model.is_empty() {
            return Err(Error::invalid_input("local provider model is required"));
        }
        let mut api_mode = LocalProviderApiMode::OpenAiCompatible;
        config.model = if is_auto_model(model) {
            let resolved = resolve_auto_model(&config.base_url, &mut transport)?;
            api_mode = resolved.api_mode;
            resolved.model
        } else {
            model.to_string()
        };
        Ok(Self {
            config,
            transport,
            api_mode,
        })
    }

    pub fn translate_batch(
        &mut self,
        request: &ProviderBatchRequest,
    ) -> Result<ProviderBatchResponse> {
        <Self as ProviderClient>::translate_batch(self, request)
    }

    fn chat_url(&self) -> String {
        chat_url(&self.config.base_url, self.api_mode)
    }

    fn request_body(&self, request: &ProviderBatchRequest) -> Value {
        self.request_body_for(self.api_mode, request)
    }

    fn request_body_for(
        &self,
        api_mode: LocalProviderApiMode,
        request: &ProviderBatchRequest,
    ) -> Value {
        let prompt = build_provider_system_prompt(
            &self.config.system_prompt,
            &self.config.source_language,
            &self.config.target_language,
        );
        if api_mode == LocalProviderApiMode::LmStudio {
            let mut body = json!({
                "model": self.config.model,
                "stream": false,
                "system_prompt": prompt,
                "input": user_content(request),
            });
            if let Some(temperature) = self.config.temperature {
                body["temperature"] = json!(temperature);
            }
            if let Some(top_p) = self.config.top_p {
                body["top_p"] = json!(top_p);
            }
            if let Some(max_output_tokens) = self.config.max_output_tokens {
                body["max_tokens"] = json!(max_output_tokens);
            }
            return body;
        }
        let mut body = json!({
            "model": self.config.model,
            "stream": false,
            "messages": [
                {
                    "role": "system",
                    "content": prompt,
                },
                {
                    "role": "user",
                    "content": user_content(request),
                }
            ],
        });
        if let Some(temperature) = self.config.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(top_p) = self.config.top_p {
            body["top_p"] = json!(top_p);
        }
        if let Some(max_output_tokens) = self.config.max_output_tokens {
            body["max_tokens"] = json!(max_output_tokens);
        }
        body
    }
}

#[must_use]
pub fn build_provider_system_prompt(
    user_prompt: &str,
    source_language: &str,
    target_language: &str,
) -> String {
    let user_prompt = user_prompt.trim();
    let prompt = if user_prompt.is_empty() || user_prompt == DEFAULT_SYSTEM_PROMPT {
        DEFAULT_SYSTEM_PROMPT
    } else {
        return format!(
            "{user_prompt}\n{DEFAULT_SYSTEM_PROMPT}\n\n{}",
            final_translation_rule(
                &language_display_name(source_language),
                &language_display_name(target_language)
            )
        );
    };
    let source_language_name = language_display_name(source_language);
    let target_language_name = language_display_name(target_language);
    format!(
        "{prompt}\n\n{}",
        final_translation_rule(&source_language_name, &target_language_name)
    )
}

#[must_use]
pub fn build_quality_retry_instruction(target_language: &str) -> String {
    let target_language_name = language_display_name(target_language);
    format!(
        "Quality Retry: Rewrite only the flagged translation rows into {target_language_name}.\n\
Preserve JSONL ids and output exactly one JSON object per input item, one object per line.\n\
Preserve RPG Maker control codes, placeholders, page breaks, real line breaks, and every ¤ character.\n\
Copy every complete angle-bracket metadata tag byte-for-byte, such as <Disable Switch: 8> or <Enable Switch: 12>.\n\
Do not emit literal \\\\n text when an actual line break is intended.\n\
Do not leave foreign connector words, particles, or filler words such as de, des, der, le, la, or les.\n\
For Korean, transliterate recurring character names unless they are protected technical tokens: Emma -> 엠마, Laura -> 로라, Aurora -> 오로라, Olivia -> 올리비아, Eva -> 에바, Victoria -> 빅토리아, Lexi -> 렉시.\n\
Translate visible gameplay/story terms into {target_language_name}; preserve bracketed keyboard keys such as [Space] and [Escape]."
    )
}

fn final_translation_rule(source_language_name: &str, target_language_name: &str) -> String {
    format!(
        "Provider I/O Contract:\n\
Source language: {source_language_name}\n\
Target language: {target_language_name}\n\n\
Input:\n\
Each user line is JSONL in this shape:\n\
{{\"id\":123,\"text\":\"source text\"}}\n\n\
Output:\n\
Return exactly one JSON object per input item, one JSON object per line:\n\
{{\"id\":123,\"translation\":\"...\"}}\n\n\
Hard requirements:\n\
- id must be an integer.\n\
- Use only the translation field for translated text.\n\
- Do NOT quote id values.\n\
- Do NOT use text instead of translation.\n\
- Do NOT use *id.\n\
- Do NOT omit, duplicate, reorder, merge, or split IDs.\n\
- Do NOT include markdown code blocks, greetings, explanations, or extra lines.\n\
- Preserve IDs, placeholders, RPG Maker control codes, ¤, real line breaks, page breaks, bracketed key tokens, variable tokens, and complete <...> metadata tags byte-for-byte.\n\
- Translate only the human-visible story/dialogue/game text into {target_language_name}.\n\
- Localize names and short dialogue into {target_language_name} unless the entire item is a technical token.\n\
- Do not leave third-language connector words unless they are part of a protected technical token."
    )
}

fn language_display_name(language: &str) -> String {
    let trimmed = language.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "en" | "eng" | "english" => "English".to_string(),
        "ja" | "jp" | "jpn" | "japanese" | "日本語" => "Japanese".to_string(),
        "ko" | "kor" | "korean" | "한국어" => "Korean".to_string(),
        "zh" | "zho" | "chinese" | "中文" => "Chinese".to_string(),
        "zh-tw" | "zh_tw" | "traditional chinese" | "chinese traditional" => {
            "Chinese Traditional".to_string()
        }
        "es" | "spa" | "spanish" => "Spanish".to_string(),
        "fr" | "fra" | "fre" | "french" => "French".to_string(),
        "de" | "deu" | "ger" | "german" => "German".to_string(),
        "it" | "ita" | "italian" => "Italian".to_string(),
        "pt" | "por" | "portuguese" => "Portuguese".to_string(),
        "ru" | "rus" | "russian" => "Russian".to_string(),
        "vi" | "vie" | "vietnamese" => "Vietnamese".to_string(),
        "th" | "tha" | "thai" => "Thai".to_string(),
        "id" | "ind" | "indonesian" => "Indonesian".to_string(),
        "tr" | "tur" | "turkish" => "Turkish".to_string(),
        "pl" | "pol" | "polish" => "Polish".to_string(),
        "uk" | "ukr" | "ukrainian" => "Ukrainian".to_string(),
        "ar" | "ara" | "arabic" => "Arabic".to_string(),
        "hi" | "hin" | "hindi" => "Hindi".to_string(),
        "ms" | "msa" | "malay" => "Malay".to_string(),
        _ => {
            if trimmed.is_empty() {
                "the target language".to_string()
            } else {
                trimmed.to_string()
            }
        }
    }
}

fn is_auto_model(model: &str) -> bool {
    model.trim().eq_ignore_ascii_case("auto")
}

fn models_url(base_url: &str) -> String {
    format!("{}/v1/models", base_url.trim_end_matches('/'))
}

fn lm_studio_models_url(base_url: &str) -> String {
    format!("{}/api/v1/models", base_url.trim_end_matches('/'))
}

fn chat_url(base_url: &str, api_mode: LocalProviderApiMode) -> String {
    match api_mode {
        LocalProviderApiMode::OpenAiCompatible => {
            format!("{}/v1/chat/completions", base_url.trim_end_matches('/'))
        }
        LocalProviderApiMode::LmStudio => {
            format!("{}/api/v1/chat", base_url.trim_end_matches('/'))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalProviderApiMode {
    OpenAiCompatible,
    LmStudio,
}

struct ResolvedModel {
    model: String,
    api_mode: LocalProviderApiMode,
}

fn resolve_auto_model<T: LocalProviderTransport>(
    base_url: &str,
    transport: &mut T,
) -> Result<ResolvedModel> {
    match transport.get_json(&models_url(base_url)) {
        Ok(response) => Ok(ResolvedModel {
            model: extract_first_model_id(&response)?,
            api_mode: LocalProviderApiMode::OpenAiCompatible,
        }),
        Err(openai_error) => match transport.get_json(&lm_studio_models_url(base_url)) {
            Ok(response) => Ok(ResolvedModel {
                model: extract_first_model_id(&response)?,
                api_mode: LocalProviderApiMode::LmStudio,
            }),
            Err(lm_studio_error) => Err(Error::invalid_input(format!(
                "local provider auto model lookup failed for /v1/models ({openai_error}) and /api/v1/models ({lm_studio_error})"
            ))),
        },
    }
}

fn extract_first_model_id(response: &Value) -> Result<String> {
    for key in ["data", "models"] {
        if let Some(models) = response.get(key).and_then(Value::as_array) {
            for model in models {
                let candidate = model
                    .as_str()
                    .or_else(|| model.get("id").and_then(Value::as_str))
                    .or_else(|| model.get("name").and_then(Value::as_str))
                    .or_else(|| model.get("model").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                if let Some(model_id) = candidate {
                    return Ok(model_id.to_string());
                }
            }
        }
    }
    Err(Error::invalid_input(
        "local provider auto model lookup returned no models; enter a model name manually",
    ))
}

impl<T: LocalProviderTransport> ProviderClient for LocalOpenAiProvider<T> {
    fn provider_name(&self) -> &str {
        "local-openai-compatible"
    }

    fn model_name(&self) -> Option<&str> {
        Some(&self.config.model)
    }

    fn translate_batch(&mut self, request: &ProviderBatchRequest) -> Result<ProviderBatchResponse> {
        let body = self.request_body(request);
        let response = match self.transport.post_json(&self.chat_url(), &body) {
            Ok(response) => response,
            Err(first_error) if self.api_mode == LocalProviderApiMode::OpenAiCompatible => {
                let fallback_url = chat_url(&self.config.base_url, LocalProviderApiMode::LmStudio);
                let fallback_body = self.request_body_for(LocalProviderApiMode::LmStudio, request);
                match self.transport.post_json(&fallback_url, &fallback_body) {
                    Ok(response) => {
                        self.api_mode = LocalProviderApiMode::LmStudio;
                        response
                    }
                    Err(second_error) => {
                        return Err(Error::invalid_input(format!(
                            "local provider request failed for /v1/chat/completions ({first_error}) and /api/v1/chat ({second_error})"
                        )));
                    }
                }
            }
            Err(error) => return Err(error),
        };
        Ok(ProviderBatchResponse {
            raw_output: extract_chat_content(&response)?,
        })
    }
}

fn jsonl_input(request: &ProviderBatchRequest) -> String {
    request
        .items
        .iter()
        .map(|item| json!({ "id": item.id, "text": item.text }).to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn user_content(request: &ProviderBatchRequest) -> String {
    let input = jsonl_input(request);
    if let Some(instruction) = request
        .instruction
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        format!("{instruction}\n{input}")
    } else {
        input
    }
}

fn extract_chat_content(response: &Value) -> Result<String> {
    if let Some(content) = response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    {
        return Ok(strip_chat_template_artifacts(content).to_string());
    }

    if let Some(content) = response
        .get("content")
        .or_else(|| response.get("response"))
        .or_else(|| response.get("text"))
        .and_then(Value::as_str)
    {
        return Ok(strip_chat_template_artifacts(content).to_string());
    }

    if let Some(output) = response.get("output").and_then(Value::as_array) {
        let content = output
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|item| item.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !content.is_empty() {
            return Ok(strip_chat_template_artifacts(&content).to_string());
        }
    }

    Err(Error::invalid_input(
        "local provider response missing chat message content",
    ))
}

fn strip_chat_template_artifacts(content: &str) -> &str {
    let mut value = content.trim();
    loop {
        let before = value;
        value = strip_known_prefix(value);
        value = strip_channel_prefix(value);
        value = strip_known_suffix(value);
        if value == before {
            return value;
        }
    }
}

fn strip_channel_prefix(content: &str) -> &str {
    let mut value = content.trim_start();
    loop {
        let Some(rest) = value.strip_prefix("<|channel>") else {
            return value;
        };
        let Some(end_index) = rest.find("<channel|>") else {
            return value;
        };
        value = rest[end_index + "<channel|>".len()..].trim_start();
    }
}

fn strip_known_prefix(content: &str) -> &str {
    let mut value = content.trim_start();
    loop {
        let Some(next) = strip_one_known_prefix(value) else {
            return value;
        };
        value = next.trim_start();
    }
}

fn strip_one_known_prefix(content: &str) -> Option<&str> {
    for prefix in [
        "<|turn>model",
        "<|turn>assistant",
        "<|start_header_id|>assistant<|end_header_id|>",
        "<|assistant|>",
    ] {
        if let Some(rest) = content.strip_prefix(prefix) {
            return Some(rest);
        }
    }
    None
}

fn strip_known_suffix(content: &str) -> &str {
    let mut value = content.trim_end();
    loop {
        let Some(next) = strip_one_known_suffix(value) else {
            return value;
        };
        value = next.trim_end();
    }
}

fn strip_one_known_suffix(content: &str) -> Option<&str> {
    for suffix in ["<turn|>", "<|eot_id|>", "<|end_of_turn|>", "<|endoftext|>"] {
        if let Some(rest) = content.strip_suffix(suffix) {
            return Some(rest);
        }
    }
    None
}
