use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, State};
use tauri_plugin_fs::FsExt;
use zip::write::SimpleFileOptions;
use serde_json::json;

use crate::state::{lock_error, AppState};
use crate::storage::{read_json, write_json};

const MANIFEST_FILE: &str = "manifest.json";
const EXTERNAL_PREFIX: &str = "external";
const FORMAT_VERSION: u32 = 1;
const MAX_SNAPSHOTS: usize = 5;

const DATA_FILES: [&str; 9] = [
    "flashcards.json",
    "collections.json",
    "exams_data.json",
    "chat_sessions.json",
    "motivation_sessions.json",
    "settings.json",
    "canvas/state.json",
    "card_qualities.json",
    "books.json",
];

const DATA_DIRS: [&str; 3] = ["documents", "notes", "analytics"];
const MAX_ENTRIES: usize = 50_000;
const MAX_ENTRY_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024 * 1024;

type Entries = Vec<(usize, PathBuf)>;

fn is_allowed_entry(relative: &Path) -> bool {
    let normal: Vec<String> = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if normal.is_empty() || normal.len() != relative.components().count() {
        return false;
    }
    let joined = normal.join("/");
    joined == MANIFEST_FILE
        || DATA_FILES.contains(&joined.as_str())
        || (normal.len() >= 2 && normal[0] == EXTERNAL_PREFIX)
        || (normal.len() >= 2
            && DATA_DIRS.contains(&normal[0].as_str())
            && !normal.iter().any(|p| p.starts_with('.')))
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, out);
        } else if path.is_file() && path.strip_prefix(root).is_ok() {
            out.push(path);
        }
    }
}

/// Paths to files the app references in place (never copied into storage).
/// Recorded in every backup so a restore can offer to reconnect them.
fn external_refs(root: &Path) -> Vec<String> {
    let mut paths = std::collections::BTreeSet::new();
    if let Some(settings) = read_json::<serde_json::Value>(&root.join("settings.json")) {
        if let Some(list) = settings.get("externalFiles").and_then(|v| v.as_array()) {
            for value in list.iter().filter_map(|v| v.as_str()) {
                paths.insert(value.to_string());
            }
        }
        if let Some(path) = settings.get("inboxNotePath").and_then(|v| v.as_str()) {
            if !path.is_empty() { paths.insert(path.to_string()); }
        }
        if let Some(list) = settings.get("captureNotes").and_then(|v| v.as_array()) {
            for note in list.iter().filter_map(|v| v.get("path").and_then(|p| p.as_str())) {
                paths.insert(note.to_string());
            }
        }
    }
    if let Some(books) = read_json::<serde_json::Value>(&root.join("books.json")) {
        if let Some(files) = books.get("files").and_then(|v| v.as_object()) {
            for file in files.values().filter_map(|v| v.get("filePath").and_then(|p| p.as_str())) {
                paths.insert(file.to_string());
            }
        }
    }
    paths.into_iter().collect()
}

fn build_manifest(root: &Path) -> serde_json::Value {
    let refs = external_refs(root)
        .iter()
        .map(|path| {
            let file = Path::new(path);
            let metadata = std::fs::metadata(file).ok();
            let modified = metadata
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339().into());
            json!({
                "path": path,
                "name": file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                "size": metadata.as_ref().map(|m| m.len()),
                "modified_at": modified,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "format": "annotate-studio-backup",
        "version": FORMAT_VERSION,
        "app_version": env!("CARGO_PKG_VERSION"),
        "created_at": chrono::Utc::now().to_rfc3339(),
        "external_files": refs,
    })
}

/// Mark referenced files that should travel inside the archive and give each a
/// collision-free archive name. Returns the (archive name, disk path) pairs.
fn prepare_external(manifest: &mut serde_json::Value, include: bool) -> Vec<(String, PathBuf)> {
    let mut copies = Vec::new();
    if !include { return copies; }
    if let Some(refs) = manifest.get_mut("external_files").and_then(|v| v.as_array_mut()) {
        for (index, reference) in refs.iter_mut().enumerate() {
            let path = reference.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
            let source = Path::new(&path);
            if path.is_empty() || !source.is_absolute() || !source.is_file() { continue; }
            let name = format!("{EXTERNAL_PREFIX}/{index:04}");
            reference["included"] = json!(true);
            reference["archive_path"] = json!(name);
            copies.push((name, source.to_path_buf()));
        }
    }
    manifest["includes_external_files"] = json!(!copies.is_empty());
    copies
}

fn read_manifest(archive: &mut zip::ZipArchive<std::fs::File>) -> Result<serde_json::Value, String> {
    let mut entry = archive
        .by_name(MANIFEST_FILE)
        .map_err(|_| "This backup has no manifest".to_string())?;
    let mut bytes = Vec::new();
    entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| format!("Could not read the backup manifest: {e}"))
}

