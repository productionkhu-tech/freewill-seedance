import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { get, set, del, keys } from 'idb-keyval';
import { showNotification, setCachedBlob, getCachedBlob, downloadViaProxy, buildDownloadFilename, API_LIMITS, storeLibraryImage, syncLibraryBackup, createThumbnail, makeJpegPreview } from './lib/utils';
import { MODEL_GRANTS, resolveModelId , brandOf } from './lib/model-access';
import { createBackupClock } from './lib/backup-clock';
import { buildSettingsPayload, type SettingsPayload } from './lib/settings-box';

// Debounced IndexedDB storage — prevents lag from writing large base64 data on every state change
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 1500;
// Latest snapshot waiting for the debounce timer. Kept so critical updates
// (e.g. downloadedAt) and window-hide/quit can flush to disk immediately —
// otherwise a quit within DEBOUNCE_MS silently drops the write.
// Holds the partialized state OBJECT (immutable zustand snapshot), NOT a string:
// JSON.stringify of the whole blob (projects + base64 elementAssets, easily MBs)
// used to run synchronously on EVERY set() — each settings commit froze frames.
// Serialization now happens only at flush time, at most once per debounce window.
let pendingWrite: { name: string; value: StorageValue<unknown> } | null = null;
// 마지막으로 저장하러 넘긴 상태와 그때의 어셋 목록 — 같은 것을 다시 쓰지 않게(setItem 주석).
let lastPersistedState: unknown = null;
let lastElementsSeen: unknown = undefined;
// 저장할 상태의 최상위 칸이 모두 같은 참조인가 — store 는 불변 갱신이라 이것으로 '바뀐 것 없음' 을 안다.
function sameTopLevel(a: any, b: any): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.is(a[k], b[k])) return false;
  return true;
}

// External backup mirror to Documents/Freewill Seedance Backup/seedance-backup.json.
// Survives any userData loss (app-name rename, uninstall+reinstall, AppData cleanup).
// Longer debounce than IDB so we don't churn the disk during heavy editing.
// 언제 쓸지는 backupClock(아래 runBackup 옆)이 정한다 — src/lib/backup-clock.ts.
const BACKUP_DEBOUNCE_MS = 5 * 60 * 1000;
// 아무리 바빠도 백업에 안 들어간 변화가 '처음' 생기고 이만큼 지나면 쓴다(26.10.701~ 처음부터 센다).
// 순수 디바운스만 두면 쉬지 않고 작업하는 동안 백업이 한 번도 안 일어난다.
const BACKUP_MAX_AGE_MS = 15 * 60 * 1000;
// 이만큼 밀리면 화면에 알린다 — 디스크가 꽉 찼거나 폴더 권한처럼 앱 혼자 못 고치는 경우다.
const BACKUP_LAG_NOTICE_MS = 45 * 60 * 1000;
// Last library payload we successfully mirrored. The library is ~500MB, so re-writing it
// every 5 minutes when nothing changed would grind the disk for no reason.
let lastBackedUpElements: string | null = null;

// ─── Element library: its own IndexedDB key ───
// elementAssets carry FULL-RESOLUTION base64 images (~12MB each; measured 368MB for
// 29 images). While they sat inside the main persisted blob, EVERY ordinary write
// (a poll status change, a settings tweak, a new message) had to re-serialize the
// whole ~385MB — a multi-second main-thread freeze, which is what made the app feel
// permanently laggy. They now live in a dedicated key that is written ONLY when the
// library itself changes, so ordinary writes serialize ~17MB instead.
// The images themselves are untouched (still full-res base64), so send / share /
// import / 원본 복사 behave exactly as before.
const ELEMENTS_KEY = 'seedance-element-assets';   // v1: the whole library as ONE string

// ── v2: the library, split across keys ───────────────────────────────────────
// v1 died at a hard wall: V8 caps a single string at 512MB, and the library reached
// 505.9MB (98.8%). Past that, JSON.stringify throws and NOTHING saves — silently, since
// the throw happens synchronously inside a timer. Raising a limit was never an option;
// the limit is in the engine.
// v2 never builds a whole-library string. Assets are serialized ONE AT A TIME (~12MB
// each) and packed into chunks under CHUNK_MAX, so the size of the library stops
// mattering. Same reason restore can stream: a chunk goes straight from file to IDB as
// a string, never parsed into a 500MB object graph on the way.
const ELEMENTS_MANIFEST = 'seedance-elements-manifest';
const ELEMENTS_CHUNK = 'seedance-elements-chunk-';
const CHUNK_MAX = 32 * 1024 * 1024;   // 32MB — far below every ceiling, ~16 chunks at today's size
type ElementsManifest = { v: 2; chunks: number; count: number; savedAt: number };

// Serializes writes. A save can take a while across N keys; a second one starting
// mid-flight could interleave chunk writes and leave a manifest describing a library
// that never existed on disk.
let elementsWriteChain: Promise<void> = Promise.resolve();

// Serialize one asset at a time and pack the pieces into JSON arrays under CHUNK_MAX.
// Never builds a string for the whole library, which is the entire point — that string
// is what hit V8's 512MB wall. Shared by the IDB write and the Documents backup so the
// two can never disagree about how the library is split.
function buildElementChunks(assets: ElementAsset[]): string[] {
  const parts: string[] = [];
  let cur: string[] = [], curLen = 0;
  for (const a of assets) {
    const one = JSON.stringify(a);      // one asset at a time — always well under any limit
    if (curLen + one.length > CHUNK_MAX && cur.length) {
      parts.push('[' + cur.join(',') + ']');
      cur = []; curLen = 0;
    }
    cur.push(one); curLen += one.length;
  }
  if (cur.length) parts.push('[' + cur.join(',') + ']');
  return parts;
}

async function writeElementsChunked(assets: ElementAsset[]): Promise<void> {
  const parts = buildElementChunks(assets);

  for (let i = 0; i < parts.length; i++) await set(ELEMENTS_CHUNK + i, parts[i]);
  // Manifest LAST: until it lands, a half-finished write is simply not visible, and the
  // reader keeps using whatever was there before.
  const man: ElementsManifest = { v: 2, chunks: parts.length, count: assets.length, savedAt: Date.now() };
  await set(ELEMENTS_MANIFEST, JSON.stringify(man));
  // Drop chunks left over from a previously longer library — ALL of them. This used to sweep
  // only the next 40 indices, which was enough while the library only ever grew or shrank a
  // little. 26.9.3001 의 원본 옮기기는 목록을 53조각 → 1조각으로 한 번에 줄인다 — 40개만 지우면
  // 41~52번(약 300MB)이 영영 남았다(격리 실측 2026-09-30). 키 목록을 한 번 읽어 전부 지운다.
  try {
    for (const k of await keys()) {
      const m = typeof k === 'string' ? /^seedance-elements-chunk-(\d+)$/.exec(k) : null;
      if (m && Number(m[1]) >= parts.length) await del(k);
    }
  } catch { /* 다음 저장 때 다시 */ }
  // Only now is the v1 blob redundant. Removing it reclaims ~500MB and stops the next
  // launch from having two sources of truth.
  try { if (await get(ELEMENTS_KEY)) await del(ELEMENTS_KEY); } catch { /* leave it */ }
}

async function readElementsChunked(): Promise<ElementAsset[] | null> {
  const raw = await get(ELEMENTS_MANIFEST);
  if (!raw) return null;
  const man = JSON.parse(raw) as ElementsManifest;
  const out: ElementAsset[] = [];
  for (let i = 0; i < man.chunks; i++) {
    const part = await get(ELEMENTS_CHUNK + i);
    if (!part) throw new Error(`element chunk ${i}/${man.chunks} missing`);
    out.push(...(JSON.parse(part) as ElementAsset[]));
  }
  if (out.length !== man.count) {
    console.warn(`[Elements] manifest says ${man.count} but ${out.length} loaded — using what loaded.`);
  }
  return out;
}

let elementsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingElements: ElementAsset[] | null = null;
// Last array reference we persisted. Every mutation (add / update / delete /
// deleteCollection / import) builds a NEW array, so a reference check catches all
// of them — no per-action wiring to forget.
let lastElements: ElementAsset[] | null = null;

function scheduleElementsSave(assets: ElementAsset[]) {
  pendingElements = assets;
  if (elementsTimer) clearTimeout(elementsTimer);
  elementsTimer = setTimeout(() => {
    const a = pendingElements; pendingElements = null;
    if (a) void saveElements(a);
  // 원본 옮기는 중에는 어셋 하나 끝날 때마다 목록이 바뀐다. 그때마다 아직 base64 가 남은 무거운
  // 목록을 통째로 쓰지 않도록, 옮기기가 잠잠해진 뒤(=대개 다 끝난 뒤) 한 번만 쓴다.
  }, libMigrating ? 10_000 : DEBOUNCE_MS);
}

// ─── 어셋 라이브러리 원본 → 파일 (26.9.3001~) ───────────────────────────────────
// 옛 어셋은 원본을 base64(url)로 스토어에 들고 있다 — 112개에 1.38GB, 그게 렌더러를 죽였다
// (2026-09-28, 최대 5.5GB). 하나씩 서버 라이브러리 폴더에 파일로 넣고, 서버가 받은 크기가 보낸
// 크기와 같을 때만 url 을 뗀다. 중간에 앱을 꺼도 안 옮겨진 것은 url 이 그대로라 다음 실행에 이어서
// 한다. 공유 팩을 가져와도 같은 길로 들어온다(가져온 어셋은 url 을 들고 온다).
// 백업: 원본 파일이 백업 폴더에 먼저 들어가야(syncLibraryBackup) 목록 백업이 새 모양으로 바뀐다
// (runBackup). 그 전까지 백업 폴더의 옛 목록(원본 base64 포함)은 그대로 남아 있다.
const isLegacyImage = (im: ElementImage) => !im.libId && typeof im.url === 'string' && im.url.startsWith('data:');
// 썸네일이 이보다 크면 원본이 썸네일 자리에 들어앉은 것이다(썸네일 없는 공유 팩) — 새로 만든다.
const THUMB_SANE_MAX = 300 * 1024;

let libMigrating = false;
let libMigrateAgain = false;
let libMigrateTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleLibraryMigration(delay = 1500) {
  if (libMigrateTimer) clearTimeout(libMigrateTimer);
  libMigrateTimer = setTimeout(() => { libMigrateTimer = null; void migrateLibraryImages(); }, delay);
}

function extForMime(type: string): string {
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/webp') return '.webp';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/bmp') return '.bmp';
  return '.png';
}

async function migrateLibraryImages(): Promise<void> {
  if (libMigrating) { libMigrateAgain = true; return; }
  libMigrating = true;
  let moved = 0, failed = 0;
  try {
    do {
      libMigrateAgain = false;
      const pending = useAppStore.getState().elementAssets.filter(a => a.images.some(isLegacyImage));
      for (const a of pending) {
        const done = new Map<string, ElementImage>();
        for (const im of a.images) {
          if (!isLegacyImage(im)) continue;
          try {
            const blob = await (await fetch(im.url!)).blob();
            const name = im.file_name || `element${extForMime(blob.type)}`;
            const libId = await storeLibraryImage(blob, name);   // 원본 저장 + 크기 확인 + 미리보기
            let thumbnailUrl = im.thumbnailUrl;
            if (!thumbnailUrl || thumbnailUrl.length > THUMB_SANE_MAX) {
              thumbnailUrl = await createThumbnail(new File([blob], name, { type: blob.type }), 256);
            }
            const { url: _movedToDisk, ...rest } = im;
            done.set(im.id, { ...rest, libId, thumbnailUrl });
            moved++;
          } catch (err) {
            failed++;
            console.warn(`[Library] '${a.name}' 이미지 옮기기 실패 — 원본을 그대로 두고 다음에 다시 한다:`, err);
          }
        }
        if (done.size) {
          // 옮기는 사이 사용자가 이 어셋을 고쳤을 수 있다 — 지금 상태에서 옮긴 이미지만 바꾼다.
          useAppStore.setState(s => ({
            elementAssets: s.elementAssets.map(x => x.id !== a.id ? x
              : { ...x, images: x.images.map(im => done.get(im.id) ?? im) }),
          }));
        }
      }
    } while (libMigrateAgain);
  } finally {
    libMigrating = false;
  }
  if (moved || failed) {
    console.log(`[Library] 원본 ${moved}장을 파일로 옮김${failed ? `, ${failed}장 실패(다음에 다시)` : ''}`);
    // 옮긴 원본을 바로 백업 폴더에도 넣는다 — 다음 백업 주기(최대 15분)까지 한 곳에만 있지 않게.
    const ids = [...new Set(useAppStore.getState().elementAssets.flatMap(x => x.images.map(i => i.libId).filter(Boolean) as string[]))];
    if (ids.length) void syncLibraryBackup(ids);
    // 옮기는 동안 미뤄 둔 목록 저장을 지금 한다(가벼워진 목록으로).
    if (pendingElements) scheduleElementsSave(pendingElements);
  }
}

// The one write path. Chunked, serialized against itself, and loud on failure — the v1
// version threw synchronously inside a timer, which no .catch could see, so saving just
// stopped without a word.
function saveElements(assets: ElementAsset[]): Promise<void> {
  if (persistBlocked) return elementsWriteChain;   // 읽지 못한 기록을 지키는 중
  elementsWriteChain = elementsWriteChain
    .catch(() => {})                       // a previous failure must not block later saves
    .then(() => writeElementsChunked(assets))
    .then(() => { console.log(`[Elements] saved ${assets.length} asset(s) in chunks`); })
    .catch((err) => {
      console.error('[Elements] SAVE FAILED — new assets are NOT on disk:', err);
      window.dispatchEvent(new CustomEvent('seedance:toast', { detail: {
        msg: '엘리먼트 라이브러리 저장에 실패했습니다. 새로 추가한 어셋이 보존되지 않습니다 — 개발자에게 알려주세요.',
        ok: false,
      }}));
    });
  return elementsWriteChain;
}

// Flush the element library NOW (quit / window hide), same contract as flushPersist.
export function flushElements(): Promise<void> {
  if (elementsTimer) { clearTimeout(elementsTimer); elementsTimer = null; }
  const a = pendingElements; pendingElements = null;
  // Await whatever is already in flight even with nothing pending, so quit doesn't cut a
  // chunk write in half and leave the manifest pointing at a chunk that isn't there.
  return a ? saveElements(a) : elementsWriteChain.catch(() => {});
}

// Load the library. Three sources in order of preference:
//   1. v2 chunks (current)
//   2. v1 single blob → migrate to chunks
//   3. whatever zustand/persist restored from the very old in-state copy → migrate
// Migration writes the new form and only then removes the old, so a failure anywhere
// leaves the previous copy exactly where it was.
async function loadElementAssets(legacy: ElementAsset[]): Promise<ElementAsset[]> {
  try {
    const chunked = await readElementsChunked();
    if (chunked) return chunked;
  } catch (err) {
    console.error('[Elements] chunked read failed, trying older formats:', err);
  }
  // v1 → v2
  try {
    const raw = await get(ELEMENTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        console.log(`[Elements] migrating ${parsed.length} asset(s) from the single-blob format → chunks`);
        // writeElementsChunked deletes ELEMENTS_KEY only after the manifest lands.
        saveElements(parsed as ElementAsset[]);
        return parsed as ElementAsset[];
      }
    }
  } catch (err) {
    console.warn('[Elements] single-blob store unreadable, falling back to in-state copy:', err);
  }
  if (legacy && legacy.length) {
    console.log(`[Elements] migrating ${legacy.length} asset(s) from the in-state copy → chunks`);
    saveElements(legacy);
  }
  return legacy || [];
}

// Custom PersistStorage (replaces createJSONStorage(() => idbStorage)) so that
// serialization is DEFERRED into the debounce. createJSONStorage stringified the
// entire partialized blob synchronously inside every set() — the debounce only
// covered the IDB write, not the stringify — so each slider commit / send / poll
// write blocked the main thread for the full stringify of a multi-MB blob.
// On-disk format is unchanged (same JSON string under the same key), so this is
// fully backward/forward compatible with data written by older versions.
// ── Where the disaster-recovery mirror goes ─────────────────────────────────
// Same four operations, two transports. On Windows the packaged app talks to Electron
// over IPC; in a browser (the Mac build runs as a local web app) there is no IPC, so it
// talks to its own local server, which writes the identical files to the identical folder.
//
// This existed as `window.electronAPI` inline at every call site, which meant the browser
// simply fell out of every backup path — silently. The Mac had ONE copy of a user's
// projects, in browser storage, with nothing behind it: clear site data and the work was
// gone. A one-line `if` was the whole safety net, and in a browser it was always false.
//
// Returning the SAME shapes as the IPC handlers is the point — every guard, the 5-minute
// debounce, the chunking and the restore path above stay exactly as they are and as they
// were tested. Only the wire changes.
type BackupApi = {
  backupSave(content: string, kind?: string): Promise<any>;
  backupSaveElementsChunk(index: number, content: string, total: number, count: number): Promise<any>;
  backupLoadElementsChunk(index: number): Promise<any>;
  backupLoad(): Promise<any>;
};

const httpBackupApi: BackupApi = {
  // text/plain, not JSON: the body IS the blob. Wrapping 20MB of JSON inside more JSON
  // just to unwrap it server-side doubles the work and the memory.
  backupSave: (content) =>
    fetch('/api/backup/state', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: content })
      .then(r => r.json()).catch(e => ({ ok: false, error: String(e) })),
  backupSaveElementsChunk: (index, content, total, count) =>
    fetch(`/api/backup/elements/${index}?total=${total}&count=${count}`,
      { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: content })
      .then(r => r.json()).catch(e => ({ ok: false, error: String(e) })),
  backupLoadElementsChunk: (index) =>
    fetch(`/api/backup/elements/${index}`).then(r => r.json()).catch(e => ({ ok: false, error: String(e) })),
  backupLoad: () =>
    fetch('/api/backup/state').then(r => r.json()).catch(e => ({ ok: false, error: String(e) })),
};

function getBackupApi(): BackupApi | null {
  if (typeof window === 'undefined') return null;
  const el = (window as any).electronAPI;
  if (el?.backupSave) return el as BackupApi;      // packaged app — keep IPC exactly as it was
  return httpBackupApi;                            // browser — same files, over the local server
}

// 대기 중인 백업 스냅샷. 언제 쓸지는 backupClock 이 정한다(src/lib/backup-clock.ts — 15분 마감은 백업에
// 안 들어간 변화가 '처음' 생긴 때부터 센다. 화면 신호나 조용한 틈에 기대지 않는다).
let pendingBackup: any = null;
const backupClock = createBackupClock({ quietMs: BACKUP_DEBOUNCE_MS, maxAgeMs: BACKUP_MAX_AGE_MS, fire: () => runBackup() });
// 연달아 실패한 횟수와 마지막 이유 — 다시 해 볼 간격(1·2·4·8·15분)과 밀렸을 때의 알림에 쓴다.
let backupFailures = 0;
let lastBackupError = '';

// 백업을 실제로 수행한다. 시계가 부르거나, 창을 숨길 때·끌 때 flushBackup 이 부른다.
function runBackup() {
  if (persistBlocked) return;   // 빈 상태로 Documents 백업까지 덮지 않게
  const v = pendingBackup;
  if (!v) return;

  const api = getBackupApi();
  if (!api?.backupSave) return;
  // ★ SAFETY: never write a backup before the library has loaded. Backing up an
  // empty/half-loaded elementAssets would OVERWRITE a good backup with one that
  // has no library — destroying the very safety net this mirror exists to be.
  // Skipping is safe: the previous good backup stays on disk. 다음 변화를 기다리지 않고 30초 뒤 다시
  // 본다 — 켜자마자 창을 숨기면 다음 변화가 한참 없을 수 있다.
  let st;
  try { st = useAppStore.getState(); } catch { backupClock.failed(0, 30_000); return; }
  if (!st || !st._elementsHydrated) {
    console.warn('[Backup] skipped — element library not hydrated yet (keeping previous backup)');
    backupClock.failed(0, 30_000);
    return;
  }

  // 여기까지 와야 '실제로 쓴다'. 스냅샷도 여기서 비운다 — 건너뛴 경우에는 들고 있다가 다음 기회에 써야 한다.
  pendingBackup = null;
  const firstChangeAt = backupClock.taken();
  // 쓰지 못했으면 이 스냅샷을 다시 든다(그새 더 새 것이 왔으면 그것이 이 내용을 다 담고 있다). 다음 변화를
  // 기다리지 않고 1 · 2 · 4 · 8 · 15분 뒤 다시 — 실패가 오래가면 아래 1분 점검이 화면에 알린다.
  const failed = (why: unknown) => {
    backupFailures++;
    lastBackupError = String(why ?? '').slice(0, 120);
    if (!pendingBackup) pendingBackup = v;
    backupClock.failed(firstChangeAt, Math.min(60_000 * 2 ** (backupFailures - 1), BACKUP_MAX_AGE_MS));
  };

  // ── The work history goes first, and ALONE ──────────────────────────────────
  // This used to be one combined string (state + library). Once the library passed
  // ~500MB the combined JSON exceeded V8's 512MB single-string ceiling and
  // JSON.stringify threw RangeError — synchronously inside this timer, so the
  // .catch below never ran and backups silently stopped for weeks. Measured:
  // 19.4MB + 505.9MB = 525.3MB against a 512MB limit.
  // Separated, the irreplaceable part is ~19MB and cannot be dragged over the
  // cliff by the library growing.
  try {
    api.backupSave(JSON.stringify(v), 'state')
      .then((r: any) => {
        if (r?.ok) {
          backupFailures = 0; lastBackupError = ''; backupClock.ok();
          console.log(`[Backup] state ${(r.bytes / 1048576).toFixed(2)}MB → ${r.path}`);
        } else {
          console.warn('[Backup] state save failed:', r?.error);
          failed(r?.error || 'save failed');
        }
      })
      .catch((err: any) => { console.warn('[Backup] state save error:', err?.message || err); failed(err?.message || err); });
  } catch (err: any) {
    // try/catch because stringify throws SYNCHRONOUSLY — a promise .catch cannot see it.
    console.error('[Backup] state serialize failed:', err?.message || err);
    failed(err?.message || err);
  }

  // ── The library second, chunked, best-effort ───────────────────────────────
  // Same chunking as IDB: no whole-library string is ever built, so the library can
  // grow past 512MB without the backup quietly dying the way it did before.
  // Skipped when unchanged. 26.9.3001~ 목록에는 원본이 없어(libId 만) 작다 — 원본 파일은 따로
  // 백업 폴더의 element-library/ 로 간다(아래 sync).
  void (async () => {
    try {
      // 기록 속 그림 파일(26.10.202~, compactMessageImages)도 백업 폴더로. 칩 아이콘·카드 썸네일이라
      // 못 채워도 아래 어셋 목록 백업은 막지 않는다 — 다음 주기에 다시.
      const msgIds = messageLibraryIds(st.projects);
      if (msgIds.length) {
        const s2 = await syncLibraryBackup(msgIds);
        if (!s2?.ok || (s2.missing && s2.missing.length)) console.warn('[Backup] message images not all in the backup folder:', s2?.error || `${s2?.missing?.length} missing`);
      }
      const els = st.elementAssets || [];
      // ★ 원본 파일이 백업 폴더에 먼저 있어야 한다. 목록은 libId 만 들고 있으므로, 원본이 백업에 없는
      //   채로 목록만 새로 쓰면 그 백업으로 되살린 라이브러리는 그림이 없다. 채우지 못하면 이번에는
      //   목록을 쓰지 않는다 — 백업 폴더의 이전 목록(옛 모양이면 원본 base64 포함)이 남는 편이 낫다.
      const libIds: string[] = [...new Set<string>((els as ElementAsset[]).flatMap(a => a.images.map(i => i.libId).filter(Boolean) as string[]))];
      if (libIds.length) {
        const sync = await syncLibraryBackup(libIds);
        if (!sync?.ok || (sync.missing && sync.missing.length)) {
          console.warn('[Backup] library originals not all in the backup folder — keeping the previous library backup:',
            sync?.error || `${sync?.missing?.length} missing`);
          return;
        }
      }
      const parts = buildElementChunks(els);
      const sig = parts.length + ':' + parts.reduce((n, p) => n + p.length, 0);
      if (sig === lastBackedUpElements) return;
      for (let i = 0; i < parts.length; i++) {
        const r = await api.backupSaveElementsChunk(i, parts[i], parts.length, els.length);
        if (!r?.ok) { console.warn('[Backup] elements chunk', i, 'failed:', r?.error); return; }
      }
      lastBackedUpElements = sig;
      console.log(`[Backup] library mirrored in ${parts.length} chunk(s), ${els.length} asset(s)`);
    } catch (err: any) {
      // The work-history backup above already succeeded and is unaffected.
      console.error('[Backup] library mirror failed (work history is safe):', err?.message || err);
    }
  })();
    
}

