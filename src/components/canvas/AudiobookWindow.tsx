'use client';

import React, { memo, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Headphones, Loader2, SkipBack, SkipForward } from 'lucide-react';
import { activeWorkspace, useCanvas, type AudioTrack } from '@/store/canvas';
import { readExternalFileBytes, readFileBytes } from '@/lib/tauri-commands';

function AudiobookWindow({ resourceId }: { resourceId: string }) {
  const resource = useCanvas((state) => activeWorkspace(state).resources.find((item) => item.id === resourceId));
  const audioHostRef = useRef<HTMLDivElement>(null);
  const navigatorRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeHref, setActiveHref] = useState<string | null>(null);
  const [trackUrls, setTrackUrls] = useState<string[]>([]);

  useEffect(() => {
    if (!resource?.filePath) return;
    let cancelled = false;
    let navigator: any = null;
    const objectUrls: string[] = [];
    const tracks: AudioTrack[] = resource.tracks?.length
      ? resource.tracks
      : [{ path: resource.filePath, title: resource.title, mediaType: 'audio/mpeg' }];
    const read = resource.isExternal ? readExternalFileBytes : readFileBytes;

    setLoading(true);
    setError(null);
    setTrackUrls([]);
    setActiveHref(null);

    void (async () => {
      try {
        const files = await Promise.all(tracks.map(async (track) => {
          const bytes = await read(track.path);
          return { track, blob: new Blob([bytes as BlobPart], { type: track.mediaType }) };
        }));
        if (cancelled) return;
        const shared = await import('@readium/shared');
        const { AudioNavigator } = await import('@readium/navigator');
        const links: any[] = files.map(({ track, blob }) => {
          const href = URL.createObjectURL(blob);
          objectUrls.push(href);
          return new shared.Link({ href, type: track.mediaType, title: track.title });
        });
        const manifest = new shared.Manifest({
          metadata: new shared.Metadata({
            title: new shared.LocalizedString(resource.title),
            conformsTo: [shared.Profile.AUDIOBOOK],
          }),
          readingOrder: new shared.Links(links),
        });
        const publication = new shared.Publication({ manifest });
        const hrefs = links.map((link) => link.href as string);
        setTrackUrls(hrefs);
        navigator = new AudioNavigator(publication, {
          trackLoaded: (media: HTMLMediaElement) => {
            if (!audioHostRef.current || cancelled) return;
            media.controls = true;
            media.preload = 'metadata';
            media.setAttribute('aria-label', 'Audiobook playback controls');
            audioHostRef.current.replaceChildren(media);
            setActiveHref(media.currentSrc || media.src);
            setLoading(false);
          },
          positionChanged: (locator: { href: string }) => setActiveHref(locator.href),
          timelineItemChanged: () => {},
          trackEnded: () => {},
          play: () => {},
          pause: () => {},
          metadataLoaded: () => {},
          stalled: () => {},
          seeking: () => {},
          seekable: () => {},
          contentProtection: () => {},
          peripheral: () => {},
          contextMenu: () => {},
          remotePlaybackStateChanged: () => {},
          error: (reason: unknown) => {
            if (!cancelled) {
              setLoading(false);
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          },
        });
        if (cancelled) {
          navigator.destroy();
          return;
        }
        navigatorRef.current = navigator;
        setLoading(false);
      } catch (reason) {
        if (!cancelled) {
          setLoading(false);
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }
    })();

    return () => {
      cancelled = true;
      navigator?.destroy();
      if (navigatorRef.current === navigator) navigatorRef.current = null;
      objectUrls.forEach(URL.revokeObjectURL);
      audioHostRef.current?.replaceChildren();
    };
  }, [resource?.filePath, resource?.isExternal, resource?.title, resource?.tracks]);

  if (!resource) return null;
  const tracks = resource.tracks?.length ? resource.tracks : [{ path: resource.filePath ?? '', title: resource.title, mediaType: 'audio/mpeg' }];
  const activeIndex = Math.max(0, trackUrls.findIndex((href) => href === activeHref || activeHref?.startsWith(href)));
  const goTo = (index: number) => {
    const target = trackUrls[index];
    const navigator = navigatorRef.current;
    if (!target || !navigator) return;
    const link = navigator.publication.readingOrder.items[index];
    if (link) navigator.goLink(link, false, () => {});
  };

  return (
    <div className="audiobook-window">
      <div className="audiobook-player">
        <button type="button" className="icon-btn icon-btn-sm" title="Previous track" disabled={activeIndex <= 0 || loading} onClick={() => goTo(activeIndex - 1)}>
          <SkipBack size={15} />
        </button>
        <div ref={audioHostRef} className="audiobook-audio-host" />
        <button type="button" className="icon-btn icon-btn-sm" title="Next track" disabled={activeIndex >= tracks.length - 1 || loading} onClick={() => goTo(activeIndex + 1)}>
          <SkipForward size={15} />
        </button>
      </div>
      {loading && <div className="audiobook-status"><Loader2 size={15} className="spin" /> Preparing Readium audiobook…</div>}
      {error && <div className="audiobook-error"><AlertTriangle size={16} /> <span>{error}</span></div>}
      {!error && <div className="audiobook-playlist" aria-label="Audiobook playlist">
        <div className="audiobook-playlist-heading"><Headphones size={14} /> {tracks.length} track{tracks.length === 1 ? '' : 's'}</div>
        {tracks.map((track, index) => (
          <button
            key={`${track.path}-${index}`}
            type="button"
            className={`audiobook-track${index === activeIndex ? ' is-active' : ''}`}
            onClick={() => goTo(index)}
            disabled={loading || trackUrls.length === 0}
            title={track.title}
          >
            <span className="audiobook-track-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="audiobook-track-title">{track.title}</span>
          </button>
        ))}
      </div>}
      <p className="audiobook-format-note">Playback formats depend on audio support in this device’s browser.</p>
    </div>
  );
}

export default memo(AudiobookWindow);
