'use client';

import React, { memo, useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { readFileBytes } from '@/lib/tauri-commands';
import { extensionOf } from '@/lib/utils';

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Renders a captured image from an app-owned workspace path directly. */
function CardImage({ path, alt, caption }: { path: string; alt: string; caption?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(false);
    readFileBytes(path)
      .then((bytes) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[extensionOf(path)] ?? 'image/png' }));
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (error) {
    return (
      <div className="card-image-error">
        <ImageOff size={14} /> Image unavailable
      </div>
    );
  }
  if (!url) {
    return (
      <div className="card-image-loading">
        <Loader2 size={16} className="spin" />
      </div>
    );
  }
  return (
    <div className="card-image-wrap">
      <img className="card-image" src={url} alt={alt} />
      {caption && <span className="card-image-caption">{caption}</span>}
    </div>
  );
}

export default memo(CardImage);
