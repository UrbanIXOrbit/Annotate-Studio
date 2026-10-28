use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, Host, SampleFormat, Stream, StreamConfig};
use serde::Serialize;
use tauri::State;

use crate::paths::{sanitize_stem, unique_in_dir};

/// Messages between the microphone callback and the writer thread.
enum SampleMessage {
    Bytes(Vec<u8>),
    /// Stop capturing and finalize the file.
    Finish,
    /// The recording never started; discard the file.
    Abort,
}

/// Control messages sent to the dedicated recorder thread.
///
/// cpal streams may not leave the thread that created them, so the microphone
/// stream lives on the recorder thread and is driven through this channel.
enum RecorderControl {
    SetPaused(bool, mpsc::Sender<Result<(), String>>),
    Stop(mpsc::Sender<Result<(), String>>),
}

#[derive(Default)]
pub struct AudioRecorderState {
    inner: Mutex<Option<ActiveRecording>>,
}

struct ActiveRecording {
    path: PathBuf,
    control: mpsc::Sender<RecorderControl>,
}

#[derive(Serialize)]
pub struct SavedRecording {
    pub path: String,
    pub name: String,
}

fn target_path(directory: &str, name: &str) -> Result<PathBuf, String> {
    let folder = PathBuf::from(directory.trim());
    if !folder.is_absolute() || !folder.is_dir() {
        return Err("Choose an existing folder on this device before recording.".into());
    }
    let folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not access the recording folder: {error}"))?;
    Ok(unique_in_dir(
        Path::new(&folder),
        &format!("{}.wav", sanitize_stem(name.trim())),
    ))
}

// ---------------------------------------------------------------------------
// WAV file: written by hand so the writer thread can own the file exclusively.
// (hound's finalize requires unique ownership, which conflicts with sharing the
// writer with the realtime callback.)
// ---------------------------------------------------------------------------

