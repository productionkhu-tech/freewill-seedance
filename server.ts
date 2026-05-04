import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';

dotenv.config();

const API_KEY = process.env.SEEDANCE_API_KEY;

// Credit tracker integration — POSTs token usage to a Google Apps Script endpoint
// when a task succeeds. The team name is derived from the SEEDANCE_API_KEY env var
// each user already has set via their team's .bat file: we hash the configured key
// and look it up against a baked-in SHA-256 map of the 13 official team keys.
//
// Why hashes and not the keys themselves? An EXE installed on one team member's PC
// would otherwise expose every other team's API key in the bundled server.cjs. With
// hashes only, the bundle reveals nothing useful — SHA-256 is one-way.
const TRACKER_URL = 'https://script.google.com/macros/s/AKfycbyC53V4K-CHJnP86qIbBP0WmXZ4cDD9D3CFVmd8otL4ZThzpQ7RKhnCeIXgDu4y7CFrnQ/exec';
const TEAM_KEY_HASHES: Record<string, string> = {
  '75a2bbd0f6a59fabc34712d4d1b70428156930f0a09f15089af5b7f4beff307a': '1팀',
  '276647adf6ebf0cd833aa34d849d15b3284ed620c32db93db8856042cdc110d8': '2팀',
  '75844d45e148d73c3a0688137b00362c6687c7c27bbad3e5edb8a3ebd93f81fe': '3팀',
  'c50dadbb9122af437fc4055818ed8adfaaedf95798f0e49844f975e637219f8a': '4팀',
  '7f386ec974cddc1275fc958610f8f87d89d2545708cafb2c5e7747c2ac09d236': '5팀',
  '46f44ffe5b2d1250afdc432a290090b458d74ba4660bd5ee056b5fe50e166ae9': '6팀',
  'c1b0d1e162f0581baab701c6f3c42d8c22fe4a66cd677d819e84fbf87b167e26': '7팀',
  '2f44415f419f831b005409e2ad102bce3ec02d67a9ace1b0b9f754143a2b5595': '8팀',
  'a363ada0a1c1d39f02ebd47a8e0364ab0de46e127a643dc305d9de3b1701170b': '9팀',
  'a4eccba638ecf60e0bab44575e0ff433938d3290d913b3ad13b2cc0fceccae17': '10팀',
  'a0f79d7874f2e5aabe1db15fc93acdb80512a30326f2fcb9914ae1ee2e9319bb': 'AFX팀',
  'bd0900883cc308becf0fe4e8d629130acea5a59e26b4667bef6f9a861a0e6bbb': '2D팀',
  '724cf3b6d22b122d01b371eb8e550ffe4053b5eef4731becd3684f5c72bf4d4d': 'Special팀',
};
const TEAM_NAME = (() => {
  if (!API_KEY) return 'UNKNOWN';
  const h = crypto.createHash('sha256').update(API_KEY).digest('hex');
  return TEAM_KEY_HASHES[h] || 'UNKNOWN';
})();
console.log(`[Tracker] Resolved team: ${TEAM_NAME}`);
const reportedTasks = new Set<string>();

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

    // Step 2: resolve a URL BytePlus task-generation can use.
    // Tries signed URL first (via manual redirect), falls back to the content endpoint itself.
    // Freshly-uploaded files may 404 briefly while BytePlus indexes — retry once after 1s.
    const fallbackUrl = `${BYTEPLUS_API_BASE}/files/${fileId}/content`;

    const tryResolve = async (): Promise<string | null> => {
      const urlAc = new AbortController();
      const urlTimer = setTimeout(() => urlAc.abort(), 15000);
      try {
        const res = await fetch(fallbackUrl, {
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
        console.warn(`[BytePlus Files] resolve got status ${res.status} for id=${fileId}`);
        return null;
      } catch (err: any) {
        console.warn(`[BytePlus Files] resolve threw: ${err.message}`);
        return null;
      } finally {
        clearTimeout(urlTimer);
      }
    };

    // First attempt
    let resolved = await tryResolve();
    if (resolved) return resolved;

    // Retry after 1s — file may still be indexing
    await new Promise(r => setTimeout(r, 1000));
    resolved = await tryResolve();
    if (resolved) return resolved;

    // Final fallback: return the content endpoint URL itself. BytePlus task-generation is
    // in-network to its own Files API and can authenticate internally when fetching own-domain
    // URLs; if that fails, the error will surface at generation time with a clearer message
    // than blocking the upload entirely.
    console.warn(`[BytePlus Files] using fallback content URL for id=${fileId}`);
    return fallbackUrl;
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

  // Upload image/audio/video → cache locally + upload to tmpfiles → returns { url, cacheId }
  // NOTE: v26.4.2201/2202 tried routing video through BytePlus Files API, but the /files/{id}/content
  // endpoint either 404'd during indexing or the URL wasn't fetchable by BytePlus task-generation
  // (got "resource download failed" at generate time). Reverted to tmpfiles for all types in 2203.
  // The uploadToBytePlusFiles helper is kept around for future debugging but is not called.
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

      const publicUrl = await uploadToTmpFiles(req.body, filename);
      console.log(`[Upload] OK → ${publicUrl} (cached: ${cacheId})`);
      res.json({ url: publicUrl, cacheId });
    } catch (error: any) {
      console.error('[Upload] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Re-upload from cache → new public URL (tmpfiles for all types)
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
      const data = await response.json() as any;

      // Fire-and-forget report to the credit tracker. Only fires once per task
      // (reportedTasks dedupes), only on success with valid usage data, and any
      // failure here is swallowed so the polling response to the frontend is
      // never delayed or corrupted.
      if (data?.status === 'succeeded' && data?.usage?.total_tokens && !reportedTasks.has(req.params.id)) {
        reportedTasks.add(req.params.id);
        fetch(TRACKER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            team: TEAM_NAME,
            task_id: req.params.id,
            total_tokens: data.usage.total_tokens,
            completion_tokens: data.usage.completion_tokens,
            source: 'app',
            timestamp: Date.now(),
          }),
        }).catch(() => {});
      }

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
