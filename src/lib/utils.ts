import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Capture a small JPEG thumbnail from the first frame of a video file.
// Used so video assets show a real preview in the asset list and mention pills
// instead of a generic Video icon. Returns '' on any failure (codec, decode,
// canvas) — callers should fall back to the icon when empty.
export function createVideoThumbnail(file: File, size: number = 80): Promise<string> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    (video as any).playsInline = true;
    let settled = false;
    const finish = (val: string) => {
      if (settled) return;
      settled = true;
      try { URL.revokeObjectURL(objectUrl); } catch {}
      resolve(val);
    };
    video.onloadedmetadata = () => {
      // Seek slightly past 0 — many codecs return a black frame at exactly 0.
      try {
        video.currentTime = Math.min(0.1, (video.duration || 1) * 0.1);
      } catch {
        finish('');
      }
    };
    video.onseeked = () => {
      try {
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return finish('');
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish('');
        const scale = Math.max(size / w, size / h);
        const sw = w * scale, sh = h * scale;
        ctx.drawImage(video, (size - sw) / 2, (size - sh) / 2, sw, sh);
        finish(canvas.toDataURL('image/jpeg', 0.6));
      } catch {
        finish('');
      }
    };
    video.onerror = () => finish('');
    // Safety net: some codecs never fire seeked; cap at 4s.
    setTimeout(() => finish(''), 4000);
    video.src = objectUrl;
  });
}

// Shrink image to tiny thumbnail for log storage (saves IndexedDB space)
// Accepts File (preferred for new flow) or data URL (legacy)
export function createThumbnail(source: File | string, size: number = 80): Promise<string> {
  return new Promise((resolve) => {
    const isFile = source instanceof File;
    const objectUrl = isFile ? URL.createObjectURL(source) : null;
    const src = isFile ? objectUrl! : source;
    // For non-image-data-URL strings (e.g. http URLs), return as-is
    if (!isFile && !source.startsWith('data:image')) { resolve(source); return; }
    const img = new Image();
    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(''); return; }
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.5));
    };
    img.onerror = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); resolve(''); };
    img.src = src;
  });
}

export function showNotification(title: string, options?: NotificationOptions) {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    new Notification(title, options);
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') new Notification(title, options);
    });
  }
}

// BytePlus API limits
export const API_LIMITS = {
  image: { maxSizeMB: 30, minPx: 300, maxPx: 6000 },
  video: { maxSizeMB: 50, minDuration: 2, maxDuration: 15, minPx: 300, maxPx: 6000 },
  audio: { maxSizeMB: 15, minDuration: 2, maxDuration: 15 },
  totalRequestMB: 64,
};

// Validate image file before reading
export function validateImageFile(file: File): string | null {
  const sizeMB = file.size / (1024 * 1024);
  if (sizeMB > API_LIMITS.image.maxSizeMB) {
    return `이미지 크기 초과: ${sizeMB.toFixed(1)}MB (최대 ${API_LIMITS.image.maxSizeMB}MB)`;
  }
  const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/gif', 'image/tiff'];
  if (!validTypes.includes(file.type)) {
    return `지원하지 않는 형식: ${file.type} (지원: JPEG, PNG, WebP, BMP, GIF, TIFF)`;
  }
  return null;
}

// Validate image dimensions (async — needs to load the image)
// Accepts File (preferred) or data URL string
export function validateImageDimensions(source: File | string): Promise<string | null> {
  return new Promise((resolve) => {
    const isFile = source instanceof File;
    const objectUrl = isFile ? URL.createObjectURL(source) : null;
    const img = new Image();
    img.onload = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      const { width, height } = img;
      const { minPx, maxPx } = API_LIMITS.image;
      if (width < minPx || height < minPx) {
        resolve(`이미지 해상도 너무 작음: ${width}x${height} (최소 ${minPx}x${minPx})`);
      } else if (width > maxPx || height > maxPx) {
        resolve(`이미지 해상도 초과: ${width}x${height} (최대 ${maxPx}x${maxPx})`);
      } else {
        resolve(null);
      }
    };
    img.onerror = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); resolve(null); };
    img.src = isFile ? objectUrl! : source;
  });
}

