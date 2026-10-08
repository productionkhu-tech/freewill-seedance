import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import https from 'https';
import { Readable } from 'node:stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
// Shared with the client store — see src/lib/model-access.ts for why these two facts
// live outside both files.
import { MODEL_GRANTS, brandOf } from './src/lib/model-access';
// 생성 결과물의 장기 보관소. R2(입력 임시 저장)와 역할이 겹치지 않는다 — ncp.ts 참고.
import {
  ensureNcp, initNcpIndex, initNcpQueue, enqueueArchive, drain as drainArchive,
  presignArchived, recoverFromHints, lookupArchived, archiveStats, pendingSource,
  backfillPosters,
  posterDir, localPosterPath, savePosterLocal,
  putPoster, presignPoster, hasPoster,
  presignPreview, previewState,
  lastNcpError, resetNcpBackoff,
  initC2paIndex, taskIdForC2pa,
} from './ncp';

dotenv.config();

// 키 · 주소는 쓸 때마다 process.env 에서 읽는다(26.10.802~). 설치본은 앱을 켤 때 게이트웨이(electron/gateway.cjs)에서
// 묶음을 받아 process.env 에 올리고, 켠 뒤 새 묶음이 오면 같은 실행 안에서 값이 바뀐다 — 상수로 잡아 두면 그 실행 내내 옛 키를 쓴다.
const apiKey = () => process.env.SEEDANCE_API_KEY || '';
const BP_BASE_DEFAULT = 'https://ark.ap-southeast.bytepluses.com/api/v3';
// 게이트웨이가 준 주소를 믿는 모양 — https, 또는 이 PC 안(http://127.0.0.1:포트 — 격리 시험의 가짜 서버). 그 밖이면 기본값.
// ★ 시험에서 가짜 주소가 기본값으로 떨어지면 진짜 시트 · 진짜 BytePlus 로 나간다 — 127.0.0.1 을 받는 이유.
const trustedUrl = (u: string) => /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u) || /^http:\/\/127\.0\.0\.1:\d+(\/[^\s]*)?$/.test(u);
// BytePlus 주소도 게이트웨이 값(SEEDANCE_BP_BASE)으로 옮길 수 있다(리전 이전 등).
const bpTasks = () => {
  const b = (process.env.SEEDANCE_BP_BASE || '').trim().replace(/\/+$/, '');
  return `${trustedUrl(b) ? b : BP_BASE_DEFAULT}/contents/generations/tasks`;
};
// BytePlus · R2 가 '키가 틀렸다' 고 하면 게이트웨이에서 한 번 다시 받아 본다 — 관리자가 Cloudflare 에서 키를 바꾼 직후
// 켜 둔 PC 가 멈추지 않게. 평소엔 켤 때만 받는다(사용자 결정 2026-10-08). 설치본에서만 있다(main.cjs 가 단다) —
// 개발 실행 · 맥 소스 실행에선 없고 false.
async function refreshKeys(reason: string): Promise<boolean> {
  const g = (globalThis as any).__seedanceGateway;
  if (!g || typeof g.refresh !== 'function') return false;
  try { const r = await g.refresh(reason); return !!(r && r.changed); } catch { return false; }
}

// ★ 2.5 Demo — 2026-08-14 종료. 별도 키(SEEDANCE_25_DEMO_KEY) · 별도 엔드포인트 ·
// 별도 계약으로 돌던 레인이었고, 키를 읽는 코드부터 모델 id, 요청 분기,
// /api/capabilities 게이트까지 전부 제거했다. 남은 것은 은퇴한 모델 id 를 정식 2.5 로
// 옮기는 매핑 하나뿐이다(src/lib/model-access.ts). 되살릴 일이 생기면 되돌리지 말고
// 새로 설계할 것 — 반쯤 남은 분기가 제일 위험하다.
const r2Endpoint = () => process.env.R2_ENDPOINT || '';
const r2KeyId = () => process.env.R2_ACCESS_KEY_ID || '';
const r2Secret = () => process.env.R2_SECRET_ACCESS_KEY || '';
const r2Bucket = () => process.env.R2_BUCKET || '';

// Credit tracker integration — POSTs token usage to a Google Apps Script endpoint
// when a task succeeds. The team name is derived from the SEEDANCE_API_KEY env var
// each user already has set via their team's .bat file: we hash the configured key
// and look it up against a baked-in SHA-256 map of the 13 official team keys.
//
// Why hashes and not the keys themselves? An EXE installed on one team member's PC
// would otherwise expose every other team's API key in the bundled server.cjs. With
// hashes only, the bundle reveals nothing useful — SHA-256 is one-way.
const TRACKER_URL_DEFAULT = 'https://script.google.com/macros/s/AKfycbyC53V4K-CHJnP86qIbBP0WmXZ4cDD9D3CFVmd8otL4ZThzpQ7RKhnCeIXgDu4y7CFrnQ/exec';
// 게이트웨이가 SEEDANCE_TRACKER_URL 을 주면 그걸 쓴다 — GAS 를 새로 배포해 주소가 바뀌어도 앱을 다시 내지 않는다.
const trackerUrl = () => {
  const u = (process.env.SEEDANCE_TRACKER_URL || '').trim();
  return trustedUrl(u) ? u : TRACKER_URL_DEFAULT;
};
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
  // AFX 를 3분야로 쪼개면서 발급한 키들(2026-09-09). 형식이 다르다 — 기존 13개는 맨
  // UUID 인데 이쪽은 'ark-' 접두어가 붙은 신형이다. 해시로만 대조하므로 형식은 상관없다.
  // 구 AFX 키는 남겨둔다: 그 bat 을 이미 돌려둔 PC 가 있고, 지우면 그 PC 들이 조용히
  // UNKNOWN 으로 넘어간다. 안 쓰기로 한 것과 못 쓰게 만드는 것은 다르다.
  '96c54e01db364d162ae628faaad0f5fc1a1dc8933b0b84defcd63bc910612a82': 'AFX_1팀',
  'be80455a50e2aeb7ecd5cab99a48fc68e2d248530b84ddf766531e2876af850e': 'AFX_2팀',
  'c66699dfb03aad9ec1de1f1d2feb315c379f8ec275bce43627aa26a3a3ba0973': 'AFX_3팀',
  'bd0900883cc308becf0fe4e8d629130acea5a59e26b4667bef6f9a861a0e6bbb': 'TA팀',
  '724cf3b6d22b122d01b371eb8e550ffe4053b5eef4731becd3684f5c72bf4d4d': 'Special팀',
  '0e43bc6b870b1d889724d6abe19cf23bda010114b780efcf0635e94964f1e117': 'AIP팀',
};
// 팀 이름 — 게이트웨이가 준 이름(SEEDANCE_TEAM_LABEL)이 먼저다. 게이트웨이는 출입증에 박힌 팀을 주므로 키를 재발급해도,
// 새 팀 키를 발급해도 앱을 고쳐 다시 내지 않아도 된다(예전엔 새 키 = 재배포 전까지 UNKNOWN). 게이트웨이를 못 거친
// 실행(개발 · 맥 · 처음 켰는데 게이트웨이가 안 닿음)은 예전처럼 키 해시 표로.
function teamName(): string {
  const label = (process.env.SEEDANCE_TEAM_LABEL || '').trim();
  if (label) return label;
  const k = apiKey();
  if (!k) return 'UNKNOWN';
  return TEAM_KEY_HASHES[crypto.createHash('sha256').update(k).digest('hex')] || 'UNKNOWN';
}
const reportedTasks = new Set<string>();

// 트래커에 "우리 앱이 맞다" 고 증명하는 서명.
//
// 왜 필요한가: 이 URL 은 공개 저장소에 적혀 있고 익명 공개였다. 아무나 열면 고객사
// 21곳 이름과 누적 사용량이 보였고(2026-09-09 확인), 가짜 사용량도 넣을 수 있었다.
//
// 비밀은 R2 키에서 한 번 더 유도한 값이다. R2 키 원본을 GAS 스크립트 속성에 두면
// 그쪽이 새는 순간 R2 까지 열린다 — 유도값은 되돌릴 수 없으니 GAS 가 털려도 R2 는
// 안전하다. 그리고 이 값은 모든 PC 가 이미 가진 R2 키에서 스스로 만들 수 있어서,
// 14개 팀에 새로 뿌릴 비밀이 없다(bat 을 안 고쳐도 된다).
//
// 키 자체는 절대 나가지 않는다. 나가는 것은 타임스탬프와 그 서명뿐이고, GAS 는
// 5분 창 안의 서명만 받는다 — 하나를 주워도 오래 못 쓴다.
//
// 26.10.802~ 게이트웨이가 이 값을 그대로 내려준다(SEEDANCE_TRACKER_SECRET) — 처음 한 번 박아 둔 값이라 R2 키를 바꿔도
// 시트 기록이 안 끊긴다(예전엔 R2 키를 바꾸는 순간 서명이 달라져 시트가 거절했다). 없으면 예전처럼 R2 키에서.
function trackerSecret(): string {
  const fromGateway = process.env.SEEDANCE_TRACKER_SECRET || '';
  if (fromGateway) return fromGateway;
  const r = r2Secret();
  return r ? crypto.createHmac('sha256', r).update('seedance-tracker-v1').digest('hex') : '';
}
function trackerAuth(): { ts: string; proof: string } | null {
  const secret = trackerSecret();
  if (!secret) return null;
  const ts = String(Math.floor(Date.now() / 1000));
  return { ts, proof: crypto.createHmac('sha256', secret).update('tracker:' + ts).digest('hex') };
}
// GET 은 쿼리로, POST 는 본문으로 같은 값을 싣는다.
function signedTrackerUrl(base: string): string {
  const a = trackerAuth();
  return a ? `${base}&ts=${a.ts}&proof=${a.proof}` : base;
}