// 창을 숨기거나(트레이로 내림) 끌 때 즉시 쓴다. 디바운스가 끝나기를 기다리면
// 그 순간의 작업분이 통째로 날아간다 — 앱을 끄는 것이 바로 그 순간이다.
export function flushBackup(): void {
  if (pendingBackup) runBackup();
}

// ─── '못 읽음' 은 '비어 있음' 이 아니다 (26.10.201~) ─────────────────────────────────
// 예전에는 작업 기록을 읽다 실패해도(IDB 오류 · 해석 실패 · 백업이 너무 큼) 빈 상태로 시작했고, 앱이
// 곧바로 'Project 1' 을 만들어 그 빈 상태를 저장했다 — 읽지 못한 기록 위에. 2026-10-01 팀원 PC 가 8월 초
// 업데이트 직후 이렇게 프로젝트 17개를 잃었다(백업 폴더의 7/30 합본에 남아 있었다).
//   · IDB 읽기 오류 → 이번 실행은 저장을 멈춘다(persistBlocked) + 빨간 띠. 다시 켜면 대개 읽힌다.
//   · 해석 실패 → 원본을 백업 폴더에 UNREADABLE 로 남기고 백업에서 되살린다. 백업도 없으면 저장을 멈춘다.
//   · 백업이 너무 커서 통째로 못 불러옴 → 빈 상태로 시작하되 곧바로 그 백업에서 프로젝트를 꺼내 붙인다
//     (runBackupRecovery). 어셋 목록은 조각이라 크기와 상관없이 그대로 되살린다.
let persistBlocked = false;
let restoreSkippedThisLaunch = false;
let persistTroubleMsg: string | null = null;
function blockPersist(msg: string) {
  persistBlocked = true;
  persistTroubleMsg = msg;
  console.error('[Persist] saving disabled for this session:', msg);
  // 스토어가 아직 만들어지는 중이면(TDZ) 실패한다 — onRehydrateStorage 가 persistTroubleMsg 로 다시 넣는다.
  try { useAppStore.setState({ persistTrouble: msg }); } catch { /* 위 주석 */ }
}

// 큰 작업 기록 백업을 프로젝트 하나씩 받아 붙인다(26.10.202~, server.ts state-outline). 한 덩어리
// 문자열을 만들지 않으므로 크기 때문에 복원을 건너뛰지 않는다. 하나라도 못 받으면 null — 부르는 쪽이
// 201 의 길(켜진 뒤 그 백업에서 프로젝트를 꺼내 붙이기)로 간다.
async function restoreStateInPieces(): Promise<StorageValue<unknown> | null> {
  try {
    const o = await (await fetch('/api/backup/state-outline')).json();
    if (!o?.ok || !Number.isInteger(o.projects) || typeof o.rest !== 'string') return null;
    const projects: unknown[] = [];
    for (let i = 0; i < o.projects; i++) {
      const r = await fetch(`/api/backup/state-project/${i}?sig=${encodeURIComponent(o.sig)}`);
      if (!r.ok) { console.warn(`[Backup] piece ${i}/${o.projects} failed: HTTP ${r.status}`); return null; }
      projects.push(await r.json());
    }
    const state = { ...JSON.parse(o.rest), projects };
    console.log(`[Backup] Restored ${projects.length} project(s) in pieces`);
    return { state, version: typeof o.version === 'number' ? o.version : 0 };
  } catch (e) {
    console.warn('[Backup] piecewise restore failed:', e);
    return null;
  }
}

// 백업 폴더의 어셋 목록 조각을 IDB 로. 상태 복원과 따로 — 상태가 너무 커서 건너뛰어도 어셋은 되살린다.
// IDB 에 어셋 목록이 이미 있으면 그대로 둔다: 작업 기록만 깨진 경우 어셋 목록은 멀쩡하고 백업보다 새롭다.
// (있는지는 keys 로만 본다 — 옛 한 덩어리 키는 수백 MB 라 읽어서 확인하면 안 된다.)
async function restoreElementChunksFromBackup(api: BackupApi, result: any): Promise<void> {
  try {
    const ks = await keys();
    if (ks.includes('seedance-elements-manifest') || ks.includes(ELEMENTS_KEY)) {
      console.log('[Backup] library already in IndexedDB — keeping it (newer than the backup)');
      return;
    }
  } catch { /* 못 보면 예전처럼 되살린다 */ }
  if (result.elementsChunks > 0 && api.backupLoadElementsChunk) {
    try {
      for (let i = 0; i < result.elementsChunks; i++) {
        const part = await api.backupLoadElementsChunk(i);
        if (!part?.ok || typeof part.content !== 'string') throw new Error(`chunk ${i} unreadable`);
        await set('seedance-elements-chunk-' + i, part.content);
      }
      await set('seedance-elements-manifest', JSON.stringify({
        v: 2, chunks: result.elementsChunks, count: result.elementsCount || 0, savedAt: Date.now(),
      }));
      console.log(`[Backup] library restored from ${result.elementsChunks} chunk(s)`);
    } catch (e) {
      console.warn('[Backup] library restore failed — work history is unaffected:', e);
    }
  } else if (result.elements) {
    // Older single-file library backup.
    try { await set(ELEMENTS_KEY, result.elements); } catch (e) { console.warn('[Backup] legacy library restore failed:', e); }
  }
}

const idbPersistStorage: PersistStorage<unknown> = {
  getItem: async (name: string): Promise<StorageValue<unknown> | null> => {
    const parse = (raw: string): StorageValue<unknown> | null => {
      try { return JSON.parse(raw); } catch (e) { console.error('[Persist] stored state is unreadable:', e); return null; }
    };
    let fromIdb: string | undefined;
    try {
      fromIdb = await get(name);
    } catch (err) {
      console.error('[Persist] IndexedDB read failed:', err);
      blockPersist('작업 기록을 읽지 못했어요. 기록을 지키려고 이번 실행에서는 저장을 멈췄어요 — 트레이 아이콘에서 Quit 으로 완전히 끄고 다시 켜 주세요.');
      return null;
    }
    let unreadable = false, keptUnreadable = false;
    if (fromIdb) {
      const parsed = parse(fromIdb);
      if (parsed) return parsed;
      unreadable = true;
      // 아래에서 백업으로 덮기 전에, 읽지 못한 원본을 백업 폴더에 남긴다(실패해도 백업 복원은 한다 —
      // 백업은 같은 기록의 몇 분 전 사본이다).
      try {
        const r = await fetch('/api/backup/unreadable', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: fromIdb });
        keptUnreadable = r.ok;
        if (!r.ok) console.warn('[Persist] could not keep the unreadable copy: HTTP', r.status);
      } catch (e) { console.warn('[Persist] could not keep the unreadable copy:', e); }
    }
    // IDB empty (fresh install / userData wiped) or unreadable — try external backup.
    try {
      const api = getBackupApi();
      if (api?.backupLoad) {
        const result = await api.backupLoad();
        if (result?.ok && !result.content && result.stateSkipped) {
          // 한 덩어리로는 안 넘어왔다. 어셋 목록은 조각이라 먼저 되살린다.
          await restoreElementChunksFromBackup(api, result);
          // 상태 전용 백업이면 프로젝트를 하나씩 받아 붙인다(26.10.202~) — 크기와 상관없이 그대로 돌아온다.
          if (result.pieces) {
            const pieced = await restoreStateInPieces();
            if (pieced) {
              try { await set(name, JSON.stringify(pieced)); }
              catch (e) { console.warn('[Backup] pieced state could not be seeded into IndexedDB (the next save writes it):', e); }
              return pieced;
            }
          }
          // 조각으로도 못 받았다(옛 합본이 너무 큼 · 받는 중 바뀜) — 켜진 뒤 그 백업에서 프로젝트를 꺼낸다(201).
          restoreSkippedThisLaunch = true;
        }
        if (result?.ok && result.content) {
          // Seed IDB so subsequent reads hit the fast path and the next setItem
          // doesn't race the restored state.
          await set(name, result.content);
          console.log(`[Backup] Restored ${(result.bytes / 1048576).toFixed(1)}MB from ${result.path}`);
          // The library lives in its own file since the split (see main.cjs). Seed it
          // straight into its own IDB key as the RAW STRING — do not parse it here and do
          // not thread it through `state`. It is ~500MB; parsing it into objects and then
          // handing those to the persist merge would hold three copies at once and can
          // OOM the renderer. loadElementAssets reads that key moments later and parses it
          // exactly once, which is what every normal launch already does.
          // Library restore, streamed. Each chunk goes file → IPC → IDB as a STRING and is
          // released before the next one; nothing ever holds the whole library as one
          // value. That is what makes an arbitrarily large library restorable — the
          // previous version tried it in one piece and killed the renderer on startup.
          await restoreElementChunksFromBackup(api, result);
          const restored = parse(result.content);
          if (restored) return restored;
        }
      }
    } catch (err) {
      console.warn('[Backup] Load failed:', err);
    }
    // 읽지 못한 기록이 있었는데 백업으로도 못 되살렸다 — 빈 상태로 시작하되 저장은 하지 않는다(덮어쓰지 않게).
    // 백업이 너무 커서 건너뛴 경우는 예외: 그 백업에서 프로젝트를 곧 꺼내 붙이므로 저장해도 된다 — 단 읽지
    // 못한 원본을 파일로 남겼을 때만(저장이 시작되면 IDB 의 원본은 덮인다).
    if (unreadable && !(restoreSkippedThisLaunch && keptUnreadable)) {
      blockPersist(keptUnreadable
        ? '작업 기록이 손상돼 읽지 못했고 백업에서도 되살리지 못했어요. 기록을 지키려고 저장을 멈췄어요 — 읽지 못한 원본은 문서\\Freewill Seedance Backup 에 UNREADABLE 파일로 남겼어요. 개발 담당에게 알려 주세요.'
        : '작업 기록이 손상돼 읽지 못했고 백업에서도 되살리지 못했어요. 기록을 지키려고 저장을 멈췄어요 — 읽지 못한 원본은 앱 안에 그대로 두었어요. 개발 담당에게 알려 주세요.');
    }
    return null;
  },
  setItem: (name: string, value: StorageValue<unknown>): void => {
    // 읽지 못한 기록을 지키는 중이면 아무것도 쓰지 않는다(위 '못 읽음' 주석). 백업 미러도 같이 멈춘다.
    if (persistBlocked) { pendingWrite = null; return; }
    // ★ 저장할 것이 그대로면 아무것도 안 한다(26.10.701~). persist 는 set 이 불릴 때마다 — 저장하지 않는 칸
    //   (trackerReachable · mentionedElementImages · billingProjectKey 등)만 바뀌어도 — 여기를 부른다. 그때마다 기록
    //   전체(33MB)를 다시 직렬화하고 백업의 '5분 조용한 틈' 을 처음부터 다시 셌다(실측 2026-10-07: 켜 둔 앱이 20초~1분
    //   마다 바이트까지 같은 내용을 다시 썼다). store 는 불변 갱신이라(바꾸면 새 객체 — 저장 칸의 제자리 수정 0건 확인)
    //   최상위 칸의 참조만 비교하면 된다. 어셋 목록은 따로 저장되지만 그 백업은 여기서 예약하므로 같이 본다.
    const st = (value as any)?.state;
    let els: unknown;
    try { els = useAppStore.getState().elementAssets; } catch { els = undefined; }
    const stateSame = sameTopLevel(st, lastPersistedState);
    if (stateSame && els === lastElementsSeen) return;
    lastElementsSeen = els;
    if (stateSame) { pendingBackup = value; backupClock.changed(); return; }   // 어셋 목록만 바뀜 — 백업만
    lastPersistedState = st;
    // `value.state` is zustand's immutable snapshot — safe to hold by reference
    // until the timer fires (updates replace objects, never mutate them).
    pendingWrite = { name, value };
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      const w = pendingWrite; pendingWrite = null;
      if (!w) return;
      // ★ try/catch, and it is not decoration. This is the SAME shape that killed the
      // backup for a week: JSON.stringify throws RangeError SYNCHRONOUSLY once the string
      // passes V8's 512MB ceiling, and a throw inside a setTimeout goes nowhere — no
      // rejection to catch, no error boundary, nothing on screen. The write just stops
      // happening while the app carries on looking perfectly healthy, and everything since
      // is gone at the next launch.
      // Measured on the real library (2026-07-31): 39.5KB per message → the ceiling lands
      // at 13,581 messages, confirmed by binary search (20x fine at 389MB, 27x throws).
      // At the current pace (503 in 3.5 months) that is ~7.7 years away — far, but the
      // backup's version of this bug was also "years away" until the element library grew.
      // So: never let it be silent. Tell the user, because the only real fix at that point
      // is theirs — archive or delete old projects.
      try {
        set(w.name, JSON.stringify(w.value));
      } catch (err: any) {
        console.error('[Persist] state serialize failed — NOT SAVED:', err?.message || err);
        window.dispatchEvent(new CustomEvent('seedance:toast', {
          detail: {
            ok: false,
            msg: '기록이 너무 커져서 저장하지 못했습니다. 오래된 프로젝트를 정리해 주세요 — 지금 작업분이 다음 실행 때 사라질 수 있습니다.',
          },
        }));
      }
    }, DEBOUNCE_MS);

    // 외부 백업 파일로 미러링.
    //
    // ★ 예전에는 순수 디바운스였다 — 저장이 있을 때마다 5분 타이머를 리셋했다.
    //   그런데 영상을 만드는 동안에는 10초마다 폴링 결과가 들어와 상태가 바뀐다.
    //   타이머가 영영 리셋되어 한 번도 안 터지고, 앱을 닫으면 대기 중이던 백업은
    //   그대로 버려진다. 즉 '계속 작업하다 끄는' 가장 흔한 패턴에서 백업이 0건이다.
    //   실제로 2026-09-15 이후 사흘간 한 번도 안 쓰였고, 그동안 영상 68편이 쌓였다.
    // ★ 그 고침(마지막 백업이 오래됐으면 바로 쓴다)은 켠 뒤 한 번은 써야 작동했다 — 첫 백업은 창을 숨길 때만
    //   났고, 305 가 그 신호를 끊자 켜 둔 동안 백업이 0번이 됐다(2026-10-05~07, 영상 135편). 이제 시계가
    //   백업에 안 들어간 변화가 '처음' 생긴 때부터 센다 — 최악의 경우에도 BACKUP_MAX_AGE_MS 만큼만 뒤처진다.
    pendingBackup = value;
    backupClock.changed();
  },
  removeItem: async (name: string): Promise<void> => {
    if (persistBlocked) return;   // 읽지 못한 기록을 지키는 중
    await del(name);
  },
};

// Write the pending snapshot to IndexedDB NOW, skipping the debounce. Used
// after critical updates (downloadedAt) and on window hide/quit so a close
// within DEBOUNCE_MS can't drop the write. Idempotent — no-op when nothing
// is pending.
export function flushPersist(): Promise<void> {
  if (persistBlocked) return Promise.resolve();   // 읽지 못한 기록을 지키는 중
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!pendingWrite) return Promise.resolve();
  const w = pendingWrite;
  pendingWrite = null;
  return set(w.name, JSON.stringify(w.value));
}

