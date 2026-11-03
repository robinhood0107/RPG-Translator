use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde::{Deserialize, Serialize};

use rpg_translator_core::{DuplicateProjectCleanupReport, Error, NewProject, ProjectWorkspace};

use super::shared::{
    CommandResult, ProjectSummary, ProjectWorkspaceSummary, display_name_from_path, engine_key,
    normalize_windows_user_path, open_db, run_blocking, strip_windows_extended_path_prefix,
    write_gate,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListProjectsRequest {
    pub db_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectsResponse {
    pub projects: Vec<ProjectSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenProjectRequest {
    pub game_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenProjectFileRequest {
    pub project_file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecreateProjectDatabaseRequest {
    pub project_file_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectPathActionRequest {
    pub project_file_path: String,
    pub target_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectPathActionResponse {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupDuplicateProjectsRequest {
    pub db_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CleanupDuplicateProjectsResponse {
    pub report: DuplicateProjectCleanupReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenProjectResponse {
    pub project: Option<ProjectSummary>,
    pub workspace: ProjectWorkspaceSummary,
    pub layout: String,
    pub data_path: String,
    pub plugin_path: String,
    pub database_missing: bool,
    pub manifest_created: bool,
}

#[tauri::command]
pub async fn list_projects(request: ListProjectsRequest) -> CommandResult<ProjectsResponse> {
    run_blocking(move || {
        let db = open_db(&normalize_windows_user_path(&request.db_path))?;
        let projects = db.list_projects()?.into_iter().map(Into::into).collect();
        Ok(ProjectsResponse { projects })
    })
    .await
}

#[tauri::command]
pub async fn open_project(request: OpenProjectRequest) -> CommandResult<OpenProjectResponse> {
    run_blocking(move || {
        let game_root = normalize_windows_user_path(&request.game_root);
        let load = ProjectWorkspace::open_or_create_for_game_root(&game_root)?;
        open_loaded_workspace(load.workspace, load.manifest_created, load.manifest_created)
    })
    .await
}

#[tauri::command]
pub async fn open_project_file(
    request: OpenProjectFileRequest,
) -> CommandResult<OpenProjectResponse> {
    run_blocking(move || {
        let project_file_path = normalize_windows_user_path(&request.project_file_path);
        let workspace = ProjectWorkspace::open_project_file(&project_file_path)?;
        open_loaded_workspace(workspace, false, false)
    })
    .await
}

#[tauri::command]
pub async fn recreate_project_database(
    request: RecreateProjectDatabaseRequest,
) -> CommandResult<OpenProjectResponse> {
    run_blocking(move || {
        let project_file_path = normalize_windows_user_path(&request.project_file_path);
        let workspace = ProjectWorkspace::open_project_file(&project_file_path)?;
        open_loaded_workspace(workspace, false, true)
    })
    .await
}

#[tauri::command]
pub async fn cleanup_duplicate_projects(
    request: CleanupDuplicateProjectsRequest,
) -> CommandResult<CleanupDuplicateProjectsResponse> {
    run_blocking(move || {
        let _gate = write_gate()?;
        let mut db = open_db(&request.db_path)?;
        let report = db.cleanup_duplicate_projects()?;
        Ok(CleanupDuplicateProjectsResponse { report })
    })
    .await
}

#[tauri::command]
pub async fn reveal_path_in_explorer(
    request: ProjectPathActionRequest,
) -> CommandResult<ProjectPathActionResponse> {
    run_blocking(move || {
        let path = validated_project_target_path(&request)?;
        reveal_path(&path)?;
        Ok(ProjectPathActionResponse {
            path: normalize_windows_user_path(&path.to_string_lossy()),
        })
    })
    .await
}

#[tauri::command]
pub async fn open_folder_in_explorer(
    request: ProjectPathActionRequest,
) -> CommandResult<ProjectPathActionResponse> {
    run_blocking(move || {
        let path = validated_project_target_path(&request)?;
        let folder = folder_for_open(&path)?;
        open_folder(&folder)?;
        Ok(ProjectPathActionResponse {
            path: normalize_windows_user_path(&folder.to_string_lossy()),
        })
    })
    .await
}

#[tauri::command]
pub async fn copy_path_to_clipboard(
    request: ProjectPathActionRequest,
) -> CommandResult<ProjectPathActionResponse> {
    run_blocking(move || {
        let path = validated_project_target_path(&request)?;
        let display_path = normalize_windows_user_path(&path.to_string_lossy());
        copy_text_to_clipboard(&display_path)?;
        Ok(ProjectPathActionResponse { path: display_path })
    })
    .await
}

fn open_loaded_workspace(
    workspace: ProjectWorkspace,
    manifest_created: bool,
    create_missing_database: bool,
) -> CommandResult<OpenProjectResponse> {
    let detected = rpg_translator_core::RpgMakerDetector::detect(&workspace.game_root)?;
    let project = if workspace.database_missing && !create_missing_database {
        None
    } else {
        workspace.ensure_artifact_dirs()?;
        let mut db = open_db(&workspace.database_path.to_string_lossy())?;
        let workspace_game_root =
            normalize_windows_user_path(&workspace.game_root.to_string_lossy());
        let project_id = db.upsert_project(&NewProject {
            game_root: workspace_game_root.clone(),
            display_name: workspace.as_new_project_display_name(),
            engine: detected.engine.clone(),
        })?;
        Some(ProjectSummary {
            id: project_id,
            game_root: workspace_game_root.clone(),
            display_name: display_name_from_path(&workspace_game_root)?,
            engine: engine_key(&detected.engine),
        })
    };
    let mut workspace_summary: ProjectWorkspaceSummary = workspace.into();
    if create_missing_database {
        workspace_summary.database_missing = false;
    }
    Ok(OpenProjectResponse {
        project,
        workspace: workspace_summary.clone(),
        layout: format!("{:?}", detected.layout).to_ascii_lowercase(),
        data_path: strip_windows_extended_path_prefix(&detected.data_path),
        plugin_path: strip_windows_extended_path_prefix(&detected.plugin_path),
        database_missing: workspace_summary.database_missing,
        manifest_created,
    })
}

fn validated_project_target_path(
    request: &ProjectPathActionRequest,
) -> rpg_translator_core::Result<PathBuf> {
    let project_file_path = normalize_windows_user_path(&request.project_file_path);
    let target_path = PathBuf::from(normalize_windows_user_path(&request.target_path));
    if target_path.as_os_str().is_empty() {
        return Err(Error::invalid_input("target_path is required"));
    }
    let workspace = ProjectWorkspace::open_project_file(&project_file_path)?;
    let target = canonicalize_existing_or_parent(&target_path, "target path")?;
    let game_root = canonicalize_existing_or_parent(&workspace.game_root, "game root")?;
    let artifact_root = canonicalize_existing_or_parent(&workspace.artifact_root, "artifact root")?;
    if is_same_or_child(&target, &game_root) || is_same_or_child(&target, &artifact_root) {
        return Ok(target_path);
    }
    Err(Error::invalid_input(
        "target path must be inside the active project workspace",
    ))
}

fn canonicalize_existing_or_parent(
    path: &Path,
    label: &str,
) -> rpg_translator_core::Result<PathBuf> {
    if path.exists() {
        return fs::canonicalize(path).map_err(|error| {
            Error::invalid_input(format!(
                "failed to resolve {label} {}: {error}",
                path.display()
            ))
        });
    }
    let parent = path.parent().ok_or_else(|| {
        Error::invalid_input(format!(
            "{label} has no parent directory: {}",
            path.display()
        ))
    })?;
    let parent = fs::canonicalize(parent).map_err(|error| {
        Error::invalid_input(format!(
            "failed to resolve {label} parent {}: {error}",
            parent.display()
        ))
    })?;
    let file_name = path.file_name().ok_or_else(|| {
        Error::invalid_input(format!("{label} has no file name: {}", path.display()))
    })?;
    Ok(parent.join(file_name))
}

fn is_same_or_child(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn folder_for_open(path: &Path) -> rpg_translator_core::Result<PathBuf> {
    if path.is_dir() {
        return Ok(path.to_path_buf());
    }
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| Error::invalid_input("target path has no folder"))
}

fn reveal_path(path: &Path) -> rpg_translator_core::Result<()> {
    let target = if path.exists() {
        path.to_path_buf()
    } else {
        folder_for_open(path)?
    };
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(format!("/select,{}", target.display()))
            .spawn()
            .map(|_| ())
            .map_err(|error| Error::invalid_input(format!("failed to start Explorer: {error}")))
    }
    #[cfg(target_os = "macos")]
    {
        command_status_result(
            Command::new("open").arg("-R").arg(&target).status(),
            "reveal path in file manager",
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        command_status_result(
            Command::new("xdg-open")
                .arg(folder_for_open(&target)?)
                .status(),
            "reveal path in file manager",
        )
    }
}

fn open_folder(path: &Path) -> rpg_translator_core::Result<()> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer.exe")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| Error::invalid_input(format!("failed to start Explorer: {error}")))
    }
    #[cfg(target_os = "macos")]
    {
        command_status_result(
            Command::new("open").arg(path).status(),
            "open folder in file manager",
        )
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        command_status_result(
            Command::new("xdg-open").arg(path).status(),
            "open folder in file manager",
        )
    }
}

fn copy_text_to_clipboard(text: &str) -> rpg_translator_core::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let mut child = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-Command",
                "Set-Clipboard -Value ([Console]::In.ReadToEnd())",
            ])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| {
                Error::invalid_input(format!("failed to start clipboard command: {error}"))
            })?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|error| {
                Error::invalid_input(format!("failed to write clipboard text: {error}"))
            })?;
        }
        return command_status_result(child.wait(), "copy path to clipboard");
    }
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|error| {
                Error::invalid_input(format!("failed to start clipboard command: {error}"))
            })?;
        if let Some(stdin) = child.stdin.as_mut() {
            stdin.write_all(text.as_bytes()).map_err(|error| {
                Error::invalid_input(format!("failed to write clipboard text: {error}"))
            })?;
        }
        return command_status_result(child.wait(), "copy path to clipboard");
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for command in ["wl-copy", "xclip"] {
            let mut child = match Command::new(command).stdin(Stdio::piped()).spawn() {
                Ok(child) => child,
                Err(_) => continue,
            };
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(text.as_bytes()).map_err(|error| {
                    Error::invalid_input(format!("failed to write clipboard text: {error}"))
                })?;
            }
            return command_status_result(child.wait(), "copy path to clipboard");
        }
        Err(Error::invalid_input("clipboard command is not available"))
    }
}

