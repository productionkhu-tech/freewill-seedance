import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Shrink base64 image to tiny thumbnail for log storage (saves IndexedDB space)
export function createThumbnail(dataUrl: string, size: number = 80): Promise<string> {
  return new Promise((resolve) => {
    if (!dataUrl.startsWith('data:image')) { resolve(dataUrl); return; }
    const img = new Image();
    img.onload = () => {
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
    img.onerror = () => resolve('');
    img.src = dataUrl;
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
export function validateImageDimensions(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
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
    img.onerror = () => resolve(null); // skip check on error
    img.src = dataUrl;
  });
}

// Upload video/audio to temp public hosting → returns public URL
export async function uploadToPublicUrl(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const res = await fetch('/api/upload-public', {
    method: 'POST',
    headers: { 'Content-Type': file.type, 'X-Filename': file.name },
    body: buffer,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  const data = await res.json();
  return data.url;
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

export async function downloadViaProxy(remoteUrl: string, filename: string) {
  const params = new URLSearchParams({ url: remoteUrl, filename });
  const res = await fetch(`/api/download?${params.toString()}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function buildDownloadFilename(taskId: string, ext: string = '.mp4'): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return `dreamina-${date}-${taskId}${ext}`;
}