// Safety net: flush whenever the window hides (minimize/tray) or unloads
// (quit, auto-update restart). pagehide covers real navigation/quit.
// ★ visibilitychange 는 브라우저에서만 온다. 앱 창은 backgroundThrottling:false(26.10.305~)라 숨겨도
//   최소화해도 'visible' 그대로다(실측: 이벤트 0개) — 앱에서는 main 이 창 이벤트로 알려 준다(onFlushRequest:
//   숨김 · 최소화 · 절전 · 화면 잠금 · 윈도우 종료, 26.10.701~).
if (typeof window !== 'undefined') {
  const flushAll = () => { void flushPersist(); void flushElements(); flushBackup(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
  window.addEventListener('pagehide', flushAll);
  (window as any).electronAPI?.onFlushRequest?.(flushAll);

  // 1분마다 백업 시계를 본다 — 밀린 게 있는데 타이머가 어떤 이유로든 없으면 다시 걸고, 45분 넘게 밀렸으면
  // 알린다. 그 정도면 디스크가 꽉 찼거나 폴더 권한처럼 앱 혼자 못 고치는 경우다(작업 기록 자체는 IDB 에
  // 계속 저장되고 있다). 백업이 조용히 멎는 것이 세 번(7월 · 9월 · 10월) 사고의 공통점이었다.
  let lastLagNoticeAt = 0;
  window.setInterval(() => {
    if (persistBlocked) return;   // 빨간 띠가 이미 말하고 있다
    const lag = backupClock.check();
    if (lag < BACKUP_LAG_NOTICE_MS || Date.now() - lastLagNoticeAt < 60 * 60 * 1000) return;
    lastLagNoticeAt = Date.now();
    console.error(`[Backup] ${Math.round(lag / 60000)}분째 밀림`, lastBackupError);
    window.dispatchEvent(new CustomEvent('seedance:toast', {
      detail: {
        ok: false,
        msg: `문서 폴더 백업이 ${Math.round(lag / 60000)}분째 저장되지 않고 있어요${lastBackupError ? ` (${lastBackupError})` : ''}. 작업 기록은 앱 안에 계속 저장되고 있어요 — 디스크 공간과 문서\\Freewill Seedance Backup 폴더를 확인해 주세요.`,
      },
    }));
  }, 60 * 1000);
}

export type AssetRole = 'reference_image' | 'reference_video' | 'reference_audio' | 'first_frame' | 'last_frame';

export type GenerationMode = 'text_to_video' | 'image_to_video_first' | 'image_to_video_first_last' | 'multimodal_reference' | 'edit_video' | 'extend_video';

export interface Asset {
  id: string;
  type: 'image_url' | 'video_url' | 'audio_url';
  url: string;
  role: AssetRole;
  file_name?: string;
  cacheId?: string;
  durationSec?: number;  // measured at attach (video/audio) — enforces the 15s
                         // combined-duration cap across reference videos/audios
  thumbnailUrl?: string; // small base64 preview for image assets (avoids re-fetch)
  originalPath?: string; // Electron absolute path of the source file — last-resort
                         // recovery when both the server media-cache entry and the
                         // tmpfiles URL are gone (e.g. attached on a pre-2408 build).
}

/* ─── Element asset library (independent collections, mention-by-name) ───
   Stored separately from project reference assets. An element's images keep a
   FULL-RES base64 data URL in `url` so the library survives deletion of the
   on-disk source file AND userData loss (the Documents backup mirror persists
   the whole store JSON). At send time the base64 is re-cached + re-uploaded to
   R2 via the SAME helpers panel assets use — no server.ts changes. */
export type AssetCategory = 'character' | 'location' | 'prop';

export interface ElementImage {
  id: string;
  // 원본. 26.9.3001~ 서버 라이브러리 폴더의 파일 이름(내용 md5 앞 12자리 + 확장자). 보내기·복사·
  // 공유는 이 파일 바이트 그대로 나간다. 화면은 JPG 미리보기(libraryPreviewSrc)를 주소로 불러온다.
  libId?: string;
  // 옛 방식의 원본 base64 data URL. 옮기기(migrateLibraryImages)가 원본을 파일로 넣은 뒤 지운다 —
  // 이게 스토어에 남아 있으면 그만큼 화면 메모리를 먹는다(2026-09-28 렌더러 사망의 원인).
  // 새로 만드는 이미지에는 넣지 않는다. 공유 팩을 가져올 때 잠깐 들고 오는 것만 있다.
  url?: string;
  thumbnailUrl: string; // small base64 preview for the UI
  cacheId?: string;     // opportunistic media-cache id (옛 어셋의 보내기 대체 경로)
  file_name?: string;
}

export interface ElementAsset {
  id: string;
  collectionId: string;
  category: AssetCategory;
  name: string;
  description: string;
  images: ElementImage[];
  createdAt: number;
  updatedAt: number;
}

export interface AssetCollection {
  id: string;
  name: string;
  createdAt: number;
}

export interface GenerationSettings {
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
  generate_audio: boolean;
  return_last_frame: boolean;
  output_count: number;
  use_asset_id: boolean;
  mode: GenerationMode;
  // Gemini Omni only — explicit task (text_to_video|image_to_video|reference_to_video|edit). Seedance ignores it.
  // Reuses `ratio` (aspect 16:9/9:16) and `duration` (3–10s) from above.
  omniTask?: string;
  // Container/codec the API renders to. Only meaningful for models that offer a choice
  // (MODELS.outputFormats); absent or unsupported falls back to the model's default, so
  // every model that never had this behaves exactly as before.
  output_format?: string;
  // 초안 모드 (2.5 전용, MODELS.draftMode). 켜면 480p 초안으로 보내고, 마음에 드는 것만
  // 카드에서 1080p 본편으로 만든다. 해상도는 이 값이 대신 정하므로(applyTaskConstraints)
  // 저장된 resolution 은 건드리지 않는다 — 끄면 쓰던 해상도가 그대로 돌아온다.
  // ★ 세 가지 상태다. undefined = "모델 기본값을 따름"(2.5 는 켜짐, draftEffective),
  //   true/false = 사용자가 해상도 드롭다운에서 직접 고른 것. 모델·모드를 바꾸거나 초기화하면
  //   undefined 로 돌아가 기본값을 다시 따른다.
  draft?: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  content: string;
  taskId?: string;
  status?: 'queued' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string;
  imageUrl?: string;
  // NCP 보관 힌트. videoUrl 은 약 24시간 뒤 죽으므로 그 뒤의 재생은 /api/media/{taskId}
  // 로 간다. 서버가 taskId→위치 색인을 들고 있어서 평소엔 이 값이 필요 없지만,
  // 재설치 등으로 색인을 잃으면 이 두 값으로 객체를 되찾는다.
  // ext 를 여기 굽는 이유: 확장자는 생성 API 가 준 URL 에서만 확정되고(2.5 는 .mov),
  // 그 URL 은 24시간 뒤 없다 — 나중에는 계산할 방법이 없다.
  // project 는 보낼 때의 이름 — NCP 폴더 이름이라 나중에 이름이 바뀌어도 그대로 둔다(영상이 거기 있다).
  // projectId/projectKey 는 과금 프로젝트를 이름 대신 따라가는 값이다(Draft → 본편 권한·트래커 보고).
  // 26.9.2306 이전 메시지에는 없다 — 그때는 project(이름)로 찾는다.
  videoStorage?: { project?: string; ext?: string; projectId?: string; projectKey?: string };
  error?: string;
  timestamp: number;
  startTime?: number;
  endTime?: number;
  usedSettings?: GenerationSettings;
  usedAssets?: Asset[];
  promptText?: string;
  promptHtml?: string; // innerHTML snapshot (with mention pills) for exact 재사용 — element mentions are stored as bare names in promptText and can't be re-pillified from it
  apiPrompt?: string;  // BytePlus·구글에 실제로 보낸 문장(@hero → [Image 3], 옴니는 <IMAGE_REF_N>). 26.10.801~ 카드만 — 받은 영상의
                       // 설정(settings-box)에 참고로 싣는다. 되살리기는 promptHtml 로 한다.
  usedElementImages?: { id: string; elementId: string; imageId: string; name: string; category: string; url: string }[]; // element-mention images shown on the card reference strip (url = thumbnail; full-res for hover-zoom is looked up live by elementId+imageId)
  usedCollection?: { id: string; name: string }; // 보낼 때 이 채팅에 연결돼 있던 어셋 컬렉션(26.10.801~) — 받은 영상에서 '그때 설정 그대로' 가 다시 연결한다
  downloadedAt?: number; // last time the user downloaded this video — flips the
                         // download button to "다시 다운로드" styling
  starred?: boolean; // 채택된 컷. Selecting takes is the core of the editing workflow and
                     // a project can hold thousands of clips, so this is just a flag +
                     // a gallery filter. One boolean per message — no storage concern.
  downloadedPath?: string; // absolute path it was saved to, for "폴더에서 보기".
                           // Stored rather than recomputed at click time because the
                           // download folder is a session-only override — resolving it
                           // later would point at the wrong folder. Empty when the
                           // browser picked the location (dev/anchor fallback).
  draftOf?: string; // 이 본편을 만든 초안의 taskId. 초안 카드는 이 값을 거꾸로 찾아 "본편 보기"
                    // 를 띄우고, 본편 카드는 이 값으로 초안을 찾아 "초안 보기" 를 띄운다.
}

// A sidebar folder. Purely an organisational shell: it owns no settings and no data,
// only a name, an order (its position in the array) and whether it's folded shut.
// Projects point AT a group rather than groups holding a list of projects — one place
// to update on a move, and a project can never end up in two folders.
export interface ProjectGroup {
  id: string;
  name: string;
  collapsed?: boolean;
  parentId?: string; // the folder this folder sits in. Undefined = top level.
                     // ★ EXACTLY ONE LEVEL. A group that has a parent can never itself be
                     // a parent. Deeper trees were deliberately not built: past two levels
                     // the sidebar runs out of horizontal room, the badge has to aggregate
                     // over an arbitrary depth, and every drop needs a cycle check — all to
                     // replace something project names already do well.
}

// The one rule that keeps nesting at one level, applied at READ time rather than trusted
// from the data: a group is a SUBGROUP only if its parent exists AND that parent is itself
// top-level. Anything failing the test renders at the top level instead of disappearing —
// a dangling parentId, a parent that is itself nested, even a two-group cycle (A→B→A) all
// resolve to "top-level", which is wrong-but-visible rather than right-but-gone.
// Same principle as a project with a dangling groupId: whatever exists must be reachable.
// Guarantees every group renders exactly once — a root, or a child of exactly one root.
export function groupTree(groups: ProjectGroup[]) {
  const byId = new Map(groups.map(g => [g.id, g]));
  const isSub = (g: ProjectGroup) => {
    if (!g.parentId) return false;
    const parent = byId.get(g.parentId);
    return !!parent && !parent.parentId;
  };
  return {
    isSub,
    roots: groups.filter(g => !isSub(g)),
    childrenOf: (id: string) => groups.filter(g => g.parentId === id && isSub(g)),
  };
}

// Is `parentId` a legal home for group `id`? The single gate every nesting path goes
// through — drag, the folder menu, and creation all call it, so the one-level rule can't
// be true in one path and false in another.
// The sidebar also hides illegal drop targets, so reaching a `false` here means the data
// or a caller is wrong. Refuse rather than guess: a silently-built three-deep tree is far
// worse than a drop that doesn't take.
function canNest(groups: ProjectGroup[], id: string, parentId: string | undefined): boolean {
  if (!parentId) return true;                                       // → top level is always fine
  if (parentId === id) return false;                                // never its own parent
  const parent = groups.find(g => g.id === parentId);
  if (!parent || parent.parentId) return false;                     // parent must itself be top-level
  return !groups.some(g => g.parentId === id);                      // and the mover must be childless
}

// ── Names have to be tellable apart ──────────────────────────────────────────
// Two rows with identical text are two rows you cannot choose between: which "광고" holds
// last week's cut? The list can't answer, so the name has to.
//
// Numbering starts at (1), not (2). Windows starts at (2) because it is naming a COPY and
// counts the original as 1; nothing is being copied here, so (1) is simply "the second one".
//
// An existing " (N)" is stripped before searching, or renaming 광고(1) next to a 광고 would
// grow "광고 (1) (1)" and then "광고 (1) (1) (1)". A deliberate "시즌 (2)" that happens to
// be free is returned untouched — the strip only happens on an actual collision.
// ── Auto-numbering: the number comes from what is FREE, never from how many exist ──
// "Project N" / "그룹 N" used to be built from `list.length + 1`, which is a COUNT, and a
// count answers the wrong question. Three ways that broke, all reproduced 2026-08-06:
//   · rename "Project 21" → the number 21 is free again, but the count is still 21, so the
//     next new project came out "Project 22" and 21 was never reused.
//   · delete "Project 5" → count drops to 20, so the next one aimed at "Project 21" — which
//     still exists — and uniqueName papered over the collision as "Project 21 (1)".
//   · 20 of 21 projects inside folders → the top level shows ONE item and offered
//     "Project 22", because the count is global while uniqueness is per-container.
// Windows Explorer fills the gap: rename "새 폴더 (2)" and the next one is "새 폴더 (2)"
// again. §6 already claims that rule for name collisions; this makes the numbering obey it
// too, and it reads from the SAME container list the collision check uses, so the two can
// no longer disagree.
function nextNumberedName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function uniqueName(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(desired)) return desired;
  const base = desired.replace(/\s*\(\d+\)$/, '').trim() || desired;
  for (let n = 1; n < 10000; n++) {
    const cand = `${base} (${n})`;
    if (!used.has(cand)) return cand;
  }
  return `${base} (${used.size + 1})`; // unreachable in practice; never loop forever
}

// ── Scope: one container, one namespace — exactly like a Windows folder ──────
// A CONTAINER is one visible list: the top level, or the inside of a folder. Two things
// only clash when they are drawn in the SAME list.
//   S010 (folder) containing C010, and a C010 sitting next to S010 → not a clash. They
//   are never shown side by side, so neither is ambiguous.
//   Move that outer C010 into S010 → now they meet, and the newcomer becomes C010 (1).
// Move it back out and it stays C010 (1): the name it was given is its name now, and
// silently un-renaming things behind the user is worse than a suffix they can edit.
//
// Folders and projects share ONE namespace per container, because they are drawn in one
// list — same reason Windows won't let a folder and a file take the same name.
//
// (Projects were briefly app-wide unique. That was wrong: it forbade the perfectly normal
// "C010 in every shot folder". The one thing app-wide scope bought — telling matches apart
// in the sidebar search, which flattens the tree — is now handled properly, by printing
// each match's folder next to it.)
function namesInContainer(
  groups: ProjectGroup[],
  projects: Project[],
  containerId: string | undefined,
  except?: { groupId?: string; projectId?: string },
): string[] {
  const t = groupTree(groups);
  const live = new Set(groups.map(g => g.id));
  const out: string[] = [];
  for (const g of groups) {
    if (g.id === except?.groupId) continue;
    // Effective parent, not the raw field: a group with a dangling parentId is DRAWN at
    // the top level, so that is the list it has to be distinguishable in.
    if ((t.isSub(g) ? g.parentId : undefined) === containerId) out.push(g.name);
  }
  for (const p of projects) {
    if (p.id === except?.projectId) continue;
    if ((p.groupId && live.has(p.groupId) ? p.groupId : undefined) === containerId) out.push(p.name);
  }
  return out;
}

// Unfold whatever is hiding a project, so a selection is actually on screen. Jumping to a
// clip from the gallery, or falling back to a survivor after a delete, otherwise changes
// the header while the sidebar shows no selection at all — it reads as "nothing happened".
// Returns the SAME array when nothing is folded: this runs on every project click, and
// rebuilding it each time would re-serialize the persisted state for no change.
function revealProject(groups: ProjectGroup[], projects: Project[], projectId: string | null): ProjectGroup[] {
  if (!projectId) return groups;
  const p = projects.find(x => x.id === projectId);
  const home = p?.groupId ? groups.find(g => g.id === p.groupId) : undefined;
  if (!home) return groups;
  // The whole chain — an open subfolder inside a folded parent is just as invisible.
  const chain = [home, ...(home.parentId ? groups.filter(g => g.id === home.parentId) : [])];
  const ids = new Set(chain.filter(g => g.collapsed).map(g => g.id));
  if (!ids.size) return groups;
  return groups.map(g => ids.has(g.id) ? { ...g, collapsed: false } : g);
}

// Unfold a destination folder so what just moved into it is actually on screen. Moving
// something into a folded folder is indistinguishable from deleting it.
function openChain(groups: ProjectGroup[], parentId: string | undefined): ProjectGroup[] {
  if (!parentId) return groups;
  return groups.map(g => g.id === parentId ? { ...g, collapsed: false } : g);
}

export interface Project {
  id: string;
  name: string;
  messages: ChatMessage[];
  settings: GenerationSettings;
  assets: Asset[];
  updatedAt: number;
  draftPrompt?: string; // saved prompt HTML so users can switch projects without losing in-progress text
  icon?: string; // sidebar icon: an emoji character, OR a data: URL for an uploaded 64px PNG.
                 // ONE field, not two — `startsWith('data:')` tells them apart, and two
                 // fields would permit a meaningless both-set state. Undefined = default icon.
  groupId?: string; // sidebar folder this project sits in. Undefined = ungrouped (shown
                    // in a flat list below the groups). A dangling id — group deleted
                    // some other way — is treated as ungrouped rather than hiding the
                    // project, so a project can never become unreachable.
  lastSeenAt?: number; // completion timestamp of the newest finished clip the user has
                       // actually looked at. Drives the sidebar "done" badge: anything
                       // that finished after this is unseen. Stores the CLIP's time (not
                       // Date.now()) so the comparison is idempotent — re-marking while
                       // nothing new finished is a no-op and never writes.
}

interface AppState {
  _hasHydrated: boolean;
  // 'light' | 'dark'. Persisted app-wide (not per project) and applied by toggling a
  // `dark` class on <html>, which is what every dark: utility keys off.
  theme: Theme;
  setTheme: (t: Theme) => void;
  // Element library loads from its own IDB key AFTER main hydration. Until this is
  // true the library may still be empty — element-dependent UI (@mention list, send)
  // must wait on it rather than act on a half-loaded library.
  _elementsHydrated: boolean;
  // 이번 실행에서 작업 기록을 지키려고 저장을 멈췄을 때의 안내(App.tsx 빨간 띠). 저장하지 않는다.
  persistTrouble: string | null;
  // 백업에서 되살리기로 이미 살펴본 백업 파일(이름|크기|시각 — 서버는 크기|시각으로 알아본다). 저장한다 —
  // 큰 파일을 매번 다시 훑지 않고, 되살린 걸 지운 뒤 다시 살아나지도 않게.
  recoveryScanned: string[];
  // 이 PC 에서 사용자가 직접 지운 프로젝트 id(최근 500개). 되살리기는 이것을 '있는 것'으로 친다 — 일부러
  // 다 지운 기록이 옛 백업에서 되살아나지 않게(파일 이름·시각이 바뀌어도).
  deletedProjectIds: string[];
  projects: Project[];
  currentProjectId: string | null;
  autoDownload: boolean; // global toggle — auto-save every video when it succeeds
  setAutoDownload: (v: boolean) => void;
  // 받은 영상 끝에 생성 설정(프롬프트 · 파라미터 · 레퍼런스 정보)을 넣는다(26.10.801~, settings-box). 기본 켬. 끄는 경우:
  // 받은 영상을 손대지 않고 바깥(고객 등)에 넘길 때 프롬프트가 같이 나가는 게 싫을 때.
  embedSettings: boolean;
  setEmbedSettings: (v: boolean) => void;
  // Billing/tracking project (시트 연동). Session-only + app-global: picked once per
  // launch, survives local-project switches AND queue sends, NOT persisted (restart
  // → must re-pick). Distinct from the local `projects` sidebar workspaces.
  // ★ 이름이 아니라 키(BillingProject.key)를 든다. 프로젝트 이름은 PM 프로그램(POS)에서 바뀔 수
  // 있고, 이름으로 기억하면 이름이 바뀌는 순간 선택이 풀리고 Draft → 본편이 막힌다.
  // 이름·권한이 필요하면 selectedBillingProject() 로 지금 목록에서 찾는다.
  billingProjectKey: string;
  // allow4k mirrors the tracker sheet's Project_Status F column ("4K 허용"), refreshed
  // by the same 60s poll that carries status. Kept on this list rather than in its own
  // store field so a permission flip costs zero extra writes/renders.
  // ★ The LIST is persisted; the SELECTION above is not. That split is the whole point.
  // This list changes maybe once a week, but it used to be thrown away on every restart,
  // so a cold launch had exactly one way to fill it: a live GAS call. Measured 2026-08-05:
  // a cold Apps Script /exec takes 127s and then returns 404 (warm: 2s). For those minutes
  // the app showed "등록된 프로젝트가 없습니다. PM에게 문의하세요" and no work was possible.
  // Persisting the last known-good list makes a slow tracker invisible — the dropdown is
  // there instantly and the 60s poll corrects it in the background.
  // Persisting the SELECTION would be a different matter and is still forbidden: see the
  // hydration-clamp rule (isFourKAllowed returns false whenever billingProjectKey is empty,
  // which is exactly what keeps a stored '4k' setting from being wiped at boot).
  billingProjects: BillingProject[];
  // Did the last tracker fetch actually land? null = 아직 모름 (boot). The server already
  // distinguishes "couldn't fetch" (ok:false) from "fetched, list is empty" (ok:true, []),
  // and App.tsx already acts on it — but the UI had no way to see it, so a dead tracker
  // was reported to the user as "your PM never registered you". Transient, never persisted.
  trackerReachable: boolean | null;
  setBillingProjectKey: (key: string) => void;
  setBillingProjects: (list: BillingProject[]) => void;
  setTrackerReachable: (v: boolean) => void;
  // Transient (NOT persisted): # of images from elements currently @mentioned in
  // the active prompt. ChatArea writes it; SettingsPanel reads it to show the
  // shared "panel + element" image budget in the Reference Assets hint.
  mentionedElementImages: number;
  setMentionedElementImages: (n: number) => void;
  setCurrentProjectId: (id: string) => void;
  // groupId 를 주면 그 그룹 안에 만든다(사이드바 그룹 머리의 +). 없거나 모르는 값이면 최상위.
  createProject: (groupId?: string) => void;
  renameProject: (id: string, name: string) => void;
  setProjectIcon: (id: string, icon: string | undefined) => void;
  markProjectSeen: (projectId: string) => void;
  createProjectGroup: (name?: string, parentId?: string) => string;
  renameProjectGroup: (id: string, name: string) => void;
  deleteProjectGroup: (id: string) => void;              // folder only — projects released, subfolders promoted
  deleteProjectGroupWithProjects: (id: string) => void;  // folder, its subfolders, AND every project in them
  toggleProjectGroup: (id: string) => void;
  setGroupParent: (groupId: string, parentId: string | undefined) => void;
  setProjectGroup: (projectId: string, groupId: string | undefined) => void;
  moveProjectBefore: (draggedId: string, targetId: string) => void;
  moveProjectToEnd: (projectId: string, groupId: string | undefined) => void;
  moveGroupBefore: (draggedId: string, targetId: string) => void;
  moveGroupToEnd: (draggedId: string, parentId?: string) => void;
  deleteProject: (id: string) => void;
  updateProjectSettings: (projectId: string, settings: Partial<GenerationSettings>) => void;
  addAsset: (projectId: string, asset: Omit<Asset, 'id'>) => void;
  removeAsset: (projectId: string, assetId: string) => void;
  replaceAsset: (projectId: string, assetId: string, updates: Partial<Omit<Asset, 'id'>>) => void;
  replaceAllAssets: (projectId: string, assets: Omit<Asset, 'id'>[]) => void;
  setAssetOrder: (projectId: string, orderedIds: string[]) => void;
  clearAssets: (projectId: string) => void;
  updateDraftPrompt: (projectId: string, draft: string) => void;
  addMessage: (projectId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateMessage: (projectId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  deleteMessage: (projectId: string, messageId: string) => void;
  clearMessages: (projectId: string) => void;
  pollTask: (projectId: string, messageId: string, taskId: string) => Promise<void>;
  cancelTask: (projectId: string, messageId: string, taskId: string) => Promise<void>;
  // ─── Element library ───
  assetCollections: AssetCollection[];
  elementAssets: ElementAsset[];
  projectGroups: ProjectGroup[];
  projectCollectionId: Record<string, string>; // chat-projectId → bound collectionId
  createCollection: (name: string) => string;   // returns the new collection id
  renameCollection: (id: string, name: string) => void;
  deleteCollection: (id: string) => void;        // also drops its elementAssets + bindings
  addElementAsset: (asset: Omit<ElementAsset, 'id' | 'createdAt' | 'updatedAt'>) => void;
  updateElementAsset: (id: string, updates: Partial<Omit<ElementAsset, 'id' | 'collectionId' | 'createdAt'>>) => void;
  deleteElementAsset: (id: string) => void;
  setProjectCollection: (projectId: string, collectionId: string | null) => void;
}

export const defaultSettings: GenerationSettings = {
  model: 'dreamina-seedance-2-0-260128',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  generate_audio: true,
  return_last_frame: false,
  output_count: 1,
  use_asset_id: false,
  mode: 'text_to_video',
  omniTask: 'text_to_video', // Omni task is always explicit (no "Unspecified"/auto-infer)
  // Present, and undefined on purpose. Settings are merged as {...current, ...patch}, so a
  // key that is ABSENT from defaultSettings survives every "reset to defaults" spread —
  // 초기화 would have restored everything except this one. Declaring it here means the
  // reset carries it, and undefined is exactly "use whatever this model renders by default".
  output_format: undefined,
  // 같은 이유로 명시한다 — 초기화가 이 키도 덮어써야 한다. undefined 는 "모델 기본값을 따름"
  // 이라서 2.5 는 초기화하면 Draft 로 돌아간다.
  draft: undefined,
};

// ── Theme ───────────────────────────────────────────────────────────────────────────
// Class-based, on <html>, so it is set once and every `dark:` utility in the tree follows.
// Mirrored to localStorage as well as the persisted store: IndexedDB hydration is async,
// so without a synchronous copy the app paints one light frame before flipping. The
// inline script in index.html reads that copy before React mounts.
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'seedance-theme';
export function applyTheme(t: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', t === 'dark');
  // Tells the engine to render native widgets (scrollbars, form controls, the canvas
  // behind the page) in the matching scheme — otherwise a white scrollbar track and a
  // white flash on resize sit on top of an otherwise dark UI.
  document.documentElement.style.colorScheme = t === 'dark' ? 'dark' : 'light';
  try { localStorage.setItem(THEME_KEY, t); } catch { /* private mode — the store copy still works */ }
}

// ── Seedance 2.0 model catalog ──────────────────────────────────────────────
// Only the flagship 2.0 supports 1080p and 4k; Fast and Mini cap lower (see
// modelResolutions below for the measured matrix). Single source of truth shared by
// the settings UI, the hydration clamp, and the send-time guard so a model never
// receives an unsupported resolution. Default is the flagship (dreamina-seedance-2-0-260128).
// ── Per-model capability overrides ──────────────────────────────────────────
// EVERY field below is optional and every reader falls back to the pre-existing
// behaviour when it is absent. The 2.0 family and Omni carry none of them, so their
// code paths are byte-for-byte what they were — adding a model cannot change them.
// Only add a field when a model genuinely differs; don't fill these in "for clarity".
//   res         allowed resolutions            (default: the modelResolutions() rules)
//   dur         [min, max] output seconds      (default: Omni 3–10 / Seedance 4–15)
//   imgMax      reference-image cap            (default: 9)
//   vidMax      reference-video cap            (default: 3)
//   audMax      reference-audio cap            (default: 3)
//   refVideoSec max single reference-video sec (default: 15.2)
//   refAudioSec max single reference-audio sec (default: 15.2)
//   outputFormat  API `output_format` (default: omitted → mp4)
//   audioOnly     reference audio may stand alone (default: false — 2.0 needs an image/video)
//   adaptiveOnly  modes where the API accepts ONLY ratio:'adaptive'
//   autoDurationOnly modes where the API accepts ONLY duration:-1
//   refTaskTypes  mode → API `omni_reference_task_type` (default: omitted → API infers)
//   defaults    the model's OWN documented defaults, used when a mode is picked
//               (default: the app-wide defaultSettings — what 2.0 has always used)

// Seedance 2.5's capability set.
// Numbers are the official datasheet AND re-measured against the live API 2026-08-07:
//   · 480p/720p only. The doc states 1080p/4k are unsupported; the API happens to ACCEPT
//     those values at validation, which is a validation gap, not a capability — do not be
//     fooled by a probe that only reaches the ratio check.
//   · 4–30s output (or -1), 30 images / 10 videos / 10 audio (= the advertised 50 assets)
//   · reference video AND audio ≤30.2s, per-clip and summed (API states both verbatim)
const SEEDANCE_25 = {
  // 1080p added 2026-08-18 (BytePlus opened it; the 08-07 datasheet still said "not
  // currently supported"). 4k remains 2.0-only, so nothing here needs the allow4k gate.
  // ★ 1080p is NOT just a bigger 720p on this model. Measured on the real output:
  //   480p/720p → H.264 8-bit,           1080p → HEVC, profile Rext, yuv444p10le
  // The doc only promises "10-bit + H.265"; it is actually 4:4:4 Rext, a profile most
  // browser decoders refuse. Verified it plays in our Electron renderer before shipping
  // it — loadeddata, readyState 3, 1920×1080, 9 frames decoded, 0 dropped. If a machine
  // without HEVC support ever turns up, the failure is preview-only: the .mov still
  // downloads and opens in a real player. Do not "simplify" this back into a plain
  // resolution list without re-measuring playback.
  res: ['480p', '720p', '1080p'],
  dur: [4, 30] as [number, number],
  imgMax: 30, vidMax: 10, audMax: 10,
  // BytePlus doc 2607688, video editing: "The reference video must be 4-30 seconds long."
  // A hard constraint, and one that is only checked AFTER the task is queued
  // (InvalidParameter.TaskTypeConstraint), so a 3s clip costs a full async failure.
  editRefVideoMinSec: 4,
  refVideoSec: 30.2, refAudioSec: 30.2,
  // 2.5 can take reference audio with no image/video alongside it. 2.0 cannot.
  audioOnly: true,
  // mov = H.264 High 4:4:4 + PCM. Chromium plays it — MEASURED, not assumed: readyState 4,
  // 57 decoded frames, 0 dropped, full canvas readback. Note canPlayType('video/quicktime')
  // returns '' for it, so never gate playback on canPlayType (same trap as HEVC in §5-2).
  outputFormat: 'mov',
  // The API renders EITHER format; it is a generation-time parameter, so a finished clip
  // exists only in the one it was made with — there is no "download as mp4" without
  // re-encoding locally, which we do not do (no ffmpeg bundled, and re-encoding a 4:4:4
  // master down to H.264 would lose more than asking the API for mp4 in the first place).
  // Measured at 1080p, same settings, one generation each:
  //   mov → HEVC Rext    yuv444p10le, PCM 1024kbps, 12.2Mbps
  //   mp4 → HEVC Main 10 yuv420p10le, AAC  129kbps, 14.5Mbps
  // So mp4 keeps 10-bit — the doc's "standard color precision" wording suggests 8-bit and
  // is wrong for this tier. What it actually costs is chroma (4:4:4 → 4:2:0) and lossless
  // audio. What it buys is a decoder profile everything can open; Rext 4:4:4 is refused by
  // most editors and players (our own Electron plays both — measured).
  // Default stays 'mov' so existing behaviour is unchanged.
  outputFormats: ['mov', 'mp4'],
  // ★ Task-type constraints from the official doc. Violating these does NOT fail fast — the
  // task is created, queues, gets classified, and only THEN returns
  // InvalidParameter.TaskTypeConstraint. That is time and a slot already spent, so the app
  // has to enforce them before sending.
  adaptiveOnly: ['edit_video', 'extend_video', 'image_to_video_first', 'image_to_video_first_last'] as GenerationMode[],
  autoDurationOnly: ['edit_video'] as GenerationMode[],
  // ★ omni_reference_task_type (added by BytePlus 2026-08-11). reference / edit / extend all
  // arrive with the SAME role (reference_*), so until this existed the model had to guess the
  // task from the prompt wording — and our mode picker never reached the server at all.
  // Measured 2026-08-11:
  //   · an edit-worded prompt + 'reference' came back as reference-to-video → the parameter
  //     outranks the prompt, so picking a mode in the app now actually means something.
  //   · a neutral prompt + 'edit' was rejected SYNCHRONOUSLY at create time (HTTP 400, no
  //     task) instead of queueing and failing asynchronously — the wait and the slot are
  //     saved. That is the whole point of the parameter.
  // Only the three reference-family modes get a value; frame modes are decided by the
  // first_frame/last_frame roles and text-to-video has no references at all.
  refTaskTypes: { multimodal_reference: 'reference', edit_video: 'edit', extend_video: 'extend' } as Partial<Record<GenerationMode, string>>,
  // ★ 초안 모드 (문서 2607688 #2.5_draft_mode). 2.5 만 된다 — 표에 2.0/Fast/Mini 는 ✗.
  //   초안: draft:true + 480p 만 허용. 본편: content 에 draft_task.id 하나 + 1080p 만 허용.
  // 2026-09-23 실측 (같은 레퍼런스·프롬프트·4초):
  //   초안 cgt-20260923150149-uwfpr  38,830 토큰  H.264 854x480        ~59초
  //   본편 cgt-20260923150252-668nu 196,425 토큰  HEVC 10bit 1920x1080  ~32초
  //   seed 가 같고(92341) 구도도 같다. 본편은 초안을 '키운 것' 이지 새로 뽑은 것이 아니다.
  //   초안이 끝나고 R2 레퍼런스를 지운 뒤에도 본편이 만들어졌다 — 입력은 BytePlus 가 들고 있다.
  // 본편에 generate_audio 를 다시 보내면 값이 같아도 즉시 400 이다(태스크가 안 생김).
  // 그래서 본편은 handleSend 를 타지 않고 전용 페이로드로 보낸다 (ChatArea / makeFinalFromDraft).
  draftMode: true,
  // Defaults a mode starts at. Only `resolution` is the datasheet's own "Default value" —
  // ratio and duration deliberately are not, and for the same reason: the API's defaults
  // both hand the decision to the model, and a default should be predictable.
  //   · duration: the API defaults to -1 (Auto), which on 2.5 picks anywhere in 4–30s. The
  //     model choosing 30 over 5 costs ~6x, and unlike 2.0 (4–15) nobody asked for that
  //     range. Cost is something you opt into, not something a default hands you.
  //   · ratio: the API defaults to `adaptive`, which lets the model pick the aspect ratio
  //     from the prompt — so the same prompt can come back framed differently. 16:9 is what
  //     2.0 has always started at and what most deliveries want.
  // Both stay one click away, and both are overridden automatically where the API forces a
  // value: adaptiveOnly / autoDurationOnly are applied AFTER these, so Edit / Extend /
  // first-frame modes still get adaptive (and Edit still gets -1) with no exception listed
  // here. That ordering is the whole point — exceptions live in one place, not two.
  // draft: 2.5 는 Draft 로 시작한다(사용자 요청, 2026-09-23). 모드와 상관없이 — t2v·레퍼런스·
  // 편집·연장 모두. 1080p 를 바로 뽑던 방식이 기본이면 버려질 컷에도 본편 값을 낸다.
  defaults: { resolution: '720p', ratio: '16:9', duration: 5, draft: true },
};

// The Omni video tasks every Gemini model has offered since the first Flash preview.
// "Unspecified" (omit the task → the model infers one) is an API-valid 5th state that is
// deliberately NOT here and must never be added: the task decides which assets the panel
// accepts and which prompt tags get emitted, so inferring it would make the whole surface
// guess. Task is always an explicit user choice.
export const OMNI_DEFAULT_TASKS = ['text_to_video', 'image_to_video', 'reference_to_video', 'edit'];

// ── 설정 패널과 에이전트 설명서가 같이 읽는 목록 (26.10.302~) ─────────────────────────
// 원래 SettingsPanel.tsx 안에 있던 것들이다. 에이전트 작업함의 설명서(src/lib/agent-inbox.ts)가 '패널에서 고를 수
// 있는 것' 을 그대로 알려야 해서 여기 한 곳으로 옮겼다. 패널에 따로 적지 마라 — 설명서와 갈린다.
export const GENERATION_MODES: { id: GenerationMode; name: string }[] = [
  { id: 'text_to_video', name: 'Text to Video' },
  { id: 'image_to_video_first', name: 'Image to Video (First Frame)' },
  { id: 'image_to_video_first_last', name: 'Image to Video (First & Last)' },
  { id: 'multimodal_reference', name: 'Multimodal Reference' },
  { id: 'edit_video', name: 'Edit Video' },
  { id: 'extend_video', name: 'Extend Video' },
];
export const SEEDANCE_RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const OMNI_RATIO_IDS = ['16:9', '9:16'];
// Gemini Omni — display names for the API's task values. Which of these a given model
// actually offers comes from modelOmniTasks(); this map is only the label lookup, so a
// task added for one model can never appear on another just by living in this file.
// "Unspecified" (omit task → model infers) is intentionally absent — see OMNI_DEFAULT_TASKS.
export const OMNI_TASK_NAMES: Record<string, string> = {
  text_to_video: 'Text to Video',
  image_to_video: 'Image to Video',
  reference_to_video: 'Reference to Video',
  edit: 'Edit Video',
  extend: 'Extend Video',
};
// Labels for the output-format picker. Codec details (4:4:4 vs 4:2:0, PCM vs AAC) stay out
// of the UI on purpose — the choice people actually make is "editing" vs "share it around".
// The measured difference is recorded on MODELS.outputFormats below if it's ever needed again.
export const OUTPUT_FORMAT_LABEL: Record<string, string> = {
  mov: 'MOV · 편집용',
  mp4: 'MP4 · 호환',
};
// Modes where return_last_frame makes sense.
export const RETURN_LAST_FRAME_MODES: GenerationMode[] = [
  'text_to_video',
  'image_to_video_first',
  'multimodal_reference',
  'edit_video',
  'extend_video',
];
// 한 번에 만드는 개수 상한 — 패널 슬라이더와 에이전트 작업함.
export const OUTPUT_COUNT_MAX = 3;
// Omni 편집·연장·참조 영상의 크기 상한(MB) — 첨부(attachFiles 의 옴니 분기)와 설명서.
export const OMNI_VIDEO_MAX_MB = 50;

export const MODELS: {
  id: string; name: string; provider?: 'byteplus' | 'gemini';
  res?: string[]; dur?: [number, number]; imgMax?: number; vidMax?: number; audMax?: number;
  refVideoSec?: number; refAudioSec?: number;
  // Shortest reference video the EDITING task accepts, when the model states one.
  editRefVideoMinSec?: number;
  outputFormat?: string; outputFormats?: string[]; audioOnly?: boolean;
  adaptiveOnly?: GenerationMode[]; autoDurationOnly?: GenerationMode[];
  refTaskTypes?: Partial<Record<GenerationMode, string>>;
  // 초안(480p) → 본편(1080p) 두 단계 생성을 지원하는가. 없으면 초안 토글이 안 보이고,
  // 저장된 draft 값이 남아 있어도 applyTaskConstraints 가 꺼서 보낸다.
  draftMode?: boolean;
  // Gemini Omni only — does this model do first+last frame interpolation as a documented
  // feature? Absent → the older reference_to_video workaround, which is what the Flash
  // preview has always used and must keep using.
  firstLastFrame?: boolean;
  // Gemini Omni only — longest SOURCE clip task:'extend' will accept, in seconds.
  // Stated by the API itself: "Videos longer than 30s are not supported for extension."
  extendMaxSrcSec?: number;
  // Gemini Omni only — which `generation_config.video_config.task` values this model offers.
  // Absent → OMNI_DEFAULT_TASKS (the 4 the original Flash preview shipped with), so adding
  // this field cannot change any model that doesn't declare it.
  omniTasks?: string[];
  defaults?: { resolution?: string; ratio?: string; duration?: number; draft?: boolean };
  // 에이전트 설명서(26.10.302~, src/lib/agent-inbox.ts)에 그대로 나간다. guide = 이 모델 프롬프트를 쓸 때 따를 공식
  // 가이드 이름(freewill 커넥터의 official/<guide>), notes = 위 숫자들로는 안 드러나는 사용법 한두 줄.
  // ★ 모델을 추가하면 이 둘도 적는다 — 팀원 PC 의 에이전트는 이걸 읽고 그 모델을 쓴다(커넥터는 손댈 필요 없음).
  guide?: string; notes?: string[];
}[] = [
  { id: 'dreamina-seedance-2-0-260128', name: 'Seedance 2.0', guide: 'sd2-pe',
    notes: ['4K 는 과금 프로젝트에 4K 권한이 있을 때만 — 없으면 앱이 낮춰서 보낸다. 4K 는 HEVC 10-bit 라 코덱이 없는 PC 에서는 미리보기가 안 될 수 있다.'] },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Seedance 2.0 Fast', guide: 'sd2-pe',
    notes: ['빠른 시안용 — 1080p·4K 가 없다.'] },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Seedance 2.0 Mini', guide: 'sd2-pe' },
  // Omni's reference-image cap is 10, not the Seedance default of 9. It used to live as a
  // literal `>= 10` in the panel; declaring it here is what lets the counter and the upload
  // button read the same number (they briefly disagreed — 9 vs 10 — when the literal was
  // swapped for modelImageMax without giving Omni its own value).
  // ── Measured 2026-08-28 against the live API, not taken from the model card ─────────
  // The card's "Maximum video length: 10 seconds" does NOT hold on this endpoint: a 30.0s
  // clip extended to 33.0s and 13.0s/20.0s clips were accepted as references. So no input
  // length cap is declared — there is no observed value to declare.
  //   audMax 0   Omni takes no audio input at all (generate_audio isn't even a parameter).
  //   vidMax 3   Google's documented per-prompt ceiling; 3 verified working (4 was also
  //              accepted, but undocumented and unverifiable in effect, so 3 stands).
  // These were previously left to the Seedance defaults (3 / 3 / 15.2s) — all three false.
  // The panel enforced the right thing with its own literals, so nothing broke; the
  // DECLARATIONS were the copy that lied, and modelAudioMax() answering "3" is what the
  // model-switch over-capacity warning reads.
  //
  // ★ This model has NO Extend: it answers "Video extension is currently not supported."
  // Schema validation does not reveal that — it accepts task:'extend' for both models
  // identically — which is the whole reason the two entries stay separate.
  { id: 'gemini-omni-flash-preview', name: 'Gemini Omni Flash', provider: 'gemini', imgMax: 10,
    vidMax: 3, audMax: 0, guide: 'gemini-omni-flash-api',
    notes: ['해상도 설정을 무시하고 늘 720p 로 나온다.',
      '끝 프레임은 비공식 — 참조 방식으로 유도할 뿐 정확한 보간이 아니다. 첫·끝 프레임이 필요하면 Omni 1.1.',
      '생성이 한 번에 끝나는 방식이라 카드가 보통 1분 안팎 "생성 중" 으로 있다가 바로 완성된다.'] },
  // ── Gemini Omni 1.1 Flash ───────────────────────────────────────────────────────────
  // Deliberately does NOT share a capability object with the preview above. The API
  // validates the request SCHEMA, not the model's abilities — probed 2026-08-28, both
  // models return the identical "Supported values: 'text_to_video', 'image_to_video',
  // 'reference_to_video', 'edit', 'extend'" for a bogus task. So the API will happily
  // accept `extend` addressed to the preview and we would never find out from an error.
  // Which model can do what has to live HERE, and the two entries must not be merged.
  //
  // The API's own enum, read back from a rejected value 2026-08-28:
  //   "Supported values: '360p', '720p', '1080p', '4k'"  ← no 480p, no 1440p/2k, no 8k.
  // Confirmed by generating each one and measuring the file (h264 yuv420p 24fps):
  //   360p → 640x360 ($0.34) · 720p → 1280x720 ($1.01)
  //   1080p → 1920x1080 ($1.52) · 4k → 3840x2160 ($3.04)   [per 10s clip]
  // ★ The SAME enum comes back for the Flash preview, but the preview IGNORES the field —
  // asked for 360p/1080p/4k it returned 1280x720 every time (measured, all four). That is
  // why the preview declares no `res` and never sends `resolution`: the API would accept
  // the request and the UI would claim 4K over a 720p file.
  // dur [3,10] is the API's own hard range, stated verbatim when either end is crossed:
  //   "Requested video duration 2s 0ns is less than the minimum allowed 3s 0ns"
  //   "Requested video duration 12s 0ns exceeds the maximum allowed 10s 0ns"
  // So there is no single-shot clip longer than 10s. Length past that comes only from
  // chaining Extend, which appends `duration` seconds each time and has no source-length
  // limit we could find (10.0→13.0, 13.0→16.0, 30.0→33.0, all exact).
  // Ratios verified to render, not just validate: 16:9 → 640x360, 9:16 → 360x640.
  // firstLastFrame: the model card lists "Videos from first and last frames — Supported".
  // Verified 2026-08-28 with a measurable pair (red ball left → red ball right): sending
  // both images under task:'image_to_video' with <FIRST_FRAME>/<LAST_FRAME> reproduced
  // frame 0 and the final frame from the inputs. The old reference_to_video workaround
  // also reproduced them, so this is not a bug fix — it is the documented path, and it
  // drops the "don't treat these as literal frames" disclaimer that route has to carry.
  { id: 'gemini-omni-1.1-flash', name: 'Gemini Omni 1.1 Flash', provider: 'gemini', imgMax: 10,
    vidMax: 3, audMax: 0, dur: [3, 10], firstLastFrame: true, extendMaxSrcSec: 30,
    res: ['360p', '720p', '1080p', '4k'],
    omniTasks: [...OMNI_DEFAULT_TASKS, 'extend'], guide: 'gemini-omni-flash-api',
    notes: ['첫·끝 프레임을 공식 지원한다(image_to_video 에 두 장).',
      'extend 는 30초 이하 원본에 duration 초만큼 이어 붙인다 — 한 번에 최대 40초.',
      '360p 는 1분 안팎, 1080p 는 2분 안팎, 4K 는 20분 넘게 걸리기도 한다.'] },
  // ── Seedance 2.5 (official, 2026-08-07) ─────────────────────────────────────────────
  // The demo endpoint that used to sit beside this row was retired 2026-08-14; projects
  // saved on it are moved here at hydration (LEGACY_MODEL_IDS in src/lib/model-access.ts),
  // which is safe because the two always had the identical capability set.
  // Permission lives in MODEL_GRANTS (src/lib/model-access.ts), not here — server.ts has
  // to read the same fact and must not import the store.
  { id: 'dreamina-seedance-2-5-260628', name: 'Seedance 2.5', ...SEEDANCE_25, guide: 'sd25-pe',
    notes: ['초안(draft)이 기본 — 480p 로 먼저 보고, 고른 것만 앱 카드의 \'본편\' 으로 1080p 를 만든다(같은 시드·구도를 키운 것). 바로 최종이면 draft:false 와 해상도를 정한다.',
      '1080p 는 HEVC 10-bit — mov(기본)는 4:4:4 라 일부 편집기·플레이어가 못 열고, mp4 는 4:2:0 이라 더 잘 열린다.'] },
];

// Capability lookups. Each returns the model's override when present, otherwise the
// exact rule that was in force before per-model overrides existed.
export function modelDurationRange(model: string): [number, number] {
  const o = MODELS.find(m => m.id === model)?.dur;
  if (o) return o;
  return modelProvider(model) === 'gemini' ? [3, 10] : [4, 15];
}
export function modelImageMax(model: string): number {
  return MODELS.find(m => m.id === model)?.imgMax ?? 9;
}
export function modelVideoMax(model: string): number {
  return MODELS.find(m => m.id === model)?.vidMax ?? 3;
}
export function modelAudioMax(model: string): number {
  return MODELS.find(m => m.id === model)?.audMax ?? 3;
}
export function modelRefVideoSec(model: string): number {
  return MODELS.find(m => m.id === model)?.refVideoSec ?? API_LIMITS.video.maxDuration;
}
// Shortest reference video for THIS model in THIS mode. Only editing declares a floor, and
// only on models that state one — every other combination keeps the API-wide 2s, so no
// existing model/mode pair changes.
export function refVideoMinSecFor(model: string, mode: GenerationMode): number {
  const m = MODELS.find(x => x.id === model);
  if (mode === 'edit_video' && m?.editRefVideoMinSec !== undefined) return m.editRefVideoMinSec;
  return API_LIMITS.video.minDuration;
}
export function modelRefAudioSec(model: string): number {
  return MODELS.find(m => m.id === model)?.refAudioSec ?? API_LIMITS.audio.maxDuration;
}
// Extend's source-length ceiling, and the longest clip it can ever produce.
// Measured 2026-08-28: a 30.016s source + duration:'10s' returned exactly 40.000s (960
// frames); a 33.0s source was refused outright with "Videos longer than 30s are not
// supported for extension." So the reachable maximum is source 30s + append 10s = 40s,
// and past that the only way on is to re-generate rather than extend again.
export function modelExtendMaxSrcSec(model: string): number | undefined {
  return MODELS.find(m => m.id === model)?.extendMaxSrcSec;
}
export function modelExtendMaxOutSec(model: string): number | undefined {
  const src = modelExtendMaxSrcSec(model);
  return src === undefined ? undefined : src + modelDurationRange(model)[1];
}
// Does this model do first+last frame interpolation officially (task:'image_to_video' with
// both frames) rather than through the reference_to_video workaround?
export function modelHasFirstLastFrame(model: string): boolean {
  return MODELS.find(m => m.id === model)?.firstLastFrame === true;
}
// Which Omni video tasks this model offers. The preview declares none and therefore keeps
// exactly the 4 it shipped with — adding 1.1 cannot hand it `extend`.
export function modelOmniTasks(model: string): string[] {
  return MODELS.find(m => m.id === model)?.omniTasks ?? OMNI_DEFAULT_TASKS;
}
// Normalize a stored task against a model. Every read of settings.omniTask goes through
// here, so a task that is merely *stored* (project saved on 1.1, then switched to the
// preview) can never reach a payload, an asset rule, or a chip.
export function resolveOmniTask(model?: string, task?: string): string {
  const ok = modelOmniTasks(model);
  return task && ok.includes(task) ? task : 'text_to_video';
}
// Tasks whose output FRAMING is inherited from the source clip. Verified 2026-08-28:
// `edit` rejects both duration and aspect_ratio; `extend` rejects ONLY aspect_ratio and
// uses duration as the number of seconds to APPEND (10s source + duration:'3s' → 13.0s,
// duration omitted → 20.0s). `resolution` is NOT inherited — both tasks accept it, and
// omitting it caps the output at 720p — so it is sent like any other task's. server.ts
// strips the rejected fields again on the way out: the client is where the UI decides
// what to show, the server is what guarantees the wire is clean.
// Payload `output_format`. Omitted → the API default (mp4), which is what every 2.0 model
// has always sent, so their requests are byte-for-byte unchanged.
export function modelOutputFormat(model: string): string | undefined {
  return MODELS.find(m => m.id === model)?.outputFormat;
}
// The formats this model lets the user choose between. Empty for every model that renders
// only one thing, which is how the picker stays hidden for 2.0 and Omni.
export function modelOutputFormats(model: string): string[] {
  return MODELS.find(m => m.id === model)?.outputFormats ?? [];
}
// What to actually send. A stored choice only counts if THIS model offers it — switching
// 2.5(mov) → 2.0 must not carry `mov` onto a model that never accepted the parameter.
export function resolveOutputFormat(model: string, chosen?: string): string | undefined {
  const offered = modelOutputFormats(model);
  if (chosen && offered.includes(chosen)) return chosen;
  return modelOutputFormat(model);
}
// Extension for a finished video. Reads it off the URL the API actually returned, and only
// falls back to the model's declared format when the URL says nothing. Deriving beats
// declaring here: a .mov saved as .mp4 opens in the wrong app, and the declaration can go
// stale the moment BytePlus changes a default — the URL cannot.
export function videoExtFor(url: string | undefined, model: string): string {
  const m = (url || '').split('?')[0].match(/\.(mp4|mov|m4v|webm)$/i);
  if (m) return '.' + m[1].toLowerCase();
  return modelOutputFormat(model) === 'mov' ? '.mov' : '.mp4';
}
export function modelAllowsAudioOnly(model: string): boolean {
  return MODELS.find(m => m.id === model)?.audioOnly === true;
}
// 모드(시댄스) · 작업(Omni)별로 붙일 수 있는 레퍼런스 개수 (26.10.302~). 첨부(ChatArea attachFiles — 드래그와
// 에이전트 작업함)와 에이전트 설명서가 같이 읽는다. 0 = 그 종류는 안 받음. 편집의 영상 1개는 '교체' 다.
export function modeRefCaps(model: string, mode: GenerationMode): { image: number; video: number; audio: number } {
  switch (mode) {
    case 'multimodal_reference': return { image: modelImageMax(model), video: modelVideoMax(model), audio: modelAudioMax(model) };
    case 'edit_video': return { image: modelImageMax(model), video: 1, audio: modelAudioMax(model) };
    case 'extend_video': return { image: 0, video: 3, audio: 0 };
    case 'image_to_video_first': return { image: 1, video: 0, audio: 0 };
    case 'image_to_video_first_last': return { image: 2, video: 0, audio: 0 };
    default: return { image: 0, video: 0, audio: 0 };
  }
}
export function omniTaskRefCaps(model: string, task: string): { image: number; video: number; audio: number } {
  switch (task) {
    case 'image_to_video': return { image: 2, video: 0, audio: 0 };   // 시작(·끝) 프레임
    case 'reference_to_video': return { image: modelImageMax(model), video: modelVideoMax(model), audio: 0 };
    case 'edit': case 'extend': return { image: 0, video: 1, audio: 0 };
    default: return { image: 0, video: 0, audio: 0 };
  }
}

// ── 초안 모드 ────────────────────────────────────────────────────────────────────────
// 두 해상도는 문서가 못 박은 값이다 — 둘 다 "다른 값을 넣으면 에러" 라고 적혀 있다.
export const DRAFT_RESOLUTION = '480p';
export const DRAFT_FINAL_RESOLUTION = '1080p';
// 초안 task id 는 created_at 부터 7일 동안만 본편에 쓸 수 있다 (문서 명시).
export const DRAFT_VALID_MS = 7 * 24 * 60 * 60 * 1000;
export function modelSupportsDraft(model: string): boolean {
  return MODELS.find(m => m.id === model)?.draftMode === true;
}
// 지금 보내면 Draft 로 나가는가. 저장값이 없으면(undefined) 모델 기본값을 따른다.
// 패널 표시·전송 버튼·페이로드가 모두 이 함수 하나로 판단한다 — 셋이 따로 판단하면 화면은
// 1080p 인데 480p 가 나가는 식으로 어긋난다.
export function draftEffective(model: string, draft?: boolean): boolean {
  if (!modelSupportsDraft(model)) return false;
  return draft ?? (MODELS.find(m => m.id === model)?.defaults?.draft === true);
}
// 초안 id 가 언제 만료되는가. startTime 은 생성 API 가 id 를 돌려준 순간이라 created_at 과
// 1초 안팎으로 같다. startTime 이 없으면 timestamp(전송 직전)를 쓴다 — 그쪽이 더 이르므로
// 만료를 실제보다 늦게 말하는 일은 없다.
export function draftExpiresAt(m: { startTime?: number; timestamp?: number }): number {
  return (m.startTime || m.timestamp || 0) + DRAFT_VALID_MS;
}

/**
 * 저장 파일 이름 — 항상 `{모델 상징 id}-{날짜}-{taskId}.{확장자}`.
 *
 * 자동 다운로드와 수동 다운로드가 이 함수 하나만 쓴다. 규칙이 두 벌이면 반드시
 * 갈라진다 — 실제로 Omni 의 이름 규칙은 수동 쪽에만 있었고 자동 쪽에는 없었다.
 *
 * 상징 id 는 NCP 폴더 이름과 같은 값이다(model-access.ts / brandOf). 그래서 받아둔
 * 파일 이름만 보고 NCP 어디에 있는지 알 수 있다:
 *   seedance-2026-09-06-cgt-20260906160839-q26vf.mov
 *      → seedance/{프로젝트}/cgt-20260906160839-q26vf.mov
 *
 * 확장자는 그 클립이 실제로 받은 URL 에서 뽑는다(2.5 는 .mov). 회사가 늘어도
 * 여기는 손댈 것이 없다 — brandOf 규칙 한 줄이면 이름이 알아서 따라온다.
 */
export function downloadFilenameFor(m: Pick<ChatMessage, 'videoUrl' | 'taskId' | 'usedSettings'>): string {
  const model = m.usedSettings?.model || '';
  // 초안은 끝에 -draft 를 단다. 480p 미리보기가 본편과 똑같은 모양의 이름으로 편집 폴더에
  // 섞이면 파일만 보고는 가려낼 방법이 없다. taskId 부분은 그대로라 NCP 위치 규칙도 그대로다.
  const tail = m.usedSettings?.draft ? '-draft' : '';
  return buildDownloadFilename((m.taskId || 'unknown') + tail, videoExtFor(m.videoUrl || '', model), brandOf(model));
}

// 결과물 하나당 정확히 한 번만 받는다. updateMessage 가 "이번에 처음 성공"일 때만
// 부르지만, 그 판정이 어긋나는 날을 대비해 메시지 id 로 한 겹 더 막는다. 이 Set 은
// 프로세스 수명 동안만 산다 — 앱을 다시 켜면 이미 succeeded 라 애초에 안 걸린다.
const autoDownloaded = new Set<string>();
function fireAutoDownload(m: ChatMessage) {
  if (!useAppStore.getState().autoDownload) return;
  if (!m.videoUrl || autoDownloaded.has(m.id)) return;
  // 초안은 받지 않는다. 고르기 위한 480p 미리보기라 대부분 버려지고, 받아둘 것은 본편이다.
  // 초안이 필요하면 카드의 '영상 다운로드' 로 받으면 된다(이름 끝에 -draft).
  if (m.usedSettings?.draft) return;
  autoDownloaded.add(m.id);
  // downloadedAt 은 남기지 않는다 — 그 표시는 수동 클릭("다시 다운로드") 전용이다.
  // 저장 폴더는 여기서 정하지 않는다. 폴더 지정(sessionDownloadDir)은 electron 쪽
  // will-download / saveBlob 이 공통으로 처리하므로 레인과 무관하게 따라온다.
  pinMessageReferences(m);
  void (async () => {
    const meta = await downloadMetaFor(m);
    await downloadViaProxy(m.videoUrl!, downloadFilenameFor(m), meta);
  })().catch(err => console.warn('[AutoDownload] 실패:', err?.message || err));
}

// ─── 받은 영상에 넣는 생성 설정 (26.10.801~, src/lib/settings-box.ts) ─────────────────────────
// 카드 메시지 → 영상 끝에 넣을 설정. 그 메시지가 있는 프로젝트를 찾아 이름도 싣는다(다른 PC 에서 '어느 프로젝트' 를 보여 준다).
export async function settingsPayloadFor(m: ChatMessage): Promise<SettingsPayload | null> {
  const st = useAppStore.getState();
  const owner = st.projects.find(p => p.messages.some(x => x.id === m.id));
  try { return await buildSettingsPayload({ ...m, usedCollection: usedCollectionOf(m) }, { id: owner?.id, name: owner?.name }, __APP_VERSION__); }
  catch (e) { console.warn('[Settings] 설정 만들기 실패(영상은 그대로 받는다):', e); return null; }
}
// 그 카드를 만들 때 채팅에 연결돼 있던 어셋 컬렉션. 26.10.801~ 카드는 보낼 때 적어 두고, 그 전 카드는 멘션한 어셋이 든 컬렉션으로 본다.
export function usedCollectionOf(m: Pick<ChatMessage, 'usedCollection' | 'usedElementImages'>): { id: string; name: string } | undefined {
  if (m.usedCollection?.id) return m.usedCollection;
  const st = useAppStore.getState();
  for (const e of m.usedElementImages || []) {
    const cid = st.elementAssets.find(x => x.id === e.elementId)?.collectionId;
    const c = cid ? st.assetCollections.find(x => x.id === cid) : undefined;
    if (c) return { id: c.id, name: c.name };
  }
  return undefined;
}
// 지금 이 채팅에 연결된 어셋 컬렉션 — 보낼 때 카드에 적는다(usedCollection).
export function boundCollectionOf(projectId: string): { id: string; name: string } | undefined {
  const st = useAppStore.getState();
  const c = st.assetCollections.find(x => x.id === st.projectCollectionId[projectId]);
  return c ? { id: c.id, name: c.name } : undefined;
}
// 다운로드에 실어 보낼 설정 — '받은 영상에 설정 넣기' 를 끄면 없다.
export async function downloadMetaFor(m: ChatMessage): Promise<SettingsPayload | undefined> {
  if (!useAppStore.getState().embedSettings) return undefined;
  return (await settingsPayloadFor(m)) || undefined;
}
// 받은 영상의 레퍼런스 원본을 30일 캐시 정리에서 뺀다(서버가 라이브러리 폴더로 한 벌 옮겨 둔다). 30일이 지나 그 영상을
// 끌어다 놓아도 이 PC 에서는 레퍼런스까지 되살아나게. 어셋 라이브러리 그림(libId)은 원래 지워지지 않는다.
export function pinMessageReferences(m: Pick<ChatMessage, 'usedAssets' | 'usedElementImages'>): void {
  const ids = [...new Set([
    ...((m.usedAssets as any[]) || []).map(a => a?.cacheId),
    ...((m.usedElementImages as any[]) || []).filter(e => !e?.libId).map(e => e?.cacheId),
  ].filter((x): x is string => typeof x === 'string' && !!x))];
  if (!ids.length) return;
  fetch('/api/cache/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
    .catch(() => { /* 다음에 받을 때 다시 */ });
}

// The key an @mention actually resolves on. Paste-to-mention matches a typed name against
// element names case-insensitively and ignoring spaces, so "Don Moretti", "don moretti"
// and "donmoretti" are ONE name as far as the prompt is concerned.
// Two elements sharing this key inside one collection are indistinguishable to that
// resolver — it would pick whichever the sort happened to put first, and quietly send the
// wrong images. That is why this is exported rather than kept local: the place that
// CREATES elements has to reject collisions by exactly the rule the resolver uses, or the
// check is decorative. Only the bound collection feeds mentions, so equal names in
// different collections are fine and always have been.
export function mentionKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '');
}

// "don_moretti.png" → "don_moretti". The name is already on the file; drag-and-drop intake
// reads it instead of making the user retype it.
export function fileBaseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '').trim() || '이름 없음';
}

