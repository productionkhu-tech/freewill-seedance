import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// Shared with the client store — see src/lib/model-access.ts for why these two facts
// live outside both files.
import { MODEL_GRANTS } from './src/lib/model-access';

dotenv.config();

const API_KEY = process.env.SEEDANCE_API_KEY;

// ★ 2.5 Demo — 2026-08-14 종료. 별도 키(SEEDANCE_25_DEMO_KEY) · 별도 엔드포인트 ·
// 별도 계약으로 돌던 레인이었고, 키를 읽는 코드부터 모델 id, 요청 분기,
// /api/capabilities 게이트까지 전부 제거했다. 남은 것은 은퇴한 모델 id 를 정식 2.5 로
// 옮기는 매핑 하나뿐이다(src/lib/model-access.ts). 되살릴 일이 생기면 되돌리지 말고
// 새로 설계할 것 — 반쯤 남은 분기가 제일 위험하다.
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

// Map: BytePlus task id → billing/tracking project name (from the app's dropdown).
// Captured at task-create time (stripped from the BytePlus payload), read at
// report time so the credit tracker can attribute usage to the project.
//
// ★ Mirrored to disk, and that is not belt-and-braces — it is the fix for silent
// mis-billing. A generation outlives the app: it keeps running on BytePlus across a
// quit, a crash and an auto-update. This map used to live only in memory, so any
// restart between "task created" and "task reported" lost the attribution, and the row
// still landed in usage_log — just with a blank project. Nothing errored, nothing was
// logged; the usage simply stopped belonging to anyone.
// Measured 2026-08-11: cgt-20260811142046-7zfj4 and -8tlnn (one send, output_count 2)
// reported ~68 minutes after creation with an empty project, while sends from six
// minutes later reported "TA Test" correctly — the batch boundary is the restart.
const taskToProject = new Map<string, string>();
// Same directory CACHE_DIR resolves to further down (userData/media-cache in the packaged
// app), resolved independently because that constant is declared inside startServer().
const TASK_PROJECT_DIR = process.env.MEDIA_CACHE_DIR || path.join(process.cwd(), 'media-cache');
const TASK_PROJECT_FILE = path.join(TASK_PROJECT_DIR, 'task-project.json');
// Entries are dropped when the task is reported. This TTL only catches the leftovers —
// tasks that failed, expired, or were abandoned — so the file can't grow forever.
const TASK_PROJECT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const taskProjectAt = new Map<string, number>();

function loadTaskProjects() {
  try {
    const raw = JSON.parse(fs.readFileSync(TASK_PROJECT_FILE, 'utf8')) as Record<string, { project: string; at: number }>;
    const now = Date.now();
    let kept = 0;
    for (const [id, v] of Object.entries(raw || {})) {
      if (!v?.project || now - (v.at || 0) > TASK_PROJECT_TTL_MS) continue;
      taskToProject.set(id, v.project);
      taskProjectAt.set(id, v.at);
      kept++;
    }
    if (kept) console.log(`[Tracker] restored ${kept} task→project mapping(s) from disk`);
  } catch { /* 없거나 깨졌으면 빈 상태로 시작 — 이 파일은 캐시지 원장이 아니다 */ }
}

// Writes are tiny (a few dozen short strings) and rare (one per task create / report),
// so this stays synchronous: a debounce would reintroduce the exact hole it fixes —
// a task created seconds before the app quits is precisely the one that needs the write.
function saveTaskProjects() {
  try {
    const out: Record<string, { project: string; at: number }> = {};
    for (const [id, project] of taskToProject) out[id] = { project, at: taskProjectAt.get(id) || Date.now() };
    if (!fs.existsSync(TASK_PROJECT_DIR)) fs.mkdirSync(TASK_PROJECT_DIR, { recursive: true });
    fs.writeFileSync(TASK_PROJECT_FILE, JSON.stringify(out));
  } catch (e: any) {
    console.warn('[Tracker] task→project 저장 실패:', e?.message);
  }
}
loadTaskProjects();

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