// Validate video file (size + duration + resolution + fps)
export function validateVideoFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > API_LIMITS.video.maxSizeMB) { resolve(`비디오 크기 초과: ${sizeMB.toFixed(1)}MB (최대 ${API_LIMITS.video.maxSizeMB}MB)`); return; }
    const validTypes = ['video/mp4', 'video/quicktime'];
    if (!validTypes.includes(file.type)) { resolve(`지원하지 않는 형식: ${file.type} (지원: MP4, MOV)`); return; }
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      const d = video.duration;
      if (d < API_LIMITS.video.minDuration) { resolve(`비디오 너무 짧음: ${d.toFixed(1)}초 (최소 ${API_LIMITS.video.minDuration}초)`); return; }
      if (d > API_LIMITS.video.maxDuration) { resolve(`비디오 너무 김: ${d.toFixed(1)}초 (최대 ${API_LIMITS.video.maxDuration}초)`); return; }
      // Check resolution (480p~720p → height roughly 480~1280)
      const h = video.videoHeight;
      const w = video.videoWidth;
      if (h > 0 && w > 0) {
        const shortSide = Math.min(h, w);
        if (shortSide > 1280) { resolve(`비디오 해상도 초과: ${w}x${h} (720p 이하로 줄여주세요)`); return; }
      }
      resolve(null);
    };
    video.onerror = () => { URL.revokeObjectURL(video.src); resolve(null); };
    video.src = URL.createObjectURL(file);
  });
}

// Validate audio file (size + duration)
export function validateAudioFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > API_LIMITS.audio.maxSizeMB) { resolve(`오디오 크기 초과: ${sizeMB.toFixed(1)}MB (최대 ${API_LIMITS.audio.maxSizeMB}MB)`); return; }
    const validTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3'];
    if (!validTypes.includes(file.type)) { resolve(`지원하지 않는 형식: ${file.type} (지원: WAV, MP3)`); return; }
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(audio.src);
      const d = audio.duration;
      if (d < API_LIMITS.audio.minDuration) resolve(`오디오 너무 짧음: ${d.toFixed(1)}초 (최소 ${API_LIMITS.audio.minDuration}초)`);
      else if (d > API_LIMITS.audio.maxDuration) resolve(`오디오 너무 김: ${d.toFixed(1)}초 (최대 ${API_LIMITS.audio.maxDuration}초)`);
      else resolve(null);
    };
    audio.onerror = () => { URL.revokeObjectURL(audio.src); resolve(null); };
    audio.src = URL.createObjectURL(file);
  });
}

// Cache file locally on server (for reuse) → returns cacheId
export async function cacheFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const res = await fetch('/api/cache', {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
    body: buffer,
  });
  const data = await res.json();
  return data.cacheId;
}