// "don_moretti_02" → "don_moretti". Strips ONE trailing index — the separator is optional
// so "hero2" counts, and "(3)" / "[3]" wrappers are handled too. Used to spot the files that
// are obviously frames of one asset rather than separate assets.
// Deliberately conservative: a name that is nothing but digits keeps its digits, or
// "1.png, 2.png, 3.png" would all collapse into one nameless group.
export function stripTrailingIndex(base: string): string {
  const m = /^(.*?)[\s._\-#]*(?:\(|\[)?\d{1,3}(?:\)|\])?$/.exec(base);
  const head = m?.[1]?.replace(/[\s._\-#]+$/, '') ?? '';
  return head || base;
}

// Natural order, so _2 lands before _10 instead of after it. Images inside one asset are
// positional ([Image N] markers at send time), so their order is not cosmetic.
function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) || [], bx = b.match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ax.length, bx.length); i++) {
    const x = ax[i], y = bx[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x), ny = /^\d/.test(y);
    if (nx && ny) { const d = parseInt(x, 10) - parseInt(y, 10); if (d) return d; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * How a set of dropped filenames becomes assets.
 *   'each'   — one asset per file (what the filename literally says)
 *   'single' — all of it is one asset
 *   'auto'   — files whose names differ only by a trailing index are ONE asset
 *
 * Returns groups of indices INTO the input array, in first-seen order, with each group's
 * files in natural order. Pure and index-based so the caller keeps its own File objects and
 * this stays testable without a DOM.
 */
export function groupElementFiles(fileNames: string[], mode: 'auto' | 'each' | 'single'): { name: string; files: number[] }[] {
  const bases = fileNames.map(fileBaseName);
  if (mode === 'each') return bases.map((name, i) => ({ name, files: [i] }));
  if (mode === 'single') return fileNames.length ? [{ name: stripTrailingIndex(bases[0]) || bases[0], files: bases.map((_, i) => i) }] : [];

  const order: string[] = [];
  const byKey = new Map<string, number[]>();
  bases.forEach((b, i) => {
    const key = mentionKey(stripTrailingIndex(b));
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(i);
  });
  return order.map(key => {
    const idx = byKey.get(key)!.sort((a, b) => naturalCompare(bases[a], bases[b]));
    // A group of one was never an index series — keep the filename exactly as it is.
    return { name: idx.length > 1 ? stripTrailingIndex(bases[idx[0]]) : bases[idx[0]], files: idx };
  });
}

// A name that cannot collide with anything in `takenKeys`, comparing on mentionKey rather
// than on the raw string — "Don Moretti" and "donmoretti" are the same name to the mention
// resolver, so treating them as different here would hand it back the ambiguity this is
// meant to prevent. Starts at 2 because the existing one is the first.
export function uniqueElementName(base: string, takenKeys: Set<string>): string {
  if (!takenKeys.has(mentionKey(base))) return base;
  for (let n = 2; n < 1000; n++) {
    const cand = `${base} ${n}`;
    if (!takenKeys.has(mentionKey(cand))) return cand;
  }
  return `${base} ${uuidv4().slice(0, 4)}`;
}
// Payload `omni_reference_task_type` — tells the API which task the user picked instead of
// making it infer one from the prompt's wording. Undefined for every model that doesn't
// declare the map and for modes outside the reference family, so those requests are
// unchanged. See the refTaskTypes note on SEEDANCE_25 for what was measured.
export function modelRefTaskType(model: string, mode: GenerationMode): string | undefined {
  return MODELS.find(m => m.id === model)?.refTaskTypes?.[mode];
}
// The value to actually assert for THIS request — read off the content array that is about
// to be sent, not off the mode alone.
// The mode and the attachments can legitimately disagree for a moment: switching modes
// clears assets, mention-based element images arrive from the library rather than the
// panel, and a restored/regenerated card can land with a reference the app couldn't
// re-upload. Declaring `edit` when no video actually made it into the payload converts
// something the API used to muddle through (infer from the prompt) into a hard rejection.
// So: assert only what the request can back up, and otherwise stay silent and let the API
// infer exactly as it did before this parameter existed. Silence is never worse.
export function refTaskTypeFor(
  model: string, mode: GenerationMode, content: { role?: string }[],
): string | undefined {
  const t = modelRefTaskType(model, mode);
  if (!t) return undefined;
  const roles = content.map(c => c.role).filter(Boolean) as string[];
  // edit / extend act ON a video; reference just needs something to reference.
  const backed = t === 'reference'
    ? roles.some(r => r.startsWith('reference_'))
    : roles.includes('reference_video');
  return backed ? t : undefined;
}

// ── Task-type constraints ────────────────────────────────────────────────────────────
// Some modes only accept one ratio / one duration. Returns what must be forced, or null.
// Declared per model as DATA (MODELS.adaptiveOnly / autoDurationOnly) rather than an
// `if (model === …)` scattered across the UI and the send path — those two drifting apart
// is exactly how a constraint gets enforced in the panel but not in the payload.
export function ratioLockedFor(model: string, mode: GenerationMode): boolean {
  return (MODELS.find(m => m.id === model)?.adaptiveOnly ?? []).includes(mode);
}
export function durationLockedFor(model: string, mode: GenerationMode): boolean {
  return (MODELS.find(m => m.id === model)?.autoDurationOnly ?? []).includes(mode);
}
// One place that answers "what must this request actually carry", used by both the
// settings panel (to lock the controls) and handleSend (to fix the payload).
// 비율·길이만. 모드를 바꿀 때의 기본값 계산(settingsDefaultsFor)도 이것을 쓴다 — 거기에
// Draft 의 480p 를 섞으면 저장된 해상도가 480p 로 덮여, Draft 를 꺼도 480p 가 남는다.
function applyModeConstraints<T extends { ratio: string; duration: number }>(
  model: string, mode: GenerationMode, settings: T,
): T {
  const out = { ...settings };
  if (ratioLockedFor(model, mode)) out.ratio = 'adaptive';
  if (durationLockedFor(model, mode)) out.duration = -1;
  return out;
}
export function applyTaskConstraints<T extends { ratio: string; duration: number; resolution?: string; draft?: boolean }>(
  model: string, mode: GenerationMode, settings: T,
): T {
  const out = applyModeConstraints(model, mode, settings);
  // Draft 는 480p 하나뿐이다 — 다른 해상도는 API 가 거절한다(문서). 켜졌는지는 draftEffective
  // 가 정한다: 저장값이 없으면 모델 기본값(2.5 = 켜짐), 초안을 모르는 모델은 늘 꺼짐.
  // 결과에는 실제로 나간 값을 true/false 로 적는다 — usedSettings 로 남아 재사용·재생성이
  // "그 카드 그대로" 를 되살릴 수 있어야 한다(기본값이 나중에 바뀌어도).
  // 비율·길이와 같은 규칙으로 저장값은 건드리지 않는다: 이 함수의 결과는 페이로드와
  // usedSettings 로만 간다.
  const d = draftEffective(model, out.draft);
  out.draft = d;
  if (d) out.resolution = DRAFT_RESOLUTION;
  return out;
}

// ── What a mode should START at, for THIS model ──────────────────────────────────────
// Picking a generation mode used to inherit whatever the previous mode left behind, so a
// 2.5 edit's forced `adaptive`/-1 followed you into Extend, and 2.0's 16:9/5s followed you
// into 2.5 where the documented default is adaptive/-1. Different models genuinely have
// different defaults, and each mode may pin some of them — so the answer is composed, not
// looked up: model defaults → mode constraints → validity for that model.
// Only called from an explicit user action (mode switch). Never from a watcher: that is
// what turned "lock" into "silently overwrote your setting" the first time round.
export function settingsDefaultsFor(model: string, mode: GenerationMode): { resolution: string; ratio: string; duration: number; draft: undefined } {
  const d = MODELS.find(m => m.id === model)?.defaults;
  const base = {
    resolution: d?.resolution ?? defaultSettings.resolution,
    ratio: d?.ratio ?? defaultSettings.ratio,
    duration: d?.duration ?? defaultSettings.duration,
  };
  // applyTaskConstraints 가 아니다 — 그쪽은 Draft 의 480p 까지 덮어쓰는데, 여기 결과는 프로젝트에
  // 저장된다. 480p 가 저장되면 Draft 를 꺼도 480p 가 남는다.
  const withMode = applyModeConstraints(model, mode, base);
  // Structural validity last — a default is worthless if the model can't accept it.
  if (!modelResolutions(model).includes(withMode.resolution)) withMode.resolution = '720p';
  if (withMode.duration !== -1) {
    const [lo, hi] = modelDurationRange(model);
    withMode.duration = Math.max(lo, Math.min(hi, withMode.duration));
  }
  // Draft 도 '모델 기본값을 따름' 으로 되돌린다. 모드를 바꾸면 해상도·비율·길이가 모델 기본값으로
  // 돌아가는 것과 같은 규칙이고, 2.5 는 어느 모드든 Draft 로 시작한다.
  return { ...withMode, draft: undefined };
}
// Which backend a model routes to. Gemini Omni → Interactions API (server
// /api/gemini/*, key NANOBANANA_STUDIO_KEY); everything else → BytePlus. This is
// the single switch the send path / settings UI branch on. Default byteplus.
export function modelProvider(model: string): 'byteplus' | 'gemini' {
  return MODELS.find(m => m.id === model)?.provider || 'byteplus';
}

// ── Resolution: three layers, deliberately separate ─────────────────────────
// Mixing them is what makes this kind of gate rot. Keep them apart:
//   modelResolutions   — what the model can EVER do (structural, no policy)
//   allowedResolutions — structural ∩ per-project 4k permission (UI + send)
//   clampResolution    — walk an invalid value DOWN to the nearest allowed one

// Structural capability. Verified live against the API 2026-07-27 (BytePlus validates
// `resolution` before creating a task, so this was probed at zero cost):
//   flagship 2.0 → 480p/720p/1080p/4k   ·   fast → no 4k   ·   mini → no 1080p
// The docs also state "4k: Only supported by Seedance 2.0".
//
// ★ The hydration clamp MUST use this one, never allowedResolutions. Hydration runs at
// boot, and billingProjectKey is session-only (starts empty) → the 4k permission is always
// false at that moment. Clamping against policy there would wipe a saved '4k' setting on
// every single restart. Structural validity is the right question for stored data; the
// live permission gate belongs at render + send time.
export function modelResolutions(model: string): string[] {
  const o = MODELS.find(m => m.id === model)?.res;
  if (o) return o;                                        // explicit override wins
  if (modelProvider(model) === 'gemini') return ['720p']; // Omni is 720p only
  if (model.includes('fast') || model.includes('mini')) return ['480p', '720p'];
  return ['480p', '720p', '1080p', '4k'];
}

// Structural ∩ policy. 4k is gated on the billing project's "4K 허용" column in the
// tracker sheet — but that column is a BYTEPLUS credit control, and Gemini Omni bills to
// Google on a different key entirely, so the gate does not apply to it (owner's call,
// 2026-08-28). Among BytePlus models only the flagship 2.0 has '4k' structurally, so
// Fast/Mini still can't gain it no matter what allow4k says.
export function allowedResolutions(model: string, allow4k: boolean): string[] {
  if (modelProvider(model) === 'gemini') return modelResolutions(model);
  return modelResolutions(model).filter(r => r !== '4k' || allow4k);
}

// Step DOWN to the nearest allowed tier (4k→1080p→720p→480p) rather than snapping to a
// hardcoded '720p'. Losing 4k permission should land the user on 1080p — the next thing
// down — not two tiers below where they were.
export function clampResolution(model: string, res: string, allow4k: boolean): string {
  const ok = allowedResolutions(model, allow4k);
  if (ok.includes(res)) return res;
  // 360p exists only on Gemini Omni 1.1, 480p only on Seedance — neither model sees the
  // other's rung, because every step is filtered through `ok` first.
  const ladder = ['4k', '1080p', '720p', '480p', '360p'];
  // Lowest tier this model offers. Every res list is written low→high, so it's ok[0] —
  // but derive it from the ladder instead of trusting that ordering, because this is the
  // value someone lands on by accident and it must never be the expensive one.
  const lowest = [...ladder].reverse().find(r => ok.includes(r)) || '720p';
  const from = ladder.indexOf(res);
  // Unknown/legacy value → app default, never a silent promotion to a higher tier.
  if (from < 0) return ok.includes('720p') ? '720p' : lowest;
  for (let i = from + 1; i < ladder.length; i++) if (ok.includes(ladder[i])) return ladder[i];
  // Nothing BELOW the current value is available, i.e. the value sits under this model's
  // whole range (480p → Omni 1.1, whose floor is 720p). Step UP to the floor, never to the
  // top of the list — the old `ok[ok.length - 1]` returned the HIGHEST tier here, which
  // turned a 480p → 1.1 model switch into a silent jump to 4K ($3.04 vs $1.01 per 10s).
  // Unreachable before 2026-08-28: every model until then supported 480p, so `res` was
  // always either in the list or matched by the loop above.
  return lowest;
}

// ── 과금 프로젝트 (크레딧 트래커 목록의 한 줄) ─────────────────────────────────────────
// key 가 앱 안에서 프로젝트를 가리키는 값이다. id(PM 프로그램 POS 의 영구 ID, 'PJ-' + 8자)가
// 있으면 id, 없으면(TA Test 같은 트래커 전용 프로젝트) 'name:' + 이름.
// 이름(project)은 POS 에서 바뀔 수 있으므로 선택·권한·Draft → 본편은 전부 key 로 따라가고,
// 화면에는 이름만 보인다. 트래커 안에서 이름도 유일하다(같은 이름의 행을 허용하지 않음).
export interface BillingProject {
  key: string;
  id: string;           // '' = POS 밖의 트래커 전용 프로젝트
  project: string;      // 지금 이름
  status: string;
  allow4k?: boolean;
  allow25?: boolean;
}
export function billingKeyOf(p: { id?: string; project: string }): string {
  return p.id ? String(p.id) : 'name:' + p.project;
}
// key 로 목록에서 찾는다. 저장본에 남은 옛 모양(key·id 없음)도 이름으로 key 를 만들어 비교한다.
// ★ 키 올려 주기: 'name:○○' 로 골라 둔 프로젝트에 나중에 id 가 붙으면 key 가 바뀐다. key 로
//   못 찾으면 같은 이름으로 한 번 더 찾는다 — 그 항목(새 key)을 돌려주고, 부르는 쪽이 필요하면
//   저장된 key 를 새 것으로 바꾼다. Draft 에 구워 둔 key 도 같은 규칙으로 찾는다.
export function findBillingProject(list: BillingProject[], key: string | undefined): BillingProject | undefined {
  if (!key) return undefined;
  const norm = (p: BillingProject): BillingProject =>
    ({ ...p, id: p.id || '', key: p.key || billingKeyOf(p) });
  const hit = list.find(p => (p.key || billingKeyOf(p)) === key);
  if (hit) return norm(hit);
  if (key.startsWith('name:')) {
    const byName = list.find(p => p.project === key.slice(5));
    if (byName) return norm(byName);
  }
  return undefined;
}
export function selectedBillingProject(state: {
  billingProjectKey: string; billingProjects: BillingProject[];
}): BillingProject | undefined {
  return findBillingProject(state.billingProjects, state.billingProjectKey);
}
// 목록이 새로 들어왔을 때 선택을 어떻게 할지. 순수 함수라 App.tsx 의 60초 폴링과 시험이 같은
// 답을 낸다.
//   · key 가 그대로 있으면 선택 유지 — 이름이 바뀌었으면 알림만(옛 → 새).
//   · 'name:' key 인데 같은 이름에 id 가 붙었으면 조용히 새 key 로.
//   · 그 밖에 목록에서 사라졌으면(종료) 선택 해제 + 지금과 같은 '종료' 안내.
export function reconcileBillingSelection(
  prev: BillingProject[], next: BillingProject[], selKey: string,
): { key: string; note: string | null } {
  if (!selKey) return { key: '', note: null };
  const before = findBillingProject(prev, selKey);
  const same = next.find(p => (p.key || billingKeyOf(p)) === selKey);
  if (same) {
    const renamed = before && before.project !== same.project;
    return { key: selKey, note: renamed ? `선택한 프로젝트의 이름이 바뀌었습니다: "${before!.project}" → "${same.project}"` : null };
  }
  const upgraded = findBillingProject(next, selKey);
  if (upgraded) return { key: upgraded.key, note: null };
  // id 는 화면에 보이지 않는다 — 이름을 모르면 이름 없이 말한다.
  const name = before?.project || (selKey.startsWith('name:') ? selKey.slice(5) : '');
  return { key: '', note: name
    ? `선택했던 프로젝트 "${name}"가 종료되어 해제되었습니다. 새 프로젝트를 선택해주세요.`
    : '선택했던 프로젝트가 종료되어 해제되었습니다. 새 프로젝트를 선택해주세요.' };
}

// Draft 의 과금 프로젝트를 지금 목록에서 찾는다: key → id → 이름(26.9.2306 이전 Draft) 순.
// 이름이 아니라 key 로 찾아야 Draft 를 만든 뒤 프로젝트 이름이 바뀌어도(POS) 본편이 막히지 않는다.
// hasOrigin=false 는 Draft 에 프로젝트 기록이 아예 없다는 뜻 — 부르는 쪽이 지금 선택을 쓴다.
export function billingProjectOfDraft(
  list: BillingProject[],
  vs: { project?: string; projectId?: string; projectKey?: string } | undefined,
): { hasOrigin: boolean; bill?: BillingProject } {
  const v = vs || {};
  const hasOrigin = !!(v.projectKey || v.projectId || v.project);
  if (!hasOrigin) return { hasOrigin };
  const bill = findBillingProject(list, v.projectKey)
    || findBillingProject(list, v.projectId)
    || (v.project ? findBillingProject(list, 'name:' + v.project) : undefined);
  return { hasOrigin, bill };
}

// Is 4k unlocked for the CURRENTLY selected billing project? Always derived, never
// stored — so a grant/revoke in the sheet takes effect the moment the poll lands, with
// no second copy of the truth to keep in sync. Fail-closed: no project selected, project
// missing from the list, or field absent (older tracker) → false.
export function isFourKAllowed(state: {
  billingProjectKey: string;
  billingProjects: BillingProject[];
}): boolean {
  return selectedBillingProject(state)?.allow4k === true;
}

// Is this model permitted for the selected billing project? Models without a grant are
// always allowed, so every 2.0/Omni path answers true without consulting anything.
// Fail-closed on purpose: no project selected, project missing from the list, or the
// tracker not carrying the field (older GAS) → false. Being wrongly blocked is a message;
// being wrongly allowed is someone else's credit.
// This is the UI's copy of the answer. server.ts asks the tracker the same question again
// before it forwards anything, because both inputs here are editable at rest: the roster
// is persisted in IndexedDB and settings.model is stored per project.
// state.billingProjectKey 에 선택된 키 대신 다른 키(Draft 의 프로젝트)를 넣어 물어도 된다.
export function isModelAllowed(model: string, state: {
  billingProjectKey: string;
  billingProjects: BillingProject[];
}): boolean {
  const grant = MODEL_GRANTS[model];
  if (!grant) return true;
  return selectedBillingProject(state)?.[grant] === true;
}
export function modelGrant(model: string): 'allow25' | undefined {
  return MODEL_GRANTS[model];
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      _hasHydrated: false,
      theme: 'light',
      setTheme: (t) => { applyTheme(t); set({ theme: t }); },
      _elementsHydrated: false,
      persistTrouble: null,
      recoveryScanned: [],
      deletedProjectIds: [],
      projects: [],
      currentProjectId: null,
      autoDownload: false,
      setAutoDownload: (v) => set({ autoDownload: v }),
      embedSettings: true,
      setEmbedSettings: (v) => set({ embedSettings: v }),
      billingProjectKey: '',
      billingProjects: [],
      trackerReachable: null,
      setBillingProjectKey: (key) => set({ billingProjectKey: key }),
      setBillingProjects: (list) => set({ billingProjects: list }),
      // 값이 같으면 set 을 부르지도 않는다. persist 는 set 이 불릴 때마다(값이 그대로여도) 기록 전체를 다시
      // 저장하고 백업을 다시 예약한다 — 1분마다 도는 트래커 확인이 이것으로 1분마다 33MB 를 다시 썼고, 백업이
      // 기다리던 '5분 조용한 틈' 을 없앴다(2026-10-07 실측, 26.10.701 고침).
      setTrackerReachable: (v) => { if (get().trackerReachable !== v) set({ trackerReachable: v }); },
      mentionedElementImages: 0,
      setMentionedElementImages: (n) => set({ mentionedElementImages: n }),
      // ─── Element library state + actions ───
      assetCollections: [],
      elementAssets: [],
      projectGroups: [],
      projectCollectionId: {},
      createCollection: (name) => {
        const id = uuidv4();
        set((state) => ({
          assetCollections: [...state.assetCollections, { id, name: name.trim() || '새 컬렉션', createdAt: Date.now() }],
        }));
        return id;
      },
      renameCollection: (id, name) => set((state) => ({
        assetCollections: state.assetCollections.map((c) => (c.id === id ? { ...c, name: name.trim() || c.name } : c)),
      })),
      deleteCollection: (id) => set((state) => {
        // Drop the collection, its element assets, and any project bindings to it.
        const binding = { ...state.projectCollectionId };
        for (const pid of Object.keys(binding)) if (binding[pid] === id) delete binding[pid];
        return {
          assetCollections: state.assetCollections.filter((c) => c.id !== id),
          elementAssets: state.elementAssets.filter((a) => a.collectionId !== id),
          projectCollectionId: binding,
        };
      }),
      addElementAsset: (asset) => set((state) => ({
        elementAssets: [...state.elementAssets, { ...asset, id: uuidv4(), createdAt: Date.now(), updatedAt: Date.now() }],
      })),
      // id + collectionId are pinned (a mention pill tracks the asset by id, so it
      // must never change here — same invariant as replaceAsset for panel assets).
      updateElementAsset: (id, updates) => set((state) => ({
        elementAssets: state.elementAssets.map((a) =>
          a.id === id ? { ...a, ...updates, id: a.id, collectionId: a.collectionId, updatedAt: Date.now() } : a
        ),
      })),
      deleteElementAsset: (id) => set((state) => ({
        elementAssets: state.elementAssets.filter((a) => a.id !== id),
      })),
      setProjectCollection: (projectId, collectionId) => set((state) => {
        const binding = { ...state.projectCollectionId };
        if (collectionId) binding[projectId] = collectionId;
        else delete binding[projectId];
        return { projectCollectionId: binding };
      }),
      setCurrentProjectId: (id) => set((state) => ({
        currentProjectId: id,
        projectGroups: revealProject(state.projectGroups, state.projects, id),
      })),
      createProject: (groupId) => {
        // 어디에 만드나. 사이드바 그룹 머리의 + 는 그 그룹 id 를 넘긴다. 맨 위 New Project 버튼은
        // onClick 에 그대로 물려 있어 마우스 이벤트가 들어온다 — 문자열일 때만 그룹으로 받는다.
        // 지금 없는 그룹이면 최상위로: 없는 그룹 id 를 단 프로젝트는 최상위에 그려지므로(dangling
        // 규칙), 번호도 그 목록에서 뽑아야 둘이 어긋나지 않는다.
        const groups = get().projectGroups;
        const home = typeof groupId === 'string' && groups.some(g => g.id === groupId) ? groupId : undefined;
        // 새 프로젝트가 실제로 놓이는 그 목록(최상위 또는 그 그룹 안)에서 비어 있는 가장 작은 번호.
        // 중복 검사와 같은 목록을 본다 — 번호가 꼬이지 않는 이유가 이것이다(§6, nextNumberedName).
        // 그룹 안은 하위 그룹 이름도 같은 이름공간이다(한 목록에 같이 그려지므로).
        const existing = namesInContainer(groups, get().projects, home);
        const newProject: Project = {
          id: uuidv4(),
          name: nextNumberedName('Project', existing),
          messages: [],
          settings: { ...defaultSettings },
          assets: [],
          updatedAt: Date.now(),
          ...(home ? { groupId: home } : {}),
        };
        set((state) => {
          const projects = [newProject, ...state.projects];
          return {
            projects,
            currentProjectId: newProject.id,
            // 접힌 그룹(또는 접힌 상위 그룹) 안에 만들면 새 프로젝트가 화면에 안 보인다 — 펼친다.
            projectGroups: revealProject(state.projectGroups, projects, newProject.id),
          };
        });
      },
      renameProject: (id, name) => {
        set((state) => {
          // Excluding self matters: without it, re-confirming a project's own name would
          // bump it to "이름 (1)" every time you opened the rename box.
          const me = state.projects.find(p => p.id === id);
          if (!me) return state;
          const live = new Set(state.projectGroups.map(g => g.id));
          const home = me.groupId && live.has(me.groupId) ? me.groupId : undefined;
          const final = uniqueName(name, namesInContainer(state.projectGroups, state.projects, home, { projectId: id }));
          return {
            projects: state.projects.map((p) =>
              p.id === id ? { ...p, name: final, updatedAt: Date.now() } : p
            ),
          };
        });
      },
      setProjectIcon: (id, icon) => {
        set((state) => {
          const cur = state.projects.find(p => p.id === id);
          if (!cur || cur.icon === icon) return state;   // re-picking the same icon writes nothing
          return {
          projects: state.projects.map((p) =>
            // updatedAt is deliberately NOT bumped: the icon is decoration, and the
            // project list is ordered/《recently touched》 by real work, not by cosmetics.
            p.id === id ? { ...p, icon } : p
          ),
        };
        });
      },
      // Mark every finished clip in this project as seen (clears the sidebar badge).
      // ★ The guard runs BEFORE set(): this is called on every render pass that touches
      // the open project, and an unconditional set() would hand every no-selector
      // subscriber a new state object — a re-render storm for a value that didn't change.
      markProjectSeen: (projectId) => {
        const p = get().projects.find((x) => x.id === projectId);
        if (!p) return;
        let newest = 0;
        for (const m of p.messages) {
          if (m.status !== 'succeeded') continue;
          const t = m.endTime || m.timestamp;
          if (t > newest) newest = t;
        }
        if (newest === 0 || (p.lastSeenAt || 0) >= newest) return; // nothing new — no write
        set((state) => ({
          projects: state.projects.map((x) =>
            x.id === projectId ? { ...x, lastSeenAt: newest } : x
          ),
        }));
      },
      createProjectGroup: (name, parentId) => {
        // A subfolder is only allowed under a top-level folder — same one-level rule as
        // every other path. An illegal parent degrades to a top-level folder rather than
        // failing: the user asked for a folder and gets one.
        const parent = parentId ? get().projectGroups.find(g => g.id === parentId) : undefined;
        const under = parent && !parent.parentId ? parent.id : undefined;
        // Siblings of the folder we are about to create — the one list it must be
        // distinguishable in, and the same list its number is drawn from.
        const siblings = namesInContainer(get().projectGroups, get().projects, under);
        const g: ProjectGroup = {
          id: uuidv4(),
          // A caller-supplied name still goes through uniqueName (it can collide with
          // anything); only the auto-generated "그룹 N" picks the lowest free number.
          name: name ? uniqueName(name, siblings) : nextNumberedName('그룹', siblings),
          parentId: under,
        };
        set((state) => ({
          projectGroups: [...state.projectGroups, g].map(x =>
            // Opening the destination is not optional: creating a subfolder inside a folded
            // folder would otherwise put the user straight into renaming something invisible.
            under && x.id === under ? { ...x, collapsed: false } : x),
        }));
        return g.id;
      },
      renameProjectGroup: (id, name) => {
        set((state) => {
          const me = state.projectGroups.find(g => g.id === id);
          if (!me) return state;
          const t = groupTree(state.projectGroups);
          const final = uniqueName(name, namesInContainer(state.projectGroups, state.projects,
            t.isSub(me) ? me.parentId : undefined, { groupId: id }));
          if (final === me.name) return state;   // confirming the same name writes nothing
          return { projectGroups: state.projectGroups.map(g => g.id === id ? { ...g, name: final } : g) };
        });
      },
      // Removing the folder and destroying its contents are different intentions, so they
      // are different calls — never a flag with a default, where the destructive branch
      // could be reached by forgetting to pass something. The UI asks which one.
      deleteProjectGroup: (id) => {
        set((state) => {
          const me = state.projectGroups.find(g => g.id === id);
          if (!me) return state;
          // 안에 있던 것들이 나가는 곳 = 이 그룹이 실제로 그려지던 목록. 하위 그룹을 지우면 부모
          // 그룹 안으로 남는다 — "그룹만 삭제 (프로젝트는 남김)" 을 누른 사람은 프로젝트가 부모 그룹
          // 밖, 맨 위까지 튀어나갈 거라고 생각하지 않는다(예전엔 그렇게 튀어나갔다).
          const dest = groupTree(state.projectGroups).isSub(me) ? me.parentId : undefined;
          // ★ 나가는 것들은 도착한 목록에서 이름이 겹치면 (1) 이 붙는다 — 끌어서 옮길 때와 같은 규칙.
          //   예전엔 이 경로만 검사를 안 해서, 그룹 안의 'Project 1' 이 밖의 'Project 1' 옆에 똑같은
          //   이름으로 나란히 섰다. 원래 거기 있던 것은 이름을 그대로 두고, 나오는 쪽이 바뀐다.
          //   나오는 것들끼리는 원래 한 목록(지우는 그룹 안)에 있었으므로 서로 겹치지 않는다.
          const taken = namesInContainer(state.projectGroups, state.projects, dest, { groupId: id });
          const land = (name: string) => { const n = uniqueName(name, taken); taken.push(n); return n; };
          // Subfolders are promoted, not destroyed. "그룹만 삭제" promises the contents
          // survive, and a subfolder is contents. (하위 그룹은 최상위 그룹에만 있으므로 dest 는 최상위.)
          const projectGroups = state.projectGroups
            .filter(g => g.id !== id)
            .map(g => g.parentId === id ? { ...g, parentId: undefined, name: land(g.name) } : g);
          const projects = state.projects.map(p => p.groupId === id
            ? { ...p, groupId: dest, name: land(p.name) }
            : p);
          return { projectGroups: openChain(projectGroups, dest), projects };
        });
      },
      deleteProjectGroupWithProjects: (id) => {
        set((state) => {
          // The whole subtree: this folder and its subfolders. The confirm dialog counts
          // the same set, so the number the user agreed to is the number that goes.
          const gone = new Set([id, ...state.projectGroups.filter(g => g.parentId === id).map(g => g.id)]);
          const doomed = new Set(state.projects.filter(p => p.groupId && gone.has(p.groupId)).map(p => p.id));
          const projects = state.projects.filter(p => !doomed.has(p.id));
          // If the open project was inside, fall back to whatever is left rather than
          // leaving currentProjectId pointing at something that no longer exists.
          let currentProjectId = state.currentProjectId;
          if (currentProjectId && doomed.has(currentProjectId)) {
            currentProjectId = projects.length ? projects[0].id : null;
          }
          const binding = { ...state.projectCollectionId };
          for (const pid of doomed) delete binding[pid];
          // If we had to jump to another project, make sure it is actually VISIBLE.
          // Landing on something tucked inside a folded folder looks like the app moved
          // you nowhere — the header changes but the sidebar shows no selection.
          let projectGroups = state.projectGroups.filter(g => !gone.has(g.id));
          // Unfold the whole chain down to wherever we landed — an open subfolder inside
          // a folded parent is just as invisible as a folded one.
          projectGroups = revealProject(projectGroups, projects, currentProjectId);
          return { projectGroups, projects, currentProjectId, projectCollectionId: binding,
            deletedProjectIds: [...(state.deletedProjectIds || []), ...doomed].slice(-500) };
        });
      },
      // Reorder folders themselves. Same "insert before the target" rule as projects, so
      // both drags mean the same thing — and, exactly like dropping a project onto a row,
      // the dragged folder ADOPTS the target's parent. One gesture both reorders and files.
      moveGroupBefore: (draggedId, targetId) => {
        if (draggedId === targetId) return;
        set((state) => {
          const dragged = state.projectGroups.find(g => g.id === draggedId);
          const target = state.projectGroups.find(g => g.id === targetId);
          if (!dragged || !target) return state;
          const parentId = target.parentId;
          if (!canNest(state.projectGroups, draggedId, parentId)) return state;
          const rest = state.projectGroups.filter(g => g.id !== draggedId);
          const at = rest.findIndex(g => g.id === targetId);
          if (at < 0) return state;
          const next = [...rest];
          // Landing next to a folder of the same name would produce two identical rows in
          // one list — the exact ambiguity the naming rule exists to prevent, arriving by
          // a different door. The "(1)" also tells you there was already one there.
          next.splice(at, 0, { ...dragged, parentId,
            name: uniqueName(dragged.name, namesInContainer(state.projectGroups, state.projects, parentId, { groupId: draggedId })) });
          return { projectGroups: openChain(next, parentId) };
        });
      },
      // Drop on the strip at the end of a folder list: land last among that parent's
      // children (parentId undefined = last at the top level).
      moveGroupToEnd: (draggedId, parentId) => {
        set((state) => {
          const g = state.projectGroups.find(x => x.id === draggedId);
          if (!g) return state;
          if (!canNest(state.projectGroups, draggedId, parentId)) return state;
          const rest = state.projectGroups.filter(x => x.id !== draggedId);
          const lastIdx = rest.map(x => (x.parentId || undefined) === parentId).lastIndexOf(true);
          const next = [...rest];
          next.splice(lastIdx + 1, 0, { ...g, parentId,
            name: uniqueName(g.name, namesInContainer(state.projectGroups, state.projects, parentId, { groupId: draggedId })) });
          return { projectGroups: openChain(next, parentId) };
        });
      },
      // Move a folder in or out of another without touching its position in the order.
      setGroupParent: (groupId, parentId) => {
        set((state) => {
          const g = state.projectGroups.find(x => x.id === groupId);
          if (!g || (g.parentId || undefined) === (parentId || undefined)) return state;
          if (!canNest(state.projectGroups, groupId, parentId)) return state;
          const final = uniqueName(g.name, namesInContainer(state.projectGroups, state.projects, parentId, { groupId }));
          return {
            projectGroups: openChain(
              state.projectGroups.map(x => x.id === groupId ? { ...x, parentId, name: final } : x), parentId),
          };
        });
      },
      toggleProjectGroup: (id) => {
        set((state) => {
          // Guard before the map(): a miss would still hand every subscriber a brand-new
          // array — a full re-render AND a re-serialize of the whole state for nothing.
          // Reachable in practice: the sidebar delays a folder-name click by 220ms to see
          // if it becomes a double-click, and the folder can be gone by the time it fires.
          if (!state.projectGroups.some(g => g.id === id)) return state;
          return { projectGroups: state.projectGroups.map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g) };
        });
      },
      // Change which folder a project is filed under — and NOTHING else.
      // `projects` array order is the one master order in the sidebar; groups are just a
      // way of partitioning that order for display. So filing a project doesn't move it in
      // the array, which is what makes taking it back out return it to its original spot
      // instead of dumping it at the bottom. It never actually left its place.
      // Want a specific position? That's `moveProjectBefore` — dropping ON a row is the
      // gesture that says "put it exactly here", and it carries the group along with it.
      setProjectGroup: (projectId, groupId) => {
        set((state) => {
          const cur = state.projects.find(p => p.id === projectId);
          if (!cur || cur.groupId === groupId) return state;
          // Unfold the destination — the folder and, if it's a subfolder, its parent too.
          // This path is the right-click menu, which gives no other feedback: without it,
          // filing something into a folded folder just makes the row disappear.
          // (Drag doesn't do this on purpose — the drop strip already says where it went,
          // and unfolding under the cursor mid-drag would yank the list around.)
          let projectGroups = state.projectGroups;
          if (groupId) {
            const home = projectGroups.find(g => g.id === groupId);
            const open = new Set([groupId, ...(home?.parentId ? [home.parentId] : [])]);
            projectGroups = projectGroups.map(g => open.has(g.id) ? { ...g, collapsed: false } : g);
          }
          // Moving IS how two names meet. Nothing collided while they sat in different
          // folders; the moment one arrives next to the other, one of them has to change.
          const name = uniqueName(cur.name, namesInContainer(state.projectGroups, state.projects, groupId, { projectId }));
          return { projectGroups, projects: state.projects.map(p => p.id === projectId ? { ...p, groupId, name } : p) };
        });
      },
      // Drop on the strip at the end of a section: land last inside it.
      // Needed because moveProjectBefore can only insert BEFORE something — without this
      // there is no gesture that reaches the final slot of a list.
      moveProjectToEnd: (projectId, groupId) => {
        set((state) => {
          const moved = state.projects.find(p => p.id === projectId);
          if (!moved) return state;
          const rest = state.projects.filter(p => p.id !== projectId);
          const lastIdx = rest.map(p => (p.groupId || undefined) === groupId).lastIndexOf(true);
          const next = [...rest];
          next.splice(lastIdx + 1, 0, { ...moved, groupId,
            name: uniqueName(moved.name, namesInContainer(state.projectGroups, state.projects, groupId, { projectId })) });
          return { projects: next };
        });
      },
      // Drop a project onto another: it lands directly before the target AND adopts the
      // target's group. One gesture covers both reordering and moving between folders,
      // which is what dragging onto a row visually promises.
      moveProjectBefore: (draggedId, targetId) => {
        if (draggedId === targetId) return;
        set((state) => {
          const dragged = state.projects.find(p => p.id === draggedId);
          const target = state.projects.find(p => p.id === targetId);
          if (!dragged || !target) return state;
          const rest = state.projects.filter(p => p.id !== draggedId);
          const at = rest.findIndex(p => p.id === targetId);
          if (at < 0) return state;
          const next = [...rest];
          next.splice(at, 0, { ...dragged, groupId: target.groupId,
            name: uniqueName(dragged.name, namesInContainer(state.projectGroups, state.projects, target.groupId, { projectId: draggedId })) });
          return { projects: next };
        });
      },
      deleteProject: (id) => {
        set((state) => {
          const newProjects = state.projects.filter((p) => p.id !== id);
          let newCurrentId = state.currentProjectId;
          if (state.currentProjectId === id) {
            newCurrentId = newProjects.length > 0 ? newProjects[0].id : null;
          }
          const binding = { ...state.projectCollectionId };
          delete binding[id]; // drop the deleted project's collection binding
          return {
            projects: newProjects, currentProjectId: newCurrentId, projectCollectionId: binding,
            projectGroups: revealProject(state.projectGroups, newProjects, newCurrentId),
            deletedProjectIds: [...(state.deletedProjectIds || []), id].slice(-500),
          };
        });
      },
      updateProjectSettings: (projectId, settings) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, settings: { ...p.settings, ...settings }, updatedAt: Date.now() }
              : p
          ),
        }));
      },
      addAsset: (projectId, asset) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, assets: [...p.assets, { ...asset, id: uuidv4() }], updatedAt: Date.now() }
              : p
          ),
        }));
      },
      removeAsset: (projectId, assetId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, assets: p.assets.filter((a) => a.id !== assetId), updatedAt: Date.now() }
              : p
          ),
        }));
      },
      // Atomically swap the entire asset list for a project. Used by reuse
      // (clearAssets + N addAssets used to be sequential set() calls; if
      // anything double-invoked an updater along the way the list would
      // double up). Single set() = no possible interleaving.
      replaceAllAssets: (projectId, assets) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, assets: assets.map(a => ({ ...a, id: uuidv4() })), updatedAt: Date.now() }
              : p
          ),
        }));
      },
      // Replace an asset's content while keeping its id stable. This preserves
      // any mention pills in the prompt (their data-asset-id stays valid) and
      // keeps the asset's display position/numbering — so "@[Video 1]" still
      // refers to the same slot, just pointing at new bytes.
      replaceAsset: (projectId, assetId, updates) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  assets: p.assets.map((a) =>
                    a.id === assetId ? { ...a, ...updates, id: a.id } : a
                  ),
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
      },
      // Apply a new asset order (drag-to-reorder via framer Reorder). Reorders
      // the existing asset OBJECTS by id — ids/objects preserved, only positions
      // change. Mention pills track assets by id and the ChatArea sync effect
      // renumbers their labels (Image 1↔2) automatically, so mentions stay
      // correct. Validates the id set matches (else no-op) to avoid data loss.
      setAssetOrder: (projectId, orderedIds) => {
        set((state) => ({
          projects: state.projects.map((p) => {
            if (p.id !== projectId) return p;
            const byId = new Map(p.assets.map((a) => [a.id, a]));
            const assets = orderedIds.map((id) => byId.get(id)).filter(Boolean) as typeof p.assets;
            if (assets.length !== p.assets.length) return p; // mismatch → keep original
            return { ...p, assets, updatedAt: Date.now() };
          }),
        }));
      },
      clearAssets: (projectId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, assets: [], updatedAt: Date.now() } : p
          ),
        }));
      },
      updateDraftPrompt: (projectId, draft) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, draftPrompt: draft } : p
          ),
        }));
      },
      addMessage: (projectId, message) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  messages: [...p.messages, { ...message, id: (message as any).id || uuidv4(), timestamp: Date.now() }],
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
      },
      updateMessage: (projectId, messageId, updates) => {
        // 자동 다운로드를 여기서 건다 — 레인마다 따로 배선하지 않는다.
        //
        // ★ 예전에는 레인별로 붙였다. Seedance 는 폴링 핸들러에, Omni 는 아무 데도.
        //   Omni 가 폴링을 타지 않는다는 이유로 통째로 빠졌고, 스위치는 켜져 있는데
        //   구글 결과만 조용히 저장 안 되는 상태가 오래 갔다. 오류도 로그도 없었다.
        //   결과물이 생기는 길은 앞으로도 늘어난다(모델·모드·새 벤더). 그때마다
        //   기억해서 배선해야 한다면 언젠가 또 빠뜨린다.
        //   성공은 무엇이 만들었든 반드시 이 함수를 지나가므로, 여기 한 곳에 두면
        //   새 레인은 아무것도 안 해도 자동으로 딸려 온다.
        let justSucceeded: ChatMessage | null = null;
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  messages: p.messages.map((m) => {
                    if (m.id !== messageId) return m;
                    const next = { ...m, ...updates };
                    // "이번에 처음 성공했는가" — 이미 succeeded 인 것에 별표를 달거나
                    // 다운로드 경로를 적는 등의 후속 update 에는 걸리지 않는다.
                    if (m.status !== 'succeeded' && next.status === 'succeeded' && next.videoUrl) {
                      justSucceeded = next;
                    }
                    return next;
                  }),
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
        if (justSucceeded) fireAutoDownload(justSucceeded);
      },
      deleteMessage: (projectId, messageId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, messages: p.messages.filter((m) => m.id !== messageId), updatedAt: Date.now() }
              : p
          ),
        }));
      },
      clearMessages: (projectId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, messages: [], updatedAt: Date.now() } : p
          ),
        }));
      },
      // Single-shot check — interval in App.tsx drives the loop.
      _pollingSet: new Set<string>(),
      pollTask: async (projectId, messageId, taskId) => {
        const project = get().projects.find(p => p.id === projectId);
        const message = project?.messages.find(m => m.id === messageId);
        if (!message || message.status === 'succeeded' || message.status === 'failed') return;

        // Prevent duplicate concurrent requests for the same task
        const pollingSet = (get() as any)._pollingSet as Set<string>;
        if (pollingSet.has(taskId)) return;
        pollingSet.add(taskId);

        // Hard timeout — without this, a hung fetch keeps the taskId stuck in the polling set
        // forever and the UI freezes on "생성 중". 8s is well above normal RTT (sub-second).
        const ac = new AbortController();
        const timeoutId = setTimeout(() => ac.abort(), 8000);

        try {
          console.log(`[Poll] Checking ${taskId}...`);
          const res = await fetch(`/api/byteplus/tasks/${taskId}`, { signal: ac.signal });
          if (!res.ok) {
            // Transient HTTP error (5xx, 502, etc.) — leave status unchanged so the next
            // interval retries. Only AbortError + JSON parse fall through to the catch.
            console.warn(`[Poll] ${taskId} HTTP ${res.status} — will retry next cycle`);
            return;
          }
          const text = await res.text();
          console.log(`[Poll] ${taskId} raw response: ${text.substring(0, 200)}`);

          let data: any;
          try { data = JSON.parse(text); } catch { console.error(`[Poll] JSON parse failed`); return; }

          const status = data.status;
          const contentData = data.content;
          const errorData = data.error;

          if (status === 'succeeded') {
            console.log(`[Poll] ${taskId} SUCCEEDED!`);
            get().updateMessage(projectId, messageId, {
              content: `Task ${taskId} succeeded!`,
              status: 'succeeded',
              videoUrl: contentData?.video_url,
              imageUrl: contentData?.last_frame_url,
              // 확장자는 지금만 확정할 수 있다 — 이 URL 은 24시간 뒤 사라진다.
              videoStorage: {
                ...(message as any).videoStorage,
                ext: videoExtFor(contentData?.video_url, message.usedSettings?.model || ''),
              },
              endTime: Date.now(),
            });
            // Persist the succeeded status to disk IMMEDIATELY (skip the 1.5s
            // debounce). This is the safety net against re-download on restart:
            // if the app is killed (crash / auto-update quitAndInstall) right
            // after completion, the status would otherwise revert to 'running'
            // on reopen → re-polled → re-downloaded. Forcing it succeeded here
            // means completed videos are NEVER re-polled, so auto-download can't
            // fire twice for the same video.
            void flushPersist();
            // 자동 다운로드는 updateMessage 한 곳에서 건다(fireAutoDownload). 레인마다
            // 배선하던 것을 걷어낸 자리다 — Omni 가 빠졌던 이유가 그 구조였다.
            // Full pre-fetch into memory cache → subsequent download saves from RAM (zero CDN round-trip).
            // Validate response before caching: a 404/500 body would otherwise be served as a "video"
            // resulting in blank playback and broken downloads.
            const safePrefetch = (url: string, expectedTypePrefix: string) => {
              const pAc = new AbortController();
              const pTimer = setTimeout(() => pAc.abort(), 60000); // big videos can take a while
              fetch(url, { signal: pAc.signal })
                .then(r => {
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  return r.blob();
                })
                .then(b => {
                  if (b.size < 1024) throw new Error(`blob too small (${b.size}B) — likely error response`);
                  // BytePlus serves with content-type set; accept octet-stream or empty as fallback.
                  if (b.type && !b.type.startsWith(expectedTypePrefix) && b.type !== 'application/octet-stream') {
                    throw new Error(`unexpected blob type: ${b.type}`);
                  }
                  setCachedBlob(url, b);
                })
                .catch(err => console.warn(`[Cache] skip prefetch ${url.substring(0, 60)}…:`, err.message))
                .finally(() => clearTimeout(pTimer));
            };
            if (contentData?.video_url && !getCachedBlob(contentData.video_url)) {
              safePrefetch(contentData.video_url, 'video/');
            }
            if (contentData?.last_frame_url && !getCachedBlob(contentData.last_frame_url)) {
              safePrefetch(contentData.last_frame_url, 'image/');
            }
            showNotification(message.usedSettings?.draft ? 'Draft 생성 완료' : '영상 생성 완료', {
              body: message.usedSettings?.draft ? '480p Draft가 나왔습니다. 마음에 들면 카드에서 1080p 본편을 만드세요.' : '영상이 성공적으로 생성되었습니다.',
            });
          } else if (status === 'failed' || status === 'expired') {
            console.log(`[Poll] ${taskId} FAILED: ${errorData?.message || errorData}`);
            get().updateMessage(projectId, messageId, {
              content: `Task ${taskId} ${status}.`,
              status: 'failed',
              error: errorData?.message || errorData || status,
              endTime: Date.now(),
            });
            showNotification('영상 생성 실패', { body: errorData?.message || '오류가 발생했습니다.' });
          } else {
            // Poll returned a still-in-progress status. Only write when it ACTUALLY
            // changed (e.g. queued→running); a running→running (or queued→queued) write
            // would rebuild the whole projects array + re-serialize the persisted blob
            // every 10s for zero visible change, re-rendering the entire UI. `content`
            // derives purely from status+taskId, so identical status ⇒ identical write.
            const nextStatus = status === 'queued' ? 'queued' : 'running';
            if (message.status !== nextStatus) {
              get().updateMessage(projectId, messageId, {
                content: `Task ${taskId} — ${status}`,
                status: nextStatus,
              });
            }
          }
        } catch (error: any) {
          if (error.name === 'AbortError') console.warn(`[Poll] ${taskId} timed out after 8s — will retry`);
          else console.error(`[Poll] ${taskId} fetch error:`, error.message);
        } finally {
          clearTimeout(timeoutId);
          pollingSet.delete(taskId);
        }
      },
      // BytePlus only allows deleting a task that is still QUEUED. Once it flips to
      // running the DELETE is refused with 409 InvalidAction.RunningTaskDeletion —
      // measured 2026-07-27: a task goes queued→running within seconds, so most
      // cancel clicks land on a running task.
      //
      // We used to ignore the response and mark the message failed regardless. That
      // was actively harmful: BytePlus kept generating and BILLED the tokens, but the
      // message left running/queued so App.tsx stopped polling it — which meant the
      // server's credit-tracker POST (fired from GET /tasks/:id on success) never ran.
      // Result: money spent, nothing in the sheet, and the finished video discarded.
      // At 4k (~196k tokens/sec, ~4x 1080p) that silent leak gets expensive fast.
      //
      // Now: only mark cancelled when the API actually accepted it. On 409 we keep the
      // message polling so it completes normally — the user gets the video they paid
      // for and the tracker records it.
      cancelTask: async (projectId, messageId, taskId) => {
        try {
          const res = await fetch(`/api/byteplus/tasks/${taskId}`, { method: 'DELETE' });
          if (!res.ok) {
            let code = '';
            try { code = (await res.json())?.error?.code || ''; } catch { /* body may be empty */ }
            const running = res.status === 409 || code.includes('RunningTaskDeletion');
            // Leave status untouched (still running/queued) so polling continues.
            window.dispatchEvent(new CustomEvent('seedance:cancel-failed', {
              detail: {
                taskId,
                message: running
                  ? '이미 생성이 시작되어 취소할 수 없습니다. 완료될 때까지 진행됩니다 (크레딧은 소모됩니다).'
                  : `취소 실패 (${res.status}). 작업은 계속 진행됩니다.`,
              },
            }));
            return;
          }
          get().updateMessage(projectId, messageId, {
            content: `Task ${taskId} cancelled.`,
            status: 'failed',
            error: '사용자가 작업을 취소했습니다.',
            endTime: Date.now(),
          });
        } catch (error: any) {
          // Network failure — we don't know whether it cancelled. Keep polling rather
          // than lying; the next poll reflects the real state.
          console.error('Cancel task error:', error);
          window.dispatchEvent(new CustomEvent('seedance:cancel-failed', {
            detail: { taskId, message: '취소 요청이 실패했습니다. 작업 상태를 계속 확인합니다.' },
          }));
        }
      },
    }),
    {
      name: 'seedance-app-storage',
      storage: idbPersistStorage,
      // elementAssets is deliberately NOT here — it lives in its own IDB key
      // (ELEMENTS_KEY) so ordinary writes don't re-serialize 368MB of base64.
      // NOTE: persist still MERGES a stored `elementAssets` back into state on
      // read, which is exactly how the one-time migration gets its source.
      partialize: (state) => ({
        projects: state.projects,
        currentProjectId: state.currentProjectId,
        autoDownload: state.autoDownload,
        embedSettings: state.embedSettings,
        assetCollections: state.assetCollections,
        projectGroups: state.projectGroups,
        projectCollectionId: state.projectCollectionId,
        // Last known-good tracker list. Tiny (17 rows) next to `projects`, and it is what
        // lets a launch survive a cold/slow/dead Apps Script. NOT billingProjectKey — the
        // selection stays session-only on purpose (see the field's comment).
        billingProjects: state.billingProjects,
        recoveryScanned: state.recoveryScanned,
        deletedProjectIds: state.deletedProjectIds,
        theme: state.theme,
      }),
      onRehydrateStorage: () => {
        return () => {
          // Migrate: fill missing settings fields with defaults + clamp invalid values
          const state = useAppStore.getState();
          // 한 번만: 2.5 는 이제 Draft 가 기본이다(draft 가 비어 있으면 모델 기본값). 그 전 시험 빌드
          // (26.9.2301~2303)는 기본값을 false 로 저장했기 때문에, 그 빌드를 거친 PC 에는 사용자가
          // 고른 적 없는 draft:false 가 모든 프로젝트에 박혀 있다. 그것을 한 번 비워서 새 기본값을
          // 따르게 한다. 시험 빌드를 안 거친 PC 에는 draft:false 가 없으므로 아무 일도 안 한다.
          const DRAFT_DEFAULT_KEY = 'seedance-draft-default-v1';
          let resetStaleDraft = false;
          try { resetStaleDraft = localStorage.getItem(DRAFT_DEFAULT_KEY) !== '1'; } catch { /* 못 읽으면 건드리지 않는다 */ }
          // 프로젝트마다 설정 정리 — 백업에서 되살린 옛 프로젝트에도 같은 함수를 쓴다(patchLoadedProject).
          const patched = state.projects.map(p => patchLoadedProject(p, resetStaleDraft));
          if (resetStaleDraft) { try { localStorage.setItem(DRAFT_DEFAULT_KEY, '1'); } catch { /* 다음 실행에 다시 시도 */ } }
          // Re-apply the saved theme. localStorage is the AUTHORITATIVE live copy — applyTheme
          // writes it synchronously on every change, while this store's copy only reaches
          // IndexedDB after the persist debounce. Reading the store here (which is what this
          // did first) loses a theme change made shortly before a restart AND overwrites the
          // correct localStorage value with the stale one — measured: toggle to dark, restart,
          // back to light. The store copy still earns its place as the fallback: it rides
          // along in the Documents backup, so it is what restores the theme on a fresh
          // machine or after site data is cleared.
          const savedTheme = (() => {
            try { const v = localStorage.getItem(THEME_KEY); return v === 'dark' || v === 'light' ? v as Theme : null; }
            catch { return null; }
          })();
          const theme: Theme = savedTheme ?? useAppStore.getState().theme;
          applyTheme(theme);
          // 저장된 프로젝트 목록은 key·id 가 생기기 전 모양일 수 있다 — 채워 둔다. 첫 목록 수신
          // 때 통째로 바뀌지만, 그 전(트래커가 느린 시동)에도 선택창과 권한 확인이 key 로 돌아야 한다.
          const billingProjects = (state.billingProjects || []).map(p => ({ ...p, id: p.id || '', key: p.key || billingKeyOf(p) }));
          useAppStore.setState({ projects: patched, theme, billingProjects, _hasHydrated: true });
          if (persistTroubleMsg) useAppStore.setState({ persistTrouble: persistTroubleMsg });

          // Element library loads from its own key (and migrates out of the legacy
          // blob on first run). Async, so the UI gates element-dependent surfaces on
          // `_elementsHydrated` — without that gate the @mention list would look empty
          // for a moment after launch and a send in that window could drop references.
          const legacy = useAppStore.getState().elementAssets || [];
          void loadElementAssets(legacy).then(assets => {
            lastElements = assets;             // seed BEFORE the flag so the subscriber
            useAppStore.setState({ elementAssets: assets, _elementsHydrated: true });
            // 옛 어셋의 원본을 파일로 옮긴다(한 번). 첫 화면이 뜬 뒤에 천천히.
            if (assets.some(a => a.images.some(isLegacyImage))) scheduleLibraryMigration(3000);
            // 백업 폴더에 통째로 잃은 옛 기록이 있으면 되살린다(한 번). 그다음 빠진 미리보기·썸네일을
            // 메운다(방금 되살린 것 포함). 첫 화면이 뜬 뒤에.
            setTimeout(() => {
              void runBackupRecovery()
                .catch(err => console.warn('[Recovery] failed:', err))
                .then(() => backfillLibraryImages());
            }, 4000);
          }).catch(err => {
            console.error('[Elements] load failed — keeping legacy copy in memory:', err);
            lastElements = legacy;
            useAppStore.setState({ _elementsHydrated: true });
          });
        };
      },
    }
  )
);

