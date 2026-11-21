use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, State};

use crate::filesystem::{describe, describe_absolute, list_study_files, StudyFile};
use crate::paths::{
    sanitize_file_name, sanitize_stem, split_name, unique_in_dir, NOTES_DIR,
};
use crate::external_access::{ensure_external_access, external_read_allowed};
use crate::state::AppState;
use crate::storage::{write_atomic, write_in_place};
use sha2::{Digest, Sha256};
use crate::text::{bytes_look_binary, text_from_file};

fn io_error(path: &str, err: std::io::Error) -> String {
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("File not found: {path}"),
        std::io::ErrorKind::PermissionDenied => format!("Permission denied: {path}"),
        _ => format!("Could not access {path}: {err}"),
    }
}

fn describe_or_err(state: &AppState, path: &Path) -> Result<StudyFile, String> {
    describe(&state.workspace, path)
        .ok_or_else(|| format!("Could not read file information for {}", path.display()))
}

/// Write a new file at a path chosen through a dialog (e.g. "save a copy").
/// The path must be in the current filesystem scope; existing files are not
/// overwritten by this command.
#[tauri::command(async)]
pub async fn write_external_copy(
    app: AppHandle,
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    if body.len() < 4 {
        return Err("Malformed binary payload".into());
    }
    let header_len = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
    if body.len() < 4 + header_len {
        return Err("Malformed binary payload".into());
    }
    #[derive(Deserialize)]
    struct CopyTarget {
        path: String,
    }
    let target: CopyTarget = serde_json::from_slice(&body[4..4 + header_len])
        .map_err(|e| format!("Malformed payload header: {e}"))?;
    let full = PathBuf::from(target.path.trim());
    if !full.is_absolute() {
        return Err("Choose an absolute file path".into());
    }
    ensure_external_access(&app, &state, &full)?;
    if full.exists() {
        return Err("Choose a new file name — this copy will not overwrite an existing file".into());
    }
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&full, &body[4 + header_len..]).map_err(|e| io_error(&target.path, e))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    pub size: u64,
    pub modified_at: String,
    pub hash: String,
}

/// Snapshot of an external file, used to detect edits made by another program
/// before we write our own changes back to it.
#[tauri::command(async)]
pub async fn file_fingerprint(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<FileFingerprint, String> {
    let full = PathBuf::from(path.trim());
    ensure_external_access(&app, &state, &full)?;
    let meta = std::fs::metadata(&full).map_err(|e| io_error(&path, e))?;
    let size = meta.len();
    let modified_at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default();
    let mut file = std::fs::File::open(&full).map_err(|e| io_error(&path, e))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| io_error(&path, e))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let hash = format!("{:x}", hasher.finalize());
    Ok(FileFingerprint { size, modified_at, hash })
}

/// Write a recovery copy of unsaved annotation changes into app-owned storage.
/// Uses the same binary frame as `write_file_bytes`; the target's name is used.
#[tauri::command(async)]
pub async fn save_recovery_file(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<String, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    let (target, data) = decode_frame(body)?;
    let name = target.name.unwrap_or_else(|| format!("recovery-{}.bin", chrono::Utc::now().timestamp()));
    let safe = sanitize_file_name(&name);
    let dir = state.paths.backups_dir.join("recovery");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = unique_in_dir(&dir, &safe);
    write_atomic(&path, data)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn list_workspace_files(state: State<'_, AppState>) -> Result<Vec<StudyFile>, String> {
    list_study_files(&state.workspace)
}

#[tauri::command(async)]
pub fn stat_workspace_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<StudyFile>, String> {
    let full = state.workspace.resolve_user_file(&path)?;
    Ok(describe(&state.workspace, &full))
}

#[tauri::command(async)]
pub fn read_text_file(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let full = state.workspace.resolve_user_file(&path)?;
    let bytes = std::fs::read(&full).map_err(|e| io_error(&path, e))?;
    text_from_file(&full, &bytes).ok_or_else(|| format!("{path} does not contain readable text"))
}

#[derive(Serialize)]
pub struct NoteText {
    content: String,
    editable: bool,
}

fn decode_note(bytes: &[u8]) -> Option<NoteText> {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    if bytes_look_binary(body) {
        return None;
    }
    Some(match std::str::from_utf8(body) {
        Ok(text) => NoteText {
            content: text.to_string(),
            editable: true,
        },
        Err(_) => NoteText {
            content: String::from_utf8_lossy(body).into_owned(),
            editable: false,
        },
    })
}

#[tauri::command(async)]
pub fn read_note(state: State<'_, AppState>, path: String) -> Result<NoteText, String> {
    let full = state.workspace.resolve_user_file(&path)?;
    let bytes = std::fs::read(&full).map_err(|e| io_error(&path, e))?;
    decode_note(&bytes).ok_or_else(|| format!("{path} does not contain readable text"))
}

#[tauri::command(async)]
pub fn write_text_file(
    state: State<'_, AppState>,
    path: String,
    content: String,
) -> Result<StudyFile, String> {
    let full = state.workspace.resolve_user_file(&path)?;
    write_atomic(&full, content.as_bytes())?;
    describe_or_err(&state, &full)
}

fn strip_extension_ignore_case<'a>(name: &'a str, ext: &str) -> Option<&'a str> {
    let suffix_len = ext.len() + 1;
    if name.len() <= suffix_len || !name.is_char_boundary(name.len() - suffix_len) {
        return None;
    }
    let (stem, suffix) = name.split_at(name.len() - suffix_len);
    (suffix.starts_with('.') && suffix[1..].eq_ignore_ascii_case(ext)).then_some(stem)
}

