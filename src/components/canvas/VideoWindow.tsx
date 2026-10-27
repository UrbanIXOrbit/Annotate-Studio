'use client';

import React, { memo, useEffect, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { AlertTriangle, Film, Loader2, RefreshCw } from 'lucide-react';
import Dialog from '@/components/ui/Dialog';
import { activeWorkspace, useCanvas } from '@/store/canvas';
import { allowVideoAsset, convertVideoForPlayback, isFfmpegAvailable, listVideoPlayers, openVideoWithPlayer, type VideoPlayerInfo } from '@/lib/tauri-commands';

function VideoWindow({ resourceId }: { resourceId: string }) {
  const resource = useCanvas((state) => activeWorkspace(state).resources.find((item) => item.id === resourceId));
  const [source, setSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(false);
  const [converting, setConverting] = useState(false);
  const [openingSystemPlayer, setOpeningSystemPlayer] = useState(false);
  const [playerDialogOpen, setPlayerDialogOpen] = useState(false);
  const [players, setPlayers] = useState<VideoPlayerInfo[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState('system-default');
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  useEffect(() => {
    if (!resource?.filePath) return;
    let cancelled = false;
    setSource(null);
    setLoading(true);
    setError(null);
    allowVideoAsset(resource.filePath, resource.isExternal ?? false)
      .then((absolutePath) => {
        if (!cancelled) setSource(convertFileSrc(absolutePath));
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => { cancelled = true; };
  }, [resource?.filePath, resource?.isExternal]);

  if (!resource) return null;

  const onMediaError = () => {
    setSource(null);
    setLoading(false);
    setError('This video or its audio codec is not supported by the current system player.');
    void isFfmpegAvailable().then(setFfmpegAvailable).catch(() => setFfmpegAvailable(false));
  };

  const convert = async () => {
    if (!resource.filePath || converting) return;
    setConverting(true);
    setError(null);
    try {
      const converted = await convertVideoForPlayback(resource.filePath, resource.isExternal ?? false);
      useCanvas.getState().updateResource(resourceId, {
        filePath: converted.path,
        title: converted.name,
        isExternal: false,
      }, true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConverting(false);
    }
  };

  const choosePlayer = async () => {
    if (!resource.filePath || openingSystemPlayer) return;
    setOpeningSystemPlayer(true);
    setError(null);
    try {
      await openVideoWithPlayer(resource.filePath, resource.isExternal ?? false, selectedPlayerId);
      setPlayerDialogOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setOpeningSystemPlayer(false);
    }
  };

  const showPlayerChoices = async () => {
    setPlayerDialogOpen(true);
    setLoadingPlayers(true);
    try {
      const availablePlayers = await listVideoPlayers();
      setPlayers(availablePlayers);
      setSelectedPlayerId((current) => availablePlayers.some((player) => player.id === current) ? current : 'system-default');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPlayerDialogOpen(false);
    } finally {
      setLoadingPlayers(false);
    }
  };

  return (
    <div className="video-window">
      {source ? (
        <video
          className="video-player"
          src={source}
          controls
          playsInline
          preload="metadata"
          onLoadedMetadata={() => { setLoading(false); setError(null); }}
          onError={onMediaError}
          aria-label={resource.title}
        />
      ) : loading ? (
        <div className="video-status"><Loader2 size={18} className="spin" /><span>Opening video…</span></div>
      ) : null}
      {error && (
        <div className="video-fallback">
          <AlertTriangle size={18} />
          <p>{error}</p>
          <button type="button" className="btn btn-secondary" onClick={() => void showPlayerChoices()}>
            Choose video player…
          </button>
          {ffmpegAvailable ? (
            <button type="button" className="btn btn-secondary" onClick={() => void convert()} disabled={converting}>
              {converting ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
              {converting ? 'Converting…' : 'Convert for playback'}
            </button>
          ) : (
            <p className="video-ffmpeg-hint">Optional: add a minimal FFmpeg binary to the workspace `tools` folder to convert unsupported files.</p>
          )}
        </div>
      )}
      <div className="video-format-note"><Film size={12} /> Playback uses the system video codecs; unsupported codecs can be converted with optional FFmpeg.</div>
      <Dialog
        open={playerDialogOpen}
        onClose={() => setPlayerDialogOpen(false)}
        title="Choose a video player"
        width={440}
        footer={(
          <>
            <div className="dialog-footer-spacer" />
            <button type="button" className="btn btn-ghost" onClick={() => setPlayerDialogOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={() => void choosePlayer()} disabled={loadingPlayers || openingSystemPlayer || !players.some((player) => player.id === selectedPlayerId)}>
              {openingSystemPlayer ? 'Opening…' : 'Open video'}
            </button>
          </>
        )}
      >
        <p className="video-player-picker-hint">Available players are detected on this device. The original file stays where it is.</p>
        {loadingPlayers ? (
          <div className="video-player-picker-loading"><Loader2 size={16} className="spin" /> Searching for video players…</div>
        ) : (
          <div className="video-player-picker-list" role="radiogroup" aria-label="Video player">
            {players.map((player, index) => (
              <button
                key={player.id}
                type="button"
                role="radio"
                aria-checked={selectedPlayerId === player.id}
                className={`video-player-picker-option${selectedPlayerId === player.id ? ' selected' : ''}`}
                onClick={() => setSelectedPlayerId(player.id)}
                data-autofocus={index === 0 ? '' : undefined}
              >
                <span className="video-player-picker-radio" />
                <span>{player.name}</span>
              </button>
            ))}
          </div>
        )}
      </Dialog>
    </div>
  );
}

export default memo(VideoWindow);
