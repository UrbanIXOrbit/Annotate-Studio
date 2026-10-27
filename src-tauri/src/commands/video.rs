use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::filesystem::{describe, FileType, StudyFile};
use crate::paths::{sanitize_stem, unique_in_dir, Workspace, DOCUMENTS_DIR};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoPlayerInfo {
    pub id: String,
    pub name: String,
}

struct VideoPlayerLaunch {
    info: VideoPlayerInfo,
    command: PathBuf,
    arguments: Vec<String>,
}

fn video_path(workspace: &Workspace, path: &str, is_external: bool) -> Result<PathBuf, String> {
    let candidate = if is_external {
        let candidate = Path::new(path);
        if !candidate.is_absolute() {
            return Err("External video path must be absolute".into());
        }
        candidate.to_path_buf()
    } else {
        workspace.resolve_user_file(path)?
    };
    let full = candidate
        .canonicalize()
        .map_err(|e| format!("Could not access video file: {e}"))?;
    if !full.is_file() || FileType::from_path(&full) != FileType::Video {
        return Err("The selected file is not a supported video".into());
    }
    Ok(full)
}

fn find_in_path(executable: &str) -> Option<PathBuf> {
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|paths| std::env::split_paths(&paths).collect::<Vec<_>>())
        .map(|directory| directory.join(executable))
        .find(|path| path.is_file())
}