// Persist the element library whenever it actually changes. Covers every mutation
// path at once (addElementAsset / updateElementAsset / deleteElementAsset /
// deleteCollection / 가져오기), because each rebuilds the array. Gated on
// _elementsHydrated so the empty pre-load state can never overwrite stored assets.
// ─── 프로젝트 뒤로/앞으로 — 마우스 MB4/MB5 (26.9.3002~) ─────────────────────────────
// 마지막으로 오간 두 프로젝트 사이만 오간다(프리미어·일러스트의 언두/리두처럼, 와리가리).
//   A → B 로 옮기면 쌍은 [A, B], 지금 B.  뒤로 → A.  A 에서 또 뒤로 → 아무 일 없음.
//   앞으로 → B.  B 에서 또 앞으로 → 아무 일 없음.  몇 번을 오가든 쌍은 마지막 한 번의 이동이다.
// 쌍을 만드는 것은 사용자가 프로젝트를 바꾼 모든 경우(목록 클릭·새 프로젝트·갤러리에서 이동)다.
// 뒤로/앞으로 자체는 쌍을 바꾸지 않고 자리(navAt)만 옮긴다. 켜질 때 되살린 선택, 지운 프로젝트
// 때문에 바뀐 선택은 이동으로 치지 않는다. 저장하지 않는다 — 앱을 새로 켜면 비어 있다.
let navPair: [string, string] | null = null;
let navAt: 0 | 1 = 1;
// 방금 뒤로/앞으로로 간 프로젝트. ChatArea 가 이걸 보고 맨 아래 대신 보던 자리로 스크롤한다.
let navByHistory: { id: string; at: number } | null = null;
let navLastProjectId: string | null = null;