/// Canonical 44-byte PCM header; the RIFF and data sizes are patched at the end.
fn write_wav_header(out: &mut impl Write, channels: u16, sample_rate: u32) -> std::io::Result<()> {
    let mut header = [0u8; 44];
    header[0..4].copy_from_slice(b"RIFF");
    // 4..8 riff size, patched on finalize
    header[8..12].copy_from_slice(b"WAVE");
    header[12..16].copy_from_slice(b"fmt ");
    header[16..20].copy_from_slice(&16u32.to_le_bytes());
    header[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    header[22..24].copy_from_slice(&channels.to_le_bytes());
    header[24..28].copy_from_slice(&sample_rate.to_le_bytes());
    header[28..32].copy_from_slice(&(u32::from(channels) * 2u32 * sample_rate).to_le_bytes());
    header[32..34].copy_from_slice(&(channels * 2).to_le_bytes()); // block align
    header[34..36].copy_from_slice(&16u16.to_le_bytes());
    header[36..40].copy_from_slice(b"data");
    // 40..44 data size, patched on finalize
    out.write_all(&header)
}

/// Rewrites the RIFF and data sizes from the actual file length.
fn patch_wav_header(path: &Path) -> Result<(), String> {
    let length = fs::metadata(path)
        .map_err(|error| format!("Could not finish the recording: {error}"))?
        .len();
    if length < 44 {
        return Err("Nothing was captured during the recording.".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(|error| format!("Could not finish the recording: {error}"))?;
    file.seek(SeekFrom::Start(4))
        .and_then(|_| file.write_all(&((length - 8) as u32).to_le_bytes()))
        .map_err(|error| format!("Could not finish the recording: {error}"))?;
    file.seek(SeekFrom::Start(40))
        .and_then(|_| file.write_all(&((length - 44) as u32).to_le_bytes()))
        .map_err(|error| format!("Could not finish the recording: {error}"))?;
    Ok(())
}

fn writer_task(path: PathBuf, mut out: BufWriter<File>, receiver: mpsc::Receiver<SampleMessage>, finished: mpsc::Sender<Result<(), String>>) {
    let mut discard = false;
    let outcome = loop {
        match receiver.recv() {
            Ok(SampleMessage::Bytes(bytes)) => {
                if let Err(error) = out.write_all(&bytes) {
                    break Err(format!("Could not write the recording: {error}"));
                }
            }
            Ok(SampleMessage::Finish) => {
                let flushed = out
                    .flush()
                    .map_err(|error| format!("Could not write the recording: {error}"))
                    .and_then(|_| patch_wav_header(&path));
                break flushed;
            }
            Ok(SampleMessage::Abort) => {
                discard = true;
                break Ok(());
            }
            // The recorder disappeared without a signal; keep what is on disk.
            Err(_) => {
                let flushed = out
                    .flush()
                    .map_err(|error| format!("Could not write the recording: {error}"))
                    .and_then(|_| patch_wav_header(&path));
                break flushed;
            }
        }
    };
    drop(out);
    if discard {
        fs::remove_file(&path).ok();
    }
    let _ = finished.send(outcome);
}

// ---------------------------------------------------------------------------
// Microphone capture: cpal callbacks convert samples and hand the bytes to the
// writer thread over a channel.
// ---------------------------------------------------------------------------

fn push_f32(data: &[f32], stopped: &AtomicBool, sender: &mpsc::Sender<SampleMessage>) {
    if stopped.load(Ordering::Relaxed) {
        return;
    }
    let mut bytes = Vec::with_capacity(data.len() * 2);
    for sample in data {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let _ = sender.send(SampleMessage::Bytes(bytes));
}

fn push_i16(data: &[i16], stopped: &AtomicBool, sender: &mpsc::Sender<SampleMessage>) {
    if stopped.load(Ordering::Relaxed) {
        return;
    }
    let mut bytes = Vec::with_capacity(data.len() * 2);
    for sample in data {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    let _ = sender.send(SampleMessage::Bytes(bytes));
}

fn push_u16(data: &[u16], stopped: &AtomicBool, sender: &mpsc::Sender<SampleMessage>) {
    if stopped.load(Ordering::Relaxed) {
        return;
    }
    let mut bytes = Vec::with_capacity(data.len() * 2);
    for sample in data {
        let value = (*sample as i32 - 32_768) as i16;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    let _ = sender.send(SampleMessage::Bytes(bytes));
}

/// Similar virtual audio devices pass silence into recordings, so skip them
/// when a real microphone is available.
fn appears_virtual(name: &str) -> bool {
    const HINTS: [&str; 12] = [
        "background music",
        "blackhole",
        "loopback",
        "soundflower",
        "multi-output",
        "aggregate",
        "virtual",
        "zoomaudio",
        "zoom audio",
        "screen recording",
        "vb-audio",
        "vb-cable",
    ];
    HINTS.iter().any(|hint| name.contains(hint))
}

/// Chooses which input device records the take.
///
/// The macOS default input is honoured when it is a physical device, but many
/// audio tools (Background Music, BlackHole, …) install a virtual device and
/// take over the default-input slot; silently recording that device gives the
/// user empty files. Prefer any device that clearly is a microphone.
fn pick_input_device(host: &Host) -> Result<(Device, String), String> {
    let default = host.default_input_device();
    let default_name = default.as_ref().and_then(|device| device.name().ok());
    let mut best: Option<(i64, Device, String)> = None;
    for device in host.input_devices().map_err(|error| format!("Could not list microphones: {error}"))? {
        let name = device.name().unwrap_or_default();
        let lower = name.to_lowercase();
        let score: i64 = if appears_virtual(&lower) {
            -1000
        } else if default_name.as_deref() == Some(lower.as_str()) {
            100
        } else if lower.contains("mic") {
            60
        } else {
            20
        };
        if best.as_ref().is_none_or(|best| score > best.0) {
            best = Some((score, device, name));
        }
    }
    if let Some((_, device, name)) = best.filter(|(score, _, _)| *score >= 0) {
        return Ok((device, name));
    }
    // Everything looked virtual; use whatever the system considers default.
    default
        .map(|device| {
            let name = device.name().unwrap_or_default();
            (device, name)
        })
        .ok_or_else(|| "No microphone was found on this device.".into())
}

/// Builds the input stream for the microphone on the calling thread.
fn open_mic_stream(
    device: &Device,
    config: &StreamConfig,
    sample_format: SampleFormat,
    stopped: Arc<AtomicBool>,
    sender: mpsc::Sender<SampleMessage>,
) -> Result<Stream, String> {
    let stream_error = |reason| eprintln!("Microphone stream error: {reason}");
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _| push_f32(data, &stopped, &sender),
            stream_error,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _| push_i16(data, &stopped, &sender),
            stream_error,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _| push_u16(data, &stopped, &sender),
            stream_error,
            None,
        ),
        format => return Err(format!("Unsupported microphone format: {format:?}")),
    };
    stream.map_err(|error| format!("Could not start microphone recording: {error}"))
}

/// The life of one recording: open the microphone, stream sample bytes to the
/// writer thread, and answer control messages until `Stop` arrives. The stream
/// is created, played, paused, and dropped entirely on this thread. The start
/// reply carries the name of the microphone that was chosen.
fn recorder_run(
    path: PathBuf,
    start_tx: mpsc::Sender<Result<String, String>>,
    control_rx: mpsc::Receiver<RecorderControl>,
) {
    let host = cpal::default_host();
    let (device, device_name) = match pick_input_device(&host) {
        Ok(chosen) => chosen,
        Err(message) => {
            let _ = start_tx.send(Err(message));
            return;
        }
    };
    let supported = match device.default_input_config() {
        Ok(supported) => supported,
        Err(error) => {
            let _ = start_tx.send(Err(format!("Could not open the microphone: {error}")));
            return;
        }
    };
    let config: StreamConfig = supported.config();

    // Create the file with a placeholder header before anything else runs.
    let file = match File::create(&path) {
        Ok(file) => file,
        Err(error) => {
            fs::remove_file(&path).ok();
            let _ = start_tx.send(Err(format!("Could not create the recording file: {error}")));
            return;
        }
    };
    let mut out = BufWriter::new(file);
    if let Err(error) = write_wav_header(&mut out, config.channels, config.sample_rate.0) {
        drop(out);
        fs::remove_file(&path).ok();
        let _ = start_tx.send(Err(format!("Could not create the recording file: {error}")));
        return;
    }

    let stopped = Arc::new(AtomicBool::new(false));
    let (sample_tx, sample_rx) = mpsc::channel::<SampleMessage>();
    let (finished_tx, finished_rx) = mpsc::channel::<Result<(), String>>();
    let writer_path = path.clone();
    let writer_thread = std::thread::Builder::new()
        .name("audio-writer".into())
        .spawn(move || writer_task(writer_path, out, sample_rx, finished_tx));
    if writer_thread.is_err() {
        fs::remove_file(&path).ok();
        let _ = start_tx.send(Err("Could not start the recording writer.".into()));
        return;
    }

    let stream = match open_mic_stream(&device, &config, supported.sample_format(), Arc::clone(&stopped), sample_tx.clone()) {
        Ok(stream) => stream,
        Err(message) => {
            stopped.store(true, Ordering::Relaxed);
            let _ = sample_tx.send(SampleMessage::Abort);
            let _ = start_tx.send(Err(message));
            return;
        }
    };
    if let Err(error) = stream.play() {
        stopped.store(true, Ordering::Relaxed);
        let _ = stream.pause();
        let _ = sample_tx.send(SampleMessage::Abort);
        let _ = start_tx.send(Err(format!("Could not start microphone recording: {error}")));
        return;
    }

    // Tell the caller the recording is live. If they gave up meanwhile, stop
    // everything and remove the file we just created.
    if let Err(_) = start_tx.send(Ok(device_name)) {
        stopped.store(true, Ordering::Relaxed);
        let _ = stream.pause();
        let _ = sample_tx.send(SampleMessage::Abort);
        return;
    }

    loop {
        match control_rx.recv() {
            Ok(RecorderControl::SetPaused(paused, reply)) => {
                let outcome = if paused {
                    stream
                        .pause()
                        .map_err(|error| format!("Could not pause recording: {error}"))
                } else {
                    stream
                        .play()
                        .map_err(|error| format!("Could not resume recording: {error}"))
                };
                let _ = reply.send(outcome);
            }
            Ok(RecorderControl::Stop(reply)) => {
                // Mark first so callbacks that already started drop their data,
                // then stop the unit explicitly: dropping the stream may not
                // dispose the audio unit on this cpal version.
                stopped.store(true, Ordering::Relaxed);
                let _ = stream.pause();
                drop(stream);
                let finish = sample_tx.send(SampleMessage::Finish);
                let outcome = if finish.is_ok() {
                    finished_rx
                        .recv()
                        .unwrap_or_else(|_| Err("The recording writer stopped unexpectedly.".into()))
                } else {
                    Err("The recording writer stopped unexpectedly.".into())
                };
                let _ = reply.send(outcome);
                return;
            }
            // The state disappeared without a Stop; clean up quietly.
            Err(_) => {
                stopped.store(true, Ordering::Relaxed);
                let _ = stream.pause();
                drop(stream);
                finished_rx.recv().ok();
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command(async)]
pub fn start_audio_recording(
    state: State<'_, AudioRecorderState>,
    directory: String,
    name: String,
) -> Result<String, String> {
    if name.trim().is_empty() {
        return Err("Give the recording a name first.".into());
    }
    let path = target_path(&directory, &name)?;
    let (start_tx, start_rx) = mpsc::channel::<Result<String, String>>();
    let (control_tx, control_rx) = mpsc::channel::<RecorderControl>();

    let recorder_path = path.clone();
    std::thread::Builder::new()
        .name("audio-recorder".into())
        .spawn(move || recorder_run(recorder_path, start_tx, control_rx))
        .map_err(|_| "Could not start the recorder thread.")?;

    // Reserve the slot before waiting so a second start cannot race past the
    // "already in progress" check.
    {
        let mut active = state.inner.lock().map_err(|_| "Recorder is unavailable")?;
        if active.is_some() {
            return Err("A recording is already in progress.".into());
        }
        *active = Some(ActiveRecording {
            path: path.clone(),
            control: control_tx,
        });
    }

    match start_rx.recv_timeout(Duration::from_secs(15)) {
        Ok(Ok(device_name)) => Ok(device_name),
        Ok(Err(message)) => {
            release_reservation(&state);
            Err(message)
        }
        Err(_) => {
            release_reservation(&state);
            Err("Could not start microphone recording in time.".into())
        }
    }
}

fn release_reservation(state: &State<'_, AudioRecorderState>) {
    state
        .inner
        .lock()
        .map_err(|_| "Recorder is unavailable")
        .ok()
        .and_then(|mut active| active.take());
}

#[tauri::command(async)]
pub fn set_audio_recording_paused(
    state: State<'_, AudioRecorderState>,
    paused: bool,
) -> Result<(), String> {
    let active = state.inner.lock().map_err(|_| "Recorder is unavailable")?;
    let active = active.as_ref().ok_or("No recording is in progress.")?;
    let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
    active
        .control
        .send(RecorderControl::SetPaused(paused, reply_tx))
        .map_err(|_| "The recorder stopped unexpectedly.")?;
    reply_rx
        .recv()
        .map_err(|_| "The recorder stopped unexpectedly.")?
}

#[tauri::command(async)]
pub fn stop_audio_recording(
    state: State<'_, AudioRecorderState>,
    save_as: Option<String>,
) -> Result<SavedRecording, String> {
    let active = state
        .inner
        .lock()
        .map_err(|_| "Recorder is unavailable")?
        .take()
        .ok_or("No recording is in progress.")?;
    let (reply_tx, reply_rx) = mpsc::channel::<Result<(), String>>();
    active
        .control
        .send(RecorderControl::Stop(reply_tx))
        .map_err(|_| "The recorder stopped unexpectedly.")?;
    reply_rx
        .recv()
        .map_err(|_| "The recorder stopped unexpectedly.")??;

    // The take exists on disk; apply the user's final name if it changed.
    let final_path = match rename_saved(&active.path, save_as) {
        Ok(Some(renamed)) => renamed,
        _ => active.path.clone(),
    };
    Ok(SavedRecording {
        name: final_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Recording.wav".into()),
        path: final_path.to_string_lossy().into_owned(),
    })
}

/// Moves the finished file to the name the user last typed, colliding safely.
fn rename_saved(original: &Path, save_as: Option<String>) -> Result<Option<PathBuf>, String> {
    let Some(requested) = save_as else {
        return Ok(None);
    };
    let requested = sanitize_stem(requested.trim());
    if requested.is_empty() {
        return Ok(None);
    }
    if original
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_lowercase())
        .is_some_and(|stem| stem == requested.to_lowercase())
    {
        return Ok(None);
    }
    let folder = original
        .parent()
        .ok_or("The recording folder is unavailable")?
        .to_path_buf();
    let target = unique_in_dir(&folder, &format!("{requested}.wav"));
    fs::rename(original, &target)
        .map_err(|error| format!("Could not rename the recording: {error}"))?;
    Ok(Some(target))
}
