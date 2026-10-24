use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use tauri::State;

use crate::state::AppState;
use crate::storage::{read_json, write_json};

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

    #[tokio::test]
    async fn test_import_external_files() {
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

        let result = import_external_files(paths).await;
        assert!(result.is_ok());

        let refs = result.unwrap();
        assert_eq!(refs.len(), 2);

        assert_eq!(refs[0].name, "test1.pdf");
        assert_eq!(refs[0].extension, "pdf");
        assert_eq!(refs[0].size, 14);

        assert_eq!(refs[1].name, "test2.txt");
        assert_eq!(refs[1].extension, "txt");
    }

    #[tokio::test]
    async fn test_import_skips_non_existent() {
        let result = import_external_files(vec![
            "/non/existent/file.pdf".to_string(),
            "/another/missing.txt".to_string(),
        ])
        .await;

        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_import_skips_directories() {
        let temp_dir = TempDir::new().unwrap();
        let paths = vec![temp_dir.path().to_string_lossy().into_owned()];

        let result = import_external_files(paths).await;
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn test_open_external_file_not_found() {
        let result = open_external_file("/non/existent/file.pdf".to_string()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("File not found"));
    }
}
