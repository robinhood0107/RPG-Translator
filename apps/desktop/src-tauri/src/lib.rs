use rpg_translator_core::PROJECT_NAME;
use std::sync::Arc;

pub mod commands;

#[must_use]
pub fn desktop_shell_name() -> String {
    format!("{PROJECT_NAME} Desktop")
}

pub fn run() {
    commands::scan::write_scan_console_startup_status();
    commands::translate::write_translate_console_startup_status();
    tauri::Builder::default()
        .manage(Arc::new(commands::translate::TranslationJobState::default()))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::projects::list_projects,
            commands::projects::open_project,
            commands::projects::open_project_file,
            commands::projects::recreate_project_database,
            commands::projects::cleanup_duplicate_projects,
            commands::projects::reveal_path_in_explorer,
            commands::projects::open_folder_in_explorer,
            commands::projects::copy_path_to_clipboard,
            commands::workbench::hydrate_workbench,
            commands::workbench::save_workbench_settings,
            commands::workbench::save_workbench_state,
            commands::scan::scan_game,
            commands::translate::translate_with_local_provider,
            commands::translate::pause_translation,
            commands::translate::prepare_safe_shutdown,
            commands::translate::force_close_workbench,
            commands::translate::test_local_provider,
            commands::translate::benchmark_provider_translation_speed,
            commands::review::review_queue,
            commands::review::update_review_state,
            commands::review::update_review_row,
            commands::review::bulk_approve_review_rows,
            commands::export_install::export_bundle,
            commands::export_install::install_overlay,
            commands::export_install::rollback_overlay,
            commands::diagnostics::diagnostics_summary,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run RPG-Translator workbench");
}