fn write_archive(root: &Path, output: &Path, include_external: bool) -> Result<usize, String> {
    let mut files: Vec<PathBuf> = DATA_FILES
        .iter()
        .map(|name| root.join(name))
        .filter(|path| path.is_file())
        .collect();
    for dir in DATA_DIRS {
        collect_files(root, &root.join(dir), &mut files);
    }

    let parent = output
        .parent()
        .ok_or_else(|| "Invalid output location".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = output.with_extension("anos.partial");
    let result = (|| -> Result<usize, String> {
        let file = std::fs::File::create(&temp)
            .map_err(|e| format!("Could not create {}: {e}", temp.display()))?;
        let mut zip = zip::ZipWriter::new(file);
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let mut count = 0;
        for path in &files {
            let Ok(relative) = path.strip_prefix(root) else {
                continue;
            };
            let name = relative
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let data = std::fs::read(path)
                .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
            count += 1;
        }
        let mut manifest = build_manifest(root);
        let external_copies = prepare_external(&mut manifest, include_external);
        for (name, source) in external_copies {
            let data = std::fs::read(&source)
                .map_err(|e| format!("Could not read {}: {e}", source.display()))?;
            zip.start_file(name, options).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
            count += 1;
        }
        let manifest = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| format!("Could not build the backup manifest: {e}"))?;
        zip.start_file(MANIFEST_FILE, options).map_err(|e| e.to_string())?;
        zip.write_all(&manifest).map_err(|e| e.to_string())?;
        count += 1;
        zip.finish().map_err(|e| e.to_string())?;
        Ok(count)
    })();
    match result {
        Ok(count) => {
            std::fs::rename(&temp, output)
                .map_err(|e| format!("Could not save {}: {e}", output.display()))?;
            Ok(count)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&temp);
            Err(err)
        }
    }
}

fn open_backup(path: &Path) -> Result<(zip::ZipArchive<std::fs::File>, Entries), String> {
    let file = std::fs::File::open(path).map_err(|e| format!("Could not open the backup: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("This is not a valid backup file: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("The backup contains too many files".into());
    }
    let mut entries = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if entry.is_dir() {
            continue;
        }
        if let Some(relative) = entry.enclosed_name().filter(|p| is_allowed_entry(p)) {
            entries.push((index, relative));
        }
    }
    if entries.is_empty() {
        return Err("The backup does not contain any Annotate Studio data".into());
    }
    Ok((archive, entries))
}