// Read cached file as base64 data URL (for image reuse)
export async function readCacheAsDataUrl(cacheId: string): Promise<string> {
  const res = await fetch(`/api/cache/${cacheId}`);
  if (!res.ok) throw new Error('Cache file not found');
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Upload video/audio to temp public hosting → returns { url, cacheId }
export async function uploadToPublicUrl(file: File): Promise<{ url: string; cacheId: string }> {
  const buffer = await file.arrayBuffer();
  const res = await fetch('/api/upload-public', {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
    body: buffer,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return await res.json();
}

// Re-upload from local cache → new public URL
export async function reuploadFromCache(cacheId: string): Promise<string> {
  const res = await fetch(`/api/reupload/${cacheId}`, { method: 'POST' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Re-upload failed');
  }
  const data = await res.json();
  return data.url;
}

// Image/audio counterpart to reuploadFromPath — re-reads the original file
// from disk and re-populates media-cache, but skips R2. Caller then uses
// readCacheAsDataUrl(cacheId) to get the base64 data URL.
export async function cacheFromPath(originalPath: string): Promise<string> {
  const res = await fetch('/api/cache-from-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Cache from path failed');
  }
  const data = await res.json();
  return data.cacheId;
}

// Last-resort recovery: re-read the original source file from disk by its
// absolute path. Used when the server media-cache entry is gone. Re-caches
// server-side, so returns a fresh { url, cacheId } the caller should persist.
// VIDEO-ONLY — image/audio uses cacheFromPath (no R2 round-trip).
export async function reuploadFromPath(originalPath: string): Promise<{ url: string; cacheId: string }> {
  const res = await fetch('/api/reupload-from-path', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalPath }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Re-upload from path failed');
  }
  return await res.json();
}

// Resolve a File object's absolute on-disk path via the Electron preload bridge.
// Returns '' in non-Electron contexts or if the bridge is unavailable.
export function getFilePath(file: File): string {
  try {
    return (window as any).electronAPI?.getPathForFile?.(file) || '';
  } catch {
    return '';
  }
}

// Read file as base64 data URL — lossless, no compression, no server upload
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// In-memory blob cache — pre-fetched on generation success, used by both preview and download.
// LRU with 200MB cap so memory never balloons indefinitely.
const blobCache = new Map<string, Blob>(); // insertion order = LRU recency
const MAX_CACHE_BYTES = 200 * 1024 * 1024;

function totalCacheBytes(): number {
  let s = 0;
  for (const b of blobCache.values()) s += b.size;
  return s;
}

function evictUntilFits(needed: number) {
  while (blobCache.size > 0 && totalCacheBytes() + needed > MAX_CACHE_BYTES) {
    const oldestKey = blobCache.keys().next().value;
    if (oldestKey === undefined) break;
    blobCache.delete(oldestKey);
  }
}

export function setCachedBlob(url: string, blob: Blob) {
  blobCache.delete(url); // remove if exists, so re-insert moves to end (most-recent)
  if (blob.size <= MAX_CACHE_BYTES) {
    evictUntilFits(blob.size);
    blobCache.set(url, blob);
  }
  // Auto-cleanup after 24h (BytePlus signed URLs expire then anyway)
  setTimeout(() => blobCache.delete(url), 24 * 60 * 60 * 1000);
}

export function getCachedBlob(url: string): Blob | null {
  const blob = blobCache.get(url);
  if (blob) {
    // LRU touch: re-insert to move to most-recent
    blobCache.delete(url);
    blobCache.set(url, blob);
  }
  return blob || null;
}

export function getBlobCacheStats() {
  return { count: blobCache.size, bytes: totalCacheBytes(), capBytes: MAX_CACHE_BYTES };
}

export function clearBlobCache() {
  blobCache.clear();
}

export async function downloadViaProxy(remoteUrl: string, filename: string) {
  // Fast path: serve from in-memory blob (instant, no CDN round-trip)
  const cached = blobCache.get(remoteUrl);
  if (cached) {
    const blobUrl = URL.createObjectURL(cached);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke window must outlive the browser writing the blob to disk. 5s broke 50MB downloads
    // on slower disks (file vanished mid-write). 5min covers any realistic case while still
    // freeing the memory eventually.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
    // Notify ChatArea for instant-completion toast
    window.dispatchEvent(new CustomEvent('seedance:download-instant', { detail: { filename, size: cached.size } }));
    return;
  }

  // Slow path: Electron direct download from BytePlus CDN (cold cache → may be slow)
  const api = (window as any).electronAPI;
  if (api?.download) {
    await api.download({ url: remoteUrl, filename });
    return;
  }
  // Browser/dev fallback
  const params = new URLSearchParams({ url: remoteUrl, filename });
  const a = document.createElement('a');
  a.href = `/api/download?${params.toString()}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function buildDownloadFilename(taskId: string, ext: string = '.mp4'): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `dreamina-${date}-${taskId}${ext}`;
}
