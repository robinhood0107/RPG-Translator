use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{Engine, Error, Result, RpgMakerDetector};

pub const PROJECT_ARTIFACT_DIR: &str = "rpg-translator";
const PROJECT_MANIFEST_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectManifest {
    pub schema_version: u32,
    pub project_id: String,
    pub display_name: String,
    pub engine: String,
    pub game_root: String,
    pub created_at: String,
    pub updated_at: String,
    pub paths: ProjectManifestPaths,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectManifestPaths {
    pub database: String,
    pub checkpoints: String,
    pub exports: String,
    pub installs: String,
    pub logs: String,
    pub temp: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectWorkspace {
    pub manifest: ProjectManifest,
    pub manifest_path: PathBuf,
    pub artifact_root: PathBuf,
    pub game_root: PathBuf,
    pub database_path: PathBuf,
    pub checkpoints_path: PathBuf,
    pub exports_path: PathBuf,
    pub installs_path: PathBuf,
    pub logs_path: PathBuf,
    pub temp_path: PathBuf,
    pub database_missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectWorkspaceLoad {
    pub workspace: ProjectWorkspace,
    pub manifest_created: bool,
}

impl ProjectWorkspace {
    pub fn open_or_create_for_game_root(
        game_root: impl AsRef<Path>,
    ) -> Result<ProjectWorkspaceLoad> {
        let detected = RpgMakerDetector::detect(game_root.as_ref())?;
        let game_root = canonicalize_dir(Path::new(&detected.game_root), "game root")?;
        let display_name = display_name_from_path(&game_root)?;
        let safe_name = safe_project_file_stem(&display_name);
        let artifact_root = game_root.join(PROJECT_ARTIFACT_DIR);
        let manifest_path = artifact_root.join(format!("{safe_name}.rpgmakers"));

        if manifest_path.is_file() {
            return Ok(ProjectWorkspaceLoad {
                workspace: Self::open_project_file(&manifest_path)?,
                manifest_created: false,
            });
        }

        fs::create_dir_all(&artifact_root).map_err(|error| {
            Error::invalid_input(format!(
                "failed to create project artifact directory {}: {error}",
                artifact_root.display()
            ))
        })?;
        create_standard_artifact_dirs(&artifact_root)?;

        let now = timestamp();
        let manifest = ProjectManifest {
            schema_version: PROJECT_MANIFEST_SCHEMA_VERSION,
            project_id: project_id_for(&game_root, &now),
            display_name,
            engine: detected.engine.as_key().to_string(),
            game_root: "..".to_string(),
            created_at: now.clone(),
            updated_at: now,
            paths: ProjectManifestPaths {
                database: format!("db/{safe_name}.sqlite"),
                checkpoints: "checkpoints".to_string(),
                exports: "exports".to_string(),
                installs: "installs".to_string(),
                logs: "logs".to_string(),
                temp: "temp".to_string(),
            },
        };
        write_manifest_atomic(&manifest_path, &manifest)?;
        let mut workspace = Self::from_manifest_path_and_manifest(manifest_path, manifest)?;
        workspace.database_missing = false;
        Ok(ProjectWorkspaceLoad {
            workspace,
            manifest_created: true,
        })
    }

    pub fn open_project_file(project_file_path: impl AsRef<Path>) -> Result<Self> {
        let project_file_path = project_file_path.as_ref();
        if project_file_path
            .extension()
            .and_then(|value| value.to_str())
            != Some("rpgmakers")
        {
            return Err(Error::invalid_input(
                "project file must use the .rpgmakers extension",
            ));
        }
        let manifest_path = fs::canonicalize(project_file_path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to open project file {}: {error}",
                project_file_path.display()
            ))
        })?;
        let text = fs::read_to_string(&manifest_path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to read project file {}: {error}",
                manifest_path.display()
            ))
        })?;
        let manifest: ProjectManifest = serde_json::from_str(&text).map_err(|error| {
            Error::invalid_input(format!(
                "failed to parse project file {}: {error}",
                manifest_path.display()
            ))
        })?;
        Self::from_manifest_path_and_manifest(manifest_path, manifest)
    }

    pub fn ensure_artifact_dirs(&self) -> Result<()> {
        create_standard_artifact_dirs(&self.artifact_root)
    }

    pub fn engine(&self) -> Engine {
        Engine::from_key(&self.manifest.engine)
    }

    pub fn as_new_project_display_name(&self) -> String {
        self.manifest.display_name.clone()
    }

    fn from_manifest_path_and_manifest(
        manifest_path: PathBuf,
        manifest: ProjectManifest,
    ) -> Result<Self> {
        if manifest.schema_version != PROJECT_MANIFEST_SCHEMA_VERSION {
            return Err(Error::invalid_input(format!(
                "unsupported .rpgmakers schema version {}",
                manifest.schema_version
            )));
        }
        let artifact_root = manifest_path
            .parent()
            .ok_or_else(|| Error::invalid_input("project file has no parent directory"))?
            .to_path_buf();
        if artifact_root.file_name().and_then(|value| value.to_str()) != Some(PROJECT_ARTIFACT_DIR)
        {
            return Err(Error::invalid_input(format!(
                "project file must live inside a {PROJECT_ARTIFACT_DIR} folder"
            )));
        }
        let artifact_root = canonicalize_dir(&artifact_root, "project artifact directory")?;
        let game_root = resolve_game_root(&artifact_root, &manifest.game_root)?;
        let expected_artifact_root = game_root.join(PROJECT_ARTIFACT_DIR);
        if canonicalize_dir(&expected_artifact_root, "project artifact directory")? != artifact_root
        {
            return Err(Error::invalid_input(
                "project file game_root does not point back to its game folder",
            ));
        }

        let database_path =
            resolve_artifact_path(&artifact_root, &manifest.paths.database, "paths.database")?;
        let checkpoints_path = resolve_artifact_path(
            &artifact_root,
            &manifest.paths.checkpoints,
            "paths.checkpoints",
        )?;
        let exports_path =
            resolve_artifact_path(&artifact_root, &manifest.paths.exports, "paths.exports")?;
        let installs_path =
            resolve_artifact_path(&artifact_root, &manifest.paths.installs, "paths.installs")?;
        let logs_path = resolve_artifact_path(&artifact_root, &manifest.paths.logs, "paths.logs")?;
        let temp_path = resolve_artifact_path(&artifact_root, &manifest.paths.temp, "paths.temp")?;

        Ok(Self {
            database_missing: !database_path.is_file(),
            manifest,
            manifest_path,
            artifact_root,
            game_root,
            database_path,
            checkpoints_path,
            exports_path,
            installs_path,
            logs_path,
            temp_path,
        })
    }
}