// Map: BytePlus task id → billing/tracking project (from the app's dropdown).
// project 는 보낼 때의 이름(NCP 폴더 이름으로도 쓴다), projectId 는 PM 프로그램(POS)의 영구 ID —
// 트래커는 projectId 로 프로젝트를 찾아 '지금 이름' 으로 기록한다. 트래커 전용 프로젝트는 ''.
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
type TaskProject = { project: string; projectId: string };
const taskToProject = new Map<string, TaskProject>();
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
    // 옛 모양({ project, at })도 읽는다 — 업데이트 순간 진행 중이던 작업의 보고가 프로젝트를
    // 잃지 않게. 그때는 projectId 가 '' 이고, 트래커는 이름으로 찾는다.
    const raw = JSON.parse(fs.readFileSync(TASK_PROJECT_FILE, 'utf8')) as Record<string, { project?: string; projectId?: string; at: number }>;
    const now = Date.now();
    let kept = 0;
    for (const [id, v] of Object.entries(raw || {})) {
      if ((!v?.project && !v?.projectId) || now - (v.at || 0) > TASK_PROJECT_TTL_MS) continue;
      taskToProject.set(id, { project: String(v.project || ''), projectId: typeof v.projectId === 'string' ? v.projectId : '' });
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
    const out: Record<string, { project: string; projectId: string; at: number }> = {};
    for (const [id, t] of taskToProject) out[id] = { project: t.project, projectId: t.projectId, at: taskProjectAt.get(id) || Date.now() };
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
  if (!apiKey()) {
    console.error('\n  [ERROR] SEEDANCE_API_KEY 가 설정되지 않았습니다.');
    console.error(KEY_HELP + '\n');
    process.exit(1);
  }
  if (!r2Endpoint() || !r2KeyId() || !r2Secret() || !r2Bucket()) {
    console.error('\n  [ERROR] R2_* 환경변수가 설정되지 않았습니다.');
    console.error(KEY_HELP);
    console.error('  필요한 변수: R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET\n');
    process.exit(1);
  }
  console.log(`[Tracker] Resolved team: ${teamName()}`);

  // R2 (S3-compatible) client. forcePathStyle: true so presigned URLs come out as
  // https://{account}.r2.cloudflarestorage.com/{bucket}/{key}?... — predictable for
  // extractR2Key below and the format Cloudflare recommends.
  // 게이트웨이가 실행 중에 R2 값을 바꾸면(관리자가 키 · 주소를 바꿈) 다음 호출부터 새 클라이언트로.
  let r2Cache: { sig: string; client: S3Client } | null = null;
  const r2 = (): S3Client => {
    const sig = `${r2Endpoint()}|${r2KeyId()}|${r2Secret()}`;
    if (!r2Cache || r2Cache.sig !== sig) {
      r2Cache = {
        sig,
        client: new S3Client({
          region: 'auto',
          endpoint: r2Endpoint(),
          credentials: { accessKeyId: r2KeyId(), secretAccessKey: r2Secret() },
          forcePathStyle: true,
        }),
      };
    }
    return r2Cache.client;
  };
  // R2 가 '키가 틀렸다' 고 했나 — 게이트웨이에서 다시 받아 한 번만 다시 해 본다.
  const r2AuthError = (e: any) => /InvalidAccessKeyId|SignatureDoesNotMatch|InvalidToken|AccessDenied/.test(String(e?.name || e?.Code || '')) || e?.$metadata?.httpStatusCode === 403;

  const r2Hostname = () => {
    try { return new URL(r2Endpoint()).hostname; } catch { return ''; }
  };

  function isR2Url(url: string): boolean {
    try { return new URL(url).hostname === r2Hostname(); } catch { return false; }
  }

  // Pulls the object key from a path-style R2 URL.
  // Returns null for anything that isn't a /{bucket}/{key} layout.
  function extractR2Key(url: string): string | null {
    try {
      const u = new URL(url);
      const prefix = `/${r2Bucket()}/`;
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
      r2().send(new DeleteObjectCommand({ Bucket: r2Bucket(), Key: key }))
        .then(() => console.log(`[R2] deleted ${key}`))
        .catch(err => console.warn(`[R2] delete failed for ${key}:`, err.message));
    }
  }

  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  // ★ 다른 출처에서 온 요청은 서버가 거절한다(26.10.301~). 예전에는 cors() 로 아무 웹사이트나 이 로컬 API 를
  //   부를 수 있었다(같은 PC 브라우저에 열린 페이지가 기록을 읽고 · 파일을 쓰고 · 지울 수 있었다). CORS 헤더만
  //   빼면 '응답을 못 읽게' 될 뿐 요청 자체는 실행되므로(단순 POST 는 미리 묻지도 않는다) 여기서 끊는다.
  //   - Origin 이 붙어 오면 이 서버 자신(localhost · 127.0.0.1 + 같은 포트)이어야 한다. 앱 화면이 그렇다.
  //   - Sec-Fetch-Site 가 cross-site · same-site 면 거절(다른 사이트가 <img> · <form> 으로 부르는 경우).
  //   - 둘 다 없으면 통과 — Electron 메인 프로세스의 fetch, 주소창 직접 입력(none), curl 같은 같은 PC 도구.
  const SELF_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const site = String(req.headers['sec-fetch-site'] || '');
    if ((origin && !SELF_ORIGINS.has(origin)) || site === 'cross-site' || site === 'same-site') {
      console.warn(`[Security] 다른 출처의 요청을 거절: ${req.method} ${req.path} (origin=${origin || '-'}, site=${site || '-'})`);
      return res.status(403).json({ error: 'cross-origin request refused' });
    }
    next();
  });
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

  // ── 어셋 라이브러리 원본 (26.9.3001~) ────────────────────────────────────────
  // 라이브러리 이미지의 원본 바이트는 여기에 파일로 한 번만 둔다. 이름 = 내용 md5 앞 12자리 + 확장자
  // (media-cache 의 cacheId 와 같은 꼴) — 같은 그림은 컬렉션이 몇 개든 파일 하나다.
  // 예전에는 원본을 base64 로 화면(렌더러) 메모리에 통째로 들고 있었다. 2026-09-28 에 112개가
  // 1.38GB 였고, 백업이 돌 때마다 그걸 한 벌 더 만들다 렌더러가 죽었다(최대 5.5GB).
  // ★ media-cache 와 다른 폴더인 이유: 거기는 30일 프루너·"캐시 비우기" 가 통째로 지운다.
  //   이 폴더는 아무도 자동으로 지우지 않는다. 원본이 사는 유일한 곳이기 때문이다.
  // ★ 전송·복사·공유 팩은 언제나 이 원본 바이트 그대로 나간다. preview/ 의 JPG 는 화면용일 뿐이다.
  const LIB_DIR = process.env.ELEMENT_LIBRARY_DIR || path.join(process.cwd(), 'element-library');
  const LIB_PREVIEW_DIR = path.join(LIB_DIR, 'preview');
  fs.mkdirSync(LIB_PREVIEW_DIR, { recursive: true });
  console.log(`[Library] Using ${LIB_DIR}`);

  // ★ media-cache 에는 캐시 파일만 있는 게 아니다. 앱의 작은 원장 네 개가 같이 산다.
  //   30일 프루너와 "캐시 비우기" 버튼은 디렉터리를 통째로 훑어 지우기 때문에, 막아두지
  //   않으면 이것들까지 함께 사라진다. 각각 잃었을 때 실제로 일어나는 일:
  //     task-project.json       크레딧 사용량이 어느 프로젝트 것인지 몰라진다
  //     element-pack-index.json 만료된 R2 공유 팩을 영영 못 지운다 (용량 누수)
  //     media-index.json        taskId → NCP 객체 위치를 잃는다
  //     ncp-archive-queue.json  아직 못 올린 영상을 잊는다 → 24시간 뒤 조용히 유실
  //     ncp-archive-dead.json   만료된 링크를 매 실행마다 다시 두드린다
  //   캐시 파일(영상·이미지 사본)은 지워도 NCP 가 받쳐주지만, 이 원장들은 대체물이 없다.
  const CONTROL_FILES = new Set([
    'task-project.json',
    'element-pack-index.json',
    'media-index.json',
    'ncp-archive-queue.json',
    'ncp-archive-dead.json',
    // 영상 안 C2PA 고유번호 → taskId(26.10.801~, ncp.ts). 영상 사본이 30일 뒤 지워져도 이름 바꾼 옛 영상을 찾는 단서.
    'c2pa-index.json',
  ]);

  initNcpIndex(CACHE_DIR);
  initNcpQueue(CACHE_DIR);
  initC2paIndex(CACHE_DIR);

  // ★ NCP 는 R2 와 같은 급의 필수 의존성으로 취급한다 — 없으면 앱이 켜지지 않는다.
  //
  // 없어도 "생성"은 멀쩡히 되기 때문에 게이트가 없으면 위험하다. R2.bat 을 안 돌린 PC,
  // 옛 R2 키가 남은 PC, 시계가 틀어진 PC 는 아무 경고 없이 잘 돌아가는 것처럼 보이다가
  // 24시간 뒤에 그날 만든 영상이 통째로 사라진다. 그때는 손쓸 방법이 없다.
  // 켜지지 않는 쪽이 조용히 유실되는 쪽보다 낫다.
  //
  // 대신 한 번 실패로 막지는 않는다. R2 검사와 달리 이건 네트워크를 타므로 순간적인
  // 실패가 있을 수 있어, 3초 간격으로 세 번 더 시도한 뒤에 포기한다.
  {
    let ncpOk = await ensureNcp();
    for (let i = 1; i <= 3 && !ncpOk; i++) {
      console.log(`  [NCP] 보관소 연결 재시도 ${i}/3...`);
      await new Promise(r => setTimeout(r, 3000));
      resetNcpBackoff();
      ncpOk = await ensureNcp();
    }
    if (!ncpOk) {
      console.error('\n  [ERROR] NCP 보관소에 연결하지 못했습니다.');
      console.error(`  ${lastNcpError()}`);
      console.error('\n  이 연결이 없으면 만든 영상이 24시간 뒤 사라집니다.');
      console.error('  그래서 앱을 켜지 않고 멈춥니다.\n');
      process.exit(1);
    }
    void drainArchive();
  }
  // 실패한 보관은 큐에 남는다. 다음 생성이 없어도 스스로 다시 시도하도록 주기적으로 깨운다.
  // 로컬 사본이 이미 있으면 원본 URL 이 죽은 뒤에도 성공할 수 있으므로 포기시키지 않는다.
  setInterval(() => { void drainArchive(); }, 10 * 60 * 1000).unref?.();

  // 이미 보관된 것들의 썸네일을 로컬로 확보한다. 영상이 NCP 에서 사라진 뒤에도
  // 무엇이었는지는 남아야 하는데, 사라진 뒤에는 받아올 곳이 없기 때문이다.
  // 기동을 막지 않도록 조금 늦춰 시작하고, 실패해도 조용히 넘어간다.
  setTimeout(() => { void backfillPosters().catch(() => {}); }, 20000).unref?.();

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
      if (CONTROL_FILES.has(f)) continue;
      const fp = path.join(CACHE_DIR, f);
      const st = fs.statSync(fp);
      // 폴더는 건너뛴다. 이유가 둘이다.
      //   1) posters/ 는 여기서 지우면 안 된다 — 썸네일은 영상보다 오래 남아야 한다.
      //   2) unlinkSync 는 폴더에 EPERM 을 던지는데 그 예외를 루프 바깥 try 가 잡아
      //      나머지 정리가 통째로 멈춘다. 폴더 하나 때문에 30일 청소가 조용히 안 돌고
      //      있을 수 있었다.
      if (st.isDirectory()) continue;
      const age = now - st.mtimeMs;
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

    const put = () => r2().send(new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      Body: fileBuffer,
      ContentType: opts?.contentType || mimeFromExt(ext),
      ...(opts?.contentDisposition ? { ContentDisposition: opts.contentDisposition } : {}),
    }));
    try { await put(); }
    catch (e: any) {
      if (!r2AuthError(e) || !(await refreshKeys('R2 ' + (e?.name || '403')))) throw e;
      await put();
    }

    const url = await getSignedUrl(
      r2(),
      new GetObjectCommand({ Bucket: r2Bucket(), Key: key }),
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
        try { await r2().send(new DeleteObjectCommand({ Bucket: r2Bucket(), Key: p.key })); deleted++; }
        catch { keep.push(p); /* delete failed (offline?) → retry next sweep */ }
      } else keep.push(p);
    }
    if (keep.length !== list.length) savePackIndex(keep);
    if (deleted) console.log(`[element-pack] swept ${deleted} expired pack(s) from R2`);
  }
  sweepExpiredPacks().catch(() => {});                                   // on boot
  setInterval(() => { sweepExpiredPacks().catch(() => {}); }, 60 * 60 * 1000); // hourly

  // 500mb, not 120. An element pack carries every image at FULL resolution as base64
  // (~12MB per asset, measured), so a 20-asset collection is ~240MB and was rejected with a
  // bare "Payload Too Large" — under the cache route's own 220mb and the backup route's
  // 400mb, which handle the same data. The client refuses anything larger before it builds
  // the string, so this ceiling is the backstop, not the gate.
  app.post('/api/element-pack', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
    try {
      const buf = Buffer.from(req.body as Buffer);
      if (!buf.length) return res.status(400).json({ error: 'empty body' });
      const key = `${PACK_PREFIX}${crypto.randomBytes(8).toString('hex')}-${Date.now()}.fwsl.json`;
      await r2().send(new PutObjectCommand({
        Bucket: r2Bucket(),
        Key: key,
        Body: buf,
        ContentType: 'application/json',
        ContentDisposition: 'attachment; filename="asset-pack.fwsl.json"',
      }));
      const url = await getSignedUrl(r2(), new GetObjectCommand({ Bucket: r2Bucket(), Key: key }), { expiresIn: 24 * 60 * 60 }); // 24h
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
      const r2Host = r2Hostname();
      if (!r2Host || host !== r2Host) return res.status(403).json({ error: '지원하지 않는 링크입니다 (Freewill 공유 링크만 가능)' });
      const r = await fetch(url);
      if (!r.ok) return res.status(502).json({ error: `링크를 불러올 수 없습니다 (${r.status}) — 만료됐거나 잘못된 링크` });
      const text = await r.text();
      // Must match the UPLOAD ceiling. This was 120MB while the upload route allowed the
      // same, so raising only one side would have let a pack be shared and then refused on
      // import — the worse failure, because by then the sender believes it worked. And
      // 'pack too large' told the receiver neither the size nor the limit.
      const packMB = text.length / (1024 * 1024);
      if (packMB > 500) return res.status(413).json({ error: `받은 묶음이 ${packMB.toFixed(0)}MB로 한도(500MB)를 넘습니다. 보낸 쪽에서 나눠서 공유해달라고 요청해주세요.` });
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
      // 썸네일도 캐시 비우기로 사라지므로 합계에 넣는다 — 안 그러면 안내에 적힌
      // 용량과 실제로 비워지는 양이 어긋난다.
      let posters = 0, posterBytes = 0;
      try {
        for (const p of fs.readdirSync(posterDir())) {
          const st = fs.statSync(path.join(posterDir(), p));
          if (st.isFile()) { posters++; posterBytes += st.size; }
        }
      } catch { /* 없으면 0 */ }
      res.json({ count: count + posters, bytes: bytes + posterBytes, posters, posterBytes });
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
  // 설치된 앱은 main.cjs 가 자기 폴더(app.getPath('documents') 기준)를 넘겨준다 — IPC 로 쓰는
  // 백업과 이 서버가 쓰는 라이브러리 원본이 같은 폴더에 있어야 복원이 된다. Documents 가 OneDrive
  // 로 옮겨진 PC 에서는 os.homedir()/Documents 와 그 폴더가 다르다(HANDOFF §9).
  const BACKUP_DIR = process.env.SEEDANCE_BACKUP_DIR || path.join(os.homedir(), 'Documents', 'Freewill Seedance Backup');
  const BACKUP_PATH = path.join(BACKUP_DIR, 'seedance-backup.json');
  const ELEMENTS_BACKUP_PATH = path.join(BACKUP_DIR, 'seedance-elements.json');
  const LEGACY_COMBINED_PATH = path.join(BACKUP_DIR, 'seedance-backup-combined-legacy.json');
  const ELEMENTS_MANIFEST_PATH = path.join(BACKUP_DIR, 'seedance-elements-manifest.json');
  const elementsChunkPath = (i: number) => path.join(BACKUP_DIR, `seedance-elements-${String(i).padStart(3, '0')}.json`);
  const STATE_RESTORE_MAX = 150 * 1024 * 1024;
  // 상태 전용 백업이 이보다 크면 한 덩어리로 넘기지 않고 프로젝트 하나씩 넘긴다(26.10.202~, state-outline ·
  // state-project). 한 덩어리 JSON 응답은 134MB 에서 Node 를 죽였다(2026-09-30 Zone Allocation failed).
  const STATE_SINGLE_MAX = 64 * 1024 * 1024;
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
        // 남은 조각은 전부 — 40개만 지우면 큰 축소(26.9.3001 원본 옮기기: 53 → 1)에서 뒤가 남는다.
        try {
          for (const f of fs.readdirSync(BACKUP_DIR)) {
            const m = /^seedance-elements-(\d{3,})\.json$/.exec(f);
            if (m && Number(m[1]) >= total) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} }
          }
        } catch {}
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
      if (p === BACKUP_PATH && stateSize > STATE_SINGLE_MAX) {
        // 크다고 건너뛰지 않는다 — 클라이언트가 조각으로 받아 붙인다(아래 state-outline).
        let elementsChunks = 0, elementsCount = 0;
        try { const man = JSON.parse(fs.readFileSync(ELEMENTS_MANIFEST_PATH, 'utf8')); if (man && man.chunks > 0) { elementsChunks = man.chunks; elementsCount = man.count || 0; } } catch {}
        return res.json({ ok: true, content: null, stateSkipped: true, pieces: true, stateBytes: stateSize, path: p, elementsChunks, elementsCount });
      }
      if (stateSize > STATE_RESTORE_MAX) {
        console.warn(`[Backup] ${p} is ${(stateSize / 1048576).toFixed(0)}MB — too large to load safely; skipping.`);
        // 상태는 못 넘겨도 어셋 목록은 조각이라 넘길 수 있다 — 클라이언트가 따로 되살린다(26.10.201~).
        let elementsChunks = 0, elementsCount = 0;
        try { const man = JSON.parse(fs.readFileSync(ELEMENTS_MANIFEST_PATH, 'utf8')); if (man && man.chunks > 0) { elementsChunks = man.chunks; elementsCount = man.count || 0; } } catch {}
        return res.json({ ok: true, content: null, stateSkipped: true, stateBytes: stateSize, path: p, elementsChunks, elementsCount });
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

  // ── 어셋 라이브러리: 원본 파일 · JPG 미리보기 · 백업 (26.9.3001~) ─────────────
  // 원본은 LIB_DIR 에, 백업 폴더에는 element-library/ 로 같은 이름 그대로 복사해 둔다. 이름이 곧
  // 내용이라 한 번 복사한 파일은 다시 바뀌지 않는다 — 새 그림만 복사하면 된다. userData 가 날아간
  // PC(재설치·AppData 정리)에서는 처음 쓰일 때 백업 폴더에서 되가져온다(libraryFile).
  const BACKUP_LIB_DIR = path.join(BACKUP_DIR, 'element-library');
  const BACKUP_LIB_PREVIEW_DIR = path.join(BACKUP_LIB_DIR, 'preview');
  const LIB_ID = /^[0-9a-f]{12}\.[a-z0-9]{2,5}$/;
  // 캐시 id 모양(/api/cache 가 짓는다: 내용 해시 12자 + 원래 확장자 그대로 — '.JPG' · '.jpeg' · 확장자 없음도 있다).
  // 받은 영상의 레퍼런스를 라이브러리 폴더에 고정(/api/cache/pin)하고 다시 찾을 때(libraryFile) 쓴다 — LIB_ID 로 거르면
  // 대문자 · 긴 확장자 레퍼런스가 고정되지 않고 30일 뒤 지워졌다(26.10.801 검토). 폴더 구분자 · 드라이브 문자는 여전히 막는다.
  const PIN_ID = /^[0-9a-f]{12}(\.[^\\/:*?"<>|#%\s\0]{1,16})?$/;

  // 머리 바이트로 형식을 정한다. 옛 어셋에는 파일 이름이 없는 것도 있고, 이름의 확장자가 틀린
  // 파일도 있다. 원본 바이트는 그대로 두고, 이름(→ 보낼 때의 Content-Type)만 실제 형식을 따른다.
  function sniffImageExt(buf: Buffer): string | null {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
    if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
    if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
    return null;
  }

  async function copyAtomic(src: string, dst: string) {
    await fs.promises.mkdir(path.dirname(dst), { recursive: true });
    const tmp = dst + '.tmp';
    await fs.promises.copyFile(src, tmp);
    await fs.promises.rename(tmp, dst);
  }

  // 원본을 백업 폴더에서 되가져올 때는 동기로 한다 — 요청 하나가 파일 하나를 기다리는 것이고,
  // 되가져온 뒤에는 다시 일어나지 않는다.
  function restoreFromBackup(src: string, dst: string): string {
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst + '.tmp');
      fs.renameSync(dst + '.tmp', dst);
      console.log(`[Library] restored ${path.basename(dst)} from backup`);
      return dst;
    } catch { return src; }                // 되가져오기에 실패해도 백업 쪽을 그대로 읽으면 된다
  }

  function libraryFile(id: string): string | null {
    if (!PIN_ID.test(id)) return null;   // LIB_ID 를 포함한다
    const p = path.join(LIB_DIR, id);
    if (fs.existsSync(p)) return p;
    const b = path.join(BACKUP_LIB_DIR, id);
    return fs.existsSync(b) ? restoreFromBackup(b, p) : null;
  }
  function libraryPreviewFile(id: string): string | null {
    if (!LIB_ID.test(id)) return null;
    const p = path.join(LIB_PREVIEW_DIR, id + '.jpg');
    if (fs.existsSync(p)) return p;
    const b = path.join(BACKUP_LIB_PREVIEW_DIR, id + '.jpg');
    return fs.existsSync(b) ? restoreFromBackup(b, p) : null;
  }

  // media-cache id 로도, 라이브러리 id 로도 원본을 찾는다. 요청에서 온 값이라 폴더를 벗어나는
  // 이름(../ · 경로 구분자 · 드라이브 문자)은 여기서 막는다 — 26.10.301 전에는 0.0.0.0 에 떠 있어 같은 망 어디서나
  // 부를 수 있었다. 지금은 이 PC 에서만이지만, 요청에서 온 값은 그래도 믿지 않는다.
  function resolveMediaFile(raw: unknown): string | null {
    const id = String(raw ?? '');
    if (!id || /[\\/:\0]/.test(id) || id.includes('..')) return null;
    const c = path.join(CACHE_DIR, id);
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 캐시에 없음 */ }
    return libraryFile(id);
  }

  // 원본 저장. 받은 바이트를 한 바이트도 바꾸지 않고 쓴다. 내용이 같으면 id 도 같다 — 이미 있으면 둔다.
  app.post('/api/library', express.raw({ type: '*/*', limit: '64mb' }), (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ ok: false, error: 'empty body' });
      const named = path.extname(decodeURIComponent((req.headers['x-filename'] as string) || '')).toLowerCase();
      const ext = sniffImageExt(buf) || (/^\.[a-z0-9]{2,5}$/.test(named) ? named : '.bin');
      const libId = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12) + ext;
      const p = path.join(LIB_DIR, libId);
      if (!fs.existsSync(p)) {
        fs.mkdirSync(LIB_DIR, { recursive: true });   // 켜져 있는 동안 폴더가 지워졌어도
        fs.writeFileSync(p + '.tmp', buf);
        fs.renameSync(p + '.tmp', p);
      }
      // 쓴 뒤의 실제 크기를 돌려준다 — 클라이언트는 이게 보낸 크기와 같을 때만 메모리의 원본을 놓는다.
      res.json({ ok: true, libId, bytes: fs.statSync(p).size });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 화면용 JPG 미리보기(클라이언트가 만든다 — 긴 변 제한, 투명은 검정). 원본이 있어야 받는다.
  app.put('/api/library/:id/preview', express.raw({ type: '*/*', limit: '24mb' }), (req, res) => {
    try {
      const id = String(req.params.id);
      if (!libraryFile(id)) return res.status(404).json({ ok: false, error: 'no such original' });
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (buf.length < 3 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ ok: false, error: 'preview must be a JPEG' });
      const p = path.join(LIB_PREVIEW_DIR, id + '.jpg');
      fs.mkdirSync(LIB_PREVIEW_DIR, { recursive: true });   // 켜져 있는 동안 폴더가 지워졌어도
      fs.writeFileSync(p + '.tmp', buf);
      fs.renameSync(p + '.tmp', p);
      res.json({ ok: true, bytes: buf.length });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 원본 그대로 (복사·공유 팩·옴니). 이름이 곧 내용이라 영원히 캐시해도 된다.
  app.get('/api/library/:id', (req, res) => {
    const f = libraryFile(String(req.params.id));
    if (!f) return res.status(404).json({ error: 'not found' });
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(f);
  });

  // 미리보기. 아직 없으면(만드는 중이거나, 옛 백업에서 막 되살린 경우) 원본을 대신 보여 주되 캐시는
  // 막는다 — 미리보기가 생기면 다음부터 그걸 받아야 하니까.
  app.get('/api/library/:id/preview', (req, res) => {
    const id = String(req.params.id);
    const pv = libraryPreviewFile(id);
    if (pv) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.sendFile(pv);
    }
    const f = libraryFile(id);
    if (!f) return res.status(404).json({ error: 'not found' });
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(f);
  });

  // ── 백업 파일에서 프로젝트·어셋 되살리기 (26.10.201~) ───────────────────────────
  // 2026-10-01 팀원 PC: 8월 초 업데이트 직후 앱이 빈 상태로 시작해 작업 기록을 덮어썼다. 옛 기록은 백업
  // 폴더의 seedance-backup-combined-legacy.json(7/30, 프로젝트 17개)에 그대로 남아 있었다. 앱이 켜질 때
  // 이런 파일을 찾아, 지금 기록과 프로젝트가 '하나도' 겹치지 않으면(= 통째로 잃은 것) 빠진 것을 붙인다.
  // 일부라도 겹치면 그 파일은 지금 기록의 과거일 뿐이고, 없는 것은 사용자가 지운 것이다 — 건드리지 않는다.
  // ★ 문자열로 읽지 않는다. 7월 이전 백업은 상태 + 어셋 원본이 한 덩어리라 수백 MB 이고(509MB 실측),
  //   V8 문자열 한계(약 512MB)에 닿는다. 바이트를 직접 훑어 필요한 배열의 범위만 찾고 그 부분만 해석한다
  //   (509MB 를 0.7초 · 어셋은 하나씩).
  const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  const skipWs = (b: Buffer, i: number) => { while (i < b.length && isWs(b[i])) i++; return i; };
  function skipString(b: Buffer, i: number): number {
    i++;
    while (i < b.length) { const c = b[i]; if (c === 0x5c) { i += 2; continue; } if (c === 0x22) return i + 1; i++; }
    throw new Error('unterminated string');
  }
  function skipValue(b: Buffer, i: number): number {
    i = skipWs(b, i);
    const c = b[i];
    if (c === 0x22) return skipString(b, i);
    if (c === 0x7b || c === 0x5b) {
      let depth = 0;
      while (i < b.length) {
        const d = b[i];
        if (d === 0x22) { i = skipString(b, i); continue; }
        if (d === 0x7b || d === 0x5b) depth++;
        else if (d === 0x7d || d === 0x5d) { if (--depth === 0) return i + 1; }
        i++;
      }
      throw new Error('unterminated container');
    }
    while (i < b.length && !(b[i] === 0x2c || b[i] === 0x7d || b[i] === 0x5d || isWs(b[i]))) i++;
    return i;
  }
  // 객체를 훑으며 원하는 키의 값 범위만 모은다(나머지 값은 건너뛰기만).
  function objectEntries(b: Buffer, i: number, want: string[] | null): Map<string, [number, number]> {   // null = 모든 키
    const out = new Map<string, [number, number]>();
    i = skipWs(b, i);
    if (b[i] !== 0x7b) throw new Error('not an object');
    i++;
    for (;;) {
      i = skipWs(b, i);
      if (b[i] === 0x7d) return out;
      const ks = i; i = skipString(b, i);
      const key = JSON.parse(b.toString('utf8', ks, i));
      i = skipWs(b, i); if (b[i] !== 0x3a) throw new Error('expected colon'); i = skipWs(b, i + 1);
      const vs = i; i = skipValue(b, i);
      if (!want || want.includes(key)) out.set(key, [vs, i]);
      i = skipWs(b, i);
      if (b[i] === 0x2c) { i++; continue; }
      if (b[i] === 0x7d) return out;
      throw new Error('bad object');
    }
  }
  // 루트에서 "state" 값의 시작만 찾는다 — state 를 통째로 한 번 더 훑지 않으려고.
  function stateStart(b: Buffer): number {
    let i = skipWs(b, 0);
    if (b[i] !== 0x7b) throw new Error('not an object');
    i++;
    for (;;) {
      i = skipWs(b, i);
      const ks = i; i = skipString(b, i);
      const key = JSON.parse(b.toString('utf8', ks, i));
      i = skipWs(b, skipWs(b, i) + 1);
      if (key === 'state') return i;
      i = skipWs(b, skipValue(b, i));
      if (b[i] === 0x2c) { i++; continue; }
      throw new Error('no state');
    }
  }
  function forEachItem(b: Buffer, [s, e]: [number, number], cb: (s: number, e: number) => void) {
    let i = skipWs(b, s); if (b[i] !== 0x5b) throw new Error('not an array'); i++;
    while (i < e) {
      i = skipWs(b, i);
      if (b[i] === 0x5d) return;
      const vs = i; i = skipValue(b, i); cb(vs, i);
      i = skipWs(b, i);
      if (b[i] === 0x2c) i++;
    }
  }
  // 되살릴 후보: 7월 이전 합본(legacy), 기록이 절반 이하로 줄 때 남긴 AUTOPREV, 손으로 남긴 PREV.
  // 지금 백업(seedance-backup.json)은 평소엔 지금 기록 그 자체라 보지 않는다 — 클라이언트가 이번 실행에서
  // 그 백업을 '너무 커서 못 불러왔다' 고 할 때만(includeCurrent) 후보에 넣는다.
  const RECOVERY_FILE = /^seedance-backup(-combined-legacy|\.AUTOPREV-[\w-]+|\.PREV-[\w-]+)?\.json$/;
  function recoveryCandidates(includeCurrent: boolean) {
    let names: string[] = [];
    try { names = fs.readdirSync(BACKUP_DIR); } catch { return []; }
    return names
      .filter((n) => RECOVERY_FILE.test(n) && (includeCurrent || n !== 'seedance-backup.json'))
      .map((n) => {
        const st = fs.statSync(path.join(BACKUP_DIR, n));
        return { name: n, file: path.join(BACKUP_DIR, n), mtime: st.mtimeMs, sig: `${n}|${st.size}|${Math.round(st.mtimeMs)}` };
      })
      .sort((a, b) => b.mtime - a.mtime);
  }
  const readBackupKeys = (file: string, want: string[]) => {
    const b = fs.readFileSync(file);
    return { b, keys: objectEntries(b, stateStart(b), want) };
  };

  // 후보 파일마다: 프로젝트 몇 개, 지금 기록과 몇 개 겹치나. 클라이언트가 이미 본 파일(skip)은 건너뛴다 —
  // 큰 파일을 실행할 때마다 다시 훑지 않게.
  app.post('/api/backup/recovery-scan', (req, res) => {
    try {
      const have = new Set<string>((Array.isArray(req.body?.have) ? req.body.have : []).map(String));
      // 이름은 빼고 크기·시각으로 알아본다. 너무 커서 건너뛴 지금 백업은 다음 저장 때 legacy 로 이름만 바뀌고,
      // 줄어든 기록은 AUTOPREV 로 복사된다(윈도우 복사는 시각을 그대로 둔다) — 이름까지 보면 같은 파일을 새
      // 파일로 알고, 사용자가 되살린 걸 지운 뒤라면 또 되살린다.
      const body = (sig: string) => sig.split('|').slice(-2).join('|');
      const skip = new Set<string>((Array.isArray(req.body?.skip) ? req.body.skip : []).map((x: unknown) => body(String(x))));
      const files: any[] = [];
      for (const c of recoveryCandidates(!!req.body?.includeCurrent)) {
        if (skip.has(body(c.sig))) continue;
        try {
          const { b, keys } = readBackupKeys(c.file, ['projects', 'elementAssets']);
          const pr = keys.get('projects');
          const projects: any[] = pr ? JSON.parse(b.toString('utf8', pr[0], pr[1])) : [];
          let elements = 0;
          const er = keys.get('elementAssets');
          if (er) forEachItem(b, er, () => { elements++; });
          files.push({
            sig: c.sig, name: c.name, mtime: c.mtime, projects: projects.length, elements,
            overlap: projects.filter((p) => have.has(String(p?.id))).length,
            names: projects.slice(0, 6).map((p) => String(p?.name || '')),
          });
        } catch (e: any) {
          files.push({ sig: c.sig, name: c.name, mtime: c.mtime, error: e.message });
        }
      }
      res.json({ ok: true, files });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 한 파일에서 프로젝트 전부 + 지금 없는 어셋을 꺼낸다. 어셋 원본은 여기서 바로 라이브러리 폴더에 파일로
  // 쓴다(base64 를 화면으로 보내지 않는다 — 26.9.3001 의 원칙 그대로). 미리보기는 클라이언트가 만든다.
  app.post('/api/backup/recovery-import', (req, res) => {
    try {
      const sig = String(req.body?.sig || '');
      const c = recoveryCandidates(true).find((x) => x.sig === sig);
      if (!c) return res.status(404).json({ ok: false, error: '백업 파일이 그새 바뀌었거나 없습니다' });
      const haveEl = new Set<string>((Array.isArray(req.body?.haveElements) ? req.body.haveElements : []).map(String));
      const haveCol = new Set<string>((Array.isArray(req.body?.haveCollections) ? req.body.haveCollections : []).map(String));
      const { b, keys } = readBackupKeys(c.file, ['projects', 'elementAssets', 'assetCollections', 'projectCollectionId']);
      const pr = keys.get('projects');
      const projects: any[] = pr ? JSON.parse(b.toString('utf8', pr[0], pr[1])) : [];
      // 그때 '진행 중' 이던 작업은 이미 끝났다(BytePlus 기록은 7일). 그대로 두면 앱이 10초마다 조회한다.
      for (const p of projects) for (const m of (p?.messages || [])) {
        if (m && (m.status === 'running' || m.status === 'queued')) {
          m.status = 'failed';
          m.error = '백업에서 되살린 기록 — 그때 진행 중이던 작업은 결과를 찾을 수 없습니다';
        }
      }
      const elements: any[] = [];
      let images = 0, written = 0;
      const er = keys.get('elementAssets');
      if (er) {
        const ranges: [number, number][] = [];
        forEachItem(b, er, (s, e) => { ranges.push([s, e]); });
        for (const [s, e] of ranges) {
          const a = JSON.parse(b.toString('utf8', s, e));       // 어셋 하나(원본 포함 ~12MB)씩만
          if (!a?.id || haveEl.has(String(a.id))) continue;
          const imgs: any[] = [];
          for (const im of (Array.isArray(a.images) ? a.images : [])) {
            let libId = typeof im?.libId === 'string' && LIB_ID.test(im.libId) ? im.libId : '';
            if (!libId && typeof im?.url === 'string' && im.url.startsWith('data:')) {
              const bytes = Buffer.from(im.url.slice(im.url.indexOf(',') + 1), 'base64');
              libId = crypto.createHash('md5').update(bytes).digest('hex').slice(0, 12) + (sniffImageExt(bytes) || '.png');
              const p = path.join(LIB_DIR, libId);
              if (!fs.existsSync(p)) { fs.mkdirSync(LIB_DIR, { recursive: true }); fs.writeFileSync(p + '.tmp', bytes); fs.renameSync(p + '.tmp', p); written++; }
            }
            if (!libId) continue;
            images++;
            const thumb = typeof im.thumbnailUrl === 'string' && im.thumbnailUrl.startsWith('data:') && im.thumbnailUrl.length <= 300 * 1024 ? im.thumbnailUrl : '';
            imgs.push({
              id: typeof im.id === 'string' ? im.id : crypto.randomUUID(), libId, thumbnailUrl: thumb,
              ...(typeof im.file_name === 'string' ? { file_name: im.file_name } : {}),
            });
          }
          if (imgs.length) elements.push({ ...a, images: imgs });
        }
      }
      const usedCols = new Set(elements.map((e) => String(e.collectionId)));
      const cr = keys.get('assetCollections');
      const collections = cr
        ? (JSON.parse(b.toString('utf8', cr[0], cr[1])) as any[]).filter((col) => usedCols.has(String(col?.id)) && !haveCol.has(String(col?.id)))
        : [];
      const br = keys.get('projectCollectionId');
      const allBind = br ? JSON.parse(b.toString('utf8', br[0], br[1])) : {};
      const pids = new Set(projects.map((p) => String(p?.id)));
      const bindings = Object.fromEntries(Object.entries(allBind || {}).filter(([pid]) => pids.has(pid)));
      console.log(`[Recovery] ${c.name}: 프로젝트 ${projects.length}개, 어셋 ${elements.length}개(이미지 ${images}장, 새 원본 파일 ${written}개)`);
      res.json({ ok: true, name: c.name, mtime: c.mtime, projects, elements, collections, bindings });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // ── 지금 백업을 프로젝트 하나씩 (26.10.202~) ─────────────────────────────────────
  // 작업 기록 백업이 STATE_SINGLE_MAX 를 넘으면 GET /api/backup/state 는 내용 대신 pieces:true 를 준다.
  // 클라이언트는 여기서 '프로젝트 말고 나머지' 와 프로젝트 수를 받고, 프로젝트를 하나씩 받아 붙인다 —
  // 기록이 아무리 커도 한 덩어리 문자열을 만들지 않으므로, 크기 때문에 복원을 건너뛰는 일(빈 상태로 시작
  // → 덮어쓰기, 2026-10-01 팀원 사고의 한 갈래)이 없다. 파일은 바이트로 한 번 훑고(509MB 0.7초) 범위만
  // 들고 있다가, 마지막 조각을 넘기거나 2분이 지나면 놓는다. 옛 합본(legacy)은 여기로 오지 않는다 —
  // 어셋 원본이 상태 안에 있어서, 너무 크면 예전처럼 건너뛰고 26.10.201 의 되살리기가 맡는다.
  type Outline = { sig: string; b: Buffer; rest: string; version: unknown; ranges: [number, number][] };
  let outline: Outline | null = null;
  function loadOutline(): Outline | null {
    if (!fs.existsSync(BACKUP_PATH)) return null;
    const st = fs.statSync(BACKUP_PATH);
    const sig = `${st.size}|${Math.round(st.mtimeMs)}`;
    if (outline && outline.sig === sig) return outline;
    const b = fs.readFileSync(BACKUP_PATH);
    const root = objectEntries(b, 0, ['state', 'version']);
    const s = root.get('state');
    if (!s) throw new Error('state 가 없는 백업');
    const keys = objectEntries(b, s[0], null);
    const ranges: [number, number][] = [];
    const pr = keys.get('projects');
    if (pr) forEachItem(b, pr, (a, e) => { ranges.push([a, e]); });
    const rest = '{' + [...keys]
      .filter(([k]) => k !== 'projects' && k !== 'elementAssets')
      .map(([k, [a, e]]) => JSON.stringify(k) + ':' + b.toString('utf8', a, e))
      .join(',') + '}';
    const v = root.get('version');
    const o: Outline = { sig, b, rest, version: v ? JSON.parse(b.toString('utf8', v[0], v[1])) : 0, ranges };
    outline = o;
    setTimeout(() => { if (outline === o) outline = null; }, 2 * 60 * 1000).unref?.();
    return o;
  }
  app.get('/api/backup/state-outline', (_req, res) => {
    try {
      const o = loadOutline();
      if (!o) return res.json({ ok: false, error: 'no backup' });
      res.json({ ok: true, sig: o.sig, projects: o.ranges.length, rest: o.rest, version: o.version });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/backup/state-project/:i', (req, res) => {
    try {
      const o = loadOutline();
      // 받는 도중에 백업이 바뀌었으면 섞지 않는다 — 클라이언트는 처음부터 다른 길로 간다.
      if (!o || String(req.query.sig || '') !== o.sig) return res.status(409).json({ ok: false, error: '백업이 그새 바뀌었습니다' });
      const i = Number(req.params.i);
      const r = Number.isInteger(i) ? o.ranges[i] : undefined;
      if (!r) return res.status(404).json({ ok: false, error: 'no such project' });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(o.b.subarray(r[0], r[1]));
      if (i === o.ranges.length - 1 && outline === o) outline = null;   // 다 넘겼다 — 버퍼를 놓는다
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 앱이 읽긴 했는데 해석하지 못한 작업 기록을, 덮어쓰기 전에 백업 폴더에 남긴다(26.10.201~).
  // 예전에는 이 경우 조용히 빈 상태로 시작해 그 기록을 덮어썼다 — 나중에 손으로라도 꺼낼 길을 남긴다.
  app.post('/api/backup/unreadable', express.raw({ type: '*/*', limit: '600mb' }), (req, res) => {
    try {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!buf.length) return res.status(400).json({ ok: false, error: 'empty' });
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const d = new Date();
      const p2 = (n: number) => String(n).padStart(2, '0');
      const name = `seedance-backup.UNREADABLE-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json`;
      fs.writeFileSync(path.join(BACKUP_DIR, name), buf);
      console.warn(`[Persist] 읽지 못한 작업 기록을 남김: ${name} (${(buf.length / 1048576).toFixed(1)}MB)`);
      res.json({ ok: true, name });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 화면용 미리보기가 없는 원본들. 클라이언트가 켜질 때 물어 빠진 것만 만든다 — 되살린 어셋, 옮기기 도중에
  // 앱을 끈 경우, 만들기가 한 번 실패한 경우 모두 다음 실행에 스스로 메워진다(store.ts backfillLibraryImages).
  // 있는지만 본다: libraryFile() 처럼 백업 폴더에서 되가져오면 켜질 때마다 원본 전부를 복사하게 된다.
  app.post('/api/library/missing-previews', (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));
    res.json({ ok: true, missing: ids.filter((id) => LIB_ID.test(id)
      && (has(LIB_DIR, id) || has(BACKUP_LIB_DIR, id))
      && !has(LIB_PREVIEW_DIR, id + '.jpg') && !has(BACKUP_LIB_PREVIEW_DIR, id + '.jpg')) });
  });

  // 백업 폴더에 원본(과 미리보기)을 채운다. 클라이언트가 라이브러리 목록을 백업하기 직전에 부른다 —
  // 목록이 가리키는 원본이 백업에 없는 채로 목록만 새로 쓰면, 그 백업으로 되살린 라이브러리는 그림이
  // 없다. 이미 있는 파일은 건너뛰므로 처음 한 번만 무겁고(약 1GB) 그 뒤로는 새 그림만 복사한다.
  app.post('/api/library/backup-sync', async (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      let copied = 0, present = 0, previews = 0;
      const missing: string[] = [];
      for (const id of ids) {
        if (!LIB_ID.test(id)) { missing.push(id); continue; }
        const dst = path.join(BACKUP_LIB_DIR, id);
        if (fs.existsSync(dst)) present++;
        else if (fs.existsSync(path.join(LIB_DIR, id))) { await copyAtomic(path.join(LIB_DIR, id), dst); copied++; }
        else { missing.push(id); continue; }
        const pvSrc = path.join(LIB_PREVIEW_DIR, id + '.jpg');
        const pvDst = path.join(BACKUP_LIB_PREVIEW_DIR, id + '.jpg');
        if (!fs.existsSync(pvDst) && fs.existsSync(pvSrc)) { await copyAtomic(pvSrc, pvDst); previews++; }
      }
      if (copied || previews || missing.length) {
        console.log(`[Library] backup: +${copied} original(s), +${previews} preview(s), ${present} already there${missing.length ? `, ${missing.length} MISSING` : ''}`);
      }
      res.json({ ok: true, copied, present, previews, missing });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 받은 영상의 레퍼런스 원본을 30일 정리에서 뺀다(26.10.801~) — 라이브러리 폴더로 한 벌 옮겨 둔다(이름 = 내용이라 같은 이름).
  // /api/cache/<id> 는 캐시에 없으면 라이브러리에서 찾으므로(resolveMediaFile) 주소는 그대로다. 그 영상을 30일 뒤 앱에 끌어다
  // 놓아도 이 PC 에서는 레퍼런스까지 되살아난다(src/lib/settings-box.ts). 라이브러리 폴더는 아무도 자동으로 지우지 않는다.
  // 같은 레퍼런스로 테이크를 여럿 받아도 한 벌이다.
  app.post('/api/cache/pin', async (req, res) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      let pinned = 0, already = 0, gone = 0;
      for (const id of ids) {
        if (!PIN_ID.test(id)) continue;
        const dst = path.join(LIB_DIR, id);
        if (fs.existsSync(dst)) { already++; continue; }
        const src = path.join(CACHE_DIR, id);
        if (!fs.existsSync(src)) { gone++; continue; }
        await copyAtomic(src, dst);
        pinned++;
      }
      if (pinned) console.log(`[Cache] 받은 영상의 레퍼런스 ${pinned}개를 영구 보관${gone ? ` (이미 지워진 것 ${gone})` : ''}`);
      res.json({ ok: true, pinned, already, gone });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // 이름을 바꾼 옛 영상 → 카드(26.10.801~). 영상 안 C2PA 고유번호로 taskId 를 찾는다(ncp.ts 'C2PA 고유번호').
  app.get('/api/media/by-c2pa/:id', (req, res) => {
    const id = String(req.params.id || '').toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return res.status(400).json({ ok: false });
    const taskId = taskIdForC2pa(id);
    if (!taskId) return res.status(404).json({ ok: false });
    res.json({ ok: true, taskId });
  });

  // Wipe the ENTIRE media-cache. Wired to the sidebar cleanup button — explicit
  // cleanup means full cleanup (user decision). Old messages' clipboard
  // references become unrecoverable; file references can still recover via
  // originalPath at reuse time.
  app.post('/api/cache/clear', (_req, res) => {
    try {
      let deleted = 0, bytes = 0;
      for (const f of fs.readdirSync(CACHE_DIR)) {
        if (CONTROL_FILES.has(f)) continue; // 원장은 캐시가 아니다 — CONTROL_FILES 주석 참고
        const fp = path.join(CACHE_DIR, f);
        const st = fs.statSync(fp);
        if (st.isFile()) { bytes += st.size; fs.unlinkSync(fp); deleted++; }
      }
      // 썸네일 폴더는 30일 프루너가 안 건드린다. 사용자가 비우겠다고 할 때만 비운다.
      try {
        for (const p of fs.readdirSync(posterDir())) {
          const pp = path.join(posterDir(), p);
          const pst = fs.statSync(pp);
          if (pst.isFile()) { bytes += pst.size; fs.unlinkSync(pp); deleted++; }
        }
      } catch { /* 폴더가 없으면 지울 것도 없다 */ }
      console.log(`[Cache] Cleared by user: ${deleted} files, ${(bytes / 1024 / 1024).toFixed(1)}MB`);
      res.json({ ok: true, deleted, bytes });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
  });

  // Read cached file
  app.get('/api/cache/:cacheId', (req, res) => {
    // 캐시에 없으면 어셋 라이브러리 원본에서 찾는다 — 옴니가 어셋 이미지를 이 경로로 읽는다.
    const cachePath = resolveMediaFile(req.params.cacheId);
    if (!cachePath) return res.status(404).json({ error: 'File not found in cache' });
    if (cachePath.startsWith(CACHE_DIR)) touchCache(cachePath); // 읽기도 사용 → 30일 시계 리셋
    res.sendFile(cachePath);
  });

  // 보관 상태. :taskId 와 겹치지 않도록 경로를 따로 뒀다.
  app.get('/api/archive/status', (_req, res) => res.json(archiveStats()));

  // 이 PC 가 어느 팀으로 집계되는지. 화면에 띄우기 위한 것이다.
  // R2·NCP 키가 없으면 앱이 아예 안 뜨는데, 팀 키를 모르는 경우만 조용히 넘어가고
  // 있었다 — 앱은 멀쩡히 돌고 리포트도 나가지만 사용량이 전부 UNKNOWN 으로 쌓인다.
  // 콘솔 한 줄이 유일한 신호라 아무도 못 본다. 한 달치 집계가 남의 것이 된 뒤에야
  // 알게 되는 종류의 실패다.
  // 부팅을 막지는 않는다. 새 팀 키가 발급될 때마다 그 팀이 앱을 못 쓰게 되는 쪽이
  // 더 나쁘다 — 집계는 나중에 고칠 수 있어도 멈춘 작업은 못 되돌린다.
  // 키가 아예 없는 경우는 여기까지 오지 않는다 — startServer() 첫 줄에서 이미
  // process.exit(1) 이다. 그래서 known:false 는 '키는 있는데 모르는 키' 하나뿐이다.
  app.get('/api/team', (_req, res) => res.json({
    team: teamName(),
    known: teamName() !== 'UNKNOWN',
  }));

  // ── 에이전트 작업함 (26.10.302~) ─────────────────────────────────────────────
  // 같은 PC 의 에이전트(Claude Code·Codex 의 freewill 커넥터)가 생성 요청을 넣는 곳. 서버는 받아 두기만
  // 하고, 실제로 보내는 건 앱 화면(ChatArea)이 사람이 전송 버튼을 누르는 것과 같은 길(handleSend)로 한다.
  // 그래서 생성 중 카드 · 권한 검사 · 트래커 보고 · NCP 보관 · 폴링이 전부 평소대로다.
  //   에이전트: GET /api/agent/manual(사용 설명서) → POST /api/agent/jobs → GET /api/agent/jobs/:id 로 진행을 본다.
  //             상태는 GET /api/agent/status.
  //   화면:     POST /api/agent/jobs/claim (2초마다 — 지금 프로젝트·과금 선택·권한도 같이 알린다)
  //             → 보낸 뒤 POST /api/agent/jobs/:id/report 로 카드 상태를 올린다.
  //             POST /api/agent/manual — 설명서(src/lib/agent-inbox.ts, MODELS 에서 자동 생성)를 올린다.
  // ★ 설명서 버전은 작업함 응답마다 붙인다. 에이전트는 읽은 버전을 요청의 manual 에 적어 보내고, 지금 앱의 버전과
  //   다르면 받지 않고 "업데이트됐으니 다시 읽어" 로 돌려보낸다 — 한 채팅방을 오래 써도 보낼 때마다 지금 앱에 맞춰진다.
  // ★ 진행 확인을 /api/byteplus/tasks/:id 로 하게 만들지 마라 — 그 조회는 성공을 처음 본 순간 트래커 보고와
  //   NCP 보관을 하고 작업→프로젝트 기록을 지운다. 화면과 에이전트가 같이 조회하면 그 순서가 엇갈린다.
  // 이 라우트들도 위의 127.0.0.1 바인딩 + 다른 출처 거절 미들웨어 뒤에 있다. 메모리에만 둔다(앱을 껐다 켜면
  // 사라진다). 24시간 지난 것은 지운다.
  // ★ 화면이 가져간 작업은 절대 다시 내놓지 않는다. 화면이 보내는 도중 멈췄으면 이미 BytePlus 에 작업이
  //   만들어졌을 수 있다 — 다시 내놓으면 같은 영상이 두 번 과금된다. 대신 그 화면이 1분 넘게 안 들르면
  //   실패로 닫고 "앱에서 생성됐는지 확인" 하라고 알린다.
  type AgentJob = {
    id: string; createdAt: number; updatedAt: number;
    status: 'pending' | 'taken' | 'sent' | 'done' | 'failed';
    spec: { prompt: string; project?: string; billing?: string; name?: string; settings: Record<string, unknown>; refs: { path: string; role?: string }[] };
    takenBy?: string; error?: string; projectName?: string; messages?: unknown[];
  };
  const agentJobs = new Map<string, AgentJob>();
  let agentScreen: {
    at: number; project?: string; billing?: string | null; generating?: boolean; composer?: boolean;
    allowedModels?: string[]; fourK?: boolean;
  } = { at: 0 };
  let agentManual: { version: string; manual: unknown; text: string } | null = null;   // 화면이 올린 설명서
  const manualVersionNow = () => agentManual?.version ?? null;
  const staleNotice = (have: string) => `앱이 업데이트됐습니다(읽은 설명서 ${have} → 지금 ${manualVersionNow()}). `
    + '설명서를 다시 읽고(GET /api/agent/manual · send-to-seedance.mjs --manual) 그 기준으로 확인 카드를 다시 보여 준 뒤, '
    + 'manual 을 새 버전으로 바꿔 보내 주세요.';
  const agentScreenSeen = new Map<string, number>();   // 화면(창)마다 마지막으로 들른 시각
  const pruneAgentJobs = () => {
    const now = Date.now();
    const cut = now - 24 * 3600 * 1000;
    for (const [k, j] of agentJobs) if (j.updatedAt < cut) agentJobs.delete(k);
    for (const j of agentJobs.values()) {
      // 10분 안에 화면이 못 가져간 요청은 닫는다(입력 중 · 갤러리 화면 · 앱 꺼짐). 한참 뒤 갑자기 생성되면 안 된다.
      if (j.status === 'pending' && now - j.createdAt > 10 * 60000) {
        j.status = 'failed'; j.updatedAt = now;
        j.error = '앱이 10분 안에 이 요청을 받지 못해 취소했습니다(앱이 꺼져 있었거나 · 갤러리 화면 · 계속 입력 중). 다시 보내 주세요.';
        console.warn(`[Agent] job ${j.id} → failed (10분 대기)`);
        continue;
      }
      if (j.status !== 'taken') continue;
      const seen = agentScreenSeen.get(j.takenBy || '') || 0;
      if (now - Math.max(seen, j.updatedAt) > 60000) {
        j.status = 'failed'; j.updatedAt = now;
        j.error = '앱 화면이 이 작업을 받은 뒤 응답이 없습니다(앱을 닫았거나 새로고침). 앱에서 생성됐는지 확인한 뒤, 안 됐으면 다시 보내 주세요.';
        console.warn(`[Agent] job ${j.id} → failed (화면 응답 없음)`);
      }
    }
  };
  const openAgentJobs = () => [...agentJobs.values()].filter(j => j.status === 'pending' || j.status === 'taken');

  app.get('/api/agent/status', (req, res) => {
    pruneAgentJobs();
    // ?manual=<에이전트가 읽은 버전> 을 주면 낡았는지 바로 알려 준다(보내기 전 확인 단계에서).
    const have = typeof req.query.manual === 'string' ? req.query.manual : '';
    const stale = !!have && !!agentManual && have !== agentManual.version;
    res.json({
      ok: true,
      screenAlive: Date.now() - agentScreen.at < 8000,   // 화면이 작업함을 들여다보고 있나 (2초마다 들른다)
      project: agentScreen.project ?? null,              // 지금 열린 프로젝트(사이드바)
      billing: agentScreen.billing ?? null,               // 과금 프로젝트 선택 — null 이면 아직 안 고름
      allowedModels: agentScreen.allowedModels ?? null,   // 그 과금 프로젝트로 지금 쓸 수 있는 모델
      fourK: !!agentScreen.fourK,                         // 4K 권한
      generating: !!agentScreen.generating,
      composer: agentScreen.composer !== false,           // false = 갤러리 화면(작성 칸이 없어 받지 못함)
      pending: openAgentJobs().length,
      manualVersion: manualVersionNow(),
      ...(have ? { manualStale: stale, ...(stale ? { notice: staleNotice(have) } : {}) } : {}),
    });
  });

  // 사용 설명서 — 화면이 자기 코드(MODELS · 패널 목록)에서 만들어 올리고, 에이전트가 읽는다.
  app.post('/api/agent/manual', (req, res) => {
    const b = req.body || {};
    if (typeof b.version !== 'string' || !b.version || b.version.length > 80) return res.status(400).json({ error: 'version 이 없습니다' });
    if (typeof b.text !== 'string' || b.text.length > 300000) return res.status(400).json({ error: 'text 가 없거나 너무 깁니다' });
    if (!b.manual || typeof b.manual !== 'object') return res.status(400).json({ error: 'manual 이 없습니다' });
    if (agentManual?.version !== b.version) console.log(`[Agent] 설명서 ${b.version}`);
    agentManual = { version: b.version, manual: b.manual, text: b.text };
    res.json({ ok: true });
  });
  app.get('/api/agent/manual', (_req, res) => {
    if (!agentManual) return res.status(503).json({ error: '앱 화면이 아직 설명서를 올리지 않았습니다 — 시댄스 창이 열려 있는지 확인해 주세요.' });
    res.json({ ok: true, version: agentManual.version, manual: agentManual.manual, text: agentManual.text });
  });

  app.post('/api/agent/jobs', (req, res) => {
    const b = req.body || {};
    // 설명서 버전 확인 — 에이전트가 읽은 설명서가 지금 앱의 것이어야 받는다.
    if (!agentManual) return res.status(503).json({ error: '앱 화면이 아직 준비되지 않았습니다(설명서 없음) — 시댄스 창이 열려 있는지 확인해 주세요.' });
    if (typeof b.manual !== 'string' || !b.manual) {
      return res.status(400).json({ error: '설명서 버전(manual)이 없습니다 — 설명서를 먼저 읽고(GET /api/agent/manual · send-to-seedance.mjs --manual) 그 version 을 manual 에 적어 보내 주세요.', needManual: true, manualVersion: manualVersionNow() });
    }
    if (b.manual !== agentManual.version) return res.status(409).json({ error: staleNotice(b.manual), stale: true, manualVersion: manualVersionNow() });
    const prompt = typeof b.prompt === 'string' ? b.prompt : '';
    if (!prompt.trim()) return res.status(400).json({ error: 'prompt 가 비었습니다' });
    if (prompt.length > 50000) return res.status(400).json({ error: 'prompt 가 너무 깁니다 (5만 자까지)' });
    const settings = b.settings && typeof b.settings === 'object' && !Array.isArray(b.settings) ? b.settings : {};
    const rawRefs: unknown[] = Array.isArray(b.refs) ? b.refs : [];
    if (rawRefs.length > 50) return res.status(400).json({ error: '레퍼런스는 50개까지입니다' });
    const refs = rawRefs.map((r: any) => typeof r === 'string'
      ? { path: r }
      : { path: String(r?.path || ''), ...(typeof r?.role === 'string' ? { role: r.role } : {}) });
    if (refs.some(r => !r.path)) return res.status(400).json({ error: 'path 가 없는 레퍼런스가 있습니다' });
    pruneAgentJobs();
    if (openAgentJobs().length >= 30) return res.status(429).json({ error: '아직 보내지 않은 작업이 30개입니다 — 앱이 처리할 때까지 기다려 주세요' });
    const id = crypto.randomUUID();
    const now = Date.now();
    agentJobs.set(id, {
      id, createdAt: now, updatedAt: now, status: 'pending',
      spec: {
        prompt, settings, refs,
        // 확인 카드에서 사용자가 본 프로젝트(사이드바) · 과금 프로젝트. 화면의 지금 값과 다르면 화면이 보내지 않는다.
        ...(typeof b.project === 'string' && b.project.trim() ? { project: b.project.trim() } : {}),
        ...(typeof b.billing === 'string' && b.billing.trim() ? { billing: b.billing.trim() } : {}),
        ...(typeof b.name === 'string' && b.name.trim() ? { name: b.name.trim().slice(0, 120) } : {}),
      },
    });
    console.log(`[Agent] job ${id} 받음 (레퍼런스 ${refs.length}개)`);
    res.json({ ok: true, id, manualVersion: manualVersionNow() });
  });

  app.post('/api/agent/jobs/claim', (req, res) => {
    const b = req.body || {};
    const now = Date.now();
    const screen = typeof b.screen === 'string' ? b.screen.slice(0, 64) : '';
    if (screen) agentScreenSeen.set(screen, now);
    for (const [k, t] of agentScreenSeen) if (now - t > 3600000) agentScreenSeen.delete(k);
    agentScreen = {
      at: now,
      project: typeof b.project === 'string' ? b.project : undefined,
      billing: typeof b.billing === 'string' ? b.billing : null,
      generating: !!b.generating,
      composer: b.composer !== false,
      allowedModels: Array.isArray(b.allowedModels) ? b.allowedModels.filter((x: unknown) => typeof x === 'string').slice(0, 50) : undefined,
      fourK: b.fourK === true,
    };
    pruneAgentJobs();
    pruneAgentCmds();
    // manualVersion: 화면은 자기 설명서와 다르면(서버가 다시 떴거나 처음) 올린다.
    const manualVersion = manualVersionNow();
    // 명령(26.10.305~)이 있으면 명령만 준다 — 그 틱엔 생성 요청을 주지 않는다(project.open 같은 명령 뒤의 생성은
    // 화면이 새로 그려진 다음 틱에 받아야 지금 프로젝트를 제대로 본다). 입력 중이어도(peek) 명령은 받는다.
    if (screen && b.takeCommands) {
      const cmds = [...agentCmds.values()].filter(c => c.status === 'pending').sort((x, y) => x.createdAt - y.createdAt).slice(0, 5);
      if (cmds.length) {
        for (const c of cmds) { c.status = 'taken'; c.updatedAt = now; c.takenBy = screen; }
        return res.json({ job: null, commands: cmds.map(c => ({ id: c.id, command: c.command, args: c.args })), manualVersion });
      }
    }
    // peek: 상태만 알리고 가져가지는 않는다 — 사용자가 입력 중 · 생성 중 · 다른 작업을 보내는 중일 때.
    if (b.peek || !screen) return res.json({ job: null, manualVersion });
    const next = [...agentJobs.values()].filter(j => j.status === 'pending').sort((x, y) => x.createdAt - y.createdAt)[0];
    if (!next) return res.json({ job: null, manualVersion });
    next.status = 'taken'; next.updatedAt = now; next.takenBy = screen;
    res.json({ job: { id: next.id, ...next.spec }, manualVersion });
  });

  app.post('/api/agent/jobs/:id/report', (req, res) => {
    const j = agentJobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: 'no such job' });
    const b = req.body || {};
    if (b.status === 'sent' || b.status === 'done' || b.status === 'failed') j.status = b.status;
    // 늦게라도 화면이 '보냈다' 고 알려 오면 그게 사실이다 — 응답 없음으로 닫아 둔 문구를 지운다.
    if (typeof b.error === 'string') j.error = b.error.slice(0, 4000);
    else if (b.status === 'sent') delete j.error;
    if (typeof b.project === 'string') j.projectName = b.project;
    if (Array.isArray(b.messages)) j.messages = b.messages.slice(0, 10);
    j.updatedAt = Date.now();
    if (j.status === 'failed' || j.status === 'done') console.log(`[Agent] job ${j.id} → ${j.status}${j.error ? ` (${j.error.split('\n')[0]})` : ''}`);
    res.json({ ok: true });
  });

  app.get('/api/agent/jobs/:id', (req, res) => {
    pruneAgentJobs();
    const j = agentJobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: '없는 작업입니다 (앱을 다시 켜면 작업함이 비워집니다)' });
    res.json({ id: j.id, name: j.spec.name, status: j.status, error: j.error, project: j.projectName, messages: j.messages || [], createdAt: j.createdAt, updatedAt: j.updatedAt, manualVersion: manualVersionNow() });
  });

  // ── 에이전트 명령 (26.10.305~) ───────────────────────────────────────────────
  // 생성 말고 앱 기능(프로젝트 · 어셋 라이브러리 · 카드 · 과금 목록 보기)을 에이전트가 쓰는 길. 화면이 2초마다 가져가
  // 앱 버튼과 같은 함수로 실행하고 결과를 올린다(ChatArea agentCommands — 목록은 src/lib/agent-inbox.ts AGENT_COMMANDS).
  // 에이전트의 POST 는 결과가 올 때까지(기본 30초, 최대 120초) 기다렸다가 답한다. 더 걸리면 GET 으로 이어서 본다.
  // 생성 요청과 같은 규칙: 설명서 버전 확인, 가져간 명령은 다시 내놓지 않음(화면이 1분 넘게 안 오면 실패로 닫음).
  // ★ 지우기와 과금 프로젝트 고르기는 명령이 없다(사용자 결정 2026-10-03). 서버는 명령 이름을 거르지 않는다 —
  //   모르는 이름은 화면이 "모르는 명령" 으로 돌려보낸다(목록이 화면 한 곳에만 있게).
  type AgentCmd = {
    id: string; createdAt: number; updatedAt: number; command: string; args: Record<string, unknown>;
    status: 'pending' | 'taken' | 'done' | 'failed'; takenBy?: string; result?: unknown; error?: string;
  };
  const agentCmds = new Map<string, AgentCmd>();
  const cmdWaiters = new Map<string, Array<() => void>>();
  const settleCmd = (c: AgentCmd) => { const ws = cmdWaiters.get(c.id); cmdWaiters.delete(c.id); ws?.forEach(w => w()); };
  const cmdView = (c: AgentCmd) => ({
    id: c.id, command: c.command, status: c.status,
    ...(c.result !== undefined ? { result: c.result } : {}), ...(c.error ? { error: c.error } : {}),
    manualVersion: manualVersionNow(),
  });
  function pruneAgentCmds() {
    const now = Date.now();
    for (const [k, c] of agentCmds) {
      if ((c.status === 'done' || c.status === 'failed') && now - c.updatedAt > 3600000) { agentCmds.delete(k); continue; }
      if (c.status === 'pending' && now - c.createdAt > 10 * 60000) {
        c.status = 'failed'; c.updatedAt = now;
        c.error = '앱이 10분 안에 이 명령을 받지 못했습니다(앱이 꺼져 있었거나 다른 일을 하던 중). 다시 보내 주세요.';
        settleCmd(c); continue;
      }
      if (c.status === 'taken') {
        const seen = agentScreenSeen.get(c.takenBy || '') || 0;
        if (now - Math.max(seen, c.updatedAt) > 60000) {
          c.status = 'failed'; c.updatedAt = now;
          c.error = '앱 화면이 이 명령을 받은 뒤 응답이 없습니다(앱을 닫았거나 새로고침). 앱에서 결과를 확인한 뒤 필요하면 다시 보내 주세요.';
          settleCmd(c);
        }
      }
    }
  }

  app.post('/api/agent/commands', async (req, res) => {
    const b = req.body || {};
    if (!agentManual) return res.status(503).json({ error: '앱 화면이 아직 준비되지 않았습니다(설명서 없음) — 시댄스 창이 열려 있는지 확인해 주세요.' });
    if (typeof b.manual !== 'string' || !b.manual) {
      return res.status(400).json({ error: '설명서 버전(manual)이 없습니다 — 설명서를 먼저 읽고(GET /api/agent/manual · send-to-seedance.mjs --manual) 그 version 을 manual 에 적어 보내 주세요.', needManual: true, manualVersion: manualVersionNow() });
    }
    if (b.manual !== agentManual.version) return res.status(409).json({ error: staleNotice(b.manual), stale: true, manualVersion: manualVersionNow() });
    const command = typeof b.command === 'string' ? b.command.trim() : '';
    if (!command || command.length > 60) return res.status(400).json({ error: 'command 가 없습니다' });
    const args = b.args && typeof b.args === 'object' && !Array.isArray(b.args) ? b.args : {};
    pruneAgentCmds();
    if ([...agentCmds.values()].filter(c => c.status === 'pending' || c.status === 'taken').length >= 50) {
      return res.status(429).json({ error: '아직 처리하지 않은 명령이 50개입니다 — 앱이 처리할 때까지 기다려 주세요' });
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const c: AgentCmd = { id, createdAt: now, updatedAt: now, command, args, status: 'pending' };
    agentCmds.set(id, c);
    const waitSec = Math.max(0, Math.min(120, Number(b.wait ?? 30) || 0));
    if (waitSec > 0) {
      await new Promise<void>(resolve => {
        const t = setTimeout(resolve, waitSec * 1000);
        const list = cmdWaiters.get(id) || [];
        list.push(() => { clearTimeout(t); resolve(); });
        cmdWaiters.set(id, list);
      });
    }
    res.json(cmdView(c));
  });

  app.get('/api/agent/commands/:id', (req, res) => {
    pruneAgentCmds();
    const c = agentCmds.get(req.params.id);
    if (!c) return res.status(404).json({ error: '없는 명령입니다 (앱을 다시 켜면 비워집니다)' });
    res.json(cmdView(c));
  });

  app.post('/api/agent/commands/:id/report', (req, res) => {
    const c = agentCmds.get(req.params.id);
    if (!c) return res.status(404).json({ error: 'no such command' });
    const b = req.body || {};
    if (b.status === 'done' || b.status === 'failed') c.status = b.status;
    if (b.result !== undefined) {
      const size = JSON.stringify(b.result).length;
      c.result = size > 2_000_000 ? { truncated: true, note: `결과가 너무 큽니다(${size}자) — 조건을 좁혀 다시` } : b.result;
    }
    if (typeof b.error === 'string') c.error = b.error.slice(0, 4000);
    c.updatedAt = Date.now();
    console.log(`[Agent] 명령 ${c.command} → ${c.status}${c.error ? ` (${c.error.split('\n')[0]})` : ''}`);
    settleCmd(c);
    res.json({ ok: true });
  });

  // ── 목록 썸네일(포스터) ───────────────────────────────────────────────────
  // ★ /api/media/:taskId 보다 먼저 등록한다. 뒤에 두면 '{taskId}/poster' 가 통째로
  //   :taskId 로 잡히지 않고 4-세그먼트라 아예 매칭이 안 된다.
  //
  // 포스터가 없으면 404 다. 클라이언트는 그걸 신호로 삼아 <video> 를 띄우고, 첫 프레임을
  // 캔버스로 떠서 아래 POST 로 올린다. 실패해도(4K HEVC 는 코덱 없는 PC 에서 디코딩이
  // 안 되므로 캡처도 안 된다) 아무 표시를 남기지 않는다 — 다음에 볼 때, 혹은 코덱이 있는
  // 다른 팀원 PC 가 열 때 만들어진다. 포스터는 NCP 에 있으므로 한 번 만들어지면 전원이 본다.
  app.get('/api/media/:taskId/poster', async (req, res) => {
    const taskId = String(req.params.taskId).replace(/[^A-Za-z0-9._-]/g, '');
    if (!taskId) return res.status(400).end();
    const prov = typeof req.query.provider === 'string' ? req.query.provider : undefined;
    const proj = typeof req.query.project === 'string' ? req.query.project : undefined;
    // 26.9.2306~ 메시지는 프로젝트 id 도 힌트로 싣는다 — id 폴더를 먼저, 그다음 만들 때 이름 폴더.
    const projId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    // 1) 로컬 먼저. 영상이 NCP 에서 만료된 뒤에도 여기 남아 있는 것이 이 폴더의
    //    존재 이유다. 트래픽 0 이고 NCP 아웃바운드 과금도 피한다.
    const localPoster = localPosterPath(taskId);
    if (fs.existsSync(localPoster)) {
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      return res.sendFile(localPoster);
    }
    const url = await presignPoster(taskId, prov, proj, projId);
    if (!url) return res.status(404).json({ error: 'no poster' });
    try {
      const up = await fetch(url);
      if (!up.ok || !up.body) return res.status(502).end();
      // 2) NCP 에서 가져왔으면 로컬에도 깔아둔다. 다음부터는 위에서 끝나고, 나중에
      //    NCP 에서 사라져도 이 PC 에는 남는다. 40KB 라 통째로 받아도 부담이 없다.
      const body = Buffer.from(await up.arrayBuffer());
      savePosterLocal(taskId, body);
      res.status(200);
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Content-Length', String(body.length));
      // 포스터는 내용이 바뀌지 않는다(같은 영상의 같은 프레임). 오래 캐시해도 안전하고,
      // 그래야 갤러리를 다시 열 때 NCP 를 또 치지 않는다 — 아웃바운드가 과금이다.
      res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
      res.end(body);
    } catch { res.status(502).end(); }
  });

  // 재생용 H.264 프록시. 생성 결과물이 전부 HEVC 라, 코덱 없는 PC 에서는 4K 는 물론
  // 1080p 도 재생되지 않는다 — 프록시가 있으면 코덱과 무관하게 어디서나 나온다.
  // 없으면 404 를 주고 클라이언트가 마스터로 넘어간다(원본이 이미 H.264 인 경우 포함).
  app.get('/api/media/:taskId/preview', async (req, res) => {
    const taskId = String(req.params.taskId).replace(/[^A-Za-z0-9._-]/g, '');
    if (!taskId) return res.status(400).end();
    const url = await presignPreview(taskId);
    if (!url) return res.status(404).json({ error: 'no preview', state: previewState(taskId) ?? null });
    try {
      const range = req.headers.range;
      const up = await fetch(url, { headers: range ? { Range: range } : {} });
      if (!up.ok && up.status !== 206) return res.status(502).end();
      res.status(up.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = up.headers.get(h); if (v) res.setHeader(h, v);
      }
      if (!up.body) return res.end();
      Readable.fromWeb(up.body as any).pipe(res);
    } catch { res.status(502).end(); }
  });

  app.post('/api/media/:taskId/poster', express.raw({ type: 'image/webp', limit: '2mb' }), async (req, res) => {
    const taskId = String(req.params.taskId).replace(/[^A-Za-z0-9._-]/g, '');
    const prov = typeof req.query.provider === 'string' && req.query.provider ? req.query.provider : 'seedance';
    const proj = typeof req.query.project === 'string' ? req.query.project : '';
    const projId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const buf = req.body as Buffer;
    if (!taskId || !Buffer.isBuffer(buf) || buf.length < 256) return res.status(400).json({ ok: false });
    // 로컬 저장은 NCP 상태와 무관하게 언제나 한다 — 이 PC 에 없으면 남겨야 한다.
    savePosterLocal(taskId, buf);
    if (hasPoster(taskId)) return res.json({ ok: true, already: true, local: true });
    const ok = await putPoster(taskId, prov, proj, buf, projId);
    res.json({ ok });
  });

  // 생성 결과물 재생. 클라이언트는 이 경로 하나만 보고, 서명 URL 은 절대 넘기지 않는다.
  // 이유가 셋이고 전부 측정된 것이다:
  //   (1) blob 캐시가 URL 을 키로 쓴다 — 매번 새 서명이면 적중률이 0 이 되어 볼 때마다
  //       전체를 다시 받는다.
  //   (2) NCP 는 아웃바운드가 과금이다. R2 는 무료였으므로 이 가정이 코드에 깔려 있다.
  //   (3) 서명은 1시간 뒤 죽는다. 시작한 요청은 완주하지만 새 Range(=시킹)는 403 이다.
  // 여기서 서버가 요청마다 새로 서명하면(로컬 연산 0.15ms) 셋 다 사라진다.
  app.get('/api/media/:taskId', async (req, res) => {
    // 색인은 벤더가 준 id 를 그대로 키로 쓰고, 파일 경로에는 정제한 값만 쓴다(경로 탈출 방지).
    // 두 값이 다를 수 있으므로 조회는 둘 다 해본다 — 한쪽만 보면 색인이 있는데도 못 찾는다.
    const rawId = String(req.params.taskId);
    const taskId = rawId.replace(/[^A-Za-z0-9._-]/g, '');
    if (!taskId) return res.status(400).json({ error: 'bad task id' });

    // 색인에 실제로 들어있는 키로 통일한다. 아래 presignArchived 도 이 값을 써야
    // 한다 — 한쪽은 원본, 한쪽은 정제된 값을 쓰면 색인이 있는데도 404 가 난다.
    let indexId = rawId;
    let row = lookupArchived(indexId);
    if (!row) { indexId = taskId; row = lookupArchived(indexId); }
    const qExt = String(req.query.ext || '');
    const ext = row
      ? path.extname(row.key)
      : (/^\.[A-Za-z0-9]{1,5}$/.test(qExt) ? qExt : '.mp4');

    // 1. 로컬 사본 우선. 트래픽 0, 디스크에서 바로 — 프리뷰가 즉시 뜨는 경로다.
    //    Omni 는 캐시 파일 이름이 내용 해시라 taskId 로 유추할 수 없으므로 색인에 적힌
    //    실제 경로를 먼저 본다. 30일 프루너가 지워갔으면 아래 NCP 경로로 내려간다.
    const local = row?.local && fs.existsSync(row.local)
      ? row.local
      : path.join(CACHE_DIR, `${taskId}${ext}`);
    if (fs.existsSync(local)) {
      touchCache(local);
      return res.sendFile(local); // Range 는 express 가 처리한다
    }

    // 2. 로컬에 없으면 NCP 에서. 색인이 없으면(재설치 등) 클라이언트가 들고 있던
    //    project/ext 로 되찾아본다.
    let url = await presignArchived(indexId);
    //    id 힌트가 있으면(26.9.2306~ 메시지) id 폴더를 먼저, 그다음 만들 때 이름 폴더를 본다.
    const hintProject = typeof req.query.project === 'string' ? req.query.project : '';
    const hintProjectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    if (!url && (hintProject || hintProjectId)) {
      const prov = typeof req.query.provider === 'string' && req.query.provider ? req.query.provider : 'seedance';
      url = await recoverFromHints(taskId, prov, hintProject, ext, hintProjectId);
    }
    // 3. 아직 보관 중이라면(큐에 남아 있다면) 그동안은 원본에서 내보낸다. 생성 직후
    //    다운로드를 누르면 보관 전이라 404 였고, 다운로드는 조용히 실패했다.
    //    ★ 프록시로 내려가지 않는다 — 여기서도 받는 건 원본이다.
    if (!url) {
      const p = pendingSource(indexId) || pendingSource(taskId);
      if (p?.localPath && fs.existsSync(p.localPath)) { touchCache(p.localPath); return res.sendFile(p.localPath); }
      if (p?.sourceUrl) url = p.sourceUrl;
    }
    if (!url) return res.status(404).json({ error: 'not archived' });

    try {
      const range = req.headers.range;
      const upstream = await fetch(url, { headers: range ? { Range: range } : {} });
      if (!upstream.ok && upstream.status !== 206) {
        return res.status(502).json({ error: `NCP ${upstream.status}` });
      }
      res.status(upstream.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.body) return res.end();
      Readable.fromWeb(upstream.body as any).pipe(res);
    } catch (e: any) {
      res.status(502).json({ error: `NCP 재생 실패: ${e?.message || e}` });
    }
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
    // 어셋 라이브러리 이미지는 라이브러리 id 로 온다 — 캐시에 없으면 원본 폴더에서 찾는다.
    // 어느 쪽이든 파일 바이트를 그대로 R2 에 올린다(변환 없음).
    const cachePath = resolveMediaFile(req.params.cacheId);
    console.log(`[Re-upload] ${req.params.cacheId}...`);

    try {
      if (!cachePath) {
        return res.status(404).json({ error: 'Cached file not found. Please re-attach the file.' });
      }
      if (cachePath.startsWith(CACHE_DIR)) touchCache(cachePath); // 전송에 쓰임 → 30일 시계 리셋
      const fileBuffer = fs.readFileSync(cachePath);
      const publicUrl = await uploadToR2(fileBuffer, path.basename(cachePath));
      console.log(`[Re-upload] R2 OK → ${publicUrl.substring(0, 80)}...`);
      res.json({ url: publicUrl });
    } catch (error: any) {
      console.error('[Re-upload] Error:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // ★ 경로에서 다시 읽은 파일이 '첨부했던 그 파일' 인가.
  // cacheId 는 첨부 때 내용의 md5 앞 12자리다 — 원본의 지문을 이미 들고 있는 셈이다.
  // 같은 이름으로 수정본을 덮어쓴 뒤 캐시가 지워지면(30일·캐시 정리) 예전에는 경로의 새
  // 내용을 아무 말 없이 대신 보냈다. 카드 썸네일은 옛 버전인데 나가는 건 수정본이었다.
  // 호출하는 쪽이 기대값을 주면 비교해서, 다르면 409 로 멈춘다 — 캐시에도 R2 에도 아무것도
  // 남기지 않는다. 형식이 다른 옛 id 는 비교할 근거가 없으므로 예전처럼 통과시킨다.
  function contentChanged(expectCacheId: unknown, hash: string): boolean {
    if (typeof expectCacheId !== 'string') return false;
    const m = /^([0-9a-f]{12})/.exec(expectCacheId);
    return !!m && m[1] !== hash;
  }
  const CHANGED_MSG = '첨부한 뒤 원본 파일의 내용이 바뀌었습니다 (같은 이름의 수정본).';

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
      if (contentChanged(req.body?.expectCacheId, hash)) {
        console.warn(`[Cache from path] 내용이 바뀜 — 기대 ${req.body.expectCacheId}, 지금 ${hash}: ${originalPath}`);
        return res.status(409).json({ error: CHANGED_MSG, changed: true });
      }
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
      // R2 에 올리기 전에 막는다 — 보내지도 않을 수정본이 버킷에 남지 않게.
      if (contentChanged(req.body?.expectCacheId, hash)) {
        console.warn(`[Re-upload from path] 내용이 바뀜 — 기대 ${req.body.expectCacheId}, 지금 ${hash}: ${originalPath}`);
        return res.status(409).json({ error: CHANGED_MSG, changed: true });
      }
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
      const r = await fetch(signedTrackerUrl(`${trackerUrl()}?action=projects`), { redirect: 'follow', signal: ac.signal });
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
      const r = await fetch(signedTrackerUrl(`${trackerUrl()}?action=projects`), { redirect: 'follow', signal: ac.signal });
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

  // POST JSON over node:https with NO response deadline.
  //
  // node's built-in fetch (undici) applies a 300s headersTimeout that cannot be changed
  // without the `undici` package — which is not a dependency here and resolves, on this
  // machine only, from outside the project. Gemini Omni is a SYNCHRONOUS API: a 4K extend
  // holds the connection well past five minutes, so fetch killed the request before Google
  // ever answered and every 4K extend failed with the bare string "fetch failed" (measured
  // 2026-08-28: 319s, always). https.request has no such default, so the wait is bounded by
  // the caller instead — the client's own 15-minute abort, or the user closing the card,
  // which reaches us through `signal`.
  function postJsonNoDeadline(url: string, headers: Record<string, string>, payload: string, signal?: AbortSignal):
    Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      // Both node's own socket timeout and the 300s default are off; only an explicit abort
      // or a dead socket ends this.
      req.setTimeout(0);
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) { req.destroy(new Error('aborted')); }
        else signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      }
      req.write(payload);
      req.end();
    });
  }

  // ── Gemini Omni Flash — video generation proxy (separate provider) ──────────
  // Uses NANOBANANA_STUDIO_KEY (Google AI Studio). The Interactions create call is
  // SYNCHRONOUS (~30-40s for a 720p clip) and returns the video inline as base64
  // (720p clips run ~1-3MB, under the 4MB uri threshold). We cache the bytes as an
  // .mp4 and hand back a served /api/cache URL, so the chat message stores a small
  // string rather than a multi-MB base64 data URL → no IndexedDB bloat. The
  // frontend builds the full Omni payload; this only injects the key + normalizes
  // the response. Entirely independent of the BytePlus path.
  // Resumable upload of a media buffer to the Gemini Files API → returns the file uri
  // once ACTIVE (used for the Edit/Extend source video, which must be a Files API ref).
  //
  // Returns the REASON on failure, not just null. This had four distinct failure paths —
  // the start call, the byte upload, the file being rejected during processing, and simply
  // running out of patience — and every one of them surfaced to the user as the same
  // "소스 영상 업로드 실패 (Files API)". With four causes behind one sentence there is
  // nothing to act on and nothing to debug.
  async function uploadToFilesApi(buf: Buffer, mime: string, key: string): Promise<{ uri?: string; error?: string }> {
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
    if (!uploadUrl) {
      const t = await start.text().catch(() => '');
      const m = (() => { try { return JSON.parse(t)?.error?.message; } catch { return null; } })();
      console.warn('[Gemini] Files start failed', start.status, m || t.slice(0, 200));
      return { error: `업로드를 시작하지 못했습니다 (Files API ${start.status})${m ? ': ' + m : ''}` };
    }
    const up = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0', 'Content-Length': String(buf.length) },
      body: buf,
    });
    const upJson: any = await up.json().catch(() => ({}));
    const file = upJson.file || upJson;
    if (!file?.name) {
      const m = upJson?.error?.message;
      console.warn('[Gemini] Files upload failed', up.status, m || '');
      return { error: `영상 전송이 거부되었습니다 (Files API ${up.status})${m ? ': ' + m : ''} · 형식 ${mime}` };
    }
    // Google transcodes the upload before it can be referenced, and the wait scales with the
    // clip. This was capped at 40 x 3s = 2 minutes, which is short enough that a perfectly
    // good upload got reported as a failure while it was still PROCESSING (measured: a 9.4MB
    // 1080p source failed at 215s total, which is start + upload + exactly this 120s). The
    // client now waits 40 minutes, so there is no reason for this to be the impatient one.
    const POLL_MS = 3000, POLL_BUDGET_MS = 10 * 60 * 1000;
    let state = file.state || '';
    const t0 = Date.now();
    while (state !== 'ACTIVE' && Date.now() - t0 < POLL_BUDGET_MS) {
      const fr = await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, { headers: { 'x-goog-api-key': key } });
      const fd: any = await fr.json().catch(() => ({}));
      state = fd?.state || '';
      if (state === 'FAILED') {
        const m = fd?.error?.message;
        console.warn('[Gemini] source file FAILED', m || '');
        return { error: `Google이 이 영상을 처리하지 못했습니다${m ? ': ' + m : ''} · 형식 ${mime}
지원 형식(mp4·mov·webm·mpeg·wmv·3gpp·flv)의 일반 코덱으로 변환한 뒤 다시 올려주세요.` };
      }
      if (state !== 'ACTIVE') await new Promise((r) => setTimeout(r, POLL_MS));
    }
    if (state !== 'ACTIVE') {
      console.warn('[Gemini] source file not ACTIVE within budget, last state:', state || '(없음)');
      return { error: `영상 처리가 10분 안에 끝나지 않았습니다 (마지막 상태: ${state || '알 수 없음'}). 더 짧거나 가벼운 영상으로 다시 시도해주세요.` };
    }
    return { uri: file.uri };
  }

  app.post('/api/gemini/generate', async (req, res) => {
    const shared = (process.env.NANOBANANA_STUDIO_KEY || '').trim();
    const KEY = process.env.SEEDANCE_GEMINI_KEY || (shared && shared !== 'managed-by-gateway' ? shared : '');
    if (!KEY) { console.error('[Gemini] NANOBANANA_STUDIO_KEY not set'); return res.status(500).json({ error: 'NANOBANANA_STUDIO_KEY가 설정되지 않았습니다.' }); }
    console.log('[Gemini] Omni generate...');
    try {
      const body: any = req.body && typeof req.body === 'object' ? req.body : {};
      // 앱 전용 필드. NCP 폴더 이름으로만 쓰고 구글로는 절대 보내지 않는다 —
      // Interactions API 는 모르는 필드에 400 을 낸다(BytePlus 쪽 `project` 와 같은 취급).
      const _archiveProject = typeof body.project === 'string' ? body.project : '';
      const _archiveModel = typeof body.model === 'string' ? body.model : '';
      // 보관 폴더를 프로젝트 id 로 정하려고 받는다(없으면 이름 폴더). 구글로는 보내지 않는다.
      const _archiveProjectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
      delete body.project;
      delete body.project_id;
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
              const p = resolveMediaFile(cacheRef);
              if (p) buf = fs.readFileSync(p);
            } else if (dataRef) {
              buf = Buffer.from(dataRef, 'base64');
            }
            if (!buf) return res.status(502).json({ error: '소스 영상을 찾지 못했습니다 (캐시 유실 — 다시 올려주세요).' });
            const up = await uploadToFilesApi(buf, part.mime_type || 'video/mp4', KEY);
            if (!up.uri) return res.status(502).json({ error: up.error || '소스 영상 업로드 실패 (Files API)' });
            part.uri = up.uri;
          }
          // Always strip the private upload markers so they never reach the API.
          delete part._uploadData; delete part._uploadCacheId;
        }
      }
      // Edit derives duration/aspect from the source video — the API 400s if either is set.
      // Extend derives geometry the same way but NOT length: its `duration` is how many
      // seconds to APPEND (verified 2026-08-28 — 10s source + '3s' → 13.0s, omitted → 20.0s),
      // so only aspect_ratio comes off. Sending it returns
      //   "Aspect ratio cannot be set in response format for extend task."
      // `resolution` is NOT in that group and must be passed through: both tasks accept and
      // honour it (a 360p source with resolution:'1080p' returns 1920x1080). Dropping it here
      // is what silently capped edit/extend output at 720p, so a 4K source came back 720p.
      const _omniTask = body?.generation_config?.video_config?.task;
      if ((_omniTask === 'edit' || _omniTask === 'extend') && body.response_format) {
        if (_omniTask === 'edit') delete body.response_format.duration;
        delete body.response_format.aspect_ratio;
      }
      // previous_interaction_id and video_config.task are MUTUALLY EXCLUSIVE — the API
      // answers "previous_interaction_id is not allowed when video task is set." Every
      // Omni path here sends an explicit task, so the id can never ride along.
      if (_omniTask && body.previous_interaction_id) delete body.previous_interaction_id;
      // Synchronous unary generation (doc's recommended fast path). store MUST be true —
      // the API rejects delivery:"uri" (which we always use) unless store=true, so store=false
      // from the doc's perf tip is NOT usable here. background/stream=false = plain sync call.
      body.background = false;
      body.stream = false;
      body.store = true;
      // Hang up on Google the moment the app gives up. Without this the generation runs to
      // completion on a request nobody is waiting for any more — the result is written to a
      // cache id the client never learns, and the tokens are spent all the same. /api/download
      // has had this guard for the same reason; this route did not.
      const geminiCtrl = new AbortController();
      // ★ res, not req. `req` (IncomingMessage) emits 'close' as soon as the request stream
      // is consumed — for a POST that is right after body-parser reads the JSON, long before
      // we answer — so listening there aborted our own upstream call on every single request
      // and every Omni generation failed instantly with "요청이 취소되었습니다". The response
      // stream is the one that closes when the CLIENT actually goes away, which is what
      // /api/download has always used.
      res.on('close', () => { if (!res.writableEnded) { try { geminiCtrl.abort(); } catch { /* already settled */ } } });
      const r = await postJsonNoDeadline(
        'https://generativelanguage.googleapis.com/v1beta/interactions',
        { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
        JSON.stringify(body), geminiCtrl.signal,
      );
      const text = r.text;
      const rOk = r.status >= 200 && r.status < 300;
      let data: any; try { data = JSON.parse(text); } catch { return res.status(r.status || 502).json({ error: `Gemini 응답 파싱 실패 (${r.status})` }); }
      if (!rOk) {
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
      // Omni 도 같은 보관소로 보낸다. 24시간 만료 문제는 없지만 media-cache 는 30일
      // 프루너에 지워지고 그 PC 에서만 유효하다 — 결과물이 사라지는 건 마찬가지다.
      // 파일이 이미 로컬에 있으므로 다운로드 단계를 건너뛴다.
      enqueueArchive({ taskId: data.id, provider: brandOf(_archiveModel), project: _archiveProject, projectId: _archiveProjectId, ext: '.mp4', model: _archiveModel, localPath: cachePath });
      res.json({ id: data.id, status: data.status || 'completed', videoUrl: `/api/cache/${cacheId}`, usage: data.usage });
    } catch (error: any) {
      // node's fetch reports every transport failure as the bare string "fetch failed",
      // including its own 300s headersTimeout — which is what a slow 4K job hits. Passing
      // that through gave the user a two-word error with nothing to act on. Name the case.
      const raw = error?.message || String(error);
      const msg = error?.name === 'AbortError'
        ? '요청이 취소되었습니다.'
        : raw === 'fetch failed'
          ? 'Gemini 응답이 5분 안에 오지 않았습니다 (node fetch 기본 한도). 4K 등 무거운 요청에서 발생합니다 — 해상도를 낮추거나 원본을 짧게 해주세요.'
          : raw;
      console.error('[Gemini] fetch error', raw);
      res.status(500).json({ error: msg });
    }
  });

  // BytePlus API — Create Task
  app.post('/api/byteplus/tasks', async (req, res) => {
    console.log('[BytePlus API] Creating task...');

    // Pull the app-only `project` / `project_id` (billing/tracking) out — BytePlus must never
    // receive them (unknown top-level fields can 400). The rest is forwarded as-is.
    const { project: billingProject, project_id: rawProjectId, ...byteplusBody } = (req.body && typeof req.body === 'object') ? req.body : {};
    const billingProjectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';

    // Gated models (2.5) must be granted to the SELECTED billing project. Checked here,
    // against the tracker, so no amount of switching app projects / models / stored state
    // gets a request through.
    // ★ id 가 있으면 id 로 찾는다 — 이름은 PM 프로그램에서 바뀔 수 있고, 이름으로만 찾던 때는
    //   이름이 바뀐 직후(앱 목록이 아직 옛 이름) 권한 없음으로 막혔다. id 가 없거나(트래커 전용
    //   프로젝트) 로스터에 아직 없으면 이름으로 찾는다.
    const grant = MODEL_GRANTS[byteplusBody.model as string];
    if (grant) {
      const roster = await getRoster();
      if (!roster) {
        return res.status(503).json({ error: { message: '크레딧 시트를 확인할 수 없어 이 모델을 사용할 수 없습니다. 잠시 후 다시 시도해주세요.' } });
      }
      const row = (billingProjectId && roster.find((p: any) => String(p?.id || p?.project_id || '').trim() === billingProjectId))
        || roster.find((p: any) => String(p?.project) === String(billingProject));
      if (row?.[grant] !== true) {
        const shown = row?.project || billingProject || '선택 없음';   // 문구엔 지금 이름
        console.warn(`[Grant] blocked ${byteplusBody.model} for project "${shown}" id=${billingProjectId || '-'} (${grant}=${row?.[grant]})`);
        return res.status(403).json({ error: { message: `"${shown}" 프로젝트는 이 모델 권한이 없습니다.` } });
      }
    }

    try {
      const create = () => fetch(bpTasks(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey()}` },
        body: JSON.stringify(byteplusBody)
      });
      let response = await create();
      // 401 = 키가 틀렸다(관리자가 Cloudflare 에서 바꾸고 옛 키를 끊음). 게이트웨이에서 새로 받았으면 한 번만 다시.
      // 만들기는 401 이면 태스크가 안 생기므로 다시 보내도 두 번 만들어지지 않는다.
      if (response.status === 401 && await refreshKeys('BytePlus 401')) response = await create();

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
      const projName = typeof billingProject === 'string' ? billingProject : '';
      if (response.ok && data?.id && (projName || billingProjectId)) {
        taskToProject.set(data.id, { project: projName, projectId: billingProjectId });
        taskProjectAt.set(data.id, Date.now());
        saveTaskProjects();   // 재시작을 넘겨야 하므로 만든 즉시 디스크에 남긴다
        console.log(`[Tracker] task ${data.id} → project "${projName}"${billingProjectId ? ` (${billingProjectId})` : ''}`);
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
      const response = await fetch(`${bpTasks()}/${req.params.id}`, {
        headers: { 'Authorization': `Bearer ${apiKey()}` }
      });
      if (response.status === 401) refreshKeys('BytePlus 401').catch(() => {});   // 다음 조회부터 새 키
      const data = await response.json() as any;

      // Fire-and-forget report to the credit tracker. Only fires once per task
      // (reportedTasks dedupes), only on success with valid usage data, and any
      // failure here is swallowed so the polling response to the frontend is
      // never delayed or corrupted.
      if (data?.status === 'succeeded' && data?.usage?.total_tokens && !reportedTasks.has(req.params.id)) {
        reportedTasks.add(req.params.id);
        fetch(trackerUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(trackerAuth() || {}),   // ts + proof
            team: teamName(),
            project: taskToProject.get(req.params.id)?.project || '', // billing project (may be '')
            // 트래커가 이 id 로 프로젝트를 찾아 '지금 이름' 으로 적는다. 이름이 그 사이 바뀌었어도
            // 기록이 한 프로젝트로 모인다. 없으면('') 트래커가 project(이름)로 찾는다.
            project_id: taskToProject.get(req.params.id)?.projectId || '',
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

      // 성공 → NCP 보관 예약. 반드시 아래 taskToProject.delete 보다 먼저 읽어야 한다.
      // 폴더 이름이 프로젝트라서 그 값이 사라진 뒤엔 어디에 넣을지 알 수 없다.
      // 큐잉만 하고 즉시 넘어간다 — 폴링 응답은 8초 안에 끝나야 한다.
      if (data?.status === 'succeeded' && data?.content?.video_url) {
        const srcUrl = String(data.content.video_url);
        // 확장자는 URL 에서 뽑는다. 2.5 는 .mov 를 준다. 이 URL 은 24시간 뒤 없어지므로
        // 지금 결정해 두지 않으면 나중에는 확정할 방법이 없다.
        const ext = (srcUrl.split('?')[0].match(/\.(mp4|mov|m4v|webm)$/i) || ['.mp4'])[0].toLowerCase();
        enqueueArchive({
          taskId: req.params.id,
          // 폴더는 모델이 정한다 — 레인마다 상수를 박아두면 회사가 늘 때 또 갈라진다.
          provider: brandOf(data.model),
          // NCP 폴더는 지금처럼 '보낼 때의 이름' 이다. 이름이 바뀐 뒤 만든 영상은 새 이름 폴더로
          // 간다(옛 영상은 옛 폴더에 그대로, 앱은 메시지에 구워 둔 이름으로 찾는다).
          project: taskToProject.get(req.params.id)?.project || '',
          // id 가 있으면 폴더가 id 가 된다(ncp.ts / archiveFolder). 없으면 지금처럼 이름 폴더.
          projectId: taskToProject.get(req.params.id)?.projectId || '',
          ext,
          model: typeof data.model === 'string' ? data.model : '',
          sourceUrl: srcUrl,
        });
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
      const cancel = () => fetch(`${bpTasks()}/${req.params.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${apiKey()}` }
      });
      let response = await cancel();
      if (response.status === 401 && await refreshKeys('BytePlus 401')) response = await cancel();
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

  // ★ 이 PC 안에서만 연다(26.10.301~). 예전 0.0.0.0 은 같은 망(회사 와이파이 · 사내망)의 누구나 이 PC 의 작업
  //   기록 · 백업 · 어셋 원본 · 생성 영상을 읽고 파일을 쓸 수 있었다. 앱은 같은 PC 에서 localhost 로만 부른다
  //   (창 주소 · 메인 프로세스의 확인 요청 · start.bat/start.command) — 0.0.0.0 도 IPv4 라 localhost 동작은 같다.
  //   바깥 서비스(BytePlus · Gemini · NCP · 트래커)는 이 서버로 들어오지 않는다 — R2 링크 · 나가는 요청뿐.
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Freewill Seedance 2.0`);
    console.log(`  ========================`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  Press Ctrl+C to stop\n`);
  });
}

startServer();
