use serde::{Deserialize, Serialize};

use rpg_translator_core::{NewProject, RpgMakerDetector};

use super::shared::{
    CommandResult, ProjectSummary, display_name_from_path, engine_key, open_db, run_blocking,
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
    pub db_path: String,
    pub game_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenProjectResponse {
    pub project: ProjectSummary,
    pub layout: String,
    pub data_path: String,
    pub plugin_path: String,
}

#[tauri::command]
pub async fn list_projects(request: ListProjectsRequest) -> CommandResult<ProjectsResponse> {
    run_blocking(move || {
        let db = open_db(&request.db_path)?;
        let projects = db.list_projects()?.into_iter().map(Into::into).collect();
        Ok(ProjectsResponse { projects })
    })
    .await
}

#[tauri::command]
pub async fn open_project(request: OpenProjectRequest) -> CommandResult<OpenProjectResponse> {
    run_blocking(move || {
        let detected = RpgMakerDetector::detect(&request.game_root)?;
        let mut db = open_db(&request.db_path)?;
        let project_id = db.upsert_project(&NewProject {
            game_root: detected.game_root.clone(),
            display_name: display_name_from_path(&request.game_root)?,
            engine: detected.engine.clone(),
        })?;
        Ok(OpenProjectResponse {
            project: ProjectSummary {
                id: project_id,
                game_root: detected.game_root,
                display_name: display_name_from_path(&request.game_root)?,
                engine: engine_key(&detected.engine),
            },
            layout: format!("{:?}", detected.layout).to_ascii_lowercase(),
            data_path: detected.data_path,
            plugin_path: detected.plugin_path,
        })
    })
    .await
}