fn extract_entries(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entries: &Entries,
    staging: &Path,
) -> Result<(), String> {
    let mut total: u64 = 0;
    for (index, relative) in entries {
        let entry = archive.by_index(*index).map_err(|e| e.to_string())?;
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(format!("{} is too large to restore", relative.display()));
        }
        let target = staging.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut output = std::fs::File::create(&target)
            .map_err(|e| format!("Could not restore {}: {e}", relative.display()))?;
        let mut limited = entry.take(MAX_ENTRY_BYTES + 1);
        let copied = std::io::copy(&mut limited, &mut output)
            .map_err(|e| format!("Could not restore {}: {e}", relative.display()))?;
        if copied > MAX_ENTRY_BYTES {
            return Err(format!("{} is too large to restore", relative.display()));
        }
        total = total.saturating_add(copied);
        if total > MAX_TOTAL_BYTES {
            return Err("The backup is too large to restore".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn move_into_place(staging: &Path, root: &Path, entries: &Entries) -> Result<usize, String> {
    let mut moved = 0;
    for (_, relative) in entries {
        // Copied external files go to the folder the user chose, never into storage.
        if relative.starts_with(EXTERNAL_PREFIX) { continue; }
        let target = root.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::rename(staging.join(relative), &target)
            .map_err(|e| format!("Could not restore {}: {e}", relative.display()))?;
        moved += 1;
    }
    Ok(moved)
}

fn staging_dir(root: &Path) -> PathBuf {
    root.join(format!(".restore-{}", uuid::Uuid::new_v4().simple()))
}

fn safe_file_name(name: &str) -> Option<String> {
    let file = Path::new(name).file_name()?.to_string_lossy().trim().to_string();
    if file.is_empty() || file == "." || file == ".." { None } else { Some(file) }
}

/// Copy archived external files into a folder chosen by the user and return
/// the old→new path mapping used to rewrite references in the staged JSON.
fn restore_external_files(
    archive: &mut zip::ZipArchive<std::fs::File>,
    entries: &Entries,
    staging: &Path,
    target: &Path,
) -> Result<Vec<(String, String)>, String> {
    let manifest = read_manifest(archive)?;
    let mut mapping = Vec::new();
    std::fs::create_dir_all(target).map_err(|e| e.to_string())?;
    let refs = manifest.get("external_files").and_then(|v| v.as_array());
    let Some(refs) = refs else { return Ok(mapping) };
    for reference in refs {
        let Some(old) = reference.get("path").and_then(|v| v.as_str()) else { continue };
        let Some(archive_path) = reference.get("archive_path").and_then(|v| v.as_str()) else { continue };
        if !entries.iter().any(|(_, path)| path.to_string_lossy() == archive_path) { continue; }
        let name = reference
            .get("name")
            .and_then(|v| v.as_str())
            .and_then(safe_file_name)
            .or_else(|| safe_file_name(archive_path))
            .ok_or_else(|| "Invalid file name in backup".to_string())?;
        let source = staging.join(archive_path);
        let destination = target.join(name);
        if !destination.exists() && source.is_file() {
            std::fs::copy(&source, &destination)
                .map_err(|e| format!("Could not restore {}: {e}", destination.display()))?;
        }
        mapping.push((old.to_string(), destination.to_string_lossy().into_owned()));
    }
    Ok(mapping)
}

/// Rewrite every string/key in staged state files that points at an old path.
fn rewrite_staged_paths(staging: &Path, mapping: &[(String, String)]) -> Result<(), String> {
    if mapping.is_empty() { return Ok(()); }
    fn replace(value: &mut serde_json::Value, mapping: &[(String, String)]) {
        match value {
            serde_json::Value::String(text) => {
                if let Some((_, new)) = mapping.iter().find(|(old, _)| old == text) {
                    *text = new.clone();
                }
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(|item| replace(item, mapping)),
            serde_json::Value::Object(map) => {
                let mut renamed = Vec::new();
                for (key, value) in map.iter_mut() {
                    if let Some((_, new)) = mapping.iter().find(|(old, _)| old == key) {
                        renamed.push((key.clone(), new.clone()));
                    } else {
                        replace(value, mapping);
                    }
                }
                for (old, new) in renamed {
                    if let Some(value) = map.remove(&old) {
                        map.insert(new, value);
                    }
                }
            }
            _ => {}
        }
    }
    for name in DATA_FILES {
        let path = staging.join(name);
        if !path.is_file() { continue; }
        let mut value: serde_json::Value = read_json(&path).ok_or_else(|| format!("Could not read restored {name}"))?;
        replace(&mut value, mapping);
        write_json(&path, &value).map_err(|e| format!("Could not update restored {name}: {e}"))?;
    }
    Ok(())
}

fn restore_archive(archive_path: &Path, root: &Path) -> Result<usize, String> {
    let (mut archive, entries) = open_backup(archive_path)?;
    let staging = staging_dir(root);
    let result = extract_entries(&mut archive, &entries, &staging)
        .and_then(|_| move_into_place(&staging, root, &entries));
    let _ = std::fs::remove_dir_all(&staging);
    result
}

fn picked_path(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() {
        return Err("Choose a backup file first".into());
    }
    if !app.fs_scope().is_allowed(&path) {
        return Err("Choose the backup file with the file picker".into());
    }
    Ok(path)
}

#[tauri::command(async)]
pub fn export_data(
    app: AppHandle,
    state: State<'_, AppState>,
    output_path: String,
    include_external: Option<bool>,
) -> Result<usize, String> {
    let output = picked_path(&app, &output_path)?;
    write_archive(state.workspace.root(), &output, include_external.unwrap_or(false))
}

/// Read the manifest of a backup before restoring, so the UI can ask where to
/// put external files when the backup includes them.
#[tauri::command(async)]
pub fn inspect_backup(app: AppHandle, archive_path: String) -> Result<serde_json::Value, String> {
    let source = picked_path(&app, &archive_path)?;
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&source).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let manifest = read_manifest(&mut archive)?;
    let count = manifest
        .get("external_files")
        .and_then(|v| v.as_array())
        .map(|refs| refs.iter().filter(|r| r.get("included") == Some(&json!(true))).count())
        .unwrap_or(0);
    Ok(json!({
        "includesExternalFiles": manifest.get("includes_external_files").and_then(|v| v.as_bool()).unwrap_or(false),
        "externalCount": count,
        "version": manifest.get("version").cloned().unwrap_or(json!(null)),
        "createdAt": manifest.get("created_at").cloned().unwrap_or(json!(null)),
    }))
}

/// The folder where automatic snapshots and pre-import safety copies live.
#[tauri::command(async)]
pub fn get_backups_dir(state: State<'_, AppState>) -> Result<String, String> {
    let dir = &state.paths.backups_dir;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// A local, automatic snapshot of app-owned data (never external files).
#[tauri::command(async)]
pub fn create_snapshot(state: State<'_, AppState>) -> Result<String, String> {
    let dir = &state.paths.backups_dir;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("auto-{stamp}.anos"));
    write_archive(state.workspace.root(), &path, false)?;
    let mut snapshots: Vec<PathBuf> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|path| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("auto-") && n.ends_with(".anos"))
                .unwrap_or(false)
        })
        .collect();
    snapshots.sort();
    while snapshots.len() > MAX_SNAPSHOTS {
        let old = snapshots.remove(0);
        let _ = std::fs::remove_file(old);
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn import_data(
    app: AppHandle,
    state: State<'_, AppState>,
    archive_path: String,
    external_dir: Option<String>,
) -> Result<usize, String> {
    let source = picked_path(&app, &archive_path)?;
    let external_target = external_dir.as_deref().map(|raw| picked_path(&app, raw)).transpose()?;
    let root = state.workspace.root().to_path_buf();
    let staging = staging_dir(&root);
    let result = (|| -> Result<usize, String> {
        let (mut archive, entries) = open_backup(&source)?;
        let mapping = match &external_target {
            Some(target) => restore_external_files(&mut archive, &entries, &staging, target)?,
            None => Vec::new(),
        };
        extract_entries(&mut archive, &entries, &staging)?;
        rewrite_staged_paths(&staging, &mapping)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let safety = state
            .paths
            .backups_dir
            .join(format!("before-import-{stamp}.anos"));
        write_archive(&root, &safety, false)
            .map_err(|e| format!("Could not back up the current data before importing: {e}"))?;
        let mut engine = state.flashcards.lock().map_err(lock_error)?;
        let outcome = move_into_place(&staging, &root, &entries).map_err(|err| {
            match restore_archive(&safety, &root) {
                Ok(_) => format!("{err}. Your previous data was put back."),
                Err(restore) => format!(
                    "{err}. Putting the previous data back also failed ({restore}); a copy is in {}",
                    safety.display()
                ),
            }
        });
        engine.reload();
        outcome
    })();
    let _ = std::fs::remove_dir_all(&staging);
    let reloaded = state.reload();
    let count = result?;
    reloaded?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_archive_entries() {
        assert!(is_allowed_entry(Path::new("flashcards.json")));
        assert!(is_allowed_entry(Path::new("books.json")));
        assert!(is_allowed_entry(Path::new("manifest.json")));
        assert!(is_allowed_entry(Path::new("canvas/state.json")));
        assert!(is_allowed_entry(Path::new("documents/a.pdf")));
        assert!(is_allowed_entry(Path::new("notes/sub/b.md")));
        assert!(!is_allowed_entry(Path::new("documents")));
        assert!(!is_allowed_entry(Path::new("random.txt")));
        assert!(!is_allowed_entry(Path::new("../evil")));
        assert!(!is_allowed_entry(Path::new("notes/.hidden")));
        assert!(!is_allowed_entry(Path::new("/etc/passwd")));
        assert!(!is_allowed_entry(Path::new("providers.json")));
    }

    #[test]
    fn manifest_records_external_references() {
        let root = std::env::temp_dir().join(format!("annotate-manifest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("settings.json"),
            r#"{"externalFiles":["/tmp/a.pdf"],"inboxNotePath":"/tmp/inbox.md","captureNotes":[{"path":"/tmp/b.md"}]}"#,
        )
        .unwrap();
        std::fs::write(root.join("books.json"), r#"{"files":{"1":{"filePath":"/tmp/c.epub"}}}"#).unwrap();
        let manifest = build_manifest(&root);
        let refs = manifest["external_files"].as_array().unwrap();
        let paths: Vec<&str> = refs.iter().map(|r| r["path"].as_str().unwrap()).collect();
        assert!(paths.contains(&"/tmp/a.pdf"));
        assert!(paths.contains(&"/tmp/b.md"));
        assert!(paths.contains(&"/tmp/c.epub"));
        assert!(paths.contains(&"/tmp/inbox.md"));
        assert_eq!(manifest["version"], FORMAT_VERSION);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn complete_backup_copies_and_relinks_external_files() {
        let root = std::env::temp_dir().join(format!("annotate-complete-{}", uuid::Uuid::new_v4()));
        let external = root.join("outside").join("paper.pdf");
        std::fs::create_dir_all(external.parent().unwrap()).unwrap();
        std::fs::write(&external, b"%PDF-1.7").unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("settings.json"),
            format!(r#"{{"externalFiles":["{}"],"fileMeta":{{"{}":{{"starred":true}}}}}}"#, external.display(), external.display()),
        )
        .unwrap();
        let archive_path = root.join("backup.anos");
        let count = write_archive(&root, &archive_path, true).unwrap();
        assert_eq!(count, 3); // settings, manifest, external copy

        let (mut archive, entries) = open_backup(&archive_path).unwrap();
        let manifest = read_manifest(&mut archive).unwrap();
        assert_eq!(manifest["includes_external_files"], json!(true));
        let staging = staging_dir(&root);
        extract_entries(&mut archive, &entries, &staging).unwrap();
        let target = root.join("restored");
        let mapping = restore_external_files(&mut archive, &entries, &staging, &target).unwrap();
        assert_eq!(mapping.len(), 1);
        assert_eq!(mapping[0].1, target.join("paper.pdf").to_string_lossy());
        assert_eq!(std::fs::read(target.join("paper.pdf")).unwrap(), b"%PDF-1.7");
        rewrite_staged_paths(&staging, &mapping).unwrap();
        let settings: serde_json::Value = read_json(&staging.join("settings.json")).unwrap();
        assert_eq!(settings["externalFiles"][0], json!(mapping[0].1));
        assert!(settings["fileMeta"].get(&mapping[0].1).is_some());
        std::fs::remove_dir_all(&staging).unwrap();
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn restores_archives_through_a_staging_folder() {
        let root = std::env::temp_dir().join(format!("annotate-restore-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("flashcards.json"), b"[1]").unwrap();
        std::fs::write(root.join("notes").join("a.md"), b"old").unwrap();
        let archive = root.join("backup.anos");
        write_archive(&root, &archive, false).unwrap();
        std::fs::write(root.join("flashcards.json"), b"[2]").unwrap();
        std::fs::write(root.join("notes").join("a.md"), b"new").unwrap();
        assert_eq!(restore_archive(&archive, &root).unwrap(), 3);
        assert_eq!(std::fs::read(root.join("flashcards.json")).unwrap(), b"[1]");
        assert_eq!(
            std::fs::read(root.join("notes").join("a.md")).unwrap(),
            b"old"
        );
        let leftovers = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".restore-"))
            .count();
        assert_eq!(leftovers, 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_archives_without_app_data() {
        let root = std::env::temp_dir().join(format!("annotate-empty-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("other.zip");
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
        zip.start_file("readme.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"hello").unwrap();
        zip.finish().unwrap();
        assert!(open_backup(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn round_trips_archives() {
        let root = std::env::temp_dir().join(format!("annotate-backup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("documents")).unwrap();
        std::fs::create_dir_all(root.join("canvas")).unwrap();
        std::fs::write(root.join("flashcards.json"), b"[]").unwrap();
        std::fs::write(root.join("canvas").join("state.json"), b"{}").unwrap();
        std::fs::write(root.join("documents").join("a.pdf"), b"%PDF").unwrap();
        std::fs::write(root.join("secret.txt"), b"no").unwrap();
        let output = root.join("out").join("backup.anos");
        assert_eq!(write_archive(&root, &output, false).unwrap(), 4);
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["canvas/state.json", "documents/a.pdf", "flashcards.json", "manifest.json"]
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
