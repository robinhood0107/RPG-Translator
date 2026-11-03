use sha2::{Digest, Sha256};

use crate::Engine;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CacheKeyParts {
    pub engine: Engine,
    pub source_language: String,
    pub target_language: String,
    pub normalized_text: String,
    pub control_code_signature: String,
    pub context_hash: Option<String>,
}

pub struct CacheKeyBuilder;

impl CacheKeyBuilder {
    #[must_use]
    pub fn build(parts: &CacheKeyParts) -> String {
        let mut hasher = Sha256::new();
        update_field(&mut hasher, "schema", "v1");
        update_field(&mut hasher, "engine", parts.engine.as_key());
        update_field(&mut hasher, "source_language", &parts.source_language);
        update_field(&mut hasher, "target_language", &parts.target_language);
        update_field(&mut hasher, "normalized_text", &parts.normalized_text);
        update_field(
            &mut hasher,
            "control_code_signature",
            &parts.control_code_signature,
        );
        update_field(
            &mut hasher,
            "context_hash",
            parts.context_hash.as_deref().unwrap_or(""),
        );
        format!("ck:v1:{}", hex::encode(hasher.finalize()))
    }
}

fn update_field(hasher: &mut Sha256, name: &str, value: &str) {
    hasher.update(name.as_bytes());
    hasher.update([0]);
    hasher.update(value.len().to_string().as_bytes());
    hasher.update([0]);
    hasher.update(value.as_bytes());
    hasher.update([0xff]);
}
