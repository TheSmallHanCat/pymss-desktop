#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod error;
mod model_dir_migration;
mod python;
mod state;
mod storage;

use state::AppState;

fn main() {
    tauri::Builder::default()
        .on_page_load(|webview, _payload| {
            let window = webview.window();
            if !cfg!(target_os = "macos") {
                let _ = window.set_decorations(false);
            }
            let _ = window.show();
            let _ = window.set_focus();
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::app_cmd::cancel_task,
            commands::app_cmd::create_blank_editor_project,
            commands::app_cmd::create_editor_project_from_task,
            commands::app_cmd::delete_model,
            commands::app_cmd::start_model_delete,
            commands::app_cmd::delete_editor_project,
            commands::app_cmd::download_model,
            commands::app_cmd::editor_project_exists,
            commands::app_cmd::export_editor_mix,
            commands::app_cmd::get_app_paths,
            commands::app_cmd::get_env_info,
            commands::app_cmd::generate_waveform_peaks,
            commands::app_cmd::get_audio_metadata,
            commands::app_cmd::get_model_info,
            commands::app_cmd::get_model_storage_summary,
            commands::app_cmd::import_editor_assets,
            commands::app_cmd::list_audio_files,
            commands::app_cmd::list_editor_projects,
            commands::app_cmd::list_models,
            commands::app_cmd::load_app_store,
            commands::app_cmd::load_editor_project,
            commands::app_cmd::migrate_data_root_to_portable,
            commands::app_cmd::relink_editor_sources,
            commands::app_cmd::open_editor_window,
            commands::app_cmd::pick_media_files,
            commands::app_cmd::pick_audio_files,
            commands::app_cmd::pick_single_audio_file,
            commands::app_cmd::pick_input_folder,
            commands::app_cmd::pick_output_folder,
            commands::app_cmd::prepare_model_dir_change,
            commands::app_cmd::reveal_path,
            commands::app_cmd::move_paths_to_trash,
            commands::app_cmd::respond_model_dir_migration_conflict,
            commands::app_cmd::confirm_model_dir_migration_switch,
            commands::app_cmd::cancel_model_dir_migration,
            commands::app_cmd::cleanup_model_residual_files,
            commands::app_cmd::start_cleanup_model_residual_files,
            commands::app_cmd::save_app_store,
            commands::app_cmd::save_editor_project,
            commands::app_cmd::scan_media_paths,
            commands::app_cmd::scan_audio_paths,
            commands::app_cmd::scan_editor_assets,
            commands::app_cmd::start_env_check,
            commands::app_cmd::start_model_dir_migration,
            commands::app_cmd::start_model_download,
            commands::app_cmd::start_separation,
            commands::app_cmd::start_workflow_inference,
            commands::app_cmd::worker_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pymss Studio");
}
