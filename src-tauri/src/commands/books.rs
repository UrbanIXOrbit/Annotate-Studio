use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use tauri::State;

use crate::state::AppState;
use crate::storage::{read_json, write_atomic, write_json};

const EPUB_ANNOTATIONS_PATH: &str = "META-INF/annotations.json";
const MAX_ANNOTATION_SET_BYTES: usize = 10 * 1024 * 1024;

fn book_sidecar_path(workspace: &Path, book_path: &Path) -> Result<PathBuf, String> {
    let identity = book_path
        .canonicalize()
        .unwrap_or_else(|_| book_path.to_path_buf());
    let digest = Sha256::digest(identity.to_string_lossy().as_bytes());
    let file_name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(workspace
        .join("book-annotations")
        .join(format!("{file_name}.json")))
}

fn is_epub(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("epub"))
}

fn validate_annotation_set(value: &Value) -> Result<(), String> {
    if value.get("type").and_then(Value::as_str) != Some("AnnotationSet")
        || !value.get("items").is_some_and(Value::is_array)
    {
        return Err("The book annotation set has an unsupported format.".into());
    }
    Ok(())
}

fn read_epub_annotation_set(full: &Path) -> Result<Option<Value>, String> {
    let bytes =
        fs::read(full).map_err(|error| format!("Could not read {}: {error}", full.display()))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|error| format!("This EPUB archive could not be read: {error}"))?;
    let mut file = match archive.by_name(EPUB_ANNOTATIONS_PATH) {
        Ok(file) => file,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not locate embedded EPUB annotations: {error}"
            ))
        }
    };
    if file.size() as usize > MAX_ANNOTATION_SET_BYTES {
        return Err("The EPUB annotation set is too large to read.".into());
    }
    let mut json = String::new();
    file.read_to_string(&mut json)
        .map_err(|error| format!("Could not read embedded EPUB annotations: {error}"))?;
    let value: Value = serde_json::from_str(&json)
        .map_err(|error| format!("The embedded EPUB annotation set is invalid: {error}"))?;
    validate_annotation_set(&value)?;
    Ok(Some(value))
}

fn write_epub_annotation_file(
    full: &Path,
    annotation_json: &[u8],
    is_external: bool,
) -> Result<(), String> {
    let full = full
        .canonicalize()
        .map_err(|error| format!("Could not resolve {}: {error}", full.display()))?;
    let bytes =
        fs::read(&full).map_err(|error| format!("Could not read {}: {error}", full.display()))?;
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes.clone()))
        .map_err(|error| format!("This EPUB archive could not be read: {error}"))?;
    let mut output = Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut output);
        for index in 0..archive.len() {
            let file = archive.by_index(index).map_err(|error| error.to_string())?;
            if file.name() == EPUB_ANNOTATIONS_PATH {
                continue;
            }
            writer
                .raw_copy_file(file)
                .map_err(|error| error.to_string())?;
        }
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file(EPUB_ANNOTATIONS_PATH, options)
            .map_err(|error| error.to_string())?;
        writer
            .write_all(annotation_json)
            .map_err(|error| format!("Could not write EPUB annotations: {error}"))?;
        writer.finish().map_err(|error| error.to_string())?;
    }
    let updated = output.into_inner();
    match write_atomic(&full, &updated) {
        Ok(()) => Ok(()),
        Err(atomic_error) if is_external => {
            let mut file = OpenOptions::new()
                .write(true)
                .open(&full)
                .map_err(|error| format!("Could not save external EPUB atomically ({atomic_error}) or open it for direct writing: {error}"))?;
            let write_result = file
                .set_len(0)
                .and_then(|()| file.write_all(&updated))
                .and_then(|()| file.sync_all());
            if let Err(write_error) = write_result {
                let restore_result = file
                    .set_len(0)
                    .and_then(|()| file.write_all(&bytes))
                    .and_then(|()| file.sync_all());
                return match restore_result {
                    Ok(()) => Err(format!("Could not save external EPUB directly ({write_error}); the original book was restored. Atomic save error: {atomic_error}")),
                    Err(restore_error) => Err(format!("Could not save external EPUB ({write_error}) or restore its original contents ({restore_error}). Atomic save error: {atomic_error}")),
                };
            }
            Ok(())
        }
        Err(error) => Err(error),
    }?;
    let expected: Value = serde_json::from_slice(annotation_json)
        .map_err(|error| format!("Could not verify serialized EPUB annotations: {error}"))?;
    match read_epub_annotation_set(&full)? {
        Some(saved) if saved == expected => Ok(()),
        Some(_) => Err(
            "The EPUB was written, but its saved annotations did not match the requested set."
                .into(),
        ),
        None => Err(
            "The EPUB was written, but its embedded annotations could not be found afterward."
                .into(),
        ),
    }
}