fn command_status_result(
    status: std::io::Result<std::process::ExitStatus>,
    label: &str,
) -> rpg_translator_core::Result<()> {
    let status =
        status.map_err(|error| Error::invalid_input(format!("failed to {label}: {error}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(Error::invalid_input(format!(
            "{label} exited with {status}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_fixture_game(root: &Path) {
        fs::create_dir_all(root.join("data")).expect("create data dir");
        fs::create_dir_all(root.join("js")).expect("create js dir");
        fs::write(
            root.join("data/System.json"),
            r#"{"gameTitle":"City Of Secrets","advanced":{},"optAutosave":true}"#,
        )
        .expect("write system");
        fs::write(root.join("js/plugins.js"), "var $plugins = [];").expect("write plugins");
    }

    #[test]
    fn validates_project_file_actions_inside_active_workspace_only() {
        let temp = tempdir().expect("create temp dir");
        let game_root = temp.path().join("City_Of_Secrets");
        write_fixture_game(&game_root);
        let workspace = ProjectWorkspace::open_or_create_for_game_root(&game_root)
            .expect("create project workspace")
            .workspace;
        let inside_request = ProjectPathActionRequest {
            project_file_path: workspace.manifest_path.to_string_lossy().into_owned(),
            target_path: workspace
                .artifact_root
                .join("db/City_Of_Secrets.sqlite")
                .to_string_lossy()
                .into_owned(),
        };

        let accepted = validated_project_target_path(&inside_request).expect("accept project path");
        assert!(accepted.ends_with("db/City_Of_Secrets.sqlite"));

        let outside_path = temp.path().join("outside.txt");
        fs::write(&outside_path, "outside").expect("write outside file");
        let outside_request = ProjectPathActionRequest {
            project_file_path: workspace.manifest_path.to_string_lossy().into_owned(),
            target_path: outside_path.to_string_lossy().into_owned(),
        };
        let error = validated_project_target_path(&outside_request)
            .expect_err("outside path must be rejected");
        assert!(error.to_string().contains("active project workspace"));
    }
}