export function navigateProjectHistory(dir: -1 | 1): boolean {
  if (!navPair) return false;
  if ((dir === -1 && navAt !== 1) || (dir === 1 && navAt !== 0)) return false;   // 끝이면 아무 일 없음
  const st = useAppStore.getState();
  const target = navPair[dir === -1 ? 0 : 1];
  if (!st.projects.some(p => p.id === target)) return false;                     // 그새 지워졌다
  navAt = dir === -1 ? 0 : 1;
  if (target === st.currentProjectId) return false;
  navByHistory = { id: target, at: Date.now() };
  st.setCurrentProjectId(target);
  return true;
}

// ChatArea 가 프로젝트를 그린 직후 한 번 묻는다: 이번 전환이 뒤로/앞으로였나.
export function consumeHistoryNav(projectId: string | null): boolean {
  const hit = !!projectId && !!navByHistory && navByHistory.id === projectId && Date.now() - navByHistory.at < 3000;
  navByHistory = null;
  return hit;
}

// ─── 갤러리 '찾기' — 그 컷을 만든 대화의 그 자리로 (26.10.203~) ──────────────────────
// 전체 갤러리의 찾기는 다른 프로젝트로 넘어가야 한다. 넘어가면 ChatArea 가 맨 아래 고정(0.7초)을 거는데,
// 예전 코드는 0.18초 뒤에 메시지로 굴려서 곧바로 바닥으로 끌려 내려갔다 — 찾기가 안 되는 것처럼 보였다.
// 이제 갈 곳을 여기 맡겨 두고, ChatArea 가 그 프로젝트를 그리는 순간 맨 아래 대신 그 메시지로 간다
// (consumeFindRequest). 지금 보고 있는 프로젝트면 이벤트로 바로 알린다.
let findRequest: { projectId: string; messageId: string; at: number } | null = null;
export function requestFindMessage(projectId: string, messageId: string): void {
  const st = useAppStore.getState();
  if (!st.projects.some(p => p.id === projectId)) return;
  if (st.currentProjectId === projectId) {
    window.dispatchEvent(new CustomEvent('seedance:find-message', { detail: { messageId } }));
    return;
  }
  findRequest = { projectId, messageId, at: Date.now() };
  st.setCurrentProjectId(projectId);
}
export function consumeFindRequest(projectId: string | null): string | null {
  const r = findRequest;
  findRequest = null;
  return r && projectId && r.projectId === projectId && Date.now() - r.at < 5000 ? r.messageId : null;
}