#[tauri::command(async)]
pub fn read_book_annotation_set(
    state: State<'_, AppState>,
    path: String,
    is_external: bool,
) -> Result<Option<Value>, String> {
    let full = if is_external {
        PathBuf::from(path)
    } else {
        state.workspace.resolve_user_file(&path)?
    };
    if !full.is_file() {
        return Err(format!("Book file not found: {}", full.display()));
    }
    if !is_epub(&full) {
        let sidecar = book_sidecar_path(state.workspace.root(), &full)?;
        if !sidecar.exists() {
            return Ok(None);
        }
        let contents = fs::read(&sidecar)
            .map_err(|error| format!("Could not read book annotations: {error}"))?;
        if contents.len() > MAX_ANNOTATION_SET_BYTES {
            return Err("The book annotation set is too large to read.".into());
        }
        let value: Value = serde_json::from_slice(&contents)
            .map_err(|error| format!("The book annotation set is invalid: {error}"))?;
        validate_annotation_set(&value)?;
        return Ok(Some(value));
    }
    read_epub_annotation_set(&full)
}

#[tauri::command(async)]
pub fn write_book_annotation_set(
    state: State<'_, AppState>,
    path: String,
    is_external: bool,
    annotation_set: Value,
) -> Result<(), String> {
    validate_annotation_set(&annotation_set)?;
    let annotation_json = serde_json::to_vec_pretty(&annotation_set)
        .map_err(|error| format!("Could not serialize book annotations: {error}"))?;
    if annotation_json.len() > MAX_ANNOTATION_SET_BYTES {
        return Err("The book annotation set is too large to save.".into());
    }
    let full = if is_external {
        PathBuf::from(path)
    } else {
        state.workspace.resolve_user_file(&path)?
    };
    if !full.is_file() {
        return Err(format!("Book file not found: {}", full.display()));
    }
    if !is_epub(&full) {
        let sidecar = book_sidecar_path(state.workspace.root(), &full)?;
        return write_atomic(&sidecar, &annotation_json);
    }
    write_epub_annotation_file(&full, &annotation_json, is_external)
}

/// Reference to an external file (not in workspace)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalFileRef {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub modified_at: String,
}

/// Import external files - reads metadata without copying files
#[tauri::command(async)]
pub fn import_external_files(paths: Vec<String>) -> Result<Vec<ExternalFileRef>, String> {
    let mut refs = Vec::new();

    for path_str in paths {
        let path = Path::new(&path_str);

        // Check if file exists and is a file (not directory)
        if !path.exists() {
            continue; // Skip non-existent paths
        }

        if !path.is_file() {
            continue; // Skip directories
        }

        // Get metadata
        let metadata = match std::fs::metadata(path) {
            Ok(m) => m,
            Err(_) => continue, // Skip files we can't read
        };

        let size = metadata.len();

        // Get modified time
        let modified = metadata
            .modified()
            .map_err(|e| format!("Failed to get modified time: {}", e))?;

        #[cfg(not(target_arch = "wasm32"))]
        let modified_at = {
            use std::time::SystemTime;
            let duration = modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|e| format!("Invalid timestamp: {}", e))?;
            let datetime = chrono::DateTime::from_timestamp(
                duration.as_secs() as i64,
                duration.subsec_nanos(),
            )
            .ok_or("Invalid timestamp")?;
            datetime.to_rfc3339()
        };

        // Extract file name
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();

        // Extract extension
        let extension = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();

        refs.push(ExternalFileRef {
            path: path_str,
            name,
            extension,
            size,
            modified_at,
        });
    }

    Ok(refs)
}

/// Load books state from JSON file
#[tauri::command(async)]
pub fn load_books_state(state: State<'_, AppState>) -> Result<Value, String> {
    let books_file = state.workspace.join("books.json");

    if !books_file.exists() {
        return Ok(Value::Null);
    }

    Ok(read_json(&books_file).unwrap_or(Value::Null))
}

