use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use rpg_translator_core::{Engine, Error, ProjectRecord, Result, TranslationDb};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandError {
    pub message: String,
}

impl CommandError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl From<Error> for CommandError {
    fn from(error: Error) -> Self {
        Self::new(error.to_string())
    }
}

pub type CommandResult<T> = std::result::Result<T, CommandError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectSummary {
    pub id: i64,
    pub game_root: String,
    pub display_name: String,
    pub engine: String,
}

impl From<ProjectRecord> for ProjectSummary {
    fn from(project: ProjectRecord) -> Self {
        Self {
            id: project.id,
            game_root: project.game_root,
            display_name: project.display_name,
            engine: project.engine.as_key().to_string(),
        }
    }
}

pub async fn run_blocking<F, T>(work: F) -> CommandResult<T>
where
    F: FnOnce() -> CommandResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::new(format!("background task failed: {error}")))?
}

pub fn open_db(db_path: &str) -> Result<TranslationDb> {
    if db_path.trim().is_empty() {
        return Err(Error::invalid_input("db_path is required"));
    }
    let mut db = TranslationDb::open(PathBuf::from(db_path))?;
    db.migrate()?;
    Ok(db)
}

pub fn display_name_from_path(path: &str) -> Result<String> {
    PathBuf::from(path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| Error::invalid_input("game root has no display name"))
}

pub fn engine_key(engine: &Engine) -> String {
    engine.as_key().to_string()
}
