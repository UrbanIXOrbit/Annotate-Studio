pub mod ai_json;
pub mod ai_router;
pub mod analytics;
pub mod commands;
pub mod external_access;
pub mod filesystem;
pub mod paths;
pub mod spaced_repetition;
pub mod state;
pub mod storage;
pub mod text;

use commands::{ai, backup, books, data, files, flashcards, recordings, video, web_articles};
use paths::Workspace;
use state::AppState;
use tauri::{Manager, Emitter};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app_state = match AppState::initialize(Workspace::new(Workspace::default_root())) {
        Ok(state) => state,
        Err(err) => {
            eprintln!("Annotate Studio failed to start: {err}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .menu(|app| {
            // Rebuild the standard macOS menu bar, plus our Help entries.
            let app_name = "Annotate Studio";
            let sep = || PredefinedMenuItem::separator(app);

            let app_menu = tauri::menu::Submenu::with_items(
                app,
                app_name,
                true,
                &[
                    &PredefinedMenuItem::about(app, None, None)?,
                    &sep()?,
                    &PredefinedMenuItem::services(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;

            let file_menu = tauri::menu::Submenu::with_items(
                app,
                "File",
                true,
                &[&PredefinedMenuItem::close_window(app, None)?],
            )?;

            let edit_menu = tauri::menu::Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &PredefinedMenuItem::undo(app, None)?,
                    &PredefinedMenuItem::redo(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::cut(app, None)?,
                    &PredefinedMenuItem::copy(app, None)?,
                    &PredefinedMenuItem::paste(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::select_all(app, None)?,
                ],
            )?;

            let window_menu = tauri::menu::Submenu::with_items(
                app,
                "Window",
                true,
                &[
                    &PredefinedMenuItem::minimize(app, None)?,
                    &PredefinedMenuItem::maximize(app, None)?,
                    &sep()?,
                    &PredefinedMenuItem::close_window(app, None)?,
                ],
            )?;

            let help_item = MenuItem::with_id(app, "show_help", "Annotate Studio Help", true, None::<&str>)?;
            let shortcuts_item = MenuItem::with_id(app, "show_shortcuts", "Keyboard Shortcuts", true, None::<&str>)?;
            let help_sep = PredefinedMenuItem::separator(app)?;
            let about_item = PredefinedMenuItem::about(app, None, None)?;
            let help_menu = tauri::menu::Submenu::with_items(app, "Help", true, &[
                &help_item,
                &shortcuts_item,
                &help_sep,
                &about_item,
            ])?;

            Menu::with_items(app, &[
                &app_menu, &file_menu, &edit_menu, &window_menu, &help_menu,
            ])
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == "show_help" || id == "show_shortcuts" {
                let _ = app.emit("annotate:menu-help", id);
            }
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(app_state)
        .manage(recordings::AudioRecorderState::default())
        .invoke_handler(tauri::generate_handler![
            files::list_workspace_files,
            files::stat_workspace_file,
            files::read_text_file,
            files::read_note,
            files::write_text_file,
            files::create_note,
            files::rename_workspace_file,
            files::delete_workspace_file,
            files::read_file_bytes,
            files::stat_external_file,
            files::path_exists,
            files::create_external_note,
            files::rename_external_file,
            files::write_file_bytes,
            files::write_external_file_bytes,
            files::import_files,
            data::get_data_dir,
            data::load_workspace_scopes,
            data::save_workspace_scopes,
            data::load_canvas_state,
            data::save_canvas_state,
            data::load_settings,
            data::save_settings,
            data::load_exams,
            data::save_exams,
            data::load_collections,
            data::save_collections,
            data::load_chat_sessions,
            data::save_chat_sessions,
            data::load_motivation_sessions,
            data::save_motivation_sessions,
            data::log_study_activity,
            data::get_study_stats,
            flashcards::get_flashcards,
            flashcards::get_flashcard_stats,
            flashcards::count_due_flashcards,
            flashcards::create_flashcard,
            flashcards::update_flashcard,
            flashcards::review_flashcard,
            flashcards::delete_flashcard,
            flashcards::delete_flashcards_by_collection,
            flashcards::reset_flashcards,
            ai::ai_chat,
            ai::generate_flashcards,
            ai::generate_flashcards_from_file,
            ai::cancel_generation,
            ai::get_ai_providers,
            ai::add_ai_provider,
            ai::remove_ai_provider,
            ai::set_default_ai_provider,
            ai::test_ai_provider,
            ai::check_ollama,
            backup::export_data,
            backup::import_data,
            backup::inspect_backup,
            backup::create_snapshot,
            backup::get_backups_dir,
            books::import_external_files,
            books::external_files_exist,
            books::load_books_state,
            books::save_books_state,
            books::open_external_file,
            books::reveal_external_file,
            books::read_external_file_bytes,
            books::read_book_annotation_set,
            books::write_book_annotation_set,
            video::allow_video_asset,
            video::open_video_in_system_player,
            video::list_video_players,
            video::open_video_with_player,
            video::is_ffmpeg_available,
            video::convert_video_for_playback,
            web_articles::fetch_web_page,
            recordings::start_audio_recording,
            recordings::set_audio_recording_paused,
            recordings::stop_audio_recording,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Annotate Studio");
}