/// Save books state to JSON file
#[tauri::command(async)]
pub fn save_books_state(state: State<'_, AppState>, books_state: Value) -> Result<(), String> {
    if !books_state.is_object() && !books_state.is_null() {
        return Err("Books state must be an object or null".into());
    }

    let books_file = state.workspace.join("books.json");

    // Ensure workspace directory exists
    state
        .workspace
        .ensure()
        .map_err(|e| format!("Failed to create workspace directory: {}", e))?;

    write_json(&books_file, &books_state)
}

/// Open a file with the system default application
#[tauri::command(async)]
pub fn open_external_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Verify file exists
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }

    // Open the file with the system default application
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file: {}", e))?;
    }

    Ok(())
}

/// Reveal a file in the system file explorer
#[tauri::command(async)]
pub fn reveal_external_file(path: String) -> Result<(), String> {
    let file_path = Path::new(&path);

    // Verify file exists
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    // Reveal the file in the file explorer
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to reveal file: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // On Linux, try to reveal in file manager or fall back to opening the parent directory
        if let Some(parent) = file_path.parent() {
            std::process::Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| format!("Failed to reveal file: {}", e))?;
        } else {
            return Err("Could not determine parent directory".into());
        }
    }

    Ok(())
}

/// Read external file bytes
#[tauri::command(async)]
pub fn read_external_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let file_path = Path::new(&path);

    // Verify file exists
    if !file_path.exists() {
        return Err(format!("File not found: {}", path));
    }

    if !file_path.is_file() {
        return Err(format!("Path is not a file: {}", path));
    }

    // Read the file
    std::fs::read(file_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn test_import_external_files() {
        let temp_dir = TempDir::new().unwrap();

        // Create test files
        let file1 = temp_dir.path().join("test1.pdf");
        let file2 = temp_dir.path().join("test2.txt");

        fs::write(&file1, b"test content 1").unwrap();
        fs::write(&file2, b"test content 2").unwrap();

        let paths = vec![
            file1.to_string_lossy().into_owned(),
            file2.to_string_lossy().into_owned(),
        ];

        let result = import_external_files(paths);
        assert!(result.is_ok());

        let refs = result.unwrap();
        assert_eq!(refs.len(), 2);

        assert_eq!(refs[0].name, "test1.pdf");
        assert_eq!(refs[0].extension, "pdf");
        assert_eq!(refs[0].size, 14);

        assert_eq!(refs[1].name, "test2.txt");
        assert_eq!(refs[1].extension, "txt");
    }

    #[test]
    fn test_import_skips_non_existent() {
        let result = import_external_files(vec![
            "/non/existent/file.pdf".to_string(),
            "/another/missing.txt".to_string(),
        ]);

        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn test_import_skips_directories() {
        let temp_dir = TempDir::new().unwrap();
        let paths = vec![temp_dir.path().to_string_lossy().into_owned()];

        let result = import_external_files(paths);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn test_open_external_file_not_found() {
        let result = open_external_file("/non/existent/file.pdf".to_string());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }

    #[test]
    fn test_write_epub_annotations_preserves_book_and_embeds_set() {
        let temp_dir = TempDir::new().unwrap();
        let epub_path = temp_dir.path().join("book.epub");
        {
            let file = fs::File::create(&epub_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file(
                    "mimetype",
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Stored),
                )
                .unwrap();
            writer.write_all(b"application/epub+zip").unwrap();
            writer
                .start_file(
                    "OEBPS/chapter.xhtml",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.write_all(b"<html>book content</html>").unwrap();
            writer.finish().unwrap();
        }

        let set = serde_json::json!({
            "type": "AnnotationSet",
            "items": [{
                "id": "urn:uuid:test-annotation",
                "target": {
                    "source": "chapter.xhtml",
                    "selector": [{ "type": "annotateStudio:CFISelector", "value": "epubcfi(/6/2[chapter]!/4/1:0)" }]
                },
                "body": { "value": "A saved passage", "highlight": "solid" }
            }]
        });
        write_epub_annotation_file(&epub_path, &serde_json::to_vec(&set).unwrap(), false).unwrap();

        let file = fs::File::open(&epub_path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.by_index(0).unwrap().name(), "mimetype");
        let mut chapter = String::new();
        archive
            .by_name("OEBPS/chapter.xhtml")
            .unwrap()
            .read_to_string(&mut chapter)
            .unwrap();
        assert_eq!(chapter, "<html>book content</html>");
        let mut embedded = String::new();
        archive
            .by_name(EPUB_ANNOTATIONS_PATH)
            .unwrap()
            .read_to_string(&mut embedded)
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&embedded).unwrap(), set);
        assert_eq!(read_epub_annotation_set(&epub_path).unwrap(), Some(set));
    }
}