fn same_file(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        match (std::fs::metadata(a), std::fs::metadata(b)) {
            (Ok(x), Ok(y)) => x.dev() == y.dev() && x.ino() == y.ino(),
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(x), Ok(y)) => x == y,
            _ => false,
        }
    }
}

#[tauri::command(async)]
pub fn create_note(
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<StudyFile, String> {
    let requested = name.trim();
    let stem = strip_extension_ignore_case(requested, "md")
        .or_else(|| strip_extension_ignore_case(requested, "markdown"))
        .unwrap_or(requested);
    let file_name = format!("{}.md", sanitize_stem(stem));
    let dir = state.workspace.resolve(NOTES_DIR)?;
    let target = unique_in_dir(&dir, &file_name);
    write_atomic(&target, content.as_bytes())?;
    describe_or_err(&state, &target)
}

#[tauri::command(async)]
pub fn rename_workspace_file(
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<StudyFile, String> {
    let from = state.workspace.resolve_user_file(&path)?;
    if !from.is_file() {
        return Err(format!("File not found: {path}"));
    }
    let parent = from
        .parent()
        .ok_or_else(|| "Invalid file location".to_string())?;
    let current_name = from
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let requested = new_name.trim();
    let name = match split_name(&current_name).1 {
        Some(ext) => {
            let stem = strip_extension_ignore_case(requested, &ext).unwrap_or(requested);
            format!("{}.{ext}", sanitize_stem(stem))
        }
        None => sanitize_file_name(requested),
    };
    if name == current_name {
        return describe_or_err(&state, &from);
    }
    let direct = parent.join(&name);
    let target = if !direct.exists() || same_file(&from, &direct) {
        direct
    } else {
        unique_in_dir(parent, &name)
    };
    std::fs::rename(&from, &target).map_err(|e| io_error(&path, e))?;
    describe_or_err(&state, &target)
}

#[tauri::command(async)]
pub fn delete_workspace_file(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let full = state.workspace.resolve_user_file(&path)?;
    if full.is_file() {
        std::fs::remove_file(&full).map_err(|e| io_error(&path, e))?;
    }
    Ok(())
}

#[tauri::command(async)]
pub fn read_file_bytes(state: State<'_, AppState>, path: String) -> Result<Response, String> {
    let full = state.workspace.resolve_user_file(&path)?;
    let bytes = std::fs::read(&full).map_err(|e| io_error(&path, e))?;
    Ok(Response::new(bytes))
}

/// Metadata for a file at any absolute path on disk. Files the user keeps outside the
/// workspace (recordings, notes in their own folders) are referenced in place, never
/// copied, and this is how the library learns what they are.
#[tauri::command(async)]
pub fn stat_external_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Option<StudyFile>, String> {
    let full = PathBuf::from(path.trim());
    if !full.is_absolute() || !external_read_allowed(&app, &state, &full) {
        return Ok(None);
    }
    Ok(describe_absolute(&full))
}

/// Whether a user-chosen file or folder still exists. Used by the re-link UI,
/// which also handles folder settings that `stat_external_file` cannot describe.
#[tauri::command(async)]
pub fn path_exists(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> bool {
    let full = PathBuf::from(path.trim());
    if !full.is_absolute() { return false; }
    if ensure_external_access(&app, &state, &full).is_err() { return false; }
    full.exists()
}

/// Creates a note in an arbitrary absolute folder, without copying or moving anything
/// into the workspace. The note lives where the user pointed and is referenced there.
#[tauri::command(async)]
pub fn create_external_note(
    app: AppHandle,
    state: State<'_, AppState>,
    directory: String,
    name: String,
    content: String,
) -> Result<StudyFile, String> {
    let folder = PathBuf::from(directory.trim());
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("Choose an existing folder on this device for the note.".into());
    }
    ensure_external_access(&app, &state, &folder)?;
    let requested = name.trim();
    let stem = strip_extension_ignore_case(requested, "md")
        .or_else(|| strip_extension_ignore_case(requested, "markdown"))
        .unwrap_or(requested);
    let file_name = format!("{}.md", sanitize_stem(stem));
    let target = unique_in_dir(&folder, &file_name);
    write_atomic(&target, content.as_bytes())?;
    describe_absolute(&target).ok_or_else(|| "Could not read the new note back".into())
}

/// Renames a file at an absolute path in place, like `rename_workspace_file` but
/// without any workspace restriction.
#[tauri::command(async)]
pub fn rename_external_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    new_name: String,
) -> Result<StudyFile, String> {
    let from = PathBuf::from(path.trim());
    if !from.is_absolute() || !from.is_file() {
        return Err(format!("File not found: {path}"));
    }
    ensure_external_access(&app, &state, &from)?;
    let parent = from
        .parent()
        .ok_or_else(|| "Invalid file location".to_string())?;
    let current_name = from
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let requested = new_name.trim();
    let name = match split_name(&current_name).1 {
        Some(ext) => {
            let stem = strip_extension_ignore_case(requested, &ext).unwrap_or(requested);
            format!("{}.{ext}", sanitize_stem(stem))
        }
        None => sanitize_file_name(requested),
    };
    if name == current_name {
        return describe_absolute(&from).ok_or_else(|| "Could not read file information".into());
    }
    let direct = parent.join(&name);
    let target = if !direct.exists() || same_file(&from, &direct) {
        direct
    } else {
        unique_in_dir(parent, &name)
    };
    std::fs::rename(&from, &target).map_err(|e| io_error(&path, e))?;
    describe_absolute(&target).ok_or_else(|| "Could not read file information".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteTarget {
    path: Option<String>,
    dir: Option<String>,
    name: Option<String>,
    #[serde(default)]
    unique: bool,
}

fn decode_frame(body: &[u8]) -> Result<(WriteTarget, &[u8]), String> {
    if body.len() < 4 {
        return Err("Malformed binary payload".into());
    }
    let header_len = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
    let data_start = 4usize
        .checked_add(header_len)
        .filter(|end| *end <= body.len())
        .ok_or_else(|| "Malformed binary payload".to_string())?;
    let target: WriteTarget = serde_json::from_slice(&body[4..data_start])
        .map_err(|e| format!("Malformed payload header: {e}"))?;
    Ok((target, &body[data_start..]))
}

#[tauri::command]
pub async fn write_file_bytes(
    state: State<'_, AppState>,
    request: Request<'_>,
) -> Result<StudyFile, String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    let (target, data) = decode_frame(body)?;
    let full = match (target.path, target.dir, target.name) {
        (Some(path), _, _) => state.workspace.resolve_user_file(&path)?,
        (None, Some(dir), Some(name)) => {
            let dir_path = state.workspace.resolve_user_file(&dir)?;
            let file_name = sanitize_file_name(&name);
            if target.unique {
                unique_in_dir(&dir_path, &file_name)
            } else {
                dir_path.join(file_name)
            }
        }
        _ => return Err("The write target is missing".into()),
    };
    write_atomic(&full, data)?;
    describe_or_err(&state, &full)
}

/// Writes a user-selected external file. This is deliberately separate from
/// `write_file_bytes`, whose paths are restricted to the app workspace.
#[tauri::command]
pub async fn write_external_file_bytes(
    request: Request<'_>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let InvokeBody::Raw(body) = request.body() else {
        return Err("Expected a binary payload".into());
    };
    let (target, data) = decode_frame(body)?;
    let path = target.path.ok_or("The write target is missing")?;
    let full = PathBuf::from(&path);
    if !full.is_absolute() || !full.is_file() {
        return Err("External file not found".into());
    }
    ensure_external_access(&app, &state, &full)?;
    write_in_place(&full, data)
        .map_err(|error| format!("Could not save external file {path}: {error}"))
}

#[cfg(test)]
fn same_content(a: &Path, b: &Path) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if meta_a.len() != meta_b.len() {
        return false;
    }
    let (Ok(file_a), Ok(file_b)) = (std::fs::File::open(a), std::fs::File::open(b)) else {
        return false;
    };
    let mut reader_a = std::io::BufReader::new(file_a);
    let mut reader_b = std::io::BufReader::new(file_b);
    let mut buf_a = vec![0u8; 64 * 1024];
    let mut buf_b = vec![0u8; 64 * 1024];
    loop {
        let read_a = match reader_a.read(&mut buf_a) {
            Ok(n) => n,
            Err(_) => return false,
        };
        if read_a == 0 {
            return true;
        }
        if reader_b.read_exact(&mut buf_b[..read_a]).is_err() || buf_a[..read_a] != buf_b[..read_a]
        {
            return false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(header: &str, data: &[u8]) -> Vec<u8> {
        let mut out = (header.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(header.as_bytes());
        out.extend_from_slice(data);
        out
    }

    #[test]
    fn decodes_framed_payloads() {
        let body = frame(
            r#"{"dir":"documents","name":"a.pdf","unique":true}"#,
            b"%PDF-1.7",
        );
        let (target, data) = decode_frame(&body).unwrap();
        assert_eq!(target.dir.as_deref(), Some("documents"));
        assert!(target.unique);
        assert_eq!(data, b"%PDF-1.7");
    }

    #[test]
    fn rejects_truncated_payloads() {
        assert!(decode_frame(&[1, 0]).is_err());
        let mut body = frame(r#"{"path":"x"}"#, b"");
        body.truncate(6);
        assert!(decode_frame(&body).is_err());
    }

    #[test]
    fn strips_matching_extensions_only() {
        assert_eq!(strip_extension_ignore_case("Notes.MD", "md"), Some("Notes"));
        assert_eq!(strip_extension_ignore_case("Lecture 3.2", "md"), None);
        assert_eq!(strip_extension_ignore_case(".md", "md"), None);
        assert_eq!(strip_extension_ignore_case("جزوه.pdf", "pdf"), Some("جزوه"));
    }

    #[test]
    fn decodes_notes_and_flags_other_encodings() {
        let utf8 = decode_note("\u{feff}سلام\r\nworld".as_bytes()).unwrap();
        assert!(utf8.editable);
        assert_eq!(utf8.content, "سلام\r\nworld");
        let latin1 = decode_note(b"caf\xe9 cr\xe8me").unwrap();
        assert!(!latin1.editable);
        assert!(decode_note(&[0u8, 1, 2, 3, 4, 5, 6, 7]).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn detects_the_same_file() {
        let dir = std::env::temp_dir().join(format!("annotate-same-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("Physics.md");
        // Case differs on case-sensitive filesystems only; APFS treats the two as one file,
        // so distinctness is checked with a different name instead.
        let b = dir.join("other.md");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        assert!(same_file(&a, &a));
        assert!(!same_file(&a, &b));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compares_file_contents() {
        let dir = std::env::temp_dir().join(format!("annotate-cmp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a");
        let b = dir.join("b");
        let c = dir.join("c");
        std::fs::write(&a, vec![7u8; 200_000]).unwrap();
        std::fs::write(&b, vec![7u8; 200_000]).unwrap();
        let mut other = vec![7u8; 200_000];
        other[150_000] = 8;
        std::fs::write(&c, other).unwrap();
        assert!(same_content(&a, &b));
        assert!(!same_content(&a, &c));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
