use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{Error, ProviderBatchRequest, ProviderBatchResponse, ProviderClient, Result};

const SAFE_SYSTEM_PROMPT: &str = "You are a translation engine for RPG Maker text. Translate each JSONL input row from the source language to the target language. Return JSONL only, with exactly one object per input row using fields id and translation. Preserve RPG Maker control-code placeholders exactly, preserve line breaks, and do not add explanations.";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LocalOpenAiConfig {
    pub base_url: String,
    pub model: String,
    pub source_language: String,
    pub target_language: String,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_output_tokens: Option<usize>,
}

pub trait LocalProviderTransport {
    fn post_json(&mut self, url: &str, body: &Value) -> Result<Value>;
}

pub struct LocalOpenAiProvider<T> {
    config: LocalOpenAiConfig,
    transport: T,
}

impl<T> LocalOpenAiProvider<T> {
    pub fn new(config: LocalOpenAiConfig, transport: T) -> Result<Self> {
        if config.base_url.trim().is_empty() {
            return Err(Error::invalid_input("local provider base_url is required"));
        }
        if config.model.trim().is_empty() {
            return Err(Error::invalid_input("local provider model is required"));
        }
        Ok(Self { config, transport })
    }

    #[must_use]
    pub fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: LocalProviderTransport> LocalOpenAiProvider<T> {
    pub fn translate_batch(
        &mut self,
        request: &ProviderBatchRequest,
    ) -> Result<ProviderBatchResponse> {
        <Self as ProviderClient>::translate_batch(self, request)
    }

    fn chat_url(&self) -> String {
        format!(
            "{}/v1/chat/completions",
            self.config.base_url.trim_end_matches('/')
        )
    }

    fn request_body(&self, request: &ProviderBatchRequest) -> Value {
        let mut body = json!({
            "model": self.config.model,
            "stream": false,
            "messages": [
                {
                    "role": "system",
                    "content": safe_system_prompt(&self.config.source_language, &self.config.target_language),
                },
                {
                    "role": "user",
                    "content": jsonl_input(request),
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

impl<T: LocalProviderTransport> ProviderClient for LocalOpenAiProvider<T> {
    fn provider_name(&self) -> &str {
        "local-openai-compatible"
    }

    fn model_name(&self) -> Option<&str> {
        Some(&self.config.model)
    }

    fn translate_batch(&mut self, request: &ProviderBatchRequest) -> Result<ProviderBatchResponse> {
        let body = self.request_body(request);
        let response = self.transport.post_json(&self.chat_url(), &body)?;
        Ok(ProviderBatchResponse {
            raw_output: extract_chat_content(&response)?,
        })
    }
}

fn safe_system_prompt(source_language: &str, target_language: &str) -> String {
    format!(
        "{SAFE_SYSTEM_PROMPT} Source language: {source_language}. Target language: {target_language}."
    )
}

fn jsonl_input(request: &ProviderBatchRequest) -> String {
    request
        .items
        .iter()
        .map(|item| json!({ "id": item.id, "text": item.text }).to_string())
        .collect::<Vec<_>>()
        .join("\n")
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
        return Ok(content.to_string());
    }

    if let Some(output) = response.get("output").and_then(Value::as_array) {
        let content = output
            .iter()
            .filter(|item| item.get("type").and_then(Value::as_str) == Some("message"))
            .filter_map(|item| item.get("content").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("");
        if !content.is_empty() {
            return Ok(content);
        }
    }

    Err(Error::invalid_input(
        "local provider response missing chat message content",
    ))
}