fn create_standard_artifact_dirs(artifact_root: &Path) -> Result<()> {
    for child in ["db", "checkpoints", "exports", "installs", "logs", "temp"] {
        let path = artifact_root.join(child);
        fs::create_dir_all(&path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to create project artifact directory {}: {error}",
                path.display()
            ))
        })?;
    }
    Ok(())
}

fn resolve_game_root(artifact_root: &Path, relative_path: &str) -> Result<PathBuf> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err(Error::invalid_input(
            "game_root in .rpgmakers must be relative",
        ));
    }
    let resolved = lexical_normalize(&artifact_root.join(relative));
    canonicalize_dir(&resolved, "game root")
}

fn resolve_artifact_path(
    artifact_root: &Path,
    relative_path: &str,
    field: &str,
) -> Result<PathBuf> {
    let relative = Path::new(relative_path);
    if relative.as_os_str().is_empty() {
        return Err(Error::invalid_input(format!("{field} must not be empty")));
    }
    if relative.is_absolute()
        || relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(Error::invalid_input(format!(
            "{field} must be a relative path inside {PROJECT_ARTIFACT_DIR}"
        )));
    }
    Ok(artifact_root.join(relative))
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn canonicalize_dir(path: &Path, label: &str) -> Result<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(|error| {
        Error::invalid_input(format!(
            "failed to resolve {label} {}: {error}",
            path.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(Error::invalid_input(format!(
            "{label} is not a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn write_manifest_atomic(path: &Path, manifest: &ProjectManifest) -> Result<()> {
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| Error::invalid_input(format!("failed to encode project file: {error}")))?;
    let temp_path = path.with_extension("rpgmakers.tmp");
    fs::write(&temp_path, format!("{text}\n")).map_err(|error| {
        Error::invalid_input(format!(
            "failed to write project file temp {}: {error}",
            temp_path.display()
        ))
    })?;
    fs::rename(&temp_path, path).map_err(|error| {
        Error::invalid_input(format!(
            "failed to commit project file {}: {error}",
            path.display()
        ))
    })
}

fn display_name_from_path(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| Error::invalid_input("game root has no display name"))
}

fn safe_project_file_stem(value: &str) -> String {
    let mut safe = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
            safe.push(character);
        } else if character.is_whitespace()
            || matches!(
                character,
                '.' | ':' | '/' | '\\' | '"' | '\'' | '<' | '>' | '|' | '?' | '*'
            )
        {
            safe.push('_');
        }
    }
    let safe = safe.trim_matches(['_', '.', ' ']).to_string();
    if safe.is_empty() {
        "RPG_Project".to_string()
    } else {
        safe
    }
}

fn project_id_for(game_root: &Path, created_at: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(game_root.to_string_lossy().as_bytes());
    hasher.update(b"\n");
    hasher.update(created_at.as_bytes());
    let digest = hasher.finalize();
    format!("rpg-{}", &hex::encode(digest)[..16])
}

fn timestamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    format!("unix:{seconds}")
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;

    fn make_direct_game(root: &Path) {
        fs::create_dir_all(root.join("data")).expect("create data");
        fs::create_dir_all(root.join("js")).expect("create js");
        fs::write(
            root.join("data/System.json"),
            r#"{"gameTitle":"Fixture","advanced":{},"optAutosave":true}"#,
        )
        .expect("write system");
        fs::write(root.join("js/plugins.js"), "var $plugins = [];").expect("write plugins");
    }

    #[test]
    fn creates_manifest_and_standard_project_artifacts() {
        let temp = tempdir().expect("tempdir");
        let game_root = temp.path().join("City Of Secrets");
        make_direct_game(&game_root);

        let load =
            ProjectWorkspace::open_or_create_for_game_root(&game_root).expect("open project");
        let workspace = load.workspace;

        assert!(load.manifest_created);
        assert!(
            workspace
                .manifest_path
                .ends_with("rpg-translator/City_Of_Secrets.rpgmakers")
        );
        assert_eq!(
            workspace.manifest.paths.database,
            "db/City_Of_Secrets.sqlite"
        );
        assert!(
            workspace
                .database_path
                .ends_with("rpg-translator/db/City_Of_Secrets.sqlite")
        );
        assert!(workspace.checkpoints_path.is_dir());
        assert!(!workspace.database_missing);
    }

    #[test]
    fn reopens_existing_manifest_without_creating_missing_database() {
        let temp = tempdir().expect("tempdir");
        let game_root = temp.path().join("Fixture_Game");
        make_direct_game(&game_root);
        let first =
            ProjectWorkspace::open_or_create_for_game_root(&game_root).expect("create project");
        fs::write(&first.workspace.database_path, "").expect("touch db");
        fs::remove_file(&first.workspace.database_path).expect("remove db");

        let second =
            ProjectWorkspace::open_or_create_for_game_root(&game_root).expect("reopen project");

        assert!(!second.manifest_created);
        assert!(second.workspace.database_missing);
        assert!(!second.workspace.database_path.exists());
    }

    #[test]
    fn opens_project_file_directly() {
        let temp = tempdir().expect("tempdir");
        let game_root = temp.path().join("Fixture_Game");
        make_direct_game(&game_root);
        let created =
            ProjectWorkspace::open_or_create_for_game_root(&game_root).expect("create project");

        let reopened = ProjectWorkspace::open_project_file(&created.workspace.manifest_path)
            .expect("open project file");

        assert_eq!(reopened.manifest_path, created.workspace.manifest_path);
        assert_eq!(reopened.game_root, created.workspace.game_root);
        assert_eq!(reopened.database_path, created.workspace.database_path);
    }

    #[test]
    fn rejects_artifact_paths_that_escape_project_root() {
        let temp = tempdir().expect("tempdir");
        let game_root = temp.path().join("Fixture_Game");
        make_direct_game(&game_root);
        let created =
            ProjectWorkspace::open_or_create_for_game_root(&game_root).expect("create project");
        let mut manifest = created.workspace.manifest.clone();
        manifest.paths.database = "../outside.sqlite".to_string();
        write_manifest_atomic(&created.workspace.manifest_path, &manifest).expect("write manifest");

        let error = ProjectWorkspace::open_project_file(&created.workspace.manifest_path)
            .expect_err("path traversal rejected");

        assert!(error.to_string().contains("paths.database"));
    }
}
