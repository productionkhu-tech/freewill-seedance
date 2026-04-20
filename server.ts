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
    const response = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: formData });
    const data = await response.json() as any;
    if (data.status !== 'success' || !data.data?.url) throw new Error('Upload failed: ' + JSON.stringify(data));
    return data.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
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

  // Upload video/audio → cache locally + upload to tmpfiles → returns { url, cacheId }
  app.post('/api/upload-public', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
    const filename = decodeURIComponent((req.headers['x-filename'] as string) || 'upload.mp4');
    const ext = path.extname(filename) || '.mp4';
    // Hash file content → same file = same cacheId (no duplicates)
    const hash = crypto.createHash('md5').update(req.body).digest('hex').slice(0, 12);
    const cacheId = `${hash}${ext}`;
    console.log(`[Upload] ${filename} (${(req.body.length / 1024 / 1024).toFixed(1)}MB) hash=${hash}`);

    try {
      // Save to local cache (skip if same file already cached)
      const cachePath = path.join(CACHE_DIR, cacheId);
      if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, req.body);

      // Upload to public hosting
      const publicUrl = await uploadToTmpFiles(req.body, filename);
      console.log(`[Upload] OK → ${publicUrl} (cached: ${cacheId})`);
      res.json({ url: publicUrl, cacheId });
    } catch (error: any) {
      console.error('[Upload] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Re-upload from cache → new public URL
  app.post('/api/reupload/:cacheId', async (req, res) => {
    const cachePath = path.join(CACHE_DIR, req.params.cacheId);
    console.log(`[Re-upload] ${req.params.cacheId}...`);

    try {
      if (!fs.existsSync(cachePath)) {
        return res.status(404).json({ error: 'Cached file not found. Please re-attach the file.' });
      }
      const fileBuffer = fs.readFileSync(cachePath);
      const publicUrl = await uploadToTmpFiles(fileBuffer, req.params.cacheId);
      console.log(`[Re-upload] OK → ${publicUrl}`);
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
