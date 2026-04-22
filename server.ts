import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';

dotenv.config();

const API_KEY = process.env.SEEDANCE_API_KEY;

async function startServer() {
  if (!API_KEY) {
    console.error('\n  [ERROR] 환경변수 SEEDANCE_API_KEY가 설정되지 않았습니다.');
    console.error('  시스템 환경변수에 다음을 추가하세요:');
    console.error('    변수 이름: SEEDANCE_API_KEY');
    console.error('    변수 값:   (발급받은 API 키)\n');
    process.exit(1);
  }

  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '200mb' }));

  // Download proxy (SSRF-safe: BytePlus CDN only)
  const ALLOWED_DOWNLOAD_HOSTS = ['bytepluses.com', 'byteplus.com', 'bytedance.com', 'volccdn.com', 'volces.com', 'ibytedtos.com', 'volceapplog.com'];

  app.get('/api/download', async (req, res) => {
    const { url, filename, check } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });

    try {
      const parsed = new URL(url);
      if (!ALLOWED_DOWNLOAD_HOSTS.some(d => parsed.hostname.endsWith(d))) {
        return res.status(403).json({ error: 'Domain not allowed' });
      }
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    // Check mode: tiny Range GET to verify URL liveness (BytePlus signed URLs only allow GET)
    if (check) {
      try {
        const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        return res.status(probe.ok || probe.status === 206 ? 200 : probe.status).end();
      } catch { return res.status(502).end(); }
    }

    const upstreamController = new AbortController();
    try {
      const response = await fetch(url, { signal: upstreamController.signal });
      if (!response.ok) return res.status(response.status).json({ error: response.statusText });

      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent((filename as string) || 'download.mp4')}`);
      const cl = response.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);

      if (!response.body) return res.status(500).end();
      // Use Node Readable.fromWeb + pipe → handles backpressure, no memory copy, much higher throughput
      const nodeStream = Readable.fromWeb(response.body as any);

      // Cancel upstream when client disconnects (avoids server holding zombie BytePlus fetches)
      const onClientClose = () => {
        if (!res.writableEnded) {
          try { nodeStream.destroy(); } catch {}
          try { upstreamController.abort(); } catch {}
        }
      };
      res.on('close', onClientClose);

      nodeStream.on('error', (err) => {
        console.error('[Download] upstream error:', (err as Error).message);
        if (!res.headersSent) { try { res.status(502).end(); } catch {} }
        else { try { res.destroy(); } catch {} }
      });

      nodeStream.pipe(res);
    } catch (error: any) {
      console.error('[Download] fetch error:', error.message);
      if (!res.headersSent) res.status(500).json({ error: error.message });
    }
  });

  // Media cache directory for video/audio reuse
  const CACHE_DIR = path.join(process.cwd(), 'media-cache');
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // Cleanup files older than 30 days
  const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      const age = now - fs.statSync(fp).mtimeMs;
      if (age > CACHE_MAX_AGE_MS) { fs.unlinkSync(fp); console.log(`[Cache] Deleted old file: ${f}`); }
    }
  } catch {};

  async function uploadToTmpFiles(fileBuffer: Buffer, filename: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', new Blob([fileBuffer]), filename);
    // Hard timeout — tmpfiles.org has gone unresponsive in the past, freezing the whole UI
    // because the request never resolves. 60s is generous for ~50MB uploads on slow links.
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), 60000);
    try {
      const response = await fetch('https://tmpfiles.org/api/v1/upload', {
        method: 'POST',
        body: formData,
        signal: ac.signal,
      });
      if (!response.ok) throw new Error(`tmpfiles HTTP ${response.status}`);
      const data = await response.json() as any;
      if (data.status !== 'success' || !data.data?.url) throw new Error('Upload failed: ' + JSON.stringify(data));
      return data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('tmpfiles 업로드 타임아웃 (60초) — 잠시 후 다시 시도하세요');
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // BytePlus Files API — upload video to BytePlus' own storage.
  // Returns a signed download URL that BytePlus task-generation can fetch directly.
  // Advantages over tmpfiles: no third-party dependency, longer lifetime, in-network to BytePlus.
  // Images/audio still use tmpfiles — they're small enough and the payload size concerns differ.
  const BYTEPLUS_API_BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3';

  async function uploadToBytePlusFiles(fileBuffer: Buffer, filename: string, mimeType: string): Promise<string> {
    // Step 1: POST to /files to create the file record
    const formData = new FormData();
    formData.append('purpose', 'user_data');
    formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename);

    const uploadAc = new AbortController();
    const uploadTimer = setTimeout(() => uploadAc.abort(), 120000); // 2min for large videos
    let fileId: string;
    try {
      const res = await fetch(`${BYTEPLUS_API_BASE}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}` },
        body: formData,
        signal: uploadAc.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`BytePlus Files API ${res.status}: ${errText.substring(0, 200)}`);
      }
      const data = await res.json() as any;
      if (!data.id) throw new Error('BytePlus Files API returned no id: ' + JSON.stringify(data));
      fileId = data.id;
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('BytePlus Files 업로드 타임아웃 (120초)');
      throw err;
    } finally {
      clearTimeout(uploadTimer);
    }

    // Step 2: GET /files/{id}/content with manual redirect → extract the signed download URL
    // from the Location header so BytePlus task-generation can fetch it without our API key.
    const urlAc = new AbortController();
    const urlTimer = setTimeout(() => urlAc.abort(), 15000);
    try {
      const res = await fetch(`${BYTEPLUS_API_BASE}/files/${fileId}/content`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${API_KEY}` },
        signal: urlAc.signal,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) return loc;
      }
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('json')) {
          const data = await res.json().catch(() => ({})) as any;
          const url = data.url || data.download_url;
          if (url) return url;
        }
      }
      // Fallback: if we can't resolve a signed URL, point BytePlus at the content endpoint
      // directly. Works in-region but requires Authorization header — only use as last resort.
      throw new Error(`Could not resolve signed URL from Files API (status ${res.status})`);
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('BytePlus Files URL 조회 타임아웃 (15초)');
      throw err;
    } finally {
      clearTimeout(urlTimer);
    }
  }

  function isVideoExt(ext: string): boolean {
    const v = ext.toLowerCase();
    return v === '.mp4' || v === '.mov' || v === '.webm' || v === '.m4v';
  }

  function mimeFromExt(ext: string): string {
    const v = ext.toLowerCase();
    if (v === '.mp4' || v === '.m4v') return 'video/mp4';
    if (v === '.mov') return 'video/quicktime';
    if (v === '.webm') return 'video/webm';
    return 'application/octet-stream';
  }

  // Cache file locally (for image reuse) → returns { cacheId }
  app.post('/api/cache', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
    const filename = decodeURIComponent((req.headers['x-filename'] as string) || 'file');
    const ext = path.extname(filename) || '';
    const hash = crypto.createHash('md5').update(req.body).digest('hex').slice(0, 12);
    const cacheId = `${hash}${ext}`;
    const cachePath = path.join(CACHE_DIR, cacheId);
    if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, req.body);
    res.json({ cacheId });
  });

  // Read cached file
  app.get('/api/cache/:cacheId', (req, res) => {
    const cachePath = path.join(CACHE_DIR, req.params.cacheId);
    if (!fs.existsSync(cachePath)) return res.status(404).json({ error: 'File not found in cache' });
    res.sendFile(cachePath);
  });

  // Upload image/audio/video → cache locally + upload to public host → returns { url, cacheId }
  // Routing: video goes to BytePlus Files API (direct to BytePlus, in-network, more reliable).
  //          image/audio still go to tmpfiles (smaller files, avoids BytePlus storage costs).
  app.post('/api/upload-public', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
    const filename = decodeURIComponent((req.headers['x-filename'] as string) || 'upload.mp4');
    const ext = path.extname(filename) || '.mp4';
    const contentType = (req.headers['content-type'] as string) || '';
    const isVideo = contentType.startsWith('video/') || isVideoExt(ext);
    // Hash file content → same file = same cacheId (no duplicates)
    const hash = crypto.createHash('md5').update(req.body).digest('hex').slice(0, 12);
    const cacheId = `${hash}${ext}`;
    console.log(`[Upload] ${filename} (${(req.body.length / 1024 / 1024).toFixed(1)}MB) hash=${hash} video=${isVideo}`);

    try {
      // Save to local cache (skip if same file already cached)
      const cachePath = path.join(CACHE_DIR, cacheId);
      if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, req.body);

      // Route video to BytePlus, everything else to tmpfiles
      const publicUrl = isVideo
        ? await uploadToBytePlusFiles(req.body, filename, contentType || mimeFromExt(ext))
        : await uploadToTmpFiles(req.body, filename);
      console.log(`[Upload] OK (${isVideo ? 'byteplus' : 'tmpfiles'}) → ${publicUrl.substring(0, 80)}... (cached: ${cacheId})`);
      res.json({ url: publicUrl, cacheId });
    } catch (error: any) {
      console.error('[Upload] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Re-upload from cache → new public URL. Routes video → BytePlus, others → tmpfiles
  // based on the cacheId's file extension.
  app.post('/api/reupload/:cacheId', async (req, res) => {
    const cachePath = path.join(CACHE_DIR, req.params.cacheId);
    const ext = path.extname(req.params.cacheId) || '';
    const isVideo = isVideoExt(ext);
    console.log(`[Re-upload] ${req.params.cacheId} video=${isVideo}`);

    try {
      if (!fs.existsSync(cachePath)) {
        return res.status(404).json({ error: 'Cached file not found. Please re-attach the file.' });
      }
      const fileBuffer = fs.readFileSync(cachePath);
      const publicUrl = isVideo
        ? await uploadToBytePlusFiles(fileBuffer, req.params.cacheId, mimeFromExt(ext))
        : await uploadToTmpFiles(fileBuffer, req.params.cacheId);
      console.log(`[Re-upload] OK (${isVideo ? 'byteplus' : 'tmpfiles'}) → ${publicUrl.substring(0, 80)}...`);
      res.json({ url: publicUrl });
    } catch (error: any) {
      console.error('[Re-upload] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // BytePlus API — Create Task
  app.post('/api/byteplus/tasks', async (req, res) => {
    console.log('[BytePlus API] Creating task...');

    try {
      const response = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify(req.body)
      });

      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch {
        return res.status(response.status).json({ error: `BytePlus API invalid response (${response.status})` });
      }

      console.log(`[BytePlus API] Create (${response.status}):`, JSON.stringify(data).substring(0, 500));
      res.status(response.status).json(data);
    } catch (error: any) {
      console.error('[BytePlus API] Create Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // BytePlus API — Get Task
  app.get('/api/byteplus/tasks/:id', async (req, res) => {
    try {
      const response = await fetch(`https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${req.params.id}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // BytePlus API — Cancel/Delete Task
  app.delete('/api/byteplus/tasks/:id', async (req, res) => {
    console.log(`[BytePlus API] Cancelling: ${req.params.id}`);
    try {
      const response = await fetch(`https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/${req.params.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${API_KEY}` }
      });
      if (response.status === 204) return res.status(204).end();
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Freewill Seedance 2.0`);
    console.log(`  ========================`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop\n`);
  });
}

startServer();
