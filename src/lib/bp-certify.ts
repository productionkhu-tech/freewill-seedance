// 사진 한 장을 BytePlus 에셋으로 인증 — 레퍼런스 칸의 방패(SettingsPanel)와 막혔을 때의 자동 인증(send-request)이 같이 쓴다(26.11.24~).
// 사용자 11/24: "레퍼런스 칸에도 방패 넣어줘" → "오류 뜨면 … 자동으로 인증 날려준다고 뜨면 되지 않을까 기다리라고"(완전 자동을 고름).
//
// 칸 사진으로 라이브러리 인물 카드를 찾거나(같은 바이트 — contentKey) 만들고, 라이브러리 방패와 같은 registerElement 로 등록한다 —
// 등록 길은 하나(중복 · 한도 · 다시 하기 · 보관함 정리 규칙이 그대로). 카드가 있어야 하는 이유: 인증 상태는 라이브러리 사진(bpAssets)에
// 적히고, 칸 · @이름 · 다른 PC 가 모두 그것을 본다(lib/bp-assets). 새 카드는 그 채팅에 연결된 컬렉션에(없으면 '레퍼런스 인물' 컬렉션) —
// 연결을 바꾸지는 않는다. 같은 사진을 두 곳에서 동시에 불러도 한 번만(certifying, 열쇠 contentKey).
import { useAppStore, contentKey, mentionKey, fileBaseName, boundCollectionOf, type ElementImage } from '../store';
import { checkSamePhoto, libraryElementFor, registerElement, bpScope, bpErrorText, bpEntryOf } from './bp-assets';
import { PERSONAL } from './edition';
import { fileToElementImage } from './element-image';
import { sourcePathOf } from './source-path';

export const REF_COLLECTION = '레퍼런스 인물';
export type CertifyResult = { ok: boolean; message: string; elementId?: string };
const certifying = new Map<string, Promise<CertifyResult>>();

/** 칸 사진(캐시 id 가 있는 것) → 라이브러리 카드 찾기/만들기 → 등록. projectId 는 새 카드를 둘 컬렉션을 정한다(그 채팅에 연결된 것). */
export function certifyPhoto(a: { cacheId?: string; file_name?: string; originalPath?: string }, projectId?: string | null): Promise<CertifyResult> {
  const key = contentKey(a.cacheId);
  if (!key || !a.cacheId) return Promise.resolve({ ok: false, message: '이 칸은 원본이 없어 인증할 수 없어요 — 사진을 다시 넣어 주세요.' });
  const running = certifying.get(key);
  if (running) return running;
  const cacheId = a.cacheId;
  const p = (async (): Promise<CertifyResult> => {
    await checkSamePhoto(cacheId);   // 다시 저장 · 복사로 바이트만 달라진 같은 사진이면 그 카드로(새 카드 · 새 등록 없음, 26.11.25~)
    let el = libraryElementFor(cacheId);
    if (!el) {
      const r = await fetch(`/api/cache/${encodeURIComponent(cacheId)}`).catch(() => null);
      if (!r || !r.ok) return { ok: false, message: '원본을 읽지 못했어요 — 사진을 다시 넣어 주세요.' };
      const blob = await r.blob();
      const file = new File([blob], a.file_name || cacheId, { type: blob.type || 'application/octet-stream' });
      let img: ElementImage;
      try { img = await fileToElementImage(file, sourcePathOf(a) || undefined); }
      catch (e: any) { return { ok: false, message: `라이브러리에 넣지 못했어요 — ${e?.message || e}` }; }
      // 바이트가 같아야 칸의 사진이 그 에셋으로 나간다(contentKey 로 맞춘다)
      if (contentKey(img.libId) !== key) return { ok: false, message: '라이브러리에 옮긴 사진이 칸의 사진과 달라요 — 사진을 다시 넣어 주세요.' };
      el = libraryElementFor(cacheId);   // 올리는 사이 다른 길(라이브러리 · 에이전트)로 생겼으면 그 카드
      if (!el) {
        const st = useAppStore.getState();
        const pid = projectId === undefined ? st.currentProjectId : projectId;
        const colId = (pid ? boundCollectionOf(pid)?.id : undefined)
          || st.assetCollections.find(c => c.name === REF_COLLECTION)?.id
          || st.createCollection(REF_COLLECTION);
        // 컬렉션 안에서 이름은 하나(멘션이 이름으로 찾는다 — ElementLibrary 와 같은 규칙)
        const base = fileBaseName(a.file_name || '인물');
        const taken = new Set(useAppStore.getState().elementAssets.filter(e => e.collectionId === colId).map(e => mentionKey(e.name)));
        let nm = base;
        for (let i = 2; taken.has(mentionKey(nm)); i++) nm = `${base} ${i}`;
        useAppStore.getState().addElementAsset({ collectionId: colId, category: 'character', name: nm, description: '레퍼런스 칸에서 인증', images: [img] });
        el = useAppStore.getState().elementAssets.find(e => e.images.some(im => im.id === img.id));
        if (!el) return { ok: false, message: '인물 카드를 만들지 못했어요.' };
      }
    }
    const r = await registerElement(el.id);
    return { ok: r.ok, message: `[${el.name}] ${r.message}`, elementId: el.id };
  })().finally(() => certifying.delete(key));
  certifying.set(key, p);
  return p;
}