useAppStore.subscribe((state) => {
  const cur = state.currentProjectId;
  if (cur === navLastProjectId) return;
  const prev = navLastProjectId;
  navLastProjectId = cur;
  if (navByHistory && navByHistory.id === cur) return;       // 뒤로/앞으로가 만든 전환 — 쌍은 그대로
  if (!state._hasHydrated || !prev || !cur) return;          // 켜질 때 되살린 선택
  if (!state.projects.some(p => p.id === prev) || !state.projects.some(p => p.id === cur)) return;
  navPair = [prev, cur];
  navAt = 1;
});

useAppStore.subscribe((state) => {
  if (!state._elementsHydrated) return;
  if (state.elementAssets === lastElements) return;
  lastElements = state.elementAssets;
  scheduleElementsSave(state.elementAssets);
  // 공유 팩 가져오기처럼 원본 base64 를 들고 들어온 어셋이 있으면 파일로 옮긴다.
  if (state.elementAssets.some(a => a.images.some(isLegacyImage))) scheduleLibraryMigration();
});

// ─── 켜질 때 프로젝트 설정 정리 (hydration 과 백업 되살리기가 같이 쓴다) ──────────────
function patchLoadedProject(p: Project, resetStaleDraft: boolean): Project {
  const validModelIds = MODELS.map(m => m.id);
  const s = { ...defaultSettings, ...p.settings };
  // Retired ids → their replacement, BEFORE anything reads the model. This has
  // to run first: the unknown-model fallback further down would send a demo
  // project to 2.0, and the duration/resolution clamps just below would then
  // trim settings that were perfectly valid for it (30s → 15s, 30 → 9 images).
  s.model = resolveModelId(s.model);
  // Clamp duration to the provider's range: Omni 3–10, Seedance 4–15.
  // -1 = Auto (Seedance only; model picks the length — valid, don't clamp).
  // Range is per-model now; for 2.0/Omni modelDurationRange returns exactly the
  // numbers that were hardcoded here, so their stored settings are untouched.
  // ★ Like the resolution clamp, this must stay STRUCTURAL — a saved 30s on 2.5
  // has to survive a restart even before any capability/permission is known.
  if (s.duration !== -1) {
    const [lo, hi] = modelDurationRange(s.model);
    s.duration = Math.max(lo, Math.min(hi, s.duration));
  }
  // Unknown/legacy model → flagship default
  if (!validModelIds.includes(s.model)) s.model = defaultSettings.model;
  // A format this model doesn't offer is dropped rather than carried — same rule
  // as the resolution clamp right below, and it keeps the send path honest.
  if (s.output_format && !modelOutputFormats(s.model).includes(s.output_format)) delete s.output_format;
  // Clamp resolution to what THIS model supports (Fast/Mini: no 1080p)
  if (!modelResolutions(s.model).includes(s.resolution)) s.resolution = '720p';
  // Same rule for the Omni task. A project saved on 1.1 with 'extend' that is then
  // switched to the Flash preview has a task the preview never offered, and the API
  // would NOT reject it (it validates the schema, not the model) — it would just
  // generate something the user didn't ask for. Structural, like the two above.
  s.omniTask = resolveOmniTask(s.model, s.omniTask);
  // Draft 도 같은 규칙. 초안을 모르는 모델에 남은 값은 비운다(= 모델 기본값을 따름).
  if (s.draft !== undefined && !modelSupportsDraft(s.model)) delete s.draft;
  if (resetStaleDraft && s.draft === false) delete s.draft;
  // Clear in-progress draft prompts on app restart (session-only persistence)
  return { ...p, settings: s, draftPrompt: '' };
}

