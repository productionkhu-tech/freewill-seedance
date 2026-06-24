import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

dotenv.config();

const API_KEY = process.env.SEEDANCE_API_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

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
  'bd0900883cc308becf0fe4e8d629130acea5a59e26b4667bef6f9a861a0e6bbb': 'TA팀',
  '724cf3b6d22b122d01b371eb8e550ffe4053b5eef4731becd3684f5c72bf4d4d': 'Special팀',
  '0e43bc6b870b1d889724d6abe19cf23bda010114b780efcf0635e94964f1e117': 'AIP팀',
};
const TEAM_NAME = (() => {
  if (!API_KEY) return 'UNKNOWN';
  const h = crypto.createHash('sha256').update(API_KEY).digest('hex');
  return TEAM_KEY_HASHES[h] || 'UNKNOWN';
})();
console.log(`[Tracker] Resolved team: ${TEAM_NAME}`);
const reportedTasks = new Set<string>();

// Map: BytePlus task id → R2 object keys uploaded for this task.
// extend_video can carry up to 3 videos, so this is string[] not string.
// Cleared on any terminal status (succeeded/failed/expired) or user cancel.
// The 1-day R2 lifecycle rule is the backstop if something slips through.
const taskToR2Keys = new Map<string, string[]>();

// Reference count per R2 key. output_count >= 2 sends the SAME R2 URL across N
// parallel tasks; if task A finishes first and we delete the object, tasks B/C
// can still be in BytePlus's internal fetch window and would fail. Each
// taskToR2Keys.set() bumps the count, each terminal-status delete decrements;
// the actual DeleteObject only fires when the count hits 0.
const r2KeyRefCount = new Map<string, number>();