// ── 영상 레퍼런스(v2v)의 인물 — 26.11.24~, 사용자 "v2v 인증 절차도 해야겠지 당연히" ──
// BytePlus 는 영상도 에셋으로 받는다(비공개 가상 인물 라이브러리 = image · video · audio, 영상은 처리가 더 느림). 라이브러리(사진 카드)에 두지 않고
// 게이트웨이에만 등록한다 — 같은 영상(내용 key = 캐시 id)은 게이트웨이가 에셋 하나로 기억 · 찾는다(KV · ListAssets 이름). 그래서 이 PC 는
// '프로젝트:내용 key → 에셋' 을 메모리에만 들고 있다(다음 보내기부터 바로 asset://). 앱을 다시 켜면 첫 보내기가 한 번 막히고(생성 전 거절 · 과금 없음)
// 그때 게이트웨이가 이미 있는 에셋을 바로 돌려준다. 실존 인물(배우)이 나오는 실사 영상은 BytePlus 가 에셋으로 받지 않을 수 있다(보안 검토 → Failed) —
// 그때는 이유를 돌려준다(본인 인증 Real-human 에셋만 길이 있다).
type VideoAsset = { id: string; status: 'active' | 'processing' | 'failed'; error?: string; at?: number };
const videoAssets = new Map<string, VideoAsset>();
// 이 PC 에 '프로젝트:내용 key → 에셋 id' 만 작게 남긴다(26.11.25~, 사용자 "껐다 킬 때마다 신호 보내면 워커에 부담 … 용량 · 메모리만 안 차지하면 됨, 캐시 정리하면
// 같이 가게") — 안 남기면 켤 때마다 영상마다 업로드 · 막힌 요청 · 게이트웨이 호출이 한 번씩 되풀이됐다. 300개 · 30일(쓸 때마다 늘어남)까지, 캐시 정리를 누르면 모두
// 지운다(Sidebar doClearCache → forgetAllVideos). 지워진 에셋이면 보내기의 'not found' 자동 복구가 다시 등록한다. 개인판은 아무것도 안 남긴다.
const V_STORE = 'seedance-vid', V_KEEP = 300, V_DAYS = 30 * 24 * 60 * 60 * 1000;
function loadVideos() {
  if (PERSONAL) return;
  try {
    const j = JSON.parse(localStorage.getItem(V_STORE) || '{}');
    for (const [k, v] of Object.entries(j || {})) {
      if (/^.+:[0-9a-f]{12}$/.test(k) && Array.isArray(v) && /^asset-[A-Za-z0-9._-]+$/.test(String(v[0])) && Date.now() - Number(v[1]) < V_DAYS) {
        videoAssets.set(k, { id: String(v[0]), status: 'active', at: Number(v[1]) });
      }
    }
  } catch { /* 없거나 깨졌으면 기억 없이 */ }
}
function saveVideos() {
  if (PERSONAL) return;
  try {
    const rows = [...videoAssets].filter(([, v]) => v.status === 'active').sort((a, b) => (a[1].at || 0) - (b[1].at || 0)).slice(-V_KEEP);
    if (rows.length) localStorage.setItem(V_STORE, JSON.stringify(Object.fromEntries(rows.map(([k, v]) => [k, [v.id, v.at || Date.now()]]))));
    else localStorage.removeItem(V_STORE);
  } catch { /* 이번 실행 동안만 */ }
}
loadVideos();
/** 캐시 정리 — 영상 기억을 모두 지운다(다음 보내기 때 게이트웨이가 있는 에셋을 다시 알려 준다). */
export function forgetAllVideos(): void {
  videoAssets.clear();
  videoFailed.clear();
  saveVideos();
  bumpVideo();
}
/** 어느 프로젝트에서든 이 영상의 기억이 있나 — 있을 때만 보내기가 프로젝트 이름을 기다린다. */
export function videoKnown(cacheId: string | undefined): boolean {
  const key = contentKey(cacheId);
  return !!key && [...videoAssets.keys()].some((k) => k.endsWith(`:${key}`));
}
/** 켤 때 — 영상 기억이 있는 PC 만 프로젝트 이름을 한 번 묻고(사진과 같은 호출 · 10분 기억) 칸 배지를 다시 그린다. */
export async function primeVideos(): Promise<void> {
  if (PERSONAL || !videoAssets.size) return;
  await bpScope();
  bumpVideo();
}
const vKey = (scope: string, cacheId: string) => `${scope}:${contentKey(cacheId)}`;
/** 이 PC 가 이 프로젝트에서 이미 인증한 영상이면 asset://id(보내기가 막히지 않게 바로). */
export function videoAssetUrl(cacheId: string | undefined, scope: string | null): string | null {
  if (!cacheId || !scope || !contentKey(cacheId)) return null;
  const v = videoAssets.get(vKey(scope, cacheId));
  if (v?.status !== 'active') return null;
  if (Date.now() - (v.at || 0) > 24 * 60 * 60 * 1000) { v.at = Date.now(); saveVideos(); }   // 쓰는 동안은 30일이 다시 늘어난다(하루 한 번만 적는다)
  return `asset://${v.id}`;
}
/** BytePlus 에서 지워졌다(보내기가 'asset … is not found') — 기억을 지운다. 다시 인증하면 게이트웨이가 확인 뒤 새로 만든다. */
export function forgetVideoAsset(id: string): void {
  let changed = false;
  for (const [k, v] of videoAssets) if (v.id === id) { videoAssets.delete(k); changed = true; }
  if (changed) { saveVideos(); bumpVideo(); }
}
const videoInFlight = new Map<string, Promise<{ ok: boolean; url?: string; message: string }>>();
// 영상 칸의 인증 배지(26.11.24~, 사용자 "이런 경우엔 어떻게 들어가는 거임 인증 버튼이") — 위 기억은 메모리라 화면이 따라오도록 바뀔 때마다 알린다(useSyncExternalStore).
// 실패 이유도 내용 key 로 들고 있다(다시 누르면 지움). 프로젝트가 바뀌면 그 프로젝트의 기억만 본다.
const videoFailed = new Map<string, string>();
const videoListeners = new Set<() => void>();
function bumpVideo() { for (const fn of videoListeners) fn(); }
export function subscribeVideoBp(fn: () => void): () => void {
  videoListeners.add(fn);
  return () => { videoListeners.delete(fn); };
}
/** 영상 칸 배지 — 'busy' | 'done|<에셋 id>' | 'failed|<이유>' | 'idle'. 문자열이라 useSyncExternalStore 스냅샷으로 그대로 쓴다. */
export function videoBpState(cacheId: string | undefined, scope: string | null): string {
  const key = contentKey(cacheId);
  if (!key) return 'idle';
  if (videoInFlight.has(key)) return 'busy';
  const v = scope ? videoAssets.get(`${scope}:${key}`) : undefined;
  if (v?.status === 'active') return `done|${v.id}`;
  const f = videoFailed.get(key);
  return f ? `failed|${f}` : 'idle';
}
export function certifyVideo(a: { cacheId?: string; file_name?: string }, opts: { waitMs?: number; stop?: () => boolean } = {}): Promise<{ ok: boolean; url?: string; message: string }> {
  const key = contentKey(a.cacheId);
  if (!key || !a.cacheId) return Promise.resolve({ ok: false, message: '이 영상은 원본이 없어 인증할 수 없어요 — 다시 넣어 주세요.' });
  const running = videoInFlight.get(key);
  if (running) return running;
  const cacheId = a.cacheId;
  const name = (fileBaseName(a.file_name || '영상') || '영상').slice(0, 64);
  const p = (async () => {
    const sc = await bpScope({ ignoreMiss: true });
    if (!sc.project) return { ok: false, message: bpErrorText(sc) };
    const scope = sc.project;
    const t0 = Date.now(), waitMs = opts.waitMs ?? 180_000;
    const register = async () => {
      const r = await fetch('/api/bp-assets/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ group: { key: `v${key}`, name }, items: [{ libId: cacheId, type: 'Video', name }] }),
      }).catch((e) => ({ json: async () => ({ ok: false, code: 'offline', error: String(e?.message || e) }) } as any));
      return r.json().catch(() => ({}));
    };
    let j: any = await register();
    let it: any = j?.ok && Array.isArray(j.items) ? j.items[0] : null;
    if (!it) return { ok: false, message: bpErrorText(j) };
    while (Date.now() - t0 < waitMs) {
      if (opts.stop?.()) return { ok: false, message: '취소됨' };
      const st = it?.status;
      if (st === 'Active' && it.id) {
        videoAssets.set(vKey(scope, cacheId), { id: it.id, status: 'active', at: Date.now() });
        saveVideos();
        return { ok: true, url: `asset://${it.id}`, message: '인증 완료' };
      }
      if (st === 'Failed' || st === 'NotFound') {
        const e = it?.error ? `${it.error.code || ''}${it.error.message ? `: ${it.error.message}` : ''}` : '';
        if (videoAssets.delete(vKey(scope, cacheId))) saveVideos();
        return { ok: false, message: `BytePlus 가 이 영상을 에셋으로 받지 않았어요${e ? ` — ${e}` : ''}. 실존 인물(배우)이 나오는 영상이면 본인 인증(Real-human) 에셋으로만 쓸 수 있어요.` };
      }
      if (st === 'Processing' && it.id) {
        await new Promise((r) => setTimeout(r, 3000));
        const s = await fetch('/api/bp-assets/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [it.id] }) })
          .then((r) => r.json()).catch(() => null);
        const got = s?.ok && Array.isArray(s.items) ? s.items[0] : null;
        if (got && got.status && got.status !== 'Retry') it = { ...it, ...got };
        continue;
      }
      // Retry · Busy · NeedUpload(올리다 멈춤) — 기다렸다 다시 등록(게이트웨이가 이미 있는 것은 그대로 돌려준다)
      await new Promise((r) => setTimeout(r, Math.min(60, Math.max(3, Number(it?.retryAfter) || 10)) * 1000));
      j = await register();
      it = j?.ok && Array.isArray(j.items) ? j.items[0] : it;
    }
    return { ok: false, message: '영상 인증이 3분 안에 끝나지 않았어요 — 잠시 뒤 재생성해 주세요.' };
  })().then((r) => {
    // '취소됨'(자동 인증 카드를 사람이 멈춤)은 영상 탓이 아니라 실패로 남기지 않는다.
    if (r.ok) videoFailed.delete(key);
    else if (r.message !== '취소됨') videoFailed.set(key, r.message);
    return r;
  }, (e) => { videoFailed.set(key, String(e?.message || e)); throw e; })
    .finally(() => { videoInFlight.delete(key); bumpVideo(); });
  videoFailed.delete(key);
  videoInFlight.set(key, p);
  bumpVideo();
  return p;
}

