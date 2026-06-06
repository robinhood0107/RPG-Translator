use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum Engine {
    Mv,
    Mz,
    Unknown,
}

impl Engine {
    #[must_use]
    pub fn as_key(&self) -> &'static str {
        match self {
            Self::Mv => "mv",
            Self::Mz => "mz",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum GameLayoutKind {
    Direct,
    Www,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectedGame {
    pub game_root: String,
    pub engine: Engine,
    pub layout: GameLayoutKind,
    pub data_path: String,
    pub plugin_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextAnalysis {
    pub original_text: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub control_codes: Vec<String>,
    pub control_code_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewProject {
    pub game_root: String,
    pub display_name: String,
    pub engine: Engine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewSourceText {
    pub source_language: String,
    pub normalized_text: String,
    pub visible_text: String,
    pub control_code_signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataFileRecord {
    pub file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OccurrenceContext {
    pub file_path: String,
    pub json_path: String,
    pub entity_type: String,
    pub event_id: Option<i64>,
    pub page_index: Option<i64>,
    pub command_index: Option<i64>,
    pub command_code: Option<i64>,
    pub parameter_index: Option<i64>,
    pub object_key: Option<String>,
    pub extraction_rule_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExtractedOccurrence {
    pub raw_text: String,
    pub source_text: NewSourceText,
    pub context: OccurrenceContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RejectedCandidate {
    pub raw_text: String,
    pub reason: String,
    pub context: OccurrenceContext,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SkippedDataFile {
    pub file_path: String,
    pub reason: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanReport {
    pub detected_game: DetectedGame,
    pub files: Vec<DataFileRecord>,
    pub accepted: Vec<ExtractedOccurrence>,
    pub rejected: Vec<RejectedCandidate>,
    pub skipped: Vec<SkippedDataFile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewOccurrence {
    pub source_text_id: i64,
    pub file_path: String,
    pub json_path: String,
    pub entity_type: String,
    pub event_id: Option<i64>,
    pub page_index: Option<i64>,
    pub command_index: Option<i64>,
    pub command_code: Option<i64>,
    pub parameter_index: Option<i64>,
    pub object_key: Option<String>,
    pub extraction_rule_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewTranslation {
    pub source_text_id: i64,
    pub target_language: String,
    pub translated_text: String,
    pub provider: String,
    pub model: Option<String>,
    pub review_state: String,
    pub qa_state: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TranslationRecord {
    pub id: i64,
    pub source_text_id: i64,
    pub target_language: String,
    pub translated_text: String,
    pub provider: String,
    pub model: Option<String>,
    pub review_state: String,
    pub qa_state: String,
}
