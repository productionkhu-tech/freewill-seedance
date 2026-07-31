import { create } from 'zustand';
import { persist, type PersistStorage, type StorageValue } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { get, set, del } from 'idb-keyval';
import { showNotification, setCachedBlob, getCachedBlob, downloadViaProxy, buildDownloadFilename, API_LIMITS } from './lib/utils';

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

// External backup mirror to Documents/Freewill Seedance Backup/seedance-backup.json.
// Survives any userData loss (app-name rename, uninstall+reinstall, AppData cleanup).
// Longer debounce than IDB so we don't churn the disk during heavy editing.
let backupTimer: ReturnType<typeof setTimeout> | null = null;
const BACKUP_DEBOUNCE_MS = 5 * 60 * 1000;
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
  // Drop chunks left over from a previously longer library.
  for (let i = parts.length; i < parts.length + 40; i++) {
    try { await del(ELEMENTS_CHUNK + i); } catch { /* absent is fine */ }
  }
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
  }, DEBOUNCE_MS);
}

// The one write path. Chunked, serialized against itself, and loud on failure — the v1
// version threw synchronously inside a timer, which no .catch could see, so saving just
// stopped without a word.
function saveElements(assets: ElementAsset[]): Promise<void> {
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
const idbPersistStorage: PersistStorage<unknown> = {
  getItem: async (name: string): Promise<StorageValue<unknown> | null> => {
    const parse = (raw: string): StorageValue<unknown> | null => {
      try { return JSON.parse(raw); } catch { console.warn('[Persist] corrupt JSON — starting empty'); return null; }
    };
    const fromIdb = await get(name);
    if (fromIdb) return parse(fromIdb);
    // IDB empty — likely fresh install OR userData was wiped. Try external backup.
    try {
      const api = (window as any).electronAPI;
      if (api?.backupLoad) {
        const result = await api.backupLoad();
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
          return parse(result.content);
        }
      }
    } catch (err) {
      console.warn('[Backup] Load failed:', err);
    }
    return null;
  },
  setItem: (name: string, value: StorageValue<unknown>): void => {
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

    // Mirror to external backup file (long debounce — 5 min). Stringifies its own
    // snapshot at fire time (once per 5 min, not per set).
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(() => {
      const api = (window as any).electronAPI;
      if (!api?.backupSave) return;
      // ★ SAFETY: never write a backup before the library has loaded. Backing up an
      // empty/half-loaded elementAssets would OVERWRITE a good backup with one that
      // has no library — destroying the very safety net this mirror exists to be.
      // Skipping is safe: the previous good backup stays on disk and the next write
      // (post-hydration) reschedules this timer.
      let st;
      try { st = useAppStore.getState(); } catch { return; }
      if (!st || !st._elementsHydrated) {
        console.warn('[Backup] skipped — element library not hydrated yet (keeping previous backup)');
        return;
      }

      // ── The work history goes first, and ALONE ──────────────────────────────────
      // This used to be one combined string (state + library). Once the library passed
      // ~500MB the combined JSON exceeded V8's 512MB single-string ceiling and
      // JSON.stringify threw RangeError — synchronously inside this timer, so the
      // .catch below never ran and backups silently stopped for weeks. Measured:
      // 19.4MB + 505.9MB = 525.3MB against a 512MB limit.
      // Separated, the irreplaceable part is ~19MB and cannot be dragged over the
      // cliff by the library growing.
      try {
        api.backupSave(JSON.stringify(value), 'state')
          .then((r: any) => {
            if (r?.ok) console.log(`[Backup] state ${(r.bytes / 1048576).toFixed(2)}MB → ${r.path}`);
            else console.warn('[Backup] state save failed:', r?.error);
          })
          .catch((err: any) => console.warn('[Backup] state save error:', err?.message || err));
      } catch (err: any) {
        // try/catch because stringify throws SYNCHRONOUSLY — a promise .catch cannot see it.
        console.error('[Backup] state serialize failed:', err?.message || err);
      }

      // ── The library second, chunked, best-effort ───────────────────────────────
      // Same chunking as IDB: no whole-library string is ever built, so the library can
      // grow past 512MB without the backup quietly dying the way it did before.
      // Skipped when unchanged — this is half a gigabyte of disk writes.
      void (async () => {
        try {
          const els = st.elementAssets || [];
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
    }, BACKUP_DEBOUNCE_MS);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

// Write the pending snapshot to IndexedDB NOW, skipping the debounce. Used
// after critical updates (downloadedAt) and on window hide/quit so a close
// within DEBOUNCE_MS can't drop the write. Idempotent — no-op when nothing
// is pending.
export function flushPersist(): Promise<void> {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  if (!pendingWrite) return Promise.resolve();
  const w = pendingWrite;
  pendingWrite = null;
  return set(w.name, JSON.stringify(w.value));
}

// Safety net: flush whenever the window hides (minimize/tray) or unloads
// (quit, auto-update restart). visibilitychange-hidden is the reliable signal
// in Chromium/Electron; pagehide covers real navigation/quit.
if (typeof window !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { void flushPersist(); void flushElements(); }
  });
  window.addEventListener('pagehide', () => { void flushPersist(); void flushElements(); });
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
  url: string;          // full-res base64 data URL — durable source (backed up)
  thumbnailUrl: string; // small base64 preview for the UI
  cacheId?: string;     // opportunistic media-cache id for the fast send path
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
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  content: string;
  taskId?: string;
  status?: 'queued' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string;
  imageUrl?: string;
  error?: string;
  timestamp: number;
  startTime?: number;
  endTime?: number;
  usedSettings?: GenerationSettings;
  usedAssets?: Asset[];
  promptText?: string;
  promptHtml?: string; // innerHTML snapshot (with mention pills) for exact 재사용 — element mentions are stored as bare names in promptText and can't be re-pillified from it
  usedElementImages?: { id: string; elementId: string; imageId: string; name: string; category: string; url: string }[]; // element-mention images shown on the card reference strip (url = thumbnail; full-res for hover-zoom is looked up live by elementId+imageId)
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

// ── Scope: why the two differ ────────────────────────────────────────────────
// PROJECTS are unique app-wide. The sidebar search FLATTENS the tree (matches are listed
// without their folders) and the gallery's project filter is a flat list, so two projects
// called "1차" in different folders are genuinely indistinguishable in both places.
//
// GROUPS are unique only among SIBLINGS. A folder is never shown without its parent —
// indented in the sidebar, "부모 › 자식" in the gallery — so "광고 › 1차" and "예능 › 1차"
// already read as different things. Forcing "1차 (1)" on the second client would be noise.
function siblingGroupNames(groups: ProjectGroup[], exceptId: string | null, parentId: string | undefined): string[] {
  // Effective parent (groupTree), not the raw field: a group with a dangling parentId is
  // DRAWN at the top level, so that is who it has to be distinguishable from.
  const t = groupTree(groups);
  const sibs = parentId ? t.childrenOf(parentId) : t.roots;
  return sibs.filter(g => g.id !== exceptId).map(g => g.name);
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
  // Element library loads from its own IDB key AFTER main hydration. Until this is
  // true the library may still be empty — element-dependent UI (@mention list, send)
  // must wait on it rather than act on a half-loaded library.
  _elementsHydrated: boolean;
  projects: Project[];
  currentProjectId: string | null;
  autoDownload: boolean; // global toggle — auto-save every video when it succeeds
  setAutoDownload: (v: boolean) => void;
  // Billing/tracking project (시트 연동). Session-only + app-global: picked once per
  // launch, survives local-project switches AND queue sends, NOT persisted (restart
  // → must re-pick). Distinct from the local `projects` sidebar workspaces.
  billingProject: string;
  // allow4k mirrors the tracker sheet's Project_Status F column ("4K 허용"), refreshed
  // by the same 60s poll that carries status. Kept on this list rather than in its own
  // store field so a permission flip costs zero extra writes/renders.
  billingProjects: { project: string; status: string; allow4k?: boolean }[];
  setBillingProject: (p: string) => void;
  setBillingProjects: (list: { project: string; status: string; allow4k?: boolean }[]) => void;
  // Transient (NOT persisted): # of images from elements currently @mentioned in
  // the active prompt. ChatArea writes it; SettingsPanel reads it to show the
  // shared "panel + element" image budget in the Reference Assets hint.
  mentionedElementImages: number;
  setMentionedElementImages: (n: number) => void;
  setCurrentProjectId: (id: string) => void;
  createProject: () => void;
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
};

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
//   demo        routed to a separate key/endpoint server-side, never billed to the sheet
export const MODELS: {
  id: string; name: string; provider?: 'byteplus' | 'gemini';
  res?: string[]; dur?: [number, number]; imgMax?: number; vidMax?: number; audMax?: number;
  refVideoSec?: number; demo?: boolean;
}[] = [
  { id: 'dreamina-seedance-2-0-260128', name: 'Seedance 2.0' },
  { id: 'dreamina-seedance-2-0-fast-260128', name: 'Seedance 2.0 Fast' },
  { id: 'dreamina-seedance-2-0-mini-260615', name: 'Seedance 2.0 Mini' },
  { id: 'gemini-omni-flash-preview', name: 'Gemini Omni Flash', provider: 'gemini' },
  // Seedance 2.5 (BytePlus demo endpoint — separate key, see server.ts). Every number
  // here was measured against the live API 2026-07-29, not taken from the datasheet:
  // 480p/720p only (1080p/2k/4k all rejected in both t2v and r2v), 4–30s output,
  // reference video ≤30.2s, and 30 images / 10 videos / 10 audio (= the "50 assets").
  // `[Image N]` markers, roles and ratios all behave exactly like 2.0 — verified by
  // generating a clip whose three markers bound to the correct reference images.
  // ★ The real endpoint id is NOT here on purpose: the demo terms forbid sharing it and
  // this file ships to every team AND to a public repo. The server swaps this logical id
  // for SEEDANCE_25_DEMO_ENDPOINT at request time.
  { id: 'seedance-2-5-demo', name: 'Seedance 2.5 Demo',
    res: ['480p', '720p'], dur: [4, 30],
    imgMax: 30, vidMax: 10, audMax: 10,   // measured: 30/10/10 = the advertised "50 assets"
    refVideoSec: 30.2, demo: true },
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
// Demo models are billed against a separate BytePlus key and are deliberately NOT
// reported to the credit tracker; the server decides both, this just tells the UI.
export function isDemoModel(model: string): boolean {
  return MODELS.find(m => m.id === model)?.demo === true;
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
// boot, and billingProject is session-only (starts empty) → the 4k permission is always
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
// tracker sheet. Nothing else is affected: '4k' only exists in the flagship's structural
// list, so Fast/Mini/Omni can never gain it no matter what allow4k says.
export function allowedResolutions(model: string, allow4k: boolean): string[] {
  return modelResolutions(model).filter(r => r !== '4k' || allow4k);
}

// Step DOWN to the nearest allowed tier (4k→1080p→720p→480p) rather than snapping to a
// hardcoded '720p'. Losing 4k permission should land the user on 1080p — the next thing
// down — not two tiers below where they were.
export function clampResolution(model: string, res: string, allow4k: boolean): string {
  const ok = allowedResolutions(model, allow4k);
  if (ok.includes(res)) return res;
  const ladder = ['4k', '1080p', '720p', '480p'];
  const from = ladder.indexOf(res);
  // Unknown/legacy value → app default, never a silent promotion to a higher tier.
  if (from < 0) return ok.includes('720p') ? '720p' : ok[ok.length - 1];
  for (let i = from + 1; i < ladder.length; i++) if (ok.includes(ladder[i])) return ladder[i];
  return ok[ok.length - 1] || '720p';
}

// Is 4k unlocked for the CURRENTLY selected billing project? Always derived, never
// stored — so a grant/revoke in the sheet takes effect the moment the poll lands, with
// no second copy of the truth to keep in sync. Fail-closed: no project selected, project
// missing from the list, or field absent (older tracker) → false.
export function isFourKAllowed(state: {
  billingProject: string;
  billingProjects: { project: string; allow4k?: boolean }[];
}): boolean {
  if (!state.billingProject) return false;
  return state.billingProjects.find(p => p.project === state.billingProject)?.allow4k === true;
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      _hasHydrated: false,
      _elementsHydrated: false,
      projects: [],
      currentProjectId: null,
      autoDownload: false,
      setAutoDownload: (v) => set({ autoDownload: v }),
      billingProject: '',
      billingProjects: [],
      setBillingProject: (p) => set({ billingProject: p }),
      setBillingProjects: (list) => set({ billingProjects: list }),
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
      setCurrentProjectId: (id) => set({ currentProjectId: id }),
      createProject: () => {
        const existing = get().projects.map(p => p.name);
        const newProject: Project = {
          id: uuidv4(),
          // The counter is a position, not an identity: delete one project and the next
          // "Project N" collides with one that is still sitting in the list.
          name: uniqueName(`Project ${get().projects.length + 1}`, existing),
          messages: [],
          settings: { ...defaultSettings },
          assets: [],
          updatedAt: Date.now(),
        };
        set((state) => ({
          projects: [newProject, ...state.projects],
          currentProjectId: newProject.id,
        }));
      },
      renameProject: (id, name) => {
        set((state) => {
          // Excluding self matters: without it, re-confirming a project's own name would
          // bump it to "이름 (1)" every time you opened the rename box.
          const final = uniqueName(name, state.projects.filter(p => p.id !== id).map(p => p.name));
          return {
            projects: state.projects.map((p) =>
              p.id === id ? { ...p, name: final, updatedAt: Date.now() } : p
            ),
          };
        });
      },
      setProjectIcon: (id, icon) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            // updatedAt is deliberately NOT bumped: the icon is decoration, and the
            // project list is ordered/《recently touched》 by real work, not by cosmetics.
            p.id === id ? { ...p, icon } : p
          ),
        }));
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
        const wanted = name || `그룹 ${get().projectGroups.length + 1}`;
        const g: ProjectGroup = {
          id: uuidv4(),
          name: uniqueName(wanted, siblingGroupNames(get().projectGroups, null, under)),
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
          const final = uniqueName(name, siblingGroupNames(state.projectGroups, id, t.isSub(me) ? me.parentId : undefined));
          return { projectGroups: state.projectGroups.map(g => g.id === id ? { ...g, name: final } : g) };
        });
      },
      // Removing the folder and destroying its contents are different intentions, so they
      // are different calls — never a flag with a default, where the destructive branch
      // could be reached by forgetting to pass something. The UI asks which one.
      deleteProjectGroup: (id) => {
        set((state) => ({
          projectGroups: state.projectGroups
            .filter(g => g.id !== id)
            // Subfolders are promoted, not destroyed. "그룹만 삭제" promises the contents
            // survive, and a subfolder is contents.
            .map(g => g.parentId === id ? { ...g, parentId: undefined } : g),
          projects: state.projects.map(p => p.groupId === id ? { ...p, groupId: undefined } : p),
        }));
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
          const landed = projects.find(p => p.id === currentProjectId);
          if (landed?.groupId) {
            // Unfold the whole chain down to it. Unfolding only the immediate folder isn't
            // enough once folders nest — an open subfolder inside a folded parent is just
            // as invisible as a folded one.
            const home = projectGroups.find(g => g.id === landed.groupId);
            const open = new Set([landed.groupId, ...(home?.parentId ? [home.parentId] : [])]);
            projectGroups = projectGroups.map(g => open.has(g.id) ? { ...g, collapsed: false } : g);
          }
          return { projectGroups, projects, currentProjectId, projectCollectionId: binding };
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
          next.splice(at, 0, { ...dragged, parentId, name: uniqueName(dragged.name, siblingGroupNames(state.projectGroups, draggedId, parentId)) });
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
          next.splice(lastIdx + 1, 0, { ...g, parentId, name: uniqueName(g.name, siblingGroupNames(state.projectGroups, draggedId, parentId)) });
          return { projectGroups: openChain(next, parentId) };
        });
      },
      // Move a folder in or out of another without touching its position in the order.
      setGroupParent: (groupId, parentId) => {
        set((state) => {
          const g = state.projectGroups.find(x => x.id === groupId);
          if (!g || (g.parentId || undefined) === (parentId || undefined)) return state;
          if (!canNest(state.projectGroups, groupId, parentId)) return state;
          const final = uniqueName(g.name, siblingGroupNames(state.projectGroups, groupId, parentId));
          return {
            projectGroups: openChain(
              state.projectGroups.map(x => x.id === groupId ? { ...x, parentId, name: final } : x), parentId),
          };
        });
      },
      toggleProjectGroup: (id) => {
        set((state) => ({ projectGroups: state.projectGroups.map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g) }));
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
          return { projectGroups, projects: state.projects.map(p => p.id === projectId ? { ...p, groupId } : p) };
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
          next.splice(lastIdx + 1, 0, { ...moved, groupId });
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
          next.splice(at, 0, { ...dragged, groupId: target.groupId });
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
          return { projects: newProjects, currentProjectId: newCurrentId, projectCollectionId: binding };
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
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  messages: p.messages.map((m) =>
                    m.id === messageId ? { ...m, ...updates } : m
                  ),
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
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
          // Tell the server which BytePlus key this task belongs to. Derived from the
          // message's own usedSettings, so it stays correct across app restarts.
          // Empty string for every non-demo model → URL identical to before.
          const demoQ = isDemoModel(message.usedSettings?.model || '') ? '?demo=1' : '';
          const res = await fetch(`/api/byteplus/tasks/${taskId}${demoQ}`, { signal: ac.signal });
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
            // Auto-download: this succeeded block runs exactly once per task
            // (line ~343 early-returns once succeeded, and App.tsx only polls
            // running/queued), so no per-message guard is needed. Does NOT set
            // downloadedAt — that marker is manual-click only ("다시 다운로드").
            if (get().autoDownload && contentData?.video_url) {
              downloadViaProxy(contentData.video_url, buildDownloadFilename(taskId))
                .catch(err => console.warn('[AutoDownload] failed:', err?.message || err));
            }
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
            showNotification('영상 생성 완료', { body: '영상이 성공적으로 생성되었습니다.' });
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
          const msg = get().projects.find(p => p.id === projectId)?.messages.find(m => m.id === messageId);
          const demoQ = isDemoModel(msg?.usedSettings?.model || '') ? '?demo=1' : '';
          const res = await fetch(`/api/byteplus/tasks/${taskId}${demoQ}`, { method: 'DELETE' });
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
        assetCollections: state.assetCollections,
        projectGroups: state.projectGroups,
        projectCollectionId: state.projectCollectionId,
      }),
      onRehydrateStorage: () => {
        return () => {
          // Migrate: fill missing settings fields with defaults + clamp invalid values
          const validModelIds = MODELS.map(m => m.id);
          const state = useAppStore.getState();
          const patched = state.projects.map(p => {
            const s = { ...defaultSettings, ...p.settings };
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
            // Clamp resolution to what THIS model supports (Fast/Mini: no 1080p)
            if (!modelResolutions(s.model).includes(s.resolution)) s.resolution = '720p';
            // Clear in-progress draft prompts on app restart (session-only persistence)
            return { ...p, settings: s, draftPrompt: '' };
          });
          useAppStore.setState({ projects: patched, _hasHydrated: true });

          // Element library loads from its own key (and migrates out of the legacy
          // blob on first run). Async, so the UI gates element-dependent surfaces on
          // `_elementsHydrated` — without that gate the @mention list would look empty
          // for a moment after launch and a send in that window could drop references.
          const legacy = useAppStore.getState().elementAssets || [];
          void loadElementAssets(legacy).then(assets => {
            lastElements = assets;             // seed BEFORE the flag so the subscriber
            useAppStore.setState({ elementAssets: assets, _elementsHydrated: true });
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
useAppStore.subscribe((state) => {
  if (!state._elementsHydrated) return;
  if (state.elementAssets === lastElements) return;
  lastElements = state.elementAssets;
  scheduleElementsSave(state.elementAssets);
});