// Where a user is told to go when a key is missing depends entirely on which platform
// they are on: Windows machines get their keys from the team's .bat files, Mac runs from
// source and reads a .env. Telling a Mac user to run "F:\api key\R2.bat" is worse than
// saying nothing — it sends them looking for a drive that does not exist.
const KEY_HELP = process.platform === 'win32'
  ? '  F:\\api key\\R2.bat 을 실행한 뒤 앱을 다시 켜세요.'
  : '  프로젝트 폴더의 .env 파일에 값을 채우세요. (맥_실행_가이드.md 참고)';

async function startServer() {
  if (!API_KEY) {
    console.error('\n  [ERROR] SEEDANCE_API_KEY 가 설정되지 않았습니다.');
    console.error(KEY_HELP + '\n');
    process.exit(1);
  }
  if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) {
    console.error('\n  [ERROR] R2_* 환경변수가 설정되지 않았습니다.');
    console.error(KEY_HELP);
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
      res.on('close', () => { if (!res.writableEnded) { try { upstreamController.abort(); } catch {} } });

      // Pump the web-stream reader MANUALLY to the client. Two constraints must both hold:
      //  1) FULL SPEED — `Readable.fromWeb(response.body).pipe(res)` throttles to ~70KB/s (a
      //     pathology in the web-stream → http.ServerResponse backpressure adapter). Manual
      //     `reader.read()` + `res.write()` avoids that adapter entirely → ~4MB/s.
      //  2) PROGRESSIVE — bytes must start flowing immediately. Buffering the whole file first
      //     (`await response.arrayBuffer()`) delayed the FIRST byte until the entire upstream
      //     download finished. Under Electron `webContents.downloadURL`, the response headers
      //     then arrived only at the very end, so `will-download` never fired early → no progress
      //     gauge, and large/slow videos timed out mid-wait → download silently failed.
      // Manual streaming satisfies both: full speed AND first byte out immediately.
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise<void>(resolve => res.once('drain', () => resolve()));
        }
      }
      res.end();
    } catch (error: any) {
      console.error('[Download] fetch error:', error.message);
      if (!res.headersSent) res.status(500).json({ error: error.message });
      else { try { res.end(); } catch {} }
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
  //
  // ★ "Reused" is not the same as "still referenced by the history", and for two months
  // this pruner could not tell the difference. Looking at an old message shows the 80px
  // thumbnail stored ON the message — media-cache is never read, so nothing is touched,
  // so the original ages out while the message that needs it sits right there.
  // Measured on the real library before the fix (2026-07-31): 199 files / 1.76GB, of which
  // 162 were referenced by NOTHING, while 68 of the 105 originals the message history does
  // reference had already been deleted. It was keeping the junk and dropping the record.
  // The fix is /api/cache/keep below: the client tells us, once per launch, which ids the
  // history still points at, and those get their clock reset. Unreferenced staging files
  // still age out exactly as before.
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
  // 100mb was below what the app itself accepts: BytePlus allows video up to 200MB and
  // validateVideoFile() lets it through, so a 100–200MB clip passed client validation and
  // then died here with a 413 whose body is HTML — cacheFile() did res.json() on that and
  // threw a parse error instead of anything actionable. Reported from the field and
  // reproduced with a 114.9MB clip. 220mb leaves headroom over the 200MB asset cap.
  app.post('/api/cache', express.raw({ type: '*/*', limit: '220mb' }), (req, res) => {
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

  // Keep-alive for everything the message history still points at. The client posts the
  // full id set once per launch (see App.tsx), so an original stays as long as the app is
  // opened at least once every 30 days — which is what "내 기록" should mean.
  // Deliberately NOT a "protected" list on disk: mtime is already the pruner's clock, and
  // a second source of truth would be one more thing to keep in sync with reality.
  app.post('/api/cache/keep', (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
      let touched = 0, missing = 0;
      for (const raw of ids) {
        // Ids come from persisted state, so treat them as untrusted input: basename()
        // keeps a crafted "../../" from reaching outside the cache directory.
        const id = path.basename(String(raw || ''));
        if (!id) continue;
        const fp = path.join(CACHE_DIR, id);
        if (fs.existsSync(fp)) { touchCache(fp); touched++; } else missing++;
      }
      console.log(`[Cache] keep-alive: ${touched} refreshed, ${missing} already gone`);
      res.json({ ok: true, touched, missing });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── Disaster-recovery backup, over HTTP ─────────────────────────────────────
  // The Windows app mirrors its state to Documents\Freewill Seedance Backup via Electron
  // IPC. In a browser there is no IPC, so that mirror did nothing at all — and a browser
  // was the ONLY thing holding those projects. Clear site data, or let a browser evict
  // storage under pressure, and the work was gone with no second copy anywhere.
  // These routes are the same four operations the IPC handlers expose, so the client can
  // keep one code path and just swap the transport. Same directory, same filenames, same
  // atomic write — a backup written on one platform restores on the other.
  const BACKUP_DIR = path.join(os.homedir(), 'Documents', 'Freewill Seedance Backup');
  const BACKUP_PATH = path.join(BACKUP_DIR, 'seedance-backup.json');
  const ELEMENTS_BACKUP_PATH = path.join(BACKUP_DIR, 'seedance-elements.json');
  const LEGACY_COMBINED_PATH = path.join(BACKUP_DIR, 'seedance-backup-combined-legacy.json');
  const ELEMENTS_MANIFEST_PATH = path.join(BACKUP_DIR, 'seedance-elements-manifest.json');
  const elementsChunkPath = (i: number) => path.join(BACKUP_DIR, `seedance-elements-${String(i).padStart(3, '0')}.json`);
  const STATE_RESTORE_MAX = 150 * 1024 * 1024;
  const ELEMENTS_RESTORE_MAX = 150 * 1024 * 1024;

  function writeAtomic(target: string, content: string) {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);   // atomic: a power cut can't leave a half-written backup
  }

  // ★ Shrink guard — the browser half of it. Mirrored in electron/main.cjs, which writes
  // the SAME file over IPC and never goes through this server; a guard in one place only
  // protects one of the two writers. Keep the two copies in step.
  // Why it exists: this route is what gave a browser the ability to write this file at all
  // (26.8.305). A browser profile has its own IndexedDB, so an empty one legitimately
  // reaches here and replaces the entire work history with a fresh-install state.
  // Measured 2026-08-03: 19.54MB / 18 projects / 503 messages → 440 bytes.
  // Archive rather than refuse — deleting old projects is legitimate shrinkage and is
  // exactly what the state-too-large toast asks the user to do.
  const SHRINK_FLOOR = 1 * 1024 * 1024;
  const SHRINK_RATIO = 0.5;
  const AUTOPREV_KEEP = 3;
  function guardShrink(target: string, content: string) {
    try {
      if (!fs.existsSync(target)) return;
      const oldSize = fs.statSync(target).size;
      if (oldSize < SHRINK_FLOOR) return;
      if (content.length >= oldSize * SHRINK_RATIO) return;
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
      // Distinct prefix so the prune can only delete copies this guard made.
      fs.copyFileSync(target, target.replace(/\.json$/, `.AUTOPREV-${stamp}.json`));
      console.warn(`[Backup] shrink guard: ${(oldSize / 1048576).toFixed(2)}MB → ${(content.length / 1048576).toFixed(2)}MB — previous copy kept`);
      const base = path.basename(target).replace(/\.json$/, '');
      const olds = fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(`${base}.AUTOPREV-`) && f.endsWith('.json'))
        .sort();
      for (const f of olds.slice(0, Math.max(0, olds.length - AUTOPREV_KEEP))) {
        try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
      }
    } catch { /* a guard must never be the thing that breaks the save */ }
  }

  // Raw, not express.json(): this is a 20MB+ JSON string and re-parsing it here only to
  // stringify it back out would double the memory for nothing.
  app.post('/api/backup/state', express.raw({ type: '*/*', limit: '400mb' }), (req, res) => {
    try {
      const content = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      if (!content) return res.status(400).json({ ok: false, error: 'empty content' });
      if (fs.existsSync(BACKUP_PATH) && !fs.existsSync(LEGACY_COMBINED_PATH)) {
        // First state-only write on this machine. Whatever is there predates the split and
        // may be the only copy of the library — move it aside rather than over it.
        try { fs.renameSync(BACKUP_PATH, LEGACY_COMBINED_PATH); } catch {}
      }
      // After the legacy rename: if that fired, BACKUP_PATH is gone and this is a no-op.
      guardShrink(BACKUP_PATH, content);
      writeAtomic(BACKUP_PATH, content);
      res.json({ ok: true, path: BACKUP_PATH, bytes: content.length });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.post('/api/backup/elements/:index', express.raw({ type: '*/*', limit: '80mb' }), (req, res) => {
    try {
      const index = Number(req.params.index);
      const total = Number(req.query.total);
      const count = Number(req.query.count) || 0;
      if (!Number.isInteger(index) || index < 0 || !Number.isInteger(total) || total <= 0) {
        return res.status(400).json({ ok: false, error: 'bad index/total' });
      }
      const content = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      writeAtomic(elementsChunkPath(index), content);
      if (index === total - 1) {
        // Manifest last — until it lands, a partial run is simply not a valid backup.
        writeAtomic(ELEMENTS_MANIFEST_PATH, JSON.stringify({ v: 2, chunks: total, count, savedAt: Date.now() }));
        for (let i = total; i < total + 40; i++) {
          try { if (fs.existsSync(elementsChunkPath(i))) fs.unlinkSync(elementsChunkPath(i)); } catch {}
        }
        try { if (fs.existsSync(ELEMENTS_BACKUP_PATH)) fs.unlinkSync(ELEMENTS_BACKUP_PATH); } catch {}
      }
      res.json({ ok: true, bytes: content.length });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/backup/elements/:index', (req, res) => {
    try {
      const f = elementsChunkPath(Number(req.params.index));
      if (!fs.existsSync(f)) return res.json({ ok: false, error: 'missing' });
      res.json({ ok: true, content: fs.readFileSync(f, 'utf8') });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  app.get('/api/backup/state', (_req, res) => {
    try {
      let p = BACKUP_PATH;
      if (!fs.existsSync(p)) p = LEGACY_COMBINED_PATH;
      if (!fs.existsSync(p)) return res.json({ ok: true, content: null });
      // A pre-split backup is state AND library in one file. Reading that whole thing at
      // startup is what used to kill the app — booting empty and saying so is better.
      const stateSize = fs.statSync(p).size;
      if (stateSize > STATE_RESTORE_MAX) {
        console.warn(`[Backup] ${p} is ${(stateSize / 1048576).toFixed(0)}MB — too large to load safely; skipping.`);
        return res.json({ ok: true, content: null, stateSkipped: true, stateBytes: stateSize, path: p });
      }
      const content = fs.readFileSync(p, 'utf8');
      let elementsChunks = 0, elementsCount = 0;
      try {
        if (fs.existsSync(ELEMENTS_MANIFEST_PATH)) {
          const man = JSON.parse(fs.readFileSync(ELEMENTS_MANIFEST_PATH, 'utf8'));
          if (man && man.chunks > 0) { elementsChunks = man.chunks; elementsCount = man.count || 0; }
        }
      } catch (e: any) { console.warn('[Backup] manifest unreadable:', e.message); }
      let elements: string | null = null, elementsBytes = 0, elementsSkipped = false;
      if (!elementsChunks) {
        try {
          if (fs.existsSync(ELEMENTS_BACKUP_PATH)) {
            elementsBytes = fs.statSync(ELEMENTS_BACKUP_PATH).size;
            if (elementsBytes <= ELEMENTS_RESTORE_MAX) elements = fs.readFileSync(ELEMENTS_BACKUP_PATH, 'utf8');
            else elementsSkipped = true;
          }
        } catch (e: any) { console.warn('[Backup] elements file unreadable:', e.message); }
      }
      res.json({ ok: true, content, elements, elementsBytes, elementsSkipped, elementsChunks, elementsCount,
                 elementsPath: ELEMENTS_BACKUP_PATH, path: p, bytes: content.length });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
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

  // Project list proxy → GAS tracker. Server-side so the Electron renderer never
  // calls GAS directly (avoids CORS/redirect surprises; matches how the credit
  // POST already goes through the server). Returns { ok, projects:[{project,status,…}] }.
  // On any failure returns 200 + { ok:false, projects:[] } so the client can tell
  // "couldn't fetch" (keep current selection) from "fetched, list is empty".
  // ★ 25s cap. There was no timeout here at all, and Apps Script does not fail fast:
  // measured 2026-08-05, a cold /exec sat for 127 SECONDS and then answered 404 with an
  // HTML error page (warm, the same call is 2s). Without a cap this handler held the
  // renderer's fetch open for that whole time. Giving up early costs nothing — the cold
  // call warms the container even when it errors, so the client's retry lands fast.
  // ── Model grant, server side ────────────────────────────────────────────────
  // The client already blocks an ungranted model before it sends, and that block is what
  // the user actually sees. This is the copy that decides, because everything the client
  // bases its answer on survives on disk and can be edited there: the roster is persisted
  // in IndexedDB and settings.model is stored per project. A permission enforced only in
  // the UI is a convention, and this one decides who spends 2.5 credit.
  // The roster is shared with the 60s /api/projects poll rather than fetched per send —
  // a GAS round-trip on the send path would put the tracker's cold-start latency (measured
  // at 127s) in front of every generation.
  let rosterAt = 0;
  let rosterRows: any[] | null = null;
  const ROSTER_TTL_MS = 30000;   // the client polls every 60s, so this adds no visible lag
  const rememberRoster = (rows: any[]) => { rosterRows = rows; rosterAt = Date.now(); };

  async function getRoster(): Promise<any[] | null> {
    if (rosterRows && Date.now() - rosterAt < ROSTER_TTL_MS) return rosterRows;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const r = await fetch(`${TRACKER_URL}?action=projects`, { redirect: 'follow', signal: ac.signal });
      const data: any = JSON.parse(await r.text());
      if (data?.ok === true && Array.isArray(data.projects)) rememberRoster(data.projects);
    } catch { /* fall through to whatever we already hold */ } finally { clearTimeout(timer); }
    // A tracker hiccup keeps honouring the last good roster — locking everyone out of a
    // model they were granted because Apps Script blinked would be worse than a stale
    // answer that self-corrects within 30s. Only a cold start with no roster at all is
    // fail-closed, and that is a 503 the user can retry, not a denial.
    return rosterRows;
  }

  app.get('/api/projects', async (_req, res) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      const r = await fetch(`${TRACKER_URL}?action=projects`, { redirect: 'follow', signal: ac.signal });
      const text = await r.text();
      let data: any;
      // A non-JSON body is the tracker failing, not an empty roster — keep them distinct.
      try { data = JSON.parse(text); } catch { data = { ok: false, projects: [], error: `tracker returned ${r.status} (non-JSON)` }; }
      if (data?.ok === true && Array.isArray(data.projects)) rememberRoster(data.projects);
      res.json(data);
    } catch (error: any) {
      const aborted = error?.name === 'AbortError';
      res.json({ ok: false, projects: [], error: aborted ? 'tracker timeout (25s)' : (error?.message || 'fetch failed') });
    } finally {
      clearTimeout(timer);
    }
  });

  // ── Gemini Omni Flash — video generation proxy (separate provider) ──────────
  // Uses NANOBANANA_STUDIO_KEY (Google AI Studio). The Interactions create call is
  // SYNCHRONOUS (~30-40s for a 720p clip) and returns the video inline as base64
  // (720p clips run ~1-3MB, under the 4MB uri threshold). We cache the bytes as an
  // .mp4 and hand back a served /api/cache URL, so the chat message stores a small
  // string rather than a multi-MB base64 data URL → no IndexedDB bloat. The
  // frontend builds the full Omni payload; this only injects the key + normalizes
  // the response. Entirely independent of the BytePlus path.
  // Resumable upload of a media buffer to the Gemini Files API → returns the file uri
  // once ACTIVE (used for the Edit task's source video, which must be a Files API ref).
  async function uploadToFilesApi(buf: Buffer, mime: string, key: string): Promise<string | null> {
    const start = await fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(buf.length),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: 'omni-edit-src' } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) { console.warn('[Gemini] Files start failed', start.status); return null; }
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0', 'Content-Length': String(buf.length) },
      body: buf,
    });
    const upJson: any = await up.json().catch(() => ({}));
    const file = upJson.file || upJson;
    if (!file?.name) { console.warn('[Gemini] Files upload failed', up.status); return null; }
    let state = file.state || '';
    for (let i = 0; i < 40 && state !== 'ACTIVE'; i++) {
      const fr = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } });
      const fd: any = await fr.json().catch(() => ({}));
      state = fd?.state || '';
      if (state === 'FAILED') { console.warn('[Gemini] source file FAILED'); return null; }
      if (state !== 'ACTIVE') await new Promise((r) => setTimeout(r, 3000));
    }
    return state === 'ACTIVE' ? file.uri : null;
  }

  app.post('/api/gemini/generate', async (req, res) => {
    const KEY = process.env.NANOBANANA_STUDIO_KEY;
    if (!KEY) { console.error('[Gemini] NANOBANANA_STUDIO_KEY not set'); return res.status(500).json({ error: 'NANOBANANA_STUDIO_KEY가 설정되지 않았습니다.' }); }
    console.log('[Gemini] Omni generate...');
    try {
      const body: any = req.body && typeof req.body === 'object' ? req.body : {};
      // Resolve inline-uploaded media (Edit source video) → Files API uri, since the
      // resumable upload needs the server-held key. The client marks the video part
      // with `_uploadCacheId` (preferred — server reads the bytes straight off the
      // media-cache disk, no base64 over the wire) or `_uploadData` (base64 fallback).
      if (Array.isArray(body.input)) {
        for (const part of body.input) {
          if (!part || typeof part !== 'object') continue;
          const cacheRef = part._uploadCacheId; const dataRef = part._uploadData;
          if (cacheRef || dataRef) {
            let buf: Buffer | null = null;
            if (cacheRef) {
              const safe = String(cacheRef).replace(/[^a-zA-Z0-9._-]/g, '');
              const p = path.join(CACHE_DIR, safe);
              if (safe && fs.existsSync(p)) buf = fs.readFileSync(p);
            } else if (dataRef) {
              buf = Buffer.from(dataRef, 'base64');
            }
            if (!buf) return res.status(502).json({ error: '소스 영상을 찾지 못했습니다 (캐시 유실 — 다시 올려주세요).' });
            const uri = await uploadToFilesApi(buf, part.mime_type || 'video/mp4', KEY);
            if (!uri) return res.status(502).json({ error: '소스 영상 업로드 실패 (Files API)' });
            part.uri = uri;
          }
          // Always strip the private upload markers so they never reach the API.
          delete part._uploadData; delete part._uploadCacheId;
        }
      }
      // Edit derives duration/aspect from the source video — the API 400s if either is set.
      if (body?.generation_config?.video_config?.task === 'edit' && body.response_format) {
        delete body.response_format.duration;
        delete body.response_format.aspect_ratio;
      }
      // Synchronous unary generation (doc's recommended fast path). store MUST be true —
      // the API rejects delivery:"uri" (which we always use) unless store=true, so store=false
      // from the doc's perf tip is NOT usable here. background/stream=false = plain sync call.
      body.background = false;
      body.stream = false;
      body.store = true;
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify(body),
      });
      const text = await r.text();
      let data: any; try { data = JSON.parse(text); } catch { return res.status(r.status).json({ error: `Gemini 응답 파싱 실패 (${r.status})` }); }
      if (!r.ok) {
        const msg = data?.error?.message || (Array.isArray(data) && data[0]?.error?.message) || `Gemini 오류 (${r.status})`;
        console.warn('[Gemini] error', r.status, msg);
        return res.status(r.status).json({ error: msg });
      }
      let vid: any = null;
      for (const s of (data.steps || [])) for (const c of (s.content || [])) if (c.type === 'video') vid = c;
      if (!vid) return res.status(502).json({ error: '영상 출력을 찾지 못했습니다.' });
      let buf: Buffer;
      if (vid.data) {
        // Inline base64 (small videos)
        buf = Buffer.from(vid.data, 'base64');
      } else if (vid.uri) {
        // delivery:"uri" (>4MB / all sizes) — poll the Files API until ACTIVE, then download with the key.
        const fileId = (String(vid.uri).match(/files\/([^:?/]+)/) || [])[1];
        if (!fileId) return res.status(502).json({ error: '영상 파일 ID 파싱 실패' });
        let state = '';
        for (let i = 0; i < 40; i++) {
          const fr = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${fileId}`, { headers: { 'x-goog-api-key': KEY } });
          const fd: any = await fr.json().catch(() => ({}));
          state = fd?.state || '';
          if (state === 'ACTIVE') break;
          if (state === 'FAILED') return res.status(502).json({ error: '영상 파일 처리 실패(FAILED)' });
          await new Promise((r) => setTimeout(r, 3000));
        }
        if (state !== 'ACTIVE') return res.status(504).json({ error: '영상 파일 처리 시간 초과' });
        const dl = await fetch(`https://generativelanguage.googleapis.com/v1beta/files/${fileId}:download?alt=media`, { headers: { 'x-goog-api-key': KEY } });
        if (!dl.ok) return res.status(502).json({ error: `영상 다운로드 실패 (${dl.status})` });
        buf = Buffer.from(await dl.arrayBuffer());
      } else {
        return res.status(502).json({ error: '영상 출력(data/uri)이 비어 있습니다.' });
      }
      const cacheId = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12) + '.mp4';
      const cachePath = path.join(CACHE_DIR, cacheId);
      if (!fs.existsSync(cachePath)) fs.writeFileSync(cachePath, buf);
      console.log(`[Gemini] ok — interaction ${data.id}, ${(buf.length / 1048576).toFixed(2)}MB → ${cacheId}`);
      res.json({ id: data.id, status: data.status || 'completed', videoUrl: `/api/cache/${cacheId}`, usage: data.usage });
    } catch (error: any) { console.error('[Gemini] fetch error', error.message); res.status(500).json({ error: error.message }); }
  });

  // BytePlus API — Create Task
  app.post('/api/byteplus/tasks', async (req, res) => {
    console.log('[BytePlus API] Creating task...');

    // Pull the app-only `project` (billing/tracking) out — BytePlus must never
    // receive it (unknown top-level fields can 400). The rest is forwarded as-is.
    const { project: billingProject, ...byteplusBody } = (req.body && typeof req.body === 'object') ? req.body : {};

    // Gated models (2.5) must be granted to the SELECTED billing project. Checked here,
    // against the tracker, so no amount of switching app projects / models / stored state
    // gets a request through.
    const grant = MODEL_GRANTS[byteplusBody.model as string];
    if (grant) {
      const roster = await getRoster();
      if (!roster) {
        return res.status(503).json({ error: { message: '크레딧 시트를 확인할 수 없어 이 모델을 사용할 수 없습니다. 잠시 후 다시 시도해주세요.' } });
      }
      const row = roster.find((p: any) => String(p?.project) === String(billingProject));
      if (row?.[grant] !== true) {
        console.warn(`[Grant] blocked ${byteplusBody.model} for project "${billingProject}" (${grant}=${row?.[grant]})`);
        return res.status(403).json({ error: { message: `"${billingProject || '선택 없음'}" 프로젝트는 이 모델 권한이 없습니다.` } });
      }
    }

    try {
      const response = await fetch('https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
        body: JSON.stringify(byteplusBody)
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

      // Remember which billing project this task belongs to (read at report time).
      if (response.ok && data?.id && typeof billingProject === 'string' && billingProject) {
        taskToProject.set(data.id, billingProject);
        taskProjectAt.set(data.id, Date.now());
        saveTaskProjects();   // 재시작을 넘겨야 하므로 만든 즉시 디스크에 남긴다
        console.log(`[Tracker] task ${data.id} → project "${billingProject}"`);
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
            project: taskToProject.get(req.params.id) || '', // billing project (may be '')
            task_id: req.params.id,
            total_tokens: data.usage.total_tokens,
            completion_tokens: data.usage.completion_tokens,
            // Sent but NOT currently logged: the tracker deliberately drops these to keep
            // usage_log thin (it's past 20k rows and gets fully re-read every 30 min).
            // Costs a few bytes here and means turning resolution breakdown back on is a
            // one-line change in the Apps Script, with no app redeploy. BytePlus echoes
            // both on the succeeded response — verified 2026-07-27.
            resolution: data.resolution || '',
            model: data.model || '',
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
        // Drop the mapping only once the report above has actually gone out. The old code
        // deleted on ANY terminal status, but the report needs `usage.total_tokens` too —
        // so a `succeeded` that arrived a moment before usage was populated threw the
        // project away, and the next poll (10s later) reported it with a blank project.
        // A failed/expired task is never reported at all, so it leaves nothing to read;
        // those entries are cleaned up by the TTL prune at startup instead.
        if (reportedTasks.has(req.params.id) && taskToProject.delete(req.params.id)) {
          taskProjectAt.delete(req.params.id);
          saveTaskProjects();
        }
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