fn video_player_launches() -> Vec<VideoPlayerLaunch> {
    let mut players = vec![VideoPlayerLaunch {
        info: VideoPlayerInfo {
            id: "system-default".into(),
            name: "System default player".into(),
        },
        command: PathBuf::new(),
        arguments: Vec::new(),
    }];

    #[cfg(target_os = "macos")]
    {
        let mut apps = vec![
            (
                "vlc".to_string(),
                "VLC".to_string(),
                PathBuf::from("/Applications/VLC.app"),
            ),
            (
                "iina".to_string(),
                "IINA".to_string(),
                PathBuf::from("/Applications/IINA.app"),
            ),
        ];
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            apps.extend([
                (
                    "vlc".to_string(),
                    "VLC".to_string(),
                    home.join("Applications/VLC.app"),
                ),
                (
                    "iina".to_string(),
                    "IINA".to_string(),
                    home.join("Applications/IINA.app"),
                ),
            ]);
        }
        for (id, name, app_path) in apps {
            if app_path.exists() && !players.iter().any(|player| player.info.id == id) {
                players.push(VideoPlayerLaunch {
                    info: VideoPlayerInfo { id, name },
                    command: PathBuf::from("open"),
                    arguments: vec!["-a".into(), app_path.to_string_lossy().into_owned()],
                });
            }
        }
        if let Some(path) = find_in_path("mpv") {
            players.push(VideoPlayerLaunch {
                info: VideoPlayerInfo {
                    id: "mpv".into(),
                    name: "mpv".into(),
                },
                command: path,
                arguments: Vec::new(),
            });
        }
    }

    #[cfg(target_os = "windows")]
    {
        let mut candidates = Vec::new();
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            let root = PathBuf::from(program_files);
            candidates.extend([
                ("vlc", "VLC", root.join("VideoLAN/VLC/vlc.exe")),
                ("mpv", "mpv", root.join("mpv/mpv.exe")),
            ]);
        }
        if let Some(program_files) = std::env::var_os("ProgramFiles(x86)") {
            candidates.push((
                "vlc",
                "VLC",
                PathBuf::from(program_files).join("VideoLAN/VLC/vlc.exe"),
            ));
        }
        for (id, name, path) in candidates {
            if path.is_file() && !players.iter().any(|player| player.info.id == id) {
                players.push(VideoPlayerLaunch {
                    info: VideoPlayerInfo {
                        id: id.into(),
                        name: name.into(),
                    },
                    command: path,
                    arguments: Vec::new(),
                });
            }
        }
        for (id, name, executable) in [("vlc", "VLC", "vlc.exe"), ("mpv", "mpv", "mpv.exe")] {
            if !players.iter().any(|player| player.info.id == id) {
                if let Some(path) = find_in_path(executable) {
                    players.push(VideoPlayerLaunch {
                        info: VideoPlayerInfo {
                            id: id.into(),
                            name: name.into(),
                        },
                        command: path,
                        arguments: Vec::new(),
                    });
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        for (id, name, executable) in [
            ("vlc", "VLC", "vlc"),
            ("mpv", "mpv", "mpv"),
            ("celluloid", "Celluloid", "celluloid"),
            ("smplayer", "SMPlayer", "smplayer"),
            ("totem", "Videos (Totem)", "totem"),
            ("haruna", "Haruna", "haruna"),
        ] {
            if let Some(path) = find_in_path(executable) {
                players.push(VideoPlayerLaunch {
                    info: VideoPlayerInfo {
                        id: id.into(),
                        name: name.into(),
                    },
                    command: path,
                    arguments: Vec::new(),
                });
            }
        }
    }

    players
}

fn ffmpeg_candidates(workspace: &Workspace) -> Vec<PathBuf> {
    let executable = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let mut candidates = vec![
        workspace.join("tools").join(executable),
        workspace.join("tools").join("ffmpeg").join(executable),
    ];
    if let Some(paths) = std::env::var_os("PATH") {
        candidates
            .extend(std::env::split_paths(&paths).map(|directory| directory.join(executable)));
    }
    candidates
}

fn find_ffmpeg(workspace: &Workspace) -> Option<PathBuf> {
    ffmpeg_candidates(workspace)
        .into_iter()
        .find(|path| path.is_file())
}

#[tauri::command]
pub fn allow_video_asset(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    is_external: bool,
) -> Result<String, String> {
    let full = video_path(&state.workspace, &path, is_external)?;
    app.asset_protocol_scope()
        .allow_file(full.clone())
        .map_err(|e| format!("Could not prepare video for playback: {e}"))?;
    Ok(full.to_string_lossy().into_owned())
}

#[tauri::command(async)]
pub fn open_video_in_system_player(
    state: State<'_, AppState>,
    path: String,
    is_external: bool,
) -> Result<(), String> {
    let full = video_path(&state.workspace, &path, is_external)?;
    crate::commands::books::open_external_file(full.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_video_players() -> Vec<VideoPlayerInfo> {
    video_player_launches()
        .into_iter()
        .map(|player| player.info)
        .collect()
}

#[tauri::command(async)]
pub fn open_video_with_player(
    state: State<'_, AppState>,
    path: String,
    is_external: bool,
    player_id: String,
) -> Result<(), String> {
    let full = video_path(&state.workspace, &path, is_external)?;
    if player_id == "system-default" {
        return crate::commands::books::open_external_file(full.to_string_lossy().into_owned());
    }
    let player = video_player_launches()
        .into_iter()
        .find(|player| player.info.id == player_id)
        .ok_or_else(|| "That video player is no longer available.".to_string())?;
    Command::new(player.command)
        .args(player.arguments)
        .arg(full)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the video in {}: {error}", player.info.name))
}

#[tauri::command]
pub fn is_ffmpeg_available(state: State<'_, AppState>) -> bool {
    find_ffmpeg(&state.workspace).is_some()
}

#[tauri::command]
pub fn convert_video_for_playback(
    state: State<'_, AppState>,
    path: String,
    is_external: bool,
) -> Result<StudyFile, String> {
    let input = video_path(&state.workspace, &path, is_external)?;
    let ffmpeg = find_ffmpeg(&state.workspace).ok_or_else(|| {
        "FFmpeg is not installed. Add a minimal FFmpeg binary at <workspace>/tools/ffmpeg (or ffmpeg.exe on Windows), or install ffmpeg on PATH.".to_string()
    })?;
    let output_dir = state
        .workspace
        .resolve(DOCUMENTS_DIR)?
        .join("converted-videos");
    std::fs::create_dir_all(&output_dir)
        .map_err(|e| format!("Could not create conversion folder: {e}"))?;
    let stem = input
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("video");
    let output_name = format!("{}-compatible.mp4", sanitize_stem(stem));
    let output = unique_in_dir(&output_dir, &output_name);
    let result = Command::new(ffmpeg)
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(&input)
        .args([
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
        ])
        .arg(&output)
        .output()
        .map_err(|e| format!("Could not start FFmpeg: {e}"))?;
    if !result.status.success() {
        let _ = std::fs::remove_file(&output);
        let detail = String::from_utf8_lossy(&result.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "FFmpeg could not convert this video".into()
        } else {
            detail
        });
    }
    describe(&state.workspace, &output).ok_or_else(|| "Converted video was not created".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn resolves_only_existing_supported_video_files() {
        let temp = TempDir::new().unwrap();
        let workspace = Workspace::new(temp.path().to_path_buf());
        std::fs::create_dir_all(temp.path().join("documents")).unwrap();
        let video = temp.path().join("documents/lesson.MP4");
        std::fs::write(&video, b"video").unwrap();
        assert_eq!(
            video_path(&workspace, "documents/lesson.MP4", false).unwrap(),
            video.canonicalize().unwrap()
        );
        assert!(video_path(&workspace, "documents/missing.mp4", false).is_err());
        assert!(video_path(&workspace, "documents/lesson.MP4", true).is_err());
    }

    #[test]
    fn finds_optional_workspace_binary_first() {
        let temp = TempDir::new().unwrap();
        let workspace = Workspace::new(temp.path().to_path_buf());
        let filename = if cfg!(windows) {
            "ffmpeg.exe"
        } else {
            "ffmpeg"
        };
        let local = workspace.join("tools").join(filename);
        std::fs::create_dir_all(local.parent().unwrap()).unwrap();
        std::fs::write(&local, b"optional binary").unwrap();
        assert_eq!(find_ffmpeg(&workspace), Some(local));
    }
}
