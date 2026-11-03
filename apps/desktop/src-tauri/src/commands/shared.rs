use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};

use rpg_translator_core::{Engine, Error, ProjectRecord, ProjectWorkspace, Result, TranslationDb};

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
        Self::new(user_facing_error_message(&error))
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectWorkspaceSummary {
    pub project_file_path: String,
    pub artifact_root: String,
    pub db_path: String,
    pub game_root: String,
    pub display_name: String,
    pub engine: String,
    pub database_missing: bool,
    pub checkpoints_path: String,
    pub exports_path: String,
    pub installs_path: String,
    pub logs_path: String,
    pub temp_path: String,
}

impl From<ProjectWorkspace> for ProjectWorkspaceSummary {
    fn from(workspace: ProjectWorkspace) -> Self {
        Self {
            project_file_path: user_visible_path(&workspace.manifest_path),
            artifact_root: user_visible_path(&workspace.artifact_root),
            db_path: user_visible_path(&workspace.database_path),
            game_root: user_visible_path(&workspace.game_root),
            display_name: workspace.manifest.display_name,
            engine: workspace.manifest.engine,
            database_missing: workspace.database_missing,
            checkpoints_path: user_visible_path(&workspace.checkpoints_path),
            exports_path: user_visible_path(&workspace.exports_path),
            installs_path: user_visible_path(&workspace.installs_path),
            logs_path: user_visible_path(&workspace.logs_path),
            temp_path: user_visible_path(&workspace.temp_path),
        }
    }
}

impl From<ProjectRecord> for ProjectSummary {
    fn from(project: ProjectRecord) -> Self {
        Self {
            id: project.id,
            game_root: strip_windows_extended_path_prefix(&project.game_root),
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
    open_db_migrating(db_path)
}

pub fn open_db_migrating(db_path: &str) -> Result<TranslationDb> {
    let db_path = normalize_windows_user_path(db_path);
    if db_path.is_empty() {
        return Err(Error::invalid_input("db_path is required"));
    }
    let db_path = PathBuf::from(db_path);
    TranslationDb::open_with_schema_guard(&db_path)
}

pub fn open_db_existing(db_path: &str) -> Result<TranslationDb> {
    open_db_migrating(db_path)
}

pub fn write_gate() -> CommandResult<MutexGuard<'static, ()>> {
    static WRITE_GATE: OnceLock<Mutex<()>> = OnceLock::new();
    WRITE_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| CommandError::new("DB write gate is poisoned"))
}

fn user_facing_error_message(error: &Error) -> String {
    let message = error.to_string();
    if message.contains("database is locked") || message.contains("database table is locked") {
        return "DB가 현재 번역 저장 중입니다. 몇 초 후 다시 시도하세요. 다른 RPG-Translator 창이 같은 DB를 사용 중일 수도 있습니다.".to_string();
    }
    message
}

pub fn display_name_from_path(path: &str) -> Result<String> {
    PathBuf::from(normalize_windows_user_path(path))
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

pub fn user_visible_path(path: &Path) -> String {
    normalize_windows_user_path(&path.to_string_lossy())
}

pub fn strip_windows_extended_path_prefix(path: &str) -> String {
    normalize_windows_user_path(path)
}

pub fn normalize_windows_user_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_file_url = strip_file_url_prefix(trimmed);
    let slash_path = without_file_url.replace('\\', "/");
    let lower = slash_path.to_ascii_lowercase();
    if let Some(rest) = strip_prefix_by_lower(&slash_path, &lower, "///?/unc/")
        .or_else(|| strip_prefix_by_lower(&slash_path, &lower, "//?/unc/"))
    {
        return format!("\\\\{}", rest.replace('/', "\\"));
    }
    if let Some(rest) = strip_prefix_by_lower(&slash_path, &lower, "///?/")
        .or_else(|| strip_prefix_by_lower(&slash_path, &lower, "//?/"))
    {
        return normalize_windows_drive_slashes(rest);
    }
    if let Some(rest) = strip_prefix_by_lower(&slash_path, &lower, "/mnt/") {
        let mut chars = rest.chars();
        let Some(drive) = chars.next() else {
            return slash_path;
        };
        if drive.is_ascii_alphabetic() && chars.next() == Some('/') {
            let remainder: String = chars.collect();
            return format!(
                "{}:\\{}",
                drive.to_ascii_uppercase(),
                remainder.replace('/', "\\")
            );
        }
    }
    normalize_windows_drive_slashes(&slash_path)
}

fn strip_file_url_prefix(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    strip_prefix_by_lower(value, &lower, "file:///")
        .or_else(|| strip_prefix_by_lower(value, &lower, "file://"))
        .unwrap_or(value)
}

fn strip_prefix_by_lower<'a>(original: &'a str, lower: &str, prefix: &str) -> Option<&'a str> {
    lower.starts_with(prefix).then(|| &original[prefix.len()..])
}

fn normalize_windows_drive_slashes(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        value.replace('/', "\\")
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::strip_windows_extended_path_prefix;

    #[test]
    fn strips_windows_extended_device_prefix_for_display() {
        assert_eq!(
            strip_windows_extended_path_prefix(
                "\\\\?\\C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\City_Of_Secrets.rpgmakers"
            ),
            "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\City_Of_Secrets.rpgmakers"
        );
    }

    #[test]
    fn strips_windows_extended_unc_prefix_for_display() {
        assert_eq!(
            strip_windows_extended_path_prefix("\\\\?\\UNC\\server\\share\\game\\rpg-translator"),
            "\\\\server\\share\\game\\rpg-translator"
        );
    }

    #[test]
    fn normalizes_slash_device_prefix_for_display() {
        assert_eq!(
            strip_windows_extended_path_prefix(
                "///?/C:/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator/City_Of_Secrets.rpgmakers"
            ),
            "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\City_Of_Secrets.rpgmakers"
        );
        assert_eq!(
            strip_windows_extended_path_prefix(
                "//?/C:/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator"
            ),
            "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator"
        );
    }

    #[test]
    fn normalizes_file_url_and_wsl_drive_paths_for_display() {
        assert_eq!(
            strip_windows_extended_path_prefix(
                "file:///C:/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator/db/City_Of_Secrets.sqlite"
            ),
            "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator\\db\\City_Of_Secrets.sqlite"
        );
        assert_eq!(
            strip_windows_extended_path_prefix(
                "/mnt/c/Users/pjjpj/Desktop/새 폴더/City_Of_Secrets/rpg-translator"
            ),
            "C:\\Users\\pjjpj\\Desktop\\새 폴더\\City_Of_Secrets\\rpg-translator"
        );
    }
}
