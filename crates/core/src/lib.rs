mod cache_key;
mod db;
mod domain;
mod error;
mod text_codec;

pub use cache_key::{CacheKeyBuilder, CacheKeyParts};
pub use db::TranslationDb;
pub use domain::{
    Engine, NewOccurrence, NewProject, NewSourceText, NewTranslation, TextAnalysis,
    TranslationRecord,
};
pub use error::{Error, Result};
pub use text_codec::TextCodec;

pub const PROJECT_NAME: &str = "RPG-Translator";

#[must_use]
pub fn workspace_ready_message() -> String {
    format!("{PROJECT_NAME} workspace ready")
}
