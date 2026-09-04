/**
 * NCP Object Storage — 생성 결과물의 장기 보관소.
 *
 * R2 와 역할이 겹치지 않는다. R2 는 입력(참조 이미지·영상·오디오)을 BytePlus 가 가져갈 수
 * 있도록 잠깐 올려두고 태스크가 끝나면 지우는 곳이고, 여기는 완성된 영상을 오래 두는
 * 곳이다. 두 저장소는 서로를 모르고, 서로의 코드도 건드리지 않는다.
 *
 * 왜 필요한가: BytePlus 가 돌려주는 content.video_url 은 약 24시간 뒤 죽는다. 그때까지
 * 복제해 두지 않으면 과거 영상은 재생도 다운로드도 불가능해진다.
 *
 * ── 자격 증명 ──────────────────────────────────────────────────────────────────
 * NCP 키는 PC 에 심지 않는다. PC 는 이미 R2 키를 갖고 있으므로(R2.bat), 그 키로 서명해서
 * seedance-gateway 워커에 요청하면 내려온다(worker/seedance-gateway.js).
 * 메모리에만 들고 있으므로 앱을 끄면 사라지고 다음 실행 때 다시 받는다 — 키 회전이
 * 워커 시크릿 교체 한 번으로 끝나는 이유이자, setx 로 환경변수에 굽지 않는 이유다.
 * (환경변수는 레지스트리에 평문으로 남고, 새로 뜨는 프로세스부터만 적용되어 자동
 *  업데이트로 재시작한 앱이 옛 값을 계속 쓰는 문제가 있다 — 제미나이 키에서 겪은 그것.)
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const GATEWAY_URL = process.env.SEEDANCE_GATEWAY_URL || 'https://seedance-gateway.production-khu.workers.dev';

export type NcpReady = {
  client: S3Client;
  bucket: string;
  presignExpires: number;
};

// ── 자격 증명 ────────────────────────────────────────────────────────────────
let ready: NcpReady | null = null;
let inFlight: Promise<NcpReady | null> | null = null;
let lastFailAt = 0;
const RETRY_COOLDOWN_MS = 60 * 1000;

// 부팅 게이트가 사용자에게 "무엇이 잘못됐는지"를 말해줄 수 있도록 마지막 실패 이유를
// 남긴다. 그냥 "연결 실패"라고만 하면 R2.bat 을 안 돌린 것인지, 시계가 틀어진 것인지,
// 워커가 죽은 것인지 구분할 수 없어 사용자가 할 수 있는 일이 없다.
let lastError = '게이트웨이에 아직 연결하지 않았습니다.';
export function lastNcpError() { return lastError; }
/** 부팅 게이트의 재시도용. 1분 쿨다운을 무시하고 즉시 다시 시도하게 한다. */
export function resetNcpBackoff() { lastFailAt = 0; }

/**
 * 워커에서 자격 증명을 받아 S3 클라이언트를 만든다. 한 번 성공하면 프로세스가 살아있는
 * 동안 재사용한다. 실패는 던지지 않고 null 을 돌려준다 — NCP 가 죽어도 생성 자체는
 * 계속 돌아가야 하기 때문이다. 실패 직후 1분은 재시도하지 않는다(워커 장애 시
 * 매 폴링마다 두드리는 것을 막는다).
 */
