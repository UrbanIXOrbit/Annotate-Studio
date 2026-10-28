'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Check, FolderOpen, Loader2, Mic, Pause, Play, Save, Square } from 'lucide-react';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { setAudioRecordingPaused, startAudioRecording, stopAudioRecording } from '@/lib/tauri-commands';
import { useSettings } from '@/store/settings';
import { toast } from '@/store/toast';
import { baseName } from '@/lib/utils';

type RecorderStatus = 'ready' | 'recording' | 'paused' | 'saving';

function defaultName() {
  const date = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(/[,:]/g, '').replace(' ', ' ');
  return `Recording ${date}`;
}

export default function RecorderWindow({ resourceId }: { resourceId: string }) {
  const resource = useCanvas((state) => activeWorkspace(state).resources.find((item) => item.id === resourceId));
  const recordingFolder = useSettings((state) => state.recordingFolder);
  const updateSettings = useSettings((state) => state.update);
  const [status, setStatus] = useState<RecorderStatus>('ready');
  const [name, setName] = useState(defaultName);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const chooseFolder = useCallback(async () => {
    try {
      const folder = await open({ directory: true, multiple: false, title: 'Choose where recordings are saved' });
      if (typeof folder !== 'string') return null;
      updateSettings({ recordingFolder: folder });
      return folder;
    } catch (reason) {
      toast.error('Could not choose a recording folder', reason);
      return null;
    }
  }, [updateSettings]);

  const saveRecording = useCallback(async () => {
    if (!resource) return;
    setStatus('saving');
    try {
      const saved = await stopAudioRecording(name.trim());
      const title = saved.name.replace(/\.wav$/i, '');
      useCanvas.getState().updateResource(resourceId, {
        type: 'audiobook',
        title,
        filePath: saved.path,
        tracks: [{ path: saved.path, title: saved.name, mediaType: 'audio/wav' }],
        isExternal: true,
      });
      toast.success('Recording saved', saved.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setStatus('ready');
    }
  }, [name, resource, resourceId]);

  useEffect(() => {
    if (status !== 'recording') return;
    const interval = window.setInterval(() => setDuration((value) => value + 1000), 1000);
    return () => window.clearInterval(interval);
  }, [status]);

  const start = async () => {
    const folder = recordingFolder || await chooseFolder();
    if (!folder) return;
    if (!name.trim()) {
      setError('Give the recording a name first.');
      return;
    }
    try {
      setError(null);
      const device = await startAudioRecording(folder, name.trim());
      setDuration(0);
      setStatus('recording');
      toast.success('Recording started', device ? `Recording via ${device}` : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const stop = () => void saveRecording();
  const togglePause = () => {
    if (status === 'recording') {
      void setAudioRecordingPaused(true).then(() => setStatus('paused')).catch((reason) => setError(String(reason)));
    } else if (status === 'paused') {
      void setAudioRecordingPaused(false).then(() => setStatus('recording')).catch((reason) => setError(String(reason)));
    }
  };

  if (!resource) return null;
  const time = new Date(duration).toISOString().slice(14, 19);
  const active = status === 'recording' || status === 'paused';
  return (
    <div className="recorder-window">
      <div className="recorder-heading"><Mic size={17} /><span>Audio recording</span></div>
      <label className="recorder-name-label">Recording name
        <input value={name} disabled={status === 'saving'} onChange={(event) => setName(event.target.value)} placeholder="Recording name" />
      </label>
      <div className={`recorder-wave${status === 'recording' ? ' is-recording' : ''}`} aria-label="Microphone recording status">
        {Array.from({ length: 30 }, (_, index) => <span key={index} />)}
      </div>
      <div className="recorder-status-row"><span className={status === 'recording' ? 'recorder-live' : ''}>{status === 'recording' ? 'Recording' : status === 'paused' ? 'Paused' : status === 'saving' ? 'Saving' : 'Ready'}</span><time>{time}</time></div>
      {error && <p className="recorder-error">{error}</p>}
      <div className="recorder-controls">
        {!active ? <button type="button" className="btn btn-primary" disabled={status === 'saving'} onClick={() => void start()}><Mic size={15} /> Start recording</button> : <>
          <button type="button" className="btn btn-secondary" onClick={togglePause}>{status === 'recording' ? <Pause size={15} /> : <Play size={15} />}{status === 'recording' ? 'Pause' : 'Resume'}</button>
          <button type="button" className="btn btn-primary" onClick={stop}><Square size={14} /> Stop and save</button>
        </>}
        {status === 'saving' && <Loader2 size={16} className="spin" />}
      </div>
      <div className="recorder-folder"><FolderOpen size={14} /><span title={recordingFolder}>{recordingFolder ? baseName(recordingFolder) : 'No folder chosen'}</span><button type="button" onClick={() => void chooseFolder()} disabled={active || status === 'saving'}>{recordingFolder ? 'Change folder' : 'Choose folder'}</button></div>
      {recordingFolder && <p className="recorder-folder-note"><Check size={13} /> Future recordings save to this folder.</p>}
    </div>
  );
}