// ── 보관함 정리로 지워진 에셋 알아차리기(26.11.24~, 사용자 "이것도 대처해두면 좋겠네 앱에서 안 꼬이게 잘") ──
// 게이트웨이가 보관함을 정리하면서 지운 에셋을 프로젝트마다 적어 둔다(/v1/assets/evicted). 이 PC 는 켤 때 한 번 · 켜 둔 동안 1시간마다(26.11.25~ — 10분 · 창 돌아올 때였는데 워커를 하루 수백 번 불렀다. 늦게 알아도 보내기의 자동 복구가 고치고 배지만 늦다)
// '마지막으로 본 뒤 지워진 것' 만 묻고(게이트웨이 저장소 읽기 한두 번), 그 id 를 쓰던 라이브러리 사진을 '지워짐'(failed + gone)으로 바꾼다 —
// 칸 · 카드가 회색 '지워짐' 을 그린다. 다시 등록은 바로 하지 않는다: 쓸 때(보내기가 막히면 자동 인증) · 방패를 누를 때만. 지워지자마자 다시 채우면
// 보관함을 두고 정리와 등록이 서로 반복한다.
// 안 꼬이게: 그 사이 다시 등록돼 id 가 바뀐 사진은 건드리지 않는다(지금 id 가 지운 id 와 같을 때만) · 처리 중인 것도 건드리지 않는다 ·
// 등록한 적이 없는 PC 는 묻지 않는다(호출 0) · 같은 것을 두 번 받아도 같은 결과(이미 gone 이면 그대로). 콘솔 삭제 · 유료 권리 만료(15일 뒤)는
// 이 기록에 없다 — 라이브러리를 열 때(6시간에 한 번)의 확인과 보낼 때의 'not found' 자동 복구가 잡는다.
const EVICT_SINCE_KEY = (scope: string) => `seedance-bp-evicted-since:${scope}`;
let evictInFlight: Promise<number> | null = null;
let lastEvictCheck = 0;
export function checkEvicted(force = false): Promise<number> {
  if (PERSONAL) return Promise.resolve(0);
  if (!force && Date.now() - lastEvictCheck < 60_000) return Promise.resolve(0);   // 겹쳐 불러도 1분에 한 번
  if (evictInFlight) return evictInFlight;
  lastEvictCheck = Date.now();
  evictInFlight = evictNow().catch(() => 0).finally(() => { evictInFlight = null; });
  return evictInFlight;
}
async function evictNow(): Promise<number> {
  const has = videoAssets.size > 0 || useAppStore.getState().elementAssets.some((a) => a.images.some((im) => Object.values(im.bpAssets || {}).some((e) => e?.id)));
  if (!has) return 0;
  const sc = await bpScope();
  if (!sc.project) return 0;
  const scope = sc.project;
  let since = 0;
  try { since = Number(localStorage.getItem(EVICT_SINCE_KEY(scope))) || 0; } catch { /* 처음부터 */ }
  const r = await fetch('/api/bp-assets/evicted', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since }), signal: AbortSignal.timeout(30000) }).catch(() => null);
  const j: any = r ? await r.json().catch(() => null) : null;
  if (!j?.ok || !Array.isArray(j.items)) return 0;
  const project = typeof j.project === 'string' && j.project ? j.project : scope;
  const ids = new Set<string>(j.items.map((it: any) => it?.id).filter((x: unknown): x is string => typeof x === 'string' && !!x));
  let n = 0;
  if (ids.size) {
    const now = Date.now();
    const patches: { elementId: string; imageId: string; scope: string; entry: import('../store').BpAssetEntry }[] = [];
    for (const a of useAppStore.getState().elementAssets) for (const im of a.images) {
      const e = bpEntryOf(im, project);
      if (e?.id && ids.has(e.id) && e.status === 'active') {
        patches.push({ elementId: a.id, imageId: im.id, scope: project, entry: { id: e.id, status: 'failed', gone: true, error: '보관함 정리로 BytePlus 에서 지워졌어요 — 쓸 때 자동으로 다시 등록돼요', at: now } });
      }
    }
    if (patches.length) useAppStore.getState().setElementImageBp(patches);
    for (const id of ids) forgetVideoAsset(id);
    n = patches.length;
  }
  if (typeof j.until === 'number' && j.until > since) { try { localStorage.setItem(EVICT_SINCE_KEY(project), String(j.until)); } catch { /* 다음에 같은 것을 다시 받아도 같은 결과 */ } }
  return n;
}
/** 켤 때(조금 뒤) 한 번 · 1시간마다 — App 이 한 번 건다. 개인판은 아무것도 안 한다. 돌려준 함수로 끈다. */
export function startEvictWatch(): () => void {
  if (PERSONAL) return () => {};
  const run = () => { void checkEvicted(); };
  const t0 = setTimeout(run, 8000);
  const iv = setInterval(run, 60 * 60_000);
  return () => { clearTimeout(t0); clearInterval(iv); };
}