export async function ensureNcp(): Promise<NcpReady | null> {
  if (ready) return ready;
  if (inFlight) return inFlight;
  if (Date.now() - lastFailAt < RETRY_COOLDOWN_MS) return null;

  inFlight = (async () => {
    try {
      const r2Secret = process.env.R2_SECRET_ACCESS_KEY;
      if (!r2Secret) {
        lastError = 'R2_SECRET_ACCESS_KEY 가 없습니다. 게이트웨이 인증에 R2 키를 씁니다.';
        console.warn('[NCP] ' + lastError);
        return null;
      }
      // R2 시크릿 자체는 절대 보내지 않는다. ts 를 재료로 HMAC 만 만들어 보낸다.
      const ts = Date.now();
      const sig = crypto.createHmac('sha256', r2Secret).update(`ncp:${ts}`).digest('hex');

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      let res: Response;
      try {
        res = await fetch(`${GATEWAY_URL}/ncp/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ts, sig, team: process.env.SEEDANCE_TEAM || '' }),
          signal: ac.signal,
        });
      } finally { clearTimeout(timer); }

      const j: any = await res.json().catch(() => ({}));
      if (!res.ok || !j?.ok) {
        // 상태 코드마다 사용자가 할 수 있는 일이 다르다. 그걸 그대로 말해준다.
        lastError =
          res.status === 403 ? 'R2 키가 없거나 다릅니다. F:\\시댄스\\R2.bat 을 실행한 뒤 앱을 완전히 종료하고 다시 켜세요.'
          : res.status === 401 ? `PC 시계가 5분 이상 어긋나 있습니다. 시간을 맞춘 뒤 다시 켜세요. (${j?.error || ''})`
          : res.status === 503 ? '게이트웨이에 NCP 키가 설정되어 있지 않습니다. 관리자에게 알려주세요.'
          : `게이트웨이가 자격 증명을 거부했습니다 (HTTP ${res.status}): ${j?.error || '알 수 없음'}`;
        console.warn('[NCP] ' + lastError);
        return null;
      }

      const client = new S3Client({
        region: j.region || 'kr-standard',
        endpoint: j.endpoint,
        credentials: { accessKeyId: j.accessKeyId, secretAccessKey: j.secretAccessKey },
        forcePathStyle: true,
      });
      ready = { client, bucket: j.bucket, presignExpires: Number(j.presignExpiresSeconds) || 3600 };
      console.log(`[NCP] 준비됨 — bucket ${ready.bucket}, presign ${ready.presignExpires}s`);
      return ready;
    } catch (e: any) {
      lastError = e?.name === 'AbortError' || e?.name === 'TimeoutError'
        ? '게이트웨이가 15초 안에 응답하지 않았습니다 (네트워크 또는 워커 장애).'
        : `게이트웨이에 연결할 수 없습니다: ${e?.message || e}`;
      console.warn('[NCP] ' + lastError);
      return null;
    } finally {
      inFlight = null;
    }
  })();

  const out = await inFlight;
  if (!out) lastFailAt = Date.now();
  return out;
}

// ── object key ──────────────────────────────────────────────────────────────
/** 결과물을 만든 곳. 최상위 폴더가 되므로 값이 늘어나도 두 글자 이상 겹치지 않게 둘 것. */
export type Provider = 'seedance' | 'google';

/**
 * `{provider}/{프로젝트}/{taskId}{ext}`
 *
 * 콘솔에서 "시댄스냐 구글이냐 → 어느 프로젝트냐" 순으로 좁혀 들어가는 구조다.
 * 파일 이름은 taskId 만 쓴다 — 벤더가 준 불변 고유값이고, taskId 앞머리가 타임스탬프라
 * 이름순 정렬이 곧 시간순이 된다. 모델은 파일 이름 대신 객체 메타데이터에 넣는다.
 *
 * 실제 프로젝트 이름에 대괄호·한글·공백·`&` 가 들어있고(예: "[26P50]DL E&C PT"),
 * 전부 그대로 통과하는 것을 확인했다. 다만 두 가지는 반드시 걸러야 한다:
 *   - `/` 는 폴더를 하나 더 만들어 버린다 → `_`
 *   - 앞뒤 공백은 눈에 안 보이는데 다른 폴더가 된다 → trim
 * 그리고 URL 은 절대 손으로 붙이지 말 것. `&` 때문에 깨진다. 항상 SDK 에 Key 로 넘긴다.
 */
export function objectKeyFor(provider: Provider, project: string, taskId: string, ext: string): string {
  const prov: Provider = provider === 'google' ? 'google' : 'seedance';
  const p = String(project || '_없음')
    .replace(/[\/\\]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 180) || '_없음';
  const t = String(taskId).replace(/[^A-Za-z0-9._-]/g, '');
  const e = /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext : '.mp4';
  return `${prov}/${p}/${t}${e}`;
}

// ── taskId → 보관 위치 색인 ──────────────────────────────────────────────────
// 재생할 때 key 를 다시 계산하지 않기 위한 것이다. 계산은 불가능한 순간이 온다:
// 확장자(.mp4 / 2.5 는 .mov)는 API 가 돌려준 URL 에서 뽑는데 그 URL 은 24시간 뒤 없다.
// local: 로컬 사본의 실제 경로. Omni 는 파일 이름이 내용 해시라 taskId 로 유추할 수 없어서
// 여기 적어 둔다 — 프리뷰가 NCP 를 안 타고 디스크에서 바로 나오는 경로다.
type IndexRow = { key: string; bucket: string; size: number; at: number; project: string; local?: string };
let INDEX_FILE = '';
const mediaIndex = new Map<string, IndexRow>();

export function initNcpIndex(cacheDir: string) {
  INDEX_FILE = path.join(cacheDir, 'media-index.json');
  mediaIndex.clear(); // 다시 불러도 같은 결과가 나오도록 — 파일이 없으면 비어야 한다
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as Record<string, IndexRow>;
    for (const [k, v] of Object.entries(raw || {})) if (v?.key) mediaIndex.set(k, v);
    if (mediaIndex.size) console.log(`[NCP] 색인 ${mediaIndex.size}건 복원`);
  } catch { /* 없거나 깨졌으면 빈 상태 — 색인은 캐시지 원장이 아니다 */ }
}

function saveIndex() {
  if (!INDEX_FILE) return;
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(Object.fromEntries(mediaIndex)));
  } catch (e: any) { console.warn('[NCP] 색인 저장 실패:', e?.message); }
}

export function lookupArchived(taskId: string): IndexRow | undefined {
  return mediaIndex.get(taskId);
}

// ── 아카이브 ────────────────────────────────────────────────────────────────
type Job = {
  taskId: string; provider: Provider; project: string; ext: string; model?: string;
  sourceUrl?: string; localPath?: string; tries: number;
};
const queue = new Map<string, Job>();
const running = new Set<string>();
// 링크가 만료돼 더 해볼 게 없다고 판단한 taskId. 디스크에 남겨야 한다 — 앱을 켤 때마다
// 소급 보관이 히스토리 전체를 다시 보내는데, 이게 없으면 죽은 링크 수백 개를 매 실행
// 새 작업으로 받아 3번씩 다시 두드린다(포기하면 큐에서 빠지므로 tries 가 0 으로 리셋된다).
const gaveUp = new Set<string>();
let QUEUE_FILE = '';
let DEAD_FILE = '';
let CACHE_DIR = '';

export function initNcpQueue(cacheDir: string) {
  CACHE_DIR = cacheDir;
  QUEUE_FILE = path.join(cacheDir, 'ncp-archive-queue.json');
  DEAD_FILE = path.join(cacheDir, 'ncp-archive-dead.json');
  queue.clear(); gaveUp.clear();
  try {
    const raw = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) as Job[];
    // 소스 URL 은 24시간이면 죽지만 localPath 는 안 죽는다. 재시작 후에도 로컬 파일이
    // 남아 있으면 며칠 뒤에도 올릴 수 있다 — 워커/NCP 장애가 영상 유실로 번지지 않는 이유.
    for (const j of raw || []) if (j?.taskId) queue.set(j.taskId, j);
    if (queue.size) console.log(`[NCP] 미완료 아카이브 ${queue.size}건 복원`);
  } catch { /* 비어서 시작 */ }
  try {
    for (const id of JSON.parse(fs.readFileSync(DEAD_FILE, 'utf8')) || []) gaveUp.add(String(id));
  } catch { /* 비어서 시작 */ }

  // 강제 종료로 남은 반쪽 다운로드를 치운다. 1시간이 지난 것만 건드린다 — 지금 받는
  // 중인 파일을 지우지 않기 위해서다(4K 는 몇 분씩 걸린다).
  try {
    const now = Date.now();
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.endsWith('.part')) continue;
      const fp = path.join(cacheDir, f);
      if (now - fs.statSync(fp).mtimeMs > 60 * 60 * 1000) {
        fs.rmSync(fp, { force: true });
        console.log(`[NCP] 중단된 임시 파일 정리: ${f}`);
      }
    }
  } catch { /* best-effort */ }
}

function saveQueue() {
  if (!QUEUE_FILE) return;
  try { fs.writeFileSync(QUEUE_FILE, JSON.stringify([...queue.values()])); } catch { /* best-effort */ }
}

function saveDead() {
  if (!DEAD_FILE) return;
  // 무한히 자라지 않도록 최근 5000개만 남긴다. Set 은 삽입 순서를 지킨다.
  try {
    const all = [...gaveUp];
    fs.writeFileSync(DEAD_FILE, JSON.stringify(all.slice(-5000)));
  } catch { /* best-effort */ }
}

/**
 * 보관 요청. 폴링 응답을 붙잡지 않도록 즉시 반환하고 백그라운드에서 진행한다.
 * 같은 taskId 가 여러 번 들어와도(폴링은 같은 succeeded 를 두 번 볼 수 있다) 한 번만 돈다.
 */
export function enqueueArchive(job: Omit<Job, 'tries'>) {
  if (!job.taskId) return;
  if (mediaIndex.has(job.taskId) || running.has(job.taskId)) return;
  // 포기한 건 다시 받지 않는다. 단 로컬 사본이 딸려 왔다면 이야기가 다르다 —
  // 링크가 죽었어도 파일이 있으면 올릴 수 있다.
  if (gaveUp.has(job.taskId) && !(job.localPath && fs.existsSync(job.localPath))) return;
  if (!queue.has(job.taskId)) {
    queue.set(job.taskId, { ...job, tries: 0 });
    saveQueue();
  }
  void drain();
}

// 동시에 여러 번 불려도 한 번만 돈다. 다만 이미 도는 중일 때 그냥 반환하면 안 된다 —
// 호출자가 await 했을 때 "끝났다"고 거짓말을 하게 된다. 같은 약속을 돌려준다.
let drainPromise: Promise<void> | null = null;
export function drain(): Promise<void> {
  if (drainPromise) return drainPromise;

  const run = async () => {
    // 한 사이클에 한 작업당 한 번만 시도한다. 계속 실패하는 작업이 큐에 남아
    // 무한 루프가 되지 않도록 하는 장치다 — 재시도는 다음 사이클(성공 이벤트나
    // 주기 타이머)에 맡긴다.
    const attempted = new Set<string>();
    for (;;) {
      const batch = [...queue.values()].filter(j => !running.has(j.taskId) && !attempted.has(j.taskId));
      if (!batch.length) break;
      for (const job of batch) {
        attempted.add(job.taskId);
        running.add(job.taskId);
        try { await archiveOne(job); }
        finally { running.delete(job.taskId); }
      }
    }
  };

  // ★ 해제를 try/finally 안에 두면 안 된다. 큐가 비어 있으면 async 본문에 await 이
  //   하나도 없어서 finally 가 `drainPromise = ...` 대입보다 "먼저" 실행되고, 그 뒤에
  //   대입이 일어나 플래그가 영원히 세워진 채로 남는다. 그러면 이후 모든 drain 이
  //   즉시 반환하고 보관이 통째로 죽는다 — 부팅 때 항상 빈 큐로 한 번 돌기 때문에
  //   모든 PC 에서 100% 재현되는 버그였다.
  //   .finally 콜백은 절대 동기로 실행되지 않으므로 대입이 항상 먼저 끝난다.
  // archiveOne 은 스스로 잡아내지만, 예기치 못한 rejection 이 void drain() 을 타고
  // unhandled rejection 이 되어 프로세스를 죽이는 일이 없도록 한 겹 더 받는다.
  drainPromise = run()
    .catch(e => console.warn('[NCP] 큐 처리 중 예외:', e?.message || e))
    .finally(() => { drainPromise = null; });
  return drainPromise;
}

/**
 * 전송이 멈추면 끊는 감시자.
 *
 * 총 시간이 아니라 "마지막 바이트 이후 경과"를 본다. 4K 200MB 를 느린 회선으로 받는
 * 것과, 연결만 붙잡고 아무것도 안 보내는 것은 총 시간으로는 구분되지 않기 때문이다.
 * 전자는 계속 진행시키고 후자만 끊어야 한다.
 *
 * ★ 이게 없으면 멈춘 소스 하나가 큐 전체를 세운다. drain 은 순차 실행이고, 멈춘 작업
 *   뒤의 정상 작업은 영원히 대기한다. 더 나쁜 건 drainPromise 가 물린 채로 남아서
 *   이후의 모든 drain() 호출이 그 promise 를 그대로 돌려주고 아무 일도 하지 않는다는
 *   것이다 — 그 세션 동안 보관이 통째로 죽는다. 재현해서 확인한 동작이다.
 *   (node 의 기본 headersTimeout 이 300초라 언젠가는 풀리지만, 소급 보관처럼 수백 건이
 *    줄 서 있으면 그 사이 큐는 멈춰 있다.)
 */
function stallGuard(ms: number, what: string) {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`${what}이(가) ${ms / 1000}초 동안 멈춰 중단했습니다`)), ms);
  };
  kick();
  const tap = new Transform({ transform(chunk, _enc, cb) { kick(); cb(null, chunk); } });
  return { signal: ac.signal, tap, done: () => clearTimeout(timer) };
}
const STALL_MS = 60 * 1000;

async function archiveOne(job: Job) {
  const ncp = await ensureNcp();
  if (!ncp) return; // 다음 기회에. 큐에 그대로 남는다.

  const key = objectKeyFor(job.provider, job.project, job.taskId, job.ext);
  const t0 = Date.now();

  try {
    // 1. 로컬 사본을 확보한다. 이게 있어야 (a) 프리뷰가 즉시 뜨고 (b) 업로드가
    //    실패해도 원본 URL 이 죽은 뒤에 재시도할 수 있다.
    let local = job.localPath && fs.existsSync(job.localPath) ? job.localPath : '';
    if (!local) {
      if (!job.sourceUrl) throw new Error('소스가 없습니다 (URL 도 로컬 파일도 없음)');
      // taskId 와 ext 는 벤더 응답과 소급 보관 요청에서 온다. 그대로 파일명에 붙이면
      // `/` 나 `..` 한 글자로 캐시 디렉터리 밖에 쓰게 된다. 경로에 쓰는 값은 항상 정제한다.
      // (objectKeyFor 도 같은 규칙으로 정제하므로 로컬 이름과 NCP 키가 어긋나지 않는다.)
      const safeName = String(job.taskId).replace(/[^A-Za-z0-9._-]/g, '') || 'unknown';
      const safeExt = /^\.[A-Za-z0-9]{1,5}$/.test(job.ext) ? job.ext : '.mp4';
      local = path.join(CACHE_DIR, `${safeName}${safeExt}`);
      if (!fs.existsSync(local)) {
        const g = stallGuard(STALL_MS, '원본 다운로드');
        let r: Response;
        try { r = await fetch(job.sourceUrl, { signal: g.signal }); }
        catch (e) { g.done(); throw e; }
        if (!r.ok || !r.body) { g.done(); throw new Error(`원본 다운로드 실패 (HTTP ${r.status})`); }
        // .part 로 받고 나서 rename 한다. 도중에 죽으면 잘린 파일이 남는데, 그게
        // 최종 이름을 갖고 있으면 다음에 "이미 있다"고 판단해 그대로 영상으로 쓰인다.
        const part = `${local}.part`;
        try { await pipeline(Readable.fromWeb(r.body as any), g.tap, fs.createWriteStream(part)); }
        finally { g.done(); }
        const got = fs.statSync(part).size;
        if (got < 1024) { fs.rmSync(part, { force: true }); throw new Error(`받은 파일이 너무 작습니다 (${got}B)`); }
        fs.renameSync(part, local);
      }
      job.localPath = local;
      saveQueue();
    }

    // 2. 올린다.
    //
    // ★ 스트림을 PutObjectCommand 에 그대로 넘기면 안 된다. SDK 가 청크 서명
    //   (STREAMING-AWS4-HMAC-SHA256-PAYLOAD)으로 보내는데 NCP 가 이를 거부한다 —
    //   측정 결과 AccessDenied 였다. 같은 파일을 Buffer 로 넘기면 통과한다.
    //   그렇다고 Buffer 로 가면 4K 영상 100MB 이상을 통째로 메모리에 올려야 한다.
    //   presigned PUT 은 본문을 서명에 넣지 않으므로(UNSIGNED-PAYLOAD) 스트림이
    //   그대로 통과하고 메모리는 평평하다. 추가 의존성도 없다.
    const size = fs.statSync(local).size;
    const contentType = job.ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    // 프로젝트 이름은 key 에도 있지만 메타데이터에도 남긴다. 시트에서 이름이 바뀌어도
    // "이 객체가 원래 어느 프로젝트 것이었나"는 여기 남는다.
    // 모델은 여기에만 있다 — 파일 이름에 넣지 않기로 했다(이름순 = 시간순을 지키려고).
    // S3 메타데이터는 ASCII 만 안전하므로 인코딩해서 넣는다.
    const meta = {
      project: encodeURIComponent(job.project || ''),
      task: job.taskId,
      model: encodeURIComponent(job.model || ''),
    };
    const putUrl = await getSignedUrl(ncp.client, new PutObjectCommand({
      Bucket: ncp.bucket, Key: key, ContentType: contentType, Metadata: meta,
    }), { expiresIn: 900 }); // 시작만 창 안에 들어오면 완주한다 — 서명은 요청 도착 시 한 번만 검사한다

    const gu = stallGuard(STALL_MS, '업로드');
    let put: Response;
    try {
      put = await fetch(putUrl, {
        method: 'PUT',
        duplex: 'half',
        signal: gu.signal,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(size),
          'x-amz-meta-project': meta.project,
          'x-amz-meta-task': meta.task,
          'x-amz-meta-model': meta.model,
        },
        // tap 을 거치게 해서 실제로 바이트가 흐를 때마다 감시자 시계를 되돌린다.
        // 파일을 다 읽을 때까지 시간이 얼마가 걸리든, 흐르고 있으면 끊지 않는다.
        body: Readable.toWeb(fs.createReadStream(local).pipe(gu.tap)) as any,
      } as any);
    } finally { gu.done(); }
    if (!put.ok) throw new Error(`업로드 거부 (HTTP ${put.status})`);

    // 3. 올라갔는지 확인하고 나서만 성공으로 친다. 크기가 다르면 실패로 본다.
    const head = await ncp.client.send(new HeadObjectCommand({ Bucket: ncp.bucket, Key: key }));
    if (Number(head.ContentLength) !== size) {
      throw new Error(`업로드 크기 불일치 (보낸 ${size}B / 저장된 ${head.ContentLength}B)`);
    }

    mediaIndex.set(job.taskId, { key, bucket: ncp.bucket, size, at: Date.now(), project: job.project, local });
    saveIndex();
    queue.delete(job.taskId);
    saveQueue();
    console.log(`[NCP] 보관 완료 ${key} — ${(size / 1048576).toFixed(1)}MB, ${((Date.now() - t0) / 1000).toFixed(1)}초`);
  } catch (e: any) {
    job.tries++;
    console.warn(`[NCP] 보관 실패 ${key} (${job.tries}회): ${e?.message || e}`);
    // 로컬 사본이 있으면 원본 URL 이 죽은 뒤에도 언젠가 성공할 수 있으므로 포기시키지
    // 않는다. 반대로 소스가 URL 뿐인데 세 번 실패했다면 그 링크는 이미 만료된 것이고
    // 더 해볼 수 있는 게 없다 — 큐에 남겨두면 10분마다 죽은 링크를 영원히 두드린다.
    // (앱 실행 시 소급 보관에서 24시간 지난 옛 영상들이 여기로 들어온다.)
    if (job.tries >= 3 && !(job.localPath && fs.existsSync(job.localPath))) {
      queue.delete(job.taskId);
      gaveUp.add(job.taskId);
      saveDead();
      console.warn(`[NCP] 포기 ${key} — 원본 링크가 만료된 것으로 보입니다`);
    }
    saveQueue();
  }
}

// ── 재생 ────────────────────────────────────────────────────────────────────
/** 저장된 객체의 서명 URL. 서명은 로컬 연산이라 매번 새로 만들어도 0.15ms 다. */
export async function presignArchived(taskId: string): Promise<string | null> {
  const row = mediaIndex.get(taskId);
  if (!row) return null;
  const ncp = await ensureNcp();
  if (!ncp) return null;
  return getSignedUrl(ncp.client, new GetObjectCommand({ Bucket: row.bucket, Key: row.key }), {
    expiresIn: ncp.presignExpires,
  });
}

/**
 * 색인에 없을 때(재설치 등으로 색인을 잃었을 때) 클라이언트가 들고 있던
 * project/ext 로 직접 찾아본다. 있으면 색인을 되살린다.
 */
export async function recoverFromHints(taskId: string, provider: Provider, project: string, ext: string): Promise<string | null> {
  const ncp = await ensureNcp();
  if (!ncp) return null;
  const key = objectKeyFor(provider, project, taskId, ext);
  try {
    const head = await ncp.client.send(new HeadObjectCommand({ Bucket: ncp.bucket, Key: key }));
    mediaIndex.set(taskId, {
      key, bucket: ncp.bucket, size: Number(head.ContentLength) || 0, at: Date.now(), project,
    });
    saveIndex();
    console.log(`[NCP] 색인 복구 ${key}`);
    return getSignedUrl(ncp.client, new GetObjectCommand({ Bucket: ncp.bucket, Key: key }), {
      expiresIn: ncp.presignExpires,
    });
  } catch { return null; }
}

export function archiveStats() {
  return {
    ready: Boolean(ready),
    bucket: ready?.bucket || null,
    archived: mediaIndex.size,
    pending: queue.size,
    failing: [...queue.values()].filter(j => j.tries > 0).length,
    gaveUp: gaveUp.size, // 링크가 만료돼 되살릴 수 없다고 판단한 건수
  };
}
