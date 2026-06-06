use rpg_translator_core::PROJECT_NAME;

pub mod commands;

#[must_use]
pub fn desktop_shell_name() -> String {
    format!("{PROJECT_NAME} Desktop")
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::projects::list_projects,
            commands::projects::open_project,
            commands::scan::scan_game,
            commands::translate::translate_with_fake_provider,
            commands::review::review_queue,
            commands::review::update_review_state,
            commands::export_install::export_bundle,
            commands::export_install::install_overlay,
            commands::export_install::rollback_overlay,
            commands::diagnostics::diagnostics_summary,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RPG-Translator workbench");
}
