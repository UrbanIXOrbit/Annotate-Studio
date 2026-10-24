# Books Manager - Rust Backend Implementation Guide

This document outlines the Rust backend commands that need to be added to support the Books Manager virtual file system.

## Overview

The Books Manager stores **only file paths and organizational metadata** in a local JSON file. It never copies or moves actual files. This is a pure metadata layer over the user's existing filesystem.

## Required Tauri Commands

Add these commands to your Rust backend (likely in `src-tauri/src/main.rs` or a separate module):

### 1. Import External Files

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct ExternalFileRef {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub modified_at: String,
}

#[tauri::command]
async fn import_external_files(paths: Vec<String>) -> Result<Vec<ExternalFileRef>, String> {
    let mut refs = Vec::new();
    
    for path_str in paths {
        let path = std::path::Path::new(&path_str);
        
        // Check if file exists
        if !path.exists() || !path.is_file() {
            continue; // Skip non-existent or non-file paths
        }
        
        // Get metadata
        let metadata = std::fs::metadata(&path)
            .map_err(|e| format!("Failed to read file metadata: {}", e))?;
        
        let size = metadata.len();
        
        // Get modified time
        let modified = metadata.modified()
            .map_err(|e| format!("Failed to get modified time: {}", e))?;
        let modified_at = chrono::DateTime::<chrono::Utc>::from(modified)
            .to_rfc3339();
        
        // Extract file name and extension
        let name = path.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Unknown")
            .to_string();
        
        let extension = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();
        
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
```

### 2. Load Books State

```rust
#[tauri::command]
async fn load_books_state(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get data directory: {}", e))?;
    
    let books_file = data_dir.join("books.json");
    
    if !books_file.exists() {
        return Ok(serde_json::json!({}));
    }
    
    let content = std::fs::read_to_string(&books_file)
        .map_err(|e| format!("Failed to read books file: {}", e))?;
    
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse books data: {}", e))?;
    
    Ok(value)
}
```

### 3. Save Books State

```rust
#[tauri::command]
async fn save_books_state(app: tauri::AppHandle, state: serde_json::Value) -> Result<(), String> {
    let data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get data directory: {}", e))?;
    
    // Ensure directory exists
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Failed to create data directory: {}", e))?;
    
    let books_file = data_dir.join("books.json");
    
    let content = serde_json::to_string_pretty(&state)
        .map_err(|e| format!("Failed to serialize books data: {}", e))?;
    
    std::fs::write(&books_file, content)
        .map_err(|e| format!("Failed to write books file: {}", e))?;
    
    Ok(())
}
```

## Register Commands

Add these commands to your Tauri builder in `main.rs`:

```rust
fn main() {
    tauri::Builder::default()
        // ... existing setup ...
        .invoke_handler(tauri::generate_handler![
            // ... existing commands ...
            import_external_files,
            load_books_state,
            save_books_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Required Dependencies

Make sure you have these in your `Cargo.toml`:

```toml
[dependencies]
tauri = { version = "2.0", features = ["..." ] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
chrono = "0.4"
```

## Data Structure

The Books Manager stores data in `<app_data_dir>/books.json` with this structure:

```json
{
  "projects": [
    {
      "id": "unique-id",
      "name": "My Research",
      "description": "Research papers collection",
      "rootFolderIds": ["folder-id-1"],
      "fileIds": ["file-id-1"],
      "color": "#3B82F6",
      "createdAt": "2024-01-01T00:00:00Z",
      "updatedAt": "2024-01-01T00:00:00Z"
    }
  ],
  "folders": {
    "folder-id-1": {
      "id": "folder-id-1",
      "name": "Papers",
      "parentId": null,
      "projectId": "unique-id",
      "fileIds": ["file-id-2"],
      "childIds": ["folder-id-2"],
      "collapsed": false,
      "createdAt": "2024-01-01T00:00:00Z"
    }
  },
  "files": {
    "file-id-1": {
      "id": "file-id-1",
      "filePath": "/Users/user/Documents/paper.pdf",
      "name": "Important Paper",
      "extension": "pdf",
      "size": 1024000,
      "addedAt": "2024-01-01T00:00:00Z",
      "modifiedAt": "2023-12-31T00:00:00Z",
      "tags": ["ml", "research"],
      "notes": "This paper discusses..."
    }
  },
  "activeProjectId": "unique-id"
}
```

## Security Considerations

1. **Path Validation**: The `import_external_files` command should validate that paths are within allowed directories if you want to restrict access.

2. **File Access**: Users can only reference files they already have access to on their filesystem. The app doesn't grant new permissions.

3. **No File Copying**: The system never copies or moves files, only stores references. This ensures user data stays in place and under their control.

4. **Privacy**: All metadata is stored locally in the app data directory. Nothing is uploaded or shared.

## Testing

Test the implementation with:

1. Import files from different locations
2. Create projects and folders
3. Move file references between folders
4. Delete projects (ensure actual files are not affected)
5. Restart the app (ensure state persists)
6. Try to import non-existent files (should be gracefully skipped)

## Optional Enhancements

Consider adding these features later:

1. **File watching**: Detect when referenced files are moved/deleted on disk
2. **Batch import**: Import entire folders recursively
3. **Export/Import**: Backup and restore the entire books database
4. **File verification**: Periodically check if referenced files still exist
5. **Duplicate detection**: Warn when importing files already in the system

## Integration with Existing Features

The Books Manager integrates with existing features:

- Files can be opened on the canvas from the Books Manager
- Search works across all file metadata and tags
- The sidebar shows the Books tab (already added)
- State persistence uses the same pattern as other stores
