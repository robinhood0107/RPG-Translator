use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Error, ProviderBatchRequest, ProviderBatchResponse, ProviderClient, Result};

pub const DEFAULT_SYSTEM_PROMPT: &str = concat!(
    "Translate the user's text into Korean. Raw translation only, no explanations or alternative translations.\n",
    "Format: JSON Lines. Return one JSON Line per input line containing raw translated output. {\"id\":123,\"translation\":\"translated text\"}\\n\n",
    "Preserve every ¤ character exactly if one appears in the source text.",
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
        let system_prompt = self.config.system_prompt.trim();
        let prompt = if system_prompt.is_empty() || system_prompt == DEFAULT_SYSTEM_PROMPT {
            DEFAULT_SYSTEM_PROMPT.to_string()
        } else {
            format!("{system_prompt}\n{DEFAULT_SYSTEM_PROMPT}")
        };
        let prompt = format!(
            "{prompt}\nSource language: {}. Target language: {}.",
            self.config.source_language, self.config.target_language
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