async function startServer() {
  if (!API_KEY) {
    console.error('\n  [ERROR] 환경변수 SEEDANCE_API_KEY가 설정되지 않았습니다.');
    console.error('  시스템 환경변수에 다음을 추가하세요:');
    console.error('    변수 이름: SEEDANCE_API_KEY');
    console.error('    변수 값:   (발급받은 API 키)\n');
    process.exit(1);
  }
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.error('\n  [ERROR] R2_* 환경변수가 설정되지 않았습니다.');
    console.error('  F:\\api key\\R2.bat 을 한 번 실행하세요.');
    console.error('  필요한 변수: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET\n');
    process.exit(1);
  }

  // R2 (S3-compatible) client. forcePathStyle: true so presigned URLs come out as
  // https://{account}.r2.cloudflarestorage.com/{bucket}/{key}?... — predictable for
  // extractR2Key below and the format Cloudflare recommends.
  const r2 = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });

  const r2Hostname = (() => {
    try { return new URL(R2_ENDPOINT).hostname; } catch { return ''; }
  })();

  function isR2Url(url: string): boolean {
    try { return new URL(url).hostname === r2Hostname; } catch { return false; }
  }

  // Pulls the object key from a path-style R2 URL.
  // Returns null for anything that isn't a /{bucket}/{key} layout.
  function extractR2Key(url: string): string | null {
    try {
      const u = new URL(url);
      const prefix = `/${R2_BUCKET}/`;
      if (u.pathname.startsWith(prefix)) {
        return decodeURIComponent(u.pathname.slice(prefix.length));
      }
      return null;
    } catch { return null; }
  }

  function scheduleR2Delete(taskId: string) {
    const keys = taskToR2Keys.get(taskId);
    if (!keys || keys.length === 0) return;
    taskToR2Keys.delete(taskId);
    for (const key of keys) {
      const remaining = (r2KeyRefCount.get(key) || 1) - 1;
      if (remaining > 0) {
        r2KeyRefCount.set(key, remaining);
        console.log(`[R2] keep ${key} (still ref'd by ${remaining} task(s))`);
        continue;
      }
      r2KeyRefCount.delete(key);
      r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET!, Key: key }))
        .then(() => console.log(`[R2] deleted ${key}`))
        .catch(err => console.warn(`[R2] delete failed for ${key}:`, err.message));
    }
  }

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

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

  // Media cache directory for video/audio reuse. In Electron production, main.cjs
  // injects MEDIA_CACHE_DIR pointing at app.getPath('userData')/media-cache so the
  // cache survives auto-updates. In dev or other runtimes we fall back to cwd.
  const CACHE_DIR = process.env.MEDIA_CACHE_DIR || path.join(process.cwd(), 'media-cache');
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`[Cache] Using ${CACHE_DIR}`);

  // Cleanup files older than 30 days — mtime-based. Every cache READ/dedup-hit
  // refreshes mtime (touchCache below), so actively reused references never
  // age out; only genuinely unused files get pruned here.
  const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(CACHE_DIR)) {
      const fp = path.join(CACHE_DIR, f);
      const age = now - fs.statSync(fp).mtimeMs;
      if (age > CACHE_MAX_AGE_MS) { fs.unlinkSync(fp); console.log(`[Cache] Deleted old file: ${f}`); }
    }
  } catch {};

  // LRU lifetime extension: any use of a cache entry resets its 30-day clock
  function touchCache(cachePath: string) {
    try { const now = new Date(); fs.utimesSync(cachePath, now, now); } catch { /* best-effort */ }
  }

  function mimeFromExt(ext: string): string {
    const v = ext.toLowerCase();
    // video
    if (v === '.mp4' || v === '.m4v') return 'video/mp4';
    if (v === '.mov') return 'video/quicktime';
    if (v === '.webm') return 'video/webm';
    // image
    if (v === '.jpg' || v === '.jpeg') return 'image/jpeg';
    if (v === '.png') return 'image/png';
    if (v === '.webp') return 'image/webp';
    if (v === '.gif') return 'image/gif';
    if (v === '.bmp') return 'image/bmp';
    if (v === '.tif' || v === '.tiff') return 'image/tiff';
    // audio
    if (v === '.wav') return 'audio/wav';
    if (v === '.mp3') return 'audio/mpeg';
    if (v === '.m4a') return 'audio/mp4';
    if (v === '.ogg') return 'audio/ogg';
    return 'application/octet-stream';
  }

  // Upload to R2 → returns a presigned GET URL (12h) BytePlus can fetch directly.
  // Key is unique-per-upload: same source video reused across tasks gets fresh keys,
  // so deleting task A's object never breaks task B that hasn't fetched yet.
  async function uploadToR2(fileBuffer: Buffer, filename: string, opts?: { expiresIn?: number; contentType?: string; contentDisposition?: string }): Promise<string> {
    const ext = path.extname(filename) || '.mp4';
    const safeBase = path
      .basename(filename, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40) || 'file';
    const hash = crypto.createHash('md5').update(fileBuffer).digest('hex').slice(0, 8);
    const key = `${safeBase}-${hash}-${Date.now()}${ext}`;

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET!,
      Key: key,
      Body: fileBuffer,
      ContentType: opts?.contentType || mimeFromExt(ext),
      ...(opts?.contentDisposition ? { ContentDisposition: opts.contentDisposition } : {}),
    }));

    const url = await getSignedUrl(
      r2,
      new GetObjectCommand({ Bucket: R2_BUCKET!, Key: key }),
      { expiresIn: opts?.expiresIn ?? 12 * 60 * 60 }, // default 12h — covers a generation wait
    );
    return url;
  }

  // ─── Element asset-pack sharing ───
  // Client POSTs a JSON bundle (asset metadata + base64 images). We host it on R2
  // under the element-packs/ prefix and return a 24h download link. Two layers of
  // lifecycle: (1) the presigned URL controls ACCESS — dead after 24h, reusable
  // any number of times within; (2) a persisted index + boot/hourly sweep DELETEs
  // the R2 object after 24h so nothing accumulates. The sweep uses the same
  // object-delete permission as upload (more reliable than bucket lifecycle, and
  // no bucket-wide config that could touch generation media).
  const PACK_PREFIX = 'element-packs/';
  const PACK_TTL_MS = 24 * 60 * 60 * 1000;
  const PACK_INDEX = path.join(CACHE_DIR, 'element-pack-index.json');
  const loadPackIndex = (): { key: string; createdAt: number }[] => {
    try { return JSON.parse(fs.readFileSync(PACK_INDEX, 'utf8')); } catch { return []; }
  };
  const savePackIndex = (list: { key: string; createdAt: number }[]) => {
    try { fs.writeFileSync(PACK_INDEX, JSON.stringify(list)); } catch (e: any) { console.warn('[element-pack] index save failed:', e?.message); }
  };
  async function sweepExpiredPacks() {
    const list = loadPackIndex();
    if (list.length === 0) return;
    const now = Date.now();
    const keep: { key: string; createdAt: number }[] = [];
    let deleted = 0;
    for (const p of list) {
      if (now - p.createdAt >= PACK_TTL_MS) {
        try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET!, Key: p.key })); deleted++; }
        catch { keep.push(p); /* delete failed (offline?) → retry next sweep */ }
      } else keep.push(p);
    }
    if (keep.length !== list.length) savePackIndex(keep);
    if (deleted) console.log(`[element-pack] swept ${deleted} expired pack(s) from R2`);
  }
  sweepExpiredPacks().catch(() => {});                                   // on boot
  setInterval(() => { sweepExpiredPacks().catch(() => {}); }, 60 * 60 * 1000); // hourly

  app.post('/api/element-pack', express.raw({ type: '*/*', limit: '120mb' }), async (req, res) => {
    try {
      const buf = Buffer.from(req.body as Buffer);
      if (!buf.length) return res.status(400).json({ error: 'empty body' });
      const key = `${PACK_PREFIX}${crypto.randomBytes(8).toString('hex')}-${Date.now()}.fwsl.json`;
      await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET!,
        Key: key,
        Body: buf,
        ContentType: 'application/json',
        ContentDisposition: 'attachment; filename="asset-pack.fwsl.json"',
      }));
      const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: R2_BUCKET!, Key: key }), { expiresIn: 24 * 60 * 60 }); // 24h
      const list = loadPackIndex(); list.push({ key, createdAt: Date.now() }); savePackIndex(list);
      res.json({ url, expiresInHours: 24 });
    } catch (e: any) {
      console.error('[element-pack] upload failed:', e?.message || e);
      res.status(500).json({ error: e?.message || 'upload failed' });
    }
  });

  // Import-by-link: fetch a shared pack URL server-side (no browser CORS) and
  // return the JSON. SSRF-guarded — only our own R2 host is allowed. Body is the
  // raw URL string (text/plain so the json parser skips it).
  app.post('/api/element-pack/fetch', express.raw({ type: '*/*', limit: '64kb' }), async (req, res) => {
    try {
      const url = Buffer.from(req.body as Buffer).toString('utf8').trim();
      if (!url) return res.status(400).json({ error: 'no url' });
      let host = '';
      try { host = new URL(url).hostname; } catch { return res.status(400).json({ error: '잘못된 링크' }); }
      const r2Host = (() => { try { return new URL(R2_ENDPOINT!).hostname; } catch { return ''; } })();
      if (!r2Host || host !== r2Host) return res.status(403).json({ error: '지원하지 않는 링크입니다 (Freewill 공유 링크만 가능)' });
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json({ error: `링크를 불러올 수 없습니다 (${r.status}) — 만료됐거나 잘못된 링크` });
      const text = await r.text();
      if (text.length > 120 * 1024 * 1024) return res.status(413).json({ error: 'pack too large' });
      res.type('application/json').send(text);
    } catch (e: any) {
      console.error('[element-pack/fetch] failed:', e?.message || e);
      res.status(500).json({ error: e?.message || 'fetch failed' });
    }
  });

  // Cache file locally (for image/audio reuse) → returns { cacheId }
  app.post('/api/cache', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
    const filename = decodeURIComponent((req.headers['x-filename'] as string) || 'file');
    const ext = path.extname(filename) || '';
    const hash = crypto.createHash('md5').update(req.body).digest('hex').slice(0, 12);
    const cacheId = `${hash}${ext}`;
    const cachePath = path.join(CACHE_DIR, cacheId);
    if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, req.body);
    else touchCache(cachePath); // dedup hit = 재사용 → 30일 시계 리셋
    res.json({ cacheId });
  });

  // Cache stats (count + bytes) — for the cleanup confirm dialog.
  // NOTE: must be registered BEFORE /api/cache/:cacheId or it matches as cacheId.
  app.get('/api/cache/stats', (_req, res) => {
    try {
      let count = 0, bytes = 0;
      for (const f of fs.readdirSync(CACHE_DIR)) {
        const st = fs.statSync(path.join(CACHE_DIR, f));
        if (st.isFile()) { count++; bytes += st.size; }
      }
      res.json({ count, bytes });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Wipe the ENTIRE media-cache. Wired to the sidebar cleanup button — explicit
  // cleanup means full cleanup (user decision). Old messages' clipboard
  // references become unrecoverable; file references can still recover via
  // originalPath at reuse time.
  app.post('/api/cache/clear', (_req, res) => {
    try {
      let deleted = 0, bytes = 0;
      for (const f of fs.readdirSync(CACHE_DIR)) {
        const fp = path.join(CACHE_DIR, f);
        const st = fs.statSync(fp);
        if (st.isFile()) { bytes += st.size; fs.unlinkSync(fp); deleted++; }
      }
      console.log(`[Cache] Cleared by user: ${deleted} files, ${(bytes / 1024 / 1024).toFixed(1)}MB`);
      res.json({ ok: true, deleted, bytes });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Read cached file
  app.get('/api/cache/:cacheId', (req, res) => {
    const cachePath = path.join(CACHE_DIR, req.params.cacheId);
    if (!fs.existsSync(cachePath)) return res.status(404).json({ error: 'File not found in cache' });
    touchCache(cachePath); // 읽기도 사용 → 30일 시계 리셋
    res.sendFile(cachePath);
  });

  // NOTE: There is intentionally no "upload + R2 in one step" endpoint anymore.
  // Attaching a file goes only to media-cache (/api/cache). R2 upload happens
  // ONLY at send time via /api/reupload/:cacheId — so every R2 object is born
  // with a known task ID it will be tied to, and is deletable on terminal
  // status. This eliminates the "attach orphan" class: in the old design every
  // attach put bytes in R2 with no owner, leaving permanent orphans behind.
  //
  // Critical for the shared R2 bucket too: a hypothetical cross-machine
  // cleanup sweep can't safely "garbage collect" attach-time orphans because
  // each app's in-memory ref map only knows its own user's active keys.
  // Solution: don't create those orphans in the first place.

  // Re-upload from cache → fresh R2 presigned URL (all media types).
  // Called at send time (handleSend / handleReuse). Each call produces a
  // unique R2 key, mapped to its task in POST /api/byteplus/tasks below.
  app.post('/api/reupload/:cacheId', async (req, res) => {
    const cachePath = path.join(CACHE_DIR, req.params.cacheId);
    console.log(`[Re-upload] ${req.params.cacheId}...`);

    try {
      if (!fs.existsSync(cachePath)) {
        return res.status(404).json({ error: 'Cached file not found. Please re-attach the file.' });
      }
      touchCache(cachePath); // 전송에 쓰임 → 30일 시계 리셋
      const fileBuffer = fs.readFileSync(cachePath);
      const publicUrl = await uploadToR2(fileBuffer, req.params.cacheId);
      console.log(`[Re-upload] R2 OK → ${publicUrl.substring(0, 80)}...`);
      res.json({ url: publicUrl });
    } catch (error: any) {
      console.error('[Re-upload] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Re-cache an image/audio from its on-disk original path WITHOUT touching R2.
  // The image/audio path is base64-inline to BytePlus, so R2 must not be involved
  // for these — that's the whole point of the brief's audio/image separation. The
  // caller then re-reads via /api/cache/:cacheId to build the base64 data URL.
  app.post('/api/cache-from-path', async (req, res) => {
    const originalPath = (req.body && req.body.originalPath) as string | undefined;
    if (!originalPath || typeof originalPath !== 'string') {
      return res.status(400).json({ error: 'originalPath required' });
    }
    console.log(`[Cache from path] ${originalPath}`);
    try {
      if (!fs.existsSync(originalPath)) {
        return res.status(404).json({ error: '원본 파일을 찾을 수 없습니다 (이동/삭제/이름변경됨)' });
      }
      const fileBuffer = fs.readFileSync(originalPath);
      const filename = path.basename(originalPath);
      const ext = path.extname(filename) || '';
      const hash = crypto.createHash('md5').update(fileBuffer).digest('hex').slice(0, 12);
      const cacheId = `${hash}${ext}`;
      const cachePath = path.join(CACHE_DIR, cacheId);
      if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, fileBuffer);
      else touchCache(cachePath);
      console.log(`[Cache from path] OK → ${cacheId}`);
      res.json({ cacheId });
    } catch (error: any) {
      console.error('[Cache from path] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // Last-resort recovery: re-read the original source file from its on-disk path
  // and re-cache + re-upload to R2. Used when the media-cache entry is gone (wiped
  // by a pre-2408 auto-update, or aged past the 30-day cleanup). Only works while
  // the user hasn't moved/renamed/deleted the original file. Re-populates the cache
  // so subsequent reuses hit the fast path again. Works for any media type.
  app.post('/api/reupload-from-path', async (req, res) => {
    const originalPath = (req.body && req.body.originalPath) as string | undefined;
    if (!originalPath || typeof originalPath !== 'string') {
      return res.status(400).json({ error: 'originalPath required' });
    }
    console.log(`[Re-upload from path] ${originalPath}`);
    try {
      if (!fs.existsSync(originalPath)) {
        return res.status(404).json({ error: '원본 파일을 찾을 수 없습니다 (이동/삭제/이름변경됨)' });
      }
      const fileBuffer = fs.readFileSync(originalPath);
      const filename = path.basename(originalPath);
      const ext = path.extname(filename) || '';
      const hash = crypto.createHash('md5').update(fileBuffer).digest('hex').slice(0, 12);
      const cacheId = `${hash}${ext}`;
      const cachePath = path.join(CACHE_DIR, cacheId);
      if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, fileBuffer);
      else touchCache(cachePath);
      const publicUrl = await uploadToR2(fileBuffer, filename);
      console.log(`[Re-upload from path] R2 OK → ${publicUrl.substring(0, 80)}... (re-cached: ${cacheId})`);
      res.json({ url: publicUrl, cacheId });
    } catch (error: any) {
      console.error('[Re-upload from path] Error:', error.message);
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

      // Map task → R2 keys used by this submission so we can clean up on terminal
      // status. All three media types (image_url / video_url / audio_url) now go
      // through R2; walk req.body.content, pick out items whose URL is on our R2
      // host, extract the path-style key. extend_video can have up to 3 videos,
      // multimodal_reference up to 9 images + 3 audio + 3 video.
      if (response.ok && data?.id && Array.isArray(req.body?.content)) {
        const keys: string[] = [];
        for (const item of req.body.content) {
          const t = item?.type;
          if (t === 'video_url' || t === 'image_url' || t === 'audio_url') {
            const url = item?.[t]?.url;
            if (typeof url === 'string' && isR2Url(url)) {
              const key = extractR2Key(url);
              if (key) keys.push(key);
            }
          }
        }
        if (keys.length) {
          taskToR2Keys.set(data.id, keys);
          for (const key of keys) {
            r2KeyRefCount.set(key, (r2KeyRefCount.get(key) || 0) + 1);
          }
          console.log(`[R2] task ${data.id} → ${keys.length} key(s) tracked`);
        }
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

      // Terminal status → clean up R2 inputs we tracked at submit time.
      // Idempotent: the Map entry is deleted on first hit so repeated polling
      // (the 10s interval may see the same terminal status twice before the
      // client stops asking) doesn't fire duplicate DeleteObjects.
      if (data?.status === 'succeeded' || data?.status === 'failed' || data?.status === 'expired') {
        scheduleR2Delete(req.params.id);
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
      // Clean up R2 inputs whether or not the upstream cancel succeeded — by the time
      // a user clicks cancel they don't want the bytes lingering, and the 1-day
      // lifecycle rule would catch it anyway.
      scheduleR2Delete(req.params.id);

      if (response.status === 204) return res.status(204).end();
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error: any) {
      // Still try to clean up R2 even if the cancel call itself blew up
      scheduleR2Delete(req.params.id);
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