// ─── 백업에서 프로젝트·어셋 되살리기 (26.10.201~) ──────────────────────────────────
// 백업 폴더의 옛 파일(7월 이전 합본 · AUTOPREV · PREV) 가운데 지금 기록과 프로젝트가 '하나도' 겹치지 않는
// 것 = 통째로 잃은 기록이다(2026-10-01 팀원 PC: 7/30 합본에 17개). 그런 파일이 있으면 그 프로젝트를
// '되살린 프로젝트 (M/D 백업)' 그룹으로, 지금 없는 어셋을 원래 컬렉션째로 붙인다. 지금 기록은 하나도
// 바꾸지 않는다. 일부라도 겹치는 파일은 지금 기록의 과거일 뿐이라 건드리지 않는다(없는 건 지운 것).
// 한 번 본 파일은 기억한다(recoveryScanned) — 큰 파일을 실행마다 다시 훑지 않게. 사용자가 이 PC 에서
// 지운 프로젝트(deletedProjectIds)는 '있는 것'으로 친다 — 되살린 걸 지우거나 일부러 다 지운 뒤, 같은 기록이
// 이름만 바뀐 백업(legacy·AUTOPREV)으로 다시 보여도 살아나지 않게.
// 판정·추출은 서버가 바이트로 한다(server.ts recovery-scan / recovery-import).
let recoveryRan = false;
async function runBackupRecovery(): Promise<void> {
  if (recoveryRan || persistBlocked) return;
  const st0 = useAppStore.getState();
  if (!st0._hasHydrated || !st0._elementsHydrated) return;
  recoveryRan = true;
  const post = async (url: string, body: any) => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };
  let scan: any;
  try {
    scan = await post('/api/backup/recovery-scan', {
      have: [...st0.projects.map(p => p.id), ...(st0.deletedProjectIds || [])],
      skip: st0.recoveryScanned || [], includeCurrent: restoreSkippedThisLaunch,
    });
  } catch { return; }
  const files: any[] = Array.isArray(scan?.files) ? scan.files.filter((f: any) => !f.error) : [];
  if (!files.length) return;
  const remember = () => useAppStore.setState(s => ({
    recoveryScanned: [...new Set([...(s.recoveryScanned || []), ...files.map(f => String(f.sig))])].slice(-100),
  }));
  const pick = files.filter(f => f.projects > 0 && f.overlap === 0).sort((a, b) => b.mtime - a.mtime)[0];
  if (!pick) { remember(); return; }
  let got: any;
  try {
    const cur = useAppStore.getState();
    got = await post('/api/backup/recovery-import', {
      sig: pick.sig, haveElements: cur.elementAssets.map(e => e.id), haveCollections: cur.assetCollections.map(c => c.id),
    });
  } catch { return; }                      // 기억하지 않는다 — 다음 실행에 다시
  if (!got?.ok) return;
  const s = useAppStore.getState();
  const haveP = new Set([...s.projects.map(p => p.id), ...(s.deletedProjectIds || [])]);
  const projects = (Array.isArray(got.projects) ? got.projects : []).filter((p: any) => p?.id && !haveP.has(p.id)) as Project[];
  if (!projects.length) { remember(); return; }
  const d = new Date(got.mtime || pick.mtime);
  const label = `${d.getMonth() + 1}/${d.getDate()}`;
  const groupId = s.createProjectGroup(`되살린 프로젝트 (${label} 백업)`);
  const elements: ElementAsset[] = Array.isArray(got.elements) ? got.elements : [];
  useAppStore.setState(st => {
    const haveE = new Set(st.elementAssets.map(e => e.id));
    const haveC = new Set(st.assetCollections.map(c => c.id));
    return {
      projects: [...st.projects, ...projects.filter(p => !st.projects.some(q => q.id === p.id)).map(p => ({ ...patchLoadedProject(p, false), groupId }))],
      assetCollections: [...st.assetCollections, ...(Array.isArray(got.collections) ? got.collections : []).filter((c: any) => c?.id && !haveC.has(c.id))],
      elementAssets: [...st.elementAssets, ...elements.filter(e => e?.id && !haveE.has(e.id))],
      // 그 프로젝트들이 쓰던 어셋 컬렉션 연결도 되살린다(지금 연결이 있으면 지금 것이 이긴다).
      projectCollectionId: { ...(got.bindings || {}), ...st.projectCollectionId },
    };
  });
  remember();
  console.log(`[Recovery] ${got.name}: 프로젝트 ${projects.length}개 · 어셋 ${elements.length}개 되살림`);
  window.dispatchEvent(new CustomEvent('seedance:toast', { detail: {
    msg: `${label} 백업에서 프로젝트 ${projects.length}개${elements.length ? `와 어셋 ${elements.length}개` : ''}를 되살렸어요 — 사이드바 '되살린 프로젝트 (${label} 백업)'`,
    ok: true,
  } }));
}

// ─── 빠진 미리보기·썸네일 메우기 (26.10.201~) ────────────────────────────────────
// 켜질 때마다 한 번: 원본은 있는데 화면용 JPG 미리보기가 없는 이미지, 썸네일이 없거나 원본이
// 들어앉은(THUMB_SANE_MAX 초과) 이미지를 찾아 뒤에서 하나씩 만든다. 방금 되살린 어셋, 옮기기 도중에
// 앱을 끈 경우, 만들기가 한 번 실패한 경우가 모두 이 한 곳에서 다음 실행에 스스로 메워진다.
// 미리보기가 없어도 화면은 원본으로 보이지만(서버가 대신 준다) 그만큼 메모리를 먹는다 — 3001 이 막은 그것.
let libBackfillRan = false;
async function backfillLibraryImages(): Promise<void> {
  if (libBackfillRan || persistBlocked) return;
  libBackfillRan = true;
  // 옮기기와 겹치면 큰 원본 디코딩이 두 배가 된다 — 끝나길 잠깐 기다린다(옮긴 것은 옮기기가 직접 만든다).
  for (let i = 0; i < 60 && libMigrating; i++) await new Promise(r => setTimeout(r, 2000));
  const imgs = useAppStore.getState().elementAssets
    .flatMap(e => e.images.filter(im => im.libId).map(im => ({ eid: e.id, im })));
  if (!imgs.length) return;
  let missing = new Set<string>();
  try {
    const r = await fetch('/api/library/missing-previews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...new Set(imgs.map(x => x.im.libId!))] }),
    });
    const j = await r.json();
    if (Array.isArray(j?.missing)) missing = new Set(j.missing.map(String));
  } catch { /* 물어보지 못하면 썸네일만 */ }
  const thumbBad = (t?: string) => !t || t.length > THUMB_SANE_MAX;
  const todo = imgs.filter(x => missing.has(x.im.libId!) || thumbBad(x.im.thumbnailUrl));
  if (!todo.length) return;
  let previews = 0, thumbs = 0, failed = 0;
  for (const { eid, im } of todo) {
    const libId = im.libId!;
    try {
      const res = await fetch(`/api/library/${libId}`);
      if (!res.ok) { failed++; continue; }              // 원본이 어디에도 없다 — 메울 수 없다
      const blob = await res.blob();
      if (missing.has(libId)) {
        const pv = await makeJpegPreview(blob);
        const put = await fetch(`/api/library/${libId}/preview`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: pv });
        if (put.ok) { missing.delete(libId); previews++; } else failed++;   // 같은 그림이 여러 어셋에 있어도 한 번
      }
      if (thumbBad(im.thumbnailUrl)) {
        const thumb = await createThumbnail(new File([blob], im.file_name || 'image', { type: blob.type }), 256);
        if (thumb) {
          thumbs++;
          useAppStore.setState(st => ({
            elementAssets: st.elementAssets.map(x => x.id !== eid ? x
              : { ...x, images: x.images.map(y => y.id === im.id ? { ...y, thumbnailUrl: thumb } : y) }),
          }));
        }
      }
    } catch (err) { failed++; console.warn(`[Library] ${libId} 미리보기·썸네일 만들기 실패:`, err); }
  }
  console.log(`[Library] 빠진 미리보기 ${previews}개 · 썸네일 ${thumbs}개 채움${failed ? ` (실패 ${failed} — 다음 실행에 다시)` : ''}`);
}

// ─── 기록 속 그림은 한 번만 (26.10.202~) ──────────────────────────────────────────
// 메시지마다 썸네일을 base64 로 통째로 들고 있었다 — 프롬프트의 @멘션 칩 하나하나(같은 어셋을 17번
// 부르면 17장, 그 프롬프트로 4개를 뽑으면 또 4배), 카드의 레퍼런스 줄, 첨부 썸네일. 2026-10-02 실측:
// 작업 기록 133.8MB 중 106MB 가 그림인데 서로 다른 그림은 263장(1.1MB)뿐이었다. 9월 속도(월 53MB)면
// 9일 뒤 백업 자동 복원 상한(150MB)을 넘고, 저장할 때마다 그 전체를 다시 쓴다.
// 이제 그림은 서버 라이브러리 폴더에 파일로 한 번만 둔다(이름 = 내용 md5 — 같은 그림은 저절로 하나,
// 한 픽셀만 달라도 다른 파일). 메시지에는 주소(/api/library/<id>)만 남고, 화면은 주소를 그대로 그린다.
// 새 메시지는 보낸 직후에, 옛 메시지는 켜질 때 한 번. 서버가 같은 크기로 받았다고 확인한 그림만 바꾼다
// (3001 원본 옮기기와 같은 규칙) — 실패한 것은 그대로 두고 다음에 다시. 그새 바뀐 메시지는 건드리지
// 않고 다음 차례에 한다. 파일은 라이브러리 원본처럼 백업 폴더 element-library/ 로도 복사된다.
// ★ 한 방향: 이 버전 전 앱은 주소로 바뀐 칩 아이콘을 못 그린다(기록 자체는 그대로).
// 보통 그림 형식만 — 서버가 머리 바이트로 형식을 알아보는 것들. SVG 같은 것은 그대로 둔다(형식을 못
// 알아보면 확장자가 틀린 파일이 되어 화면에 안 나온다).
const DATA_IMG_RE = /data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+/g;
const isDataImg = (s: unknown): s is string => typeof s === 'string' && /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,/.test(s);
const imgUrlCache = new Map<string, string>();     // data URL → '/api/library/<id>' (이번 실행 동안)
const cleanMessages = new WeakSet<object>();        // 박힌 그림이 없는 메시지(객체 — 바뀌면 새 객체다)
let compacting = false;
let compactAgain = false;
let compactTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCompaction(delay = 4000) {
  if (compactTimer) clearTimeout(compactTimer);
  compactTimer = setTimeout(() => { compactTimer = null; void compactMessageImages(); }, delay);
}

function messageDataImages(m: any): string[] {
  const out: string[] = [];
  if (typeof m?.promptHtml === 'string' && m.promptHtml.includes('data:image/')) out.push(...(m.promptHtml.match(DATA_IMG_RE) || []));
  for (const ei of m?.usedElementImages || []) if (isDataImg(ei?.url)) out.push(ei.url);
  for (const a of m?.usedAssets || []) { if (isDataImg(a?.url)) out.push(a.url); if (isDataImg(a?.thumbnailUrl)) out.push(a.thumbnailUrl); }
  return out;
}

// 저장된 그림만 주소로 바꾼 새 메시지. 바꿀 게 없으면 같은 객체를 돌려준다.
function rewriteMessageImages(m: any): any {
  const sub = (s: string) => imgUrlCache.get(s) ?? s;
  const next: any = { ...m };
  let changed = false;
  if (typeof m.promptHtml === 'string' && m.promptHtml.includes('data:image/')) {
    const h = m.promptHtml.replace(DATA_IMG_RE, sub);
    if (h !== m.promptHtml) { next.promptHtml = h; changed = true; }
  }
  if (Array.isArray(m.usedElementImages)) {
    const arr = m.usedElementImages.map((ei: any) => isDataImg(ei?.url) && imgUrlCache.has(ei.url) ? { ...ei, url: sub(ei.url) } : ei);
    if (arr.some((x: any, i: number) => x !== m.usedElementImages[i])) { next.usedElementImages = arr; changed = true; }
  }
  if (Array.isArray(m.usedAssets)) {
    const arr = m.usedAssets.map((a: any) => {
      const u = isDataImg(a?.url) && imgUrlCache.has(a.url);
      const t = isDataImg(a?.thumbnailUrl) && imgUrlCache.has(a.thumbnailUrl);
      return u || t ? { ...a, ...(u ? { url: sub(a.url) } : {}), ...(t ? { thumbnailUrl: sub(a.thumbnailUrl) } : {}) } : a;
    });
    if (arr.some((x: any, i: number) => x !== m.usedAssets[i])) { next.usedAssets = arr; changed = true; }
  }
  return changed ? next : m;
}

async function storeMessageImage(dataUrl: string): Promise<string> {
  const blob = await (await fetch(dataUrl)).blob();
  const res = await fetch('/api/library', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', 'X-Filename': encodeURIComponent('thumb' + extForMime(blob.type)) },
    body: blob,
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.ok || !j.libId) throw new Error(j?.error || `그림 저장 실패 (${res.status})`);
  if (j.bytes !== blob.size) throw new Error(`그림 저장 확인 실패 (보낸 ${blob.size}B, 저장 ${j.bytes}B)`);
  return `/api/library/${j.libId}`;
}

async function compactMessageImages(): Promise<void> {
  if (persistBlocked) return;
  if (!useAppStore.getState()._hasHydrated) return;
  if (compacting) { compactAgain = true; return; }
  compacting = true;
  let stored = 0, failed = 0, rewritten = 0;
  try {
    do {
      compactAgain = false;
      // 1) 아직 그림이 박힌 메시지와 처음 보는 그림을 모은다. 프로젝트마다 한 번 숨을 돌린다 — 켜질 때
      //    첫 회는 기록 전체(100MB+)를 훑는다.
      const seen = new Map<string, any>();
      const fresh = new Set<string>();
      for (const p of useAppStore.getState().projects) {
        for (const m of p.messages) {
          if (cleanMessages.has(m)) continue;
          const imgs = messageDataImages(m);
          if (!imgs.length) { cleanMessages.add(m); continue; }
          seen.set(m.id, m);
          for (const d of imgs) if (!imgUrlCache.has(d)) fresh.add(d);
        }
        await new Promise(r => setTimeout(r, 0));
      }
      if (!seen.size) break;
      // 2) 처음 보는 그림만 파일로.
      let failedNow = 0;
      for (const d of fresh) {
        try { imgUrlCache.set(d, await storeMessageImage(d)); stored++; }
        catch (e) { failedNow++; console.warn('[Compact] 그림 저장 실패 — 그대로 두고 다음에 다시:', e); }
      }
      failed += failedNow;
      // 3) 주소로 바꾼 메시지를, 그새 바뀌지 않은 것만 갈아 끼운다.
      const next = new Map<string, any>();
      for (const [id, m] of seen) { const n = rewriteMessageImages(m); if (n !== m) next.set(id, n); }
      if (next.size) {
        useAppStore.setState(s => ({
          projects: s.projects.map(p => {
            let hit = false;
            const messages = p.messages.map(m => {
              const n = next.get(m.id);
              if (!n || seen.get(m.id) !== m) return m;      // 그새 바뀌었다 — 다음 차례에
              hit = true; rewritten++;
              if (!messageDataImages(n).length) cleanMessages.add(n);
              return n;
            });
            return hit ? { ...p, messages } : p;
          }),
        }));
      }
      if (failedNow) break;                                  // 실패가 있으면 이번엔 여기까지(다음 예약 때)
    } while (compactAgain);
  } finally {
    compacting = false;
  }
  if (stored || rewritten || failed) {
    console.log(`[Compact] 기록 속 그림 ${stored}장을 파일로, 메시지 ${rewritten}개를 주소로 바꿈${failed ? ` (실패 ${failed} — 다음에 다시)` : ''}`);
    // 새 파일을 바로 백업 폴더에도 — 다음 백업 주기까지 한 곳에만 있지 않게.
    const ids = [...new Set([...imgUrlCache.values()].map(u => u.slice('/api/library/'.length)))];
    if (ids.length) void syncLibraryBackup(ids);
  }
}

// 백업 폴더에 있어야 할 기록 속 그림 파일(id). 메시지 객체마다 한 번만 훑는다.
const LIB_REF_RE = /\/api\/library\/([0-9a-f]{12}\.[a-z0-9]{2,5})/g;
const msgLibRefs = new WeakMap<object, string[]>();
function messageLibraryIds(projects: Project[]): string[] {
  const ids = new Set<string>();
  for (const p of projects) for (const m of p.messages as any[]) {
    let r = msgLibRefs.get(m);
    if (!r) {
      const found: string[] = [];
      const scan = (s: unknown) => { if (typeof s === 'string' && s.includes('/api/library/')) for (const x of s.matchAll(LIB_REF_RE)) found.push(x[1]); };
      scan(m.promptHtml);
      for (const ei of m.usedElementImages || []) scan(ei?.url);
      for (const a of m.usedAssets || []) { scan(a?.url); scan(a?.thumbnailUrl); }
      msgLibRefs.set(m, found);
      r = found;
    }
    for (const id of r) ids.add(id);
  }
  return [...ids];
}

// 기록이 바뀔 때마다(새 메시지 · 되살린 프로젝트 · 가져오기) 조금 뒤에 한 번. 깨끗한 메시지는 건너뛰므로 싸다.
let lastProjectsForCompact: unknown = null;
useAppStore.subscribe((state) => {
  if (!state._elementsHydrated || state.projects === lastProjectsForCompact) return;
  lastProjectsForCompact = state.projects;
  scheduleCompaction();
});
