//! Guard for commands that touch files outside the app workspace.
//!
//! Paths chosen through a Tauri dialog are in the window's `fs_scope` for the
//! current session. Paths from earlier sessions are remembered in settings and
//! Books state, so they are accepted when they appear in that persisted
//! allowlist. Anything else is rejected — the webview renders third-party
//! HTML and EPUB content and must not be able to read or overwrite arbitrary
//! files on the user's disk.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;

use crate::state::AppState;
use crate::storage::read_json;

fn add_all(value: Option<&serde_json::Value>, out: &mut BTreeSet<PathBuf>) {
    let Some(value) = value else { return };
    match value {
        serde_json::Value::String(path) => {
            if Path::new(path).is_absolute() {
                out.insert(PathBuf::from(path));
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| add_all(Some(item), out)),
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                if Path::new(key).is_absolute() {
                    out.insert(PathBuf::from(key));
                }
                add_all(Some(item), out);
            }
        }
        _ => {}
    }
}

fn persisted_external_paths(state: &AppState) -> BTreeSet<PathBuf> {
    let mut allowed = BTreeSet::new();
    if let Some(settings) = read_json::<serde_json::Value>(&state.paths.settings) {
        for field in [
            "externalFiles",
            "inboxNotePath",
            "noteFolder",
            "recordingFolder",
            "captureNotes",
            "fileMeta",
        ] {
            add_all(settings.get(field), &mut allowed);
        }
    }
    if let Some(books) = read_json::<serde_json::Value>(&state.workspace.join("books.json")) {
        if let Some(files) = books.get("files") {
            add_all(Some(files), &mut allowed);
        }
    }
    allowed
}

/// Ensure `path` was chosen in the app (now or in a previous session).
pub fn ensure_external_access(
    app: &AppHandle,
    state: &AppState,
    path: &Path,
) -> Result<(), String> {
    if app.fs_scope().is_allowed(path) {
        return Ok(());
    }
    let allowed = persisted_external_paths(state);
    if allowed.contains(path)
        || path
            .parent()
            .map(|parent| allowed.contains(parent))
            .unwrap_or(false)
    {
        return Ok(());
    }
    Err(format!(
        "Choose this file in Annotate Studio before using it: {}",
        path.display()
    ))
}

/// Read-only variant: an unavailable path is simply reported as missing rather
/// than failing the command (refresh keeps unavailable files in the library).
pub fn external_read_allowed(app: &AppHandle, state: &AppState, path: &Path) -> bool {
    ensure_external_access(app, state, path).is_ok()
}
