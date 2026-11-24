// BytePlus 에셋 자동 등록(26.11.2301~) — 어셋 라이브러리 인물 사진 → BytePlus 비공개 에셋(asset://).
//
// 왜: Seedance 2.0 · 2.5 는 실사 얼굴이 든 레퍼런스(실존 인물처럼 보이는 AI 인물 포함)를 막는다(PrivacyInformation). 비공개 가상 인물
// 라이브러리에 등록해 Active 가 된 에셋은 asset://id 로 막힘 없이 쓴다(HANDOFF §5-8). 사용자 2026-11-23: "어셋 올리면 삥글삥글 돌더니
// 인증 완료! 이케 뜸. 그렇게 한 번 해놓으면 쭉 쓸 수 있고".
// 길: 화면 → 서버 /api/bp-assets/*(원본을 R2 서명 주소로) → 게이트웨이 /v1/assets/*(AK/SK 서명 · 팀 키의 BytePlus 프로젝트 안에) → BytePlus.
// 에셋은 BytePlus 프로젝트마다 따로 — 사진마다 bpAssets[프로젝트 이름] 에 적는다. 다른 팀 키로 켜면 그 프로젝트에 한 번 더 등록한다.
// 등록은 BytePlus 대기열(시간 보장 없음)이라 처리 중이면 몇 초마다 상태를 본다. 등록 한도(지금 무료 등급 분당 3)에 걸리면 'retry' 로 두고 다시.
import { checkSame, sameKeys } from './same-pixels';
import { useAppStore, contentKey, type ElementAsset, type ElementImage, type BpAssetEntry } from '../store';
import { PERSONAL } from './edition';

type Scope = { project: string | null; code?: string; error?: string };
let scopeCache: { project: string; at: number } | null = null;
let scopeMiss: (Scope & { at: number }) | null = null;   // 못 찾은 답도 잠깐 기억 — 그동안 라이브러리 열기 · 보내기마다 다시 묻지 않게
let scopeInFlight: Promise<Scope> | null = null;
const SCOPE_TTL_MS = 10 * 60 * 1000;
const SCOPE_MISS_MS = 90 * 1000;

/** 이 PC 팀 키의 BytePlus 프로젝트 이름(게이트웨이가 찾아 준다). 10분 기억 · 못 찾은 답은 90초 기억(사람이 누른 등록은 그 기억을 건너뛴다). */
export async function bpScope(opts: { ignoreMiss?: boolean } = {}): Promise<Scope> {
  if (PERSONAL) return { project: null, code: 'personal_edition' };
  if (scopeCache && Date.now() - scopeCache.at < SCOPE_TTL_MS) return { project: scopeCache.project };
  if (!opts.ignoreMiss && scopeMiss && Date.now() - scopeMiss.at < SCOPE_MISS_MS) return { project: null, code: scopeMiss.code, error: scopeMiss.error };
  if (scopeInFlight) return scopeInFlight;
  scopeInFlight = (async (): Promise<Scope> => {
    let s: Scope;
    try {
      const r = await fetch('/api/bp-assets/project', { signal: AbortSignal.timeout(45000) });
      const j: any = await r.json().catch(() => ({}));
      s = j?.ok && typeof j.project === 'string' && j.project ? { project: j.project } : { project: null, code: j?.code || `http_${r.status}`, error: j?.error };
    } catch (e: any) {
      s = { project: null, code: 'offline', error: String(e?.message || e) };
    }
    if (s.project) { scopeCache = { project: s.project, at: Date.now() }; scopeMiss = null; }
    else scopeMiss = { ...s, at: Date.now() };
    return s;
  })().finally(() => { scopeInFlight = null; });
  return scopeInFlight;
}
/** 이미 알고 있는 프로젝트 이름(묻지 않는다) — 화면 그리기용. */
export const knownBpScope = (): string | null => (scopeCache ? scopeCache.project : null);

export const bpEntryOf = (img: ElementImage, scope: string | null): BpAssetEntry | undefined => (scope ? img.bpAssets?.[scope] : undefined);
/** 이 프로젝트에서 Active 인 사진이면 asset://id, 아니면 null(그때는 예전처럼 사진을 올려 보낸다). */
export const assetUrlFor = (img: ElementImage, scope: string | null): string | null => {
  const e = bpEntryOf(img, scope);
  return e && e.status === 'active' && e.id ? `asset://${e.id}` : null;
};

export type BpCardState = 'none' | 'processing' | 'active' | 'failed' | 'partial' | 'gone';
/** 카드 배지 — 지금 프로젝트에서 이 인물 사진들의 상태. gone(26.11.24~) = BytePlus 에서 지워짐(보관함 정리 · 만료) — 쓸 때 다시 등록된다 */
export function bpCardState(a: ElementAsset, scope: string | null): BpCardState {
  if (!scope || !a.images.length) return 'none';
  const es = a.images.map((im) => bpEntryOf(im, scope));
  const st = es.map((e) => e?.status);
  if (st.every((s) => s === 'active')) return 'active';
  if (st.some((s) => s === 'processing' || s === 'retry')) return 'processing';
  if (es.some((e) => e?.status === 'failed' && !e.gone)) return 'failed';
  if (es.some((e) => e?.gone)) return 'gone';
  if (st.some((s) => s === 'active')) return 'partial';
  return 'none';
}
export const bpCardError = (a: ElementAsset, scope: string | null): string =>
  a.images.map((im) => bpEntryOf(im, scope)).find((e) => e?.status === 'failed' && !e.gone)?.error || '';

// 다시 해 볼 때까지 — 한도(Retry)는 25초부터 두 배씩 5분까지, 다른 PC 가 같은 사진을 등록 중(Busy)이면 10초. 게이트웨이가 retryAfter 를 주면 그보다 짧지 않게.
// 두 가지를 따로 센다:
//   tries — 기다림을 늘리는 데만 쓴다(한도 · Busy 포함). 끝은 없다 — 한도(분당 3)는 계정 전체가 나눠 쓰니 많이 몰리면 오래 기다리는 게 맞다.
//   fails — 이유가 붙은 실패(게이트웨이 · 업로드 · 원본 없음 · 오프라인)만. MAX_FAILS 번 넘으면 '등록 실패' + 마지막 이유
//           (끝없이 '등록 중…' 으로 숨지 않게, 사람이 다시 누르면 처음부터). 속도 한도 · Busy 는 이유가 없어 세지 않는다(리뷰 11/23 —
//           인물 다섯 × 열 장을 한꺼번에 누르면 한도 대기만으로 뒤쪽이 '실패' 가 됐다).
const MAX_FAILS = 8;
const retryDelay = (status: string, tries: number, retryAfterSec?: number) =>
  Math.max(status === 'Busy' ? 10_000 : Math.min(25_000 * 2 ** Math.max(0, tries - 1), 5 * 60_000), (Number(retryAfterSec) || 0) * 1000);
const errText = (e: any): string => (e ? String(e.message || e.code || e).slice(0, 300) : '');
const toEntry = (it: any, prev?: BpAssetEntry): BpAssetEntry => {
  const now = Date.now();
  const st = it?.status;
  // NeedUpload 는 서버가 올려서 다시 묻는 중간 단계라 화면까지 오면 안 되지만, 오면 다시 할 것으로 둔다.
  if (st === 'Retry' || st === 'Busy' || st === 'NeedUpload') {
    const wasRetry = prev?.status === 'retry';
    const tries = (wasRetry ? prev!.tries || 0 : 0) + 1;
    const thisErr = errText(it?.error);
    const fails = (wasRetry ? prev!.fails || 0 : 0) + (thisErr ? 1 : 0);
    const error = thisErr || (wasRetry ? prev!.error || '' : '');
    if (fails > MAX_FAILS) return { status: 'failed', at: now, error: `여러 번 다시 해도 안 됐어요${error ? ` — ${error}` : ''}`.slice(0, 300) };
    return { status: 'retry', at: now, tries, next: now + retryDelay(st, tries, it?.retryAfter), ...(fails ? { fails } : {}), ...(error ? { error } : {}) };
  }
  return {
    ...(typeof it?.id === 'string' ? { id: it.id } : {}),
    status: st === 'Active' ? 'active' : st === 'Failed' || st === 'NotFound' ? 'failed' : 'processing',
    ...(st === 'NotFound' ? { error: '에셋이 BytePlus 에서 없어졌어요(보관함 정리 · 만료 · 다른 프로젝트) — 쓸 때 자동으로 다시 등록돼요', gone: true }
      : it?.error ? { error: errText(it.error) } : {}),
    at: now,
  };
};
/** 시험용(격리 하네스 t-retry) — 게이트웨이 답 하나 → 사진 상태. 앱 안에서는 쓰지 않는다. */
export const toBpEntry = toEntry;
/** 상태 확인(status)의 답 중 화면을 바꾸는 것만 — 처리 중 · 일시 오류(Retry) · 모르는 이름은 '바뀐 것 없음'(id 를 지우지 않는다). */
const settled = (st: unknown) => st === 'Active' || st === 'Failed' || st === 'NotFound';

/** 보내기용 — 프로젝트 이름을 아는 만큼만 기다린다(기본 3초). 모르면 null → 그때는 예전처럼 사진을 올려 보낸다(생성은 등록을 기다리지 않는다). */
export async function bpScopeQuick(ms = 3000): Promise<string | null> {
  const known = knownBpScope();
  if (known) return known;
  if (PERSONAL) return null;
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([bpScope().then((s) => s.project), new Promise<null>((r) => { t = setTimeout(() => r(null), ms); })]).finally(() => clearTimeout(t));
}
/** 이 사진들 중 어느 프로젝트에서든 '인증 완료' 가 있나 — 있을 때만 보내기가 프로젝트 이름을 기다린다. */
export const hasActiveBp = (imgs: ElementImage[]): boolean =>
  imgs.some((im) => Object.values(im.bpAssets || {}).some((e) => e?.status === 'active' && !!e.id));

// ── 패널 · 프레임 칸에 그대로 넣은 사진도 '인증 완료' 면 에셋으로(26.11.24~) ──
// 라이브러리 사진과 바이트가 같으면 같은 사진이다 — 캐시 id 와 라이브러리 id 의 앞 12자리가 내용 md5 다(store contentKey). 그래서 사람이
// 인증한 사진을 @이름 으로 부르지 않고 첫 · 끝 프레임 칸이나 레퍼런스 칸에 끌어 넣어도 한 번 인증한 그대로 에셋으로 나간다.
// 실측 11/24: 에셋을 첫 프레임(role 없이 · first_frame) · 끝 프레임(last_frame, 항목 순서를 뒤집어도)으로 2.0 Fast · 2.5 Flash 모두 받았다.
// 같은 사진이 인물 여럿에 들어 있으면 이 프로젝트에서 Active 인 아무 것 — 게이트웨이가 같은 바이트를 에셋 하나로 묶으니 id 도 같다.
// 찾는 표는 라이브러리 배열마다 한 번 만든다(스토어는 바꿀 때 새 배열 — 화면이 칸마다 불러도 다시 훑지 않는다).
const keyIndex = new WeakMap<ElementAsset[], Map<string, ElementImage[]>>();
function imagesByKey(els: ElementAsset[]): Map<string, ElementImage[]> {
  let m = keyIndex.get(els);
  if (!m) {
    m = new Map();
    for (const a of els) for (const im of a.images) {
      for (const k of new Set([contentKey(im.libId), contentKey(im.cacheId)])) {
        if (!k) continue;
        const list = m.get(k);
        if (list) list.push(im); else m.set(k, [im]);
      }
    }
    keyIndex.set(els, m);
  }
  return m;
}
/** 이 내용 key 의 라이브러리 사진 + 화소가 전부 같다고 확인된 사진(lib/same-pixels, 26.11.25~ — 다시 저장 · 복사로 바이트만 달라진 것). 같은 바이트가 먼저. */
function imagesFor(k: string, els: ElementAsset[]): ElementImage[] {
  const m = imagesByKey(els), own = m.get(k) || [];
  const same = sameKeys(k).flatMap((x) => m.get(x) || []);
  return same.length ? [...own, ...same] : own;
}
/** 등록해 본(어느 프로젝트든 기록이 있는) 라이브러리 사진 — 화소 비교의 상대. 라이브러리 배열마다 한 번 만든다. */
const regIndex = new WeakMap<ElementAsset[], ElementImage[]>();
export function registeredPhotos(els: ElementAsset[] = useAppStore.getState().elementAssets): ElementImage[] {
  let l = regIndex.get(els);
  if (!l) { l = els.flatMap((a) => a.images).filter((im) => !!im.libId && Object.keys(im.bpAssets || {}).length > 0); regIndex.set(els, l); }
  return l;
}
/** 이 칸 사진과 화소가 전부 같은 등록 사진이 있는지 본다(있으면 그 뒤 위 찾기가 안다). 등록한 것이 없으면 바로 끝. */
export const checkSamePhoto = (cacheId: string | undefined): Promise<boolean> =>
  (PERSONAL ? Promise.resolve(false) : checkSame(cacheId, registeredPhotos()));
/** 라이브러리 사진 im 이 이 칸 사진(캐시 id)인가 — 바이트가 같거나 화소가 전부 같거나. */
export function isPhotoOf(im: ElementImage, cacheId: string | undefined): boolean {
  const k = contentKey(cacheId);
  if (!k) return false;
  const ks = new Set([k, ...sameKeys(k)]);
  return [contentKey(im.libId), contentKey(im.cacheId)].some((x) => !!x && ks.has(x));
}
/** 패널 레퍼런스(캐시 id)와 같은 바이트의 라이브러리 사진이 이 프로젝트에서 '인증 완료' 면 asset://id, 아니면 null(그때는 사진을 올려 보낸다). */
export function certifiedAssetUrl(cacheId: string | undefined, scope: string | null, els: ElementAsset[] = useAppStore.getState().elementAssets): string | null {
  const k = contentKey(cacheId);
  if (!k || !scope) return null;
  for (const im of imagesFor(k, els)) {
    const u = assetUrlFor(im, scope);
    if (u) return u;
  }
  return null;
}
/** 이 패널 사진과 같은 바이트가 어느 프로젝트에서든 '인증 완료' 인가 — 그럴 때만 보내기가 프로젝트 이름을 기다린다. */
export function certifiedAnywhere(cacheId: string | undefined, els: ElementAsset[] = useAppStore.getState().elementAssets): boolean {
  const k = contentKey(cacheId);
  return !!k && hasActiveBp(imagesFor(k, els));
}

// ── 레퍼런스 칸의 방패(26.11.24~, 사용자 "레퍼런스 칸에도 방패 넣어줘 그게 편할 거 같음") ──
// 칸에서 누르면 그 사진의 라이브러리 인물 카드(같은 바이트가 이미 있으면 그 카드, 없으면 새로)를 registerElement 로 등록한다 —
// 등록 길은 라이브러리 방패와 하나다(중복 · 한도 · 다시 하기 규칙이 그대로). 칸은 아래 두 함수로 상태만 그린다.
/** 칸 사진과 같은 바이트의 라이브러리 인물(처음 찾은 것). 없으면 undefined — 방패가 새 카드를 만든다. */
export function libraryElementFor(cacheId: string | undefined, els: ElementAsset[] = useAppStore.getState().elementAssets): ElementAsset | undefined {
  const k = contentKey(cacheId);
  if (!k) return undefined;
  return els.find((a) => a.images.some((im) => contentKey(im.libId) === k || contentKey(im.cacheId) === k))
    || (sameKeys(k).length ? els.find((a) => a.images.some((im) => isPhotoOf(im, cacheId))) : undefined);
}
/** 칸에 그릴 등록 상태 — 'processing' · 'failed|이유' · 'gone'(BytePlus 에서 지워짐 — 쓸 때 다시 등록) · ''(없음). 인증 완료는 certifiedAssetUrl 이 본다.
 *  글자로 돌려 셀렉터가 같은 값이면 다시 그리지 않게. */
export function panelBpState(cacheId: string | undefined, scope: string | null, els: ElementAsset[] = useAppStore.getState().elementAssets): string {
  const k = contentKey(cacheId);
  if (!k || !scope) return '';
  const es = imagesFor(k, els).map((im) => bpEntryOf(im, scope)).filter((e): e is BpAssetEntry => !!e);
  if (es.some((e) => e.status === 'processing' || e.status === 'retry')) return 'processing';
  const f = es.find((e) => e.status === 'failed' && !e.gone);
  if (f) return `failed|${f.error || ''}`;
  return es.some((e) => e.gone) ? 'gone' : '';
}

/** 게이트웨이 · 서버 거절 → 사람 말 */
export function bpErrorText(j: any): string {
  const code = j?.code || '';
  if (code === 'personal_edition') return '개인판은 BytePlus 에셋 등록을 쓰지 않아요.';
  if (code === 'gateway_off') return '게이트웨이에 연결된 실행이 아니에요(설치본에서만 돼요).';
  if (code === 'not_enrolled' || code === 'revoked') return '이 PC 가 게이트웨이에 등록돼 있지 않거나 끊겼어요 — 팀 bat 을 확인해 주세요.';
  if (code === 'not_configured') return '게이트웨이에 BytePlus 에셋 키가 아직 없어요 — 관리자에게 알려 주세요.';
  if (code === 'no_project') return '이 팀 키가 속한 BytePlus 프로젝트를 찾지 못했어요 — 관리자에게 알려 주세요.';
  if (code === 'ambiguous_project') return '이 팀 키가 BytePlus 프로젝트 여러 곳에 걸려 있어요 — 관리자에게 알려 주세요.';
  if (code === 'rate_limited') return '등록 한도에 걸렸어요 — 잠시 뒤 저절로 다시 해요.';
  if (code === 'offline') return '게이트웨이에 닿지 못했어요 — 인터넷을 확인해 주세요.';
  return String(j?.error || code || '알 수 없는 오류').slice(0, 300);
}

const inFlightEls = new Set<string>();
/**
 * 이 인물 사진들을 지금 프로젝트에 등록한다. 결과를 사람 말로 돌려준다.
 * - 사람이 누른 등록: Active · 처리 중이 아닌 것 모두(실패 · 대기 · 아직 안 함).
 * - 저절로 다시(onlyRetry, 상태 확인이 부름): '다시 할 것'(retry) 중 시각이 된 것만 — 실패한 사진은 사람이 누를 때만 다시 만든다
 *   (저절로 실패까지 다시 보내면 계속 거절되는 사진이 25초마다 에셋을 새로 만든다).
 * 같은 원본(libId)이 한 인물에 두 장 있으면 한 번만 보내고 답을 두 장 모두에 붙인다(서버는 겹친 libId 를 거절한다).
 */
export async function registerElement(elementId: string, opts: { onlyRetry?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  if (inFlightEls.has(elementId)) return { ok: true, message: '등록 중이에요' };
  inFlightEls.add(elementId);
  try {
    const sc = await bpScope({ ignoreMiss: !opts.onlyRetry });
    if (!sc.project) return { ok: false, message: bpErrorText(sc) };
    const scope = sc.project;
    const a = useAppStore.getState().elementAssets.find((x) => x.id === elementId);
    if (!a) return { ok: false, message: '어셋이 사라졌어요' };
    const now = Date.now();
    const todo = a.images.filter((im) => {
      const e = bpEntryOf(im, scope);
      return opts.onlyRetry ? e?.status === 'retry' && now >= (e.next ?? 0) : e?.status !== 'active' && e?.status !== 'processing';
    });
    if (!todo.length) return { ok: true, message: opts.onlyRetry ? '다시 할 것이 없어요' : '이미 등록됐어요' };
    const withLib = todo.filter((im) => im.libId);
    if (!withLib.length) return { ok: false, message: '원본이 아직 라이브러리로 옮겨지지 않았어요 — 잠시 뒤 다시 해 주세요.' };
    const libs = [...new Set(withLib.map((im) => im.libId!))].slice(0, 10);
    const send = withLib.filter((im) => libs.includes(im.libId!));
    const name = (a.name || '인물').slice(0, 64);
    let j: any = {};
    try {
      const r = await fetch('/api/bp-assets/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(180000),
        body: JSON.stringify({ group: { key: a.id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'element', name },
          items: libs.map((libId, i) => ({ libId, name: `${name} ${i + 1}`.slice(0, 64) })) }),
      });
      j = await r.json().catch(() => ({}));
    } catch (e: any) { j = { code: 'offline', error: String(e?.message || e) }; }
    if (!j?.ok || !Array.isArray(j.items)) {
      // 한 장도 못 넣었다. 한도(rate_limited)거나 저절로 다시 하던 중이면 '다시 할 것' 으로 두고 늘려 가며 기다린다(횟수를 넘기면 실패로) —
      // 그대로 두면 시각이 지난 retry 가 2초마다 다시 불린다. 사람이 누른 등록이 다른 이유로 실패하면 상태는 그대로(이유는 알림으로).
      if (j?.code === 'rate_limited' || opts.onlyRetry) {
        const why = j?.code === 'rate_limited' ? { status: 'Retry', retryAfter: j.retryAfter } : { status: 'Retry', error: { message: bpErrorText(j) } };
        const cur = useAppStore.getState().elementAssets.find((x) => x.id === elementId);
        useAppStore.getState().setElementImageBp(send.flatMap((im) => {
          const live = cur?.images.find((x) => x.id === im.id);
          return live ? [{ elementId: a.id, imageId: im.id, scope, entry: toEntry(why, bpEntryOf(live, scope)) }] : [];
        }));
        kickBpPoll(10000);
      }
      return { ok: false, message: bpErrorText(j) };
    }
    const project: string = typeof j.project === 'string' && j.project ? j.project : scope;
    if (project !== scope) scopeCache = { project, at: Date.now() };
    const byKey = new Map<string, any>(j.items.map((it: any) => [it?.key, it]));
    // 지금 스토어의 사진(편집 · 지우기가 그 사이 있었을 수 있다)에 붙인다 — 없어진 사진은 setElementImageBp 가 건너뛴다.
    const cur = useAppStore.getState().elementAssets.find((x) => x.id === elementId);
    const patches = send.flatMap((im) => {
      // 답에 빠진 사진은 '다시 할 것'(늘려 가며) — 그대로 두면 시각이 지난 retry 가 2초마다 다시 불린다
      const it = byKey.get(im.libId!) || { status: 'Retry', error: { message: '게이트웨이 답에 이 사진이 없었어요' } };
      const live = cur?.images.find((x) => x.id === im.id);
      return live ? [{ elementId: a.id, imageId: im.id, scope: project, entry: toEntry(it, bpEntryOf(live, project)) }] : [];
    });
    useAppStore.getState().setElementImageBp(patches);
    kickBpPoll(4000);
    const n = (s: string) => patches.filter((p) => p.entry.status === s).length;
    const parts = [n('active') && `완료 ${n('active')}`, n('processing') && `처리 중 ${n('processing')}`, n('retry') && `잠시 뒤 다시 ${n('retry')}`, n('failed') && `실패 ${n('failed')}`].filter(Boolean);
    const firstErr = patches.find((p) => p.entry.status === 'failed')?.entry.error;
    return { ok: !n('failed'), message: `BytePlus 에셋 등록(${project}): ${parts.join(' · ') || '받은 결과 없음'}${firstErr ? ` — ${firstErr}` : ''}` };
  } finally { inFlightEls.delete(elementId); }
}

// ── '인증 완료' 가 아직 살아 있나(어셋 라이브러리를 열 때 6시간에 한 번) ──
// BytePlus 에서 지워진 에셋(유료 권리가 끝나고 15일 뒤 · 콘솔에서 지움)을 계속 asset:// 로 보내면 생성이 실패한다. 없어졌으면 '등록 실패'
// 로 바꿔 카드에 보이게 한다 — 다시 등록하면 게이트웨이가 확인 뒤 새로 만든다. 일시 오류(Retry)는 그대로 둔다(멀쩡한 걸 버리지 않게).
let lastVerify = 0;
let verifyInFlight: Promise<number> | null = null;   // 겹쳐 불러도 하나만(라이브러리를 열 때 효과가 두 번 돌 수 있다 — 11/23 시험에서 status 2번)
export function verifyBpAssets(force = false): Promise<number> {
  if (PERSONAL || (!force && Date.now() - lastVerify < 6 * 60 * 60 * 1000)) return Promise.resolve(0);   // 6시간에 한 번 — 권리 만료 · 콘솔 삭제는 드물다
  if (verifyInFlight) return verifyInFlight;
  lastVerify = Date.now();   // 시작할 때 적는다 — 기다리는 사이 또 불려도 다시 안 돈다(못 물어봤으면 아래에서 되돌린다)
  verifyInFlight = verifyNow().finally(() => { verifyInFlight = null; });
  return verifyInFlight;
}
async function verifyNow(): Promise<number> {
  const sc = await bpScope();
  if (!sc.project) { lastVerify = 0; return 0; }
  const scope = sc.project;
  const act: { elementId: string; imageId: string; id: string }[] = [];
  for (const a of useAppStore.getState().elementAssets) for (const im of a.images) {
    const e = bpEntryOf(im, scope);
    if (e?.status === 'active' && e.id) act.push({ elementId: a.id, imageId: im.id, id: e.id });
  }
  let changed = 0;
  for (let i = 0; i < act.length; i += 20) {
    const chunk = act.slice(i, i + 20);
    try {
      const r = await fetch('/api/bp-assets/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: chunk.map((p) => p.id) }), signal: AbortSignal.timeout(60000) });
      const j: any = await r.json().catch(() => ({}));
      if (!j?.ok || !Array.isArray(j.items)) continue;
      const byId = new Map<string, any>(j.items.map((it: any) => [it?.id, it]));
      const nowEls = useAppStore.getState().elementAssets;
      const patches = chunk.flatMap((p) => {
        const it = byId.get(p.id);
        if (!it || (it.status !== 'NotFound' && it.status !== 'Failed')) return [];
        const cur = nowEls.find((a) => a.id === p.elementId)?.images.find((im) => im.id === p.imageId);
        const e = cur && bpEntryOf(cur, scope);
        if (!e || e.id !== p.id || e.status !== 'active') return [];
        return [{ elementId: p.elementId, imageId: p.imageId, scope, entry: toEntry(it) }];
      });
      changed += patches.length;
      if (patches.length) useAppStore.getState().setElementImageBp(patches);
    } catch { /* 다음에 */ }
  }
  return changed;
}

// ── 상태 확인 — 처리 중이 있으면 몇 초마다, 한도로 밀린 것은 25초 뒤 다시 등록 ──
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollDue = 0;       // 잡아 둔 확인 시각 — 더 이른 확인이 오면 다시 잡는다(늦은 재시도 타이머가 새 등록의 확인을 몇 분 밀지 않게)
let polling = false;   // 확인은 한 번에 하나 — 겹치면 끝난 뒤로 미룬다
export function kickBpPoll(delay = 4000): void {
  if (PERSONAL) return;
  const due = Date.now() + delay;
  if (pollTimer) {
    if (due >= pollDue) return;
    clearTimeout(pollTimer);
  }
  pollDue = due;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (polling) { kickBpPoll(2000); return; }
    polling = true;
    void pollOnce().catch(() => {}).finally(() => { polling = false; });
  }, delay);
}
// 처리 중인 것을 얼마나 자주 볼까 — 보통 몇 초 만에 끝난다(실측 6초). 오래 걸리면(대기열이 밀림) 점점 드물게.
const processingWait = (e: BpAssetEntry) => { const age = Date.now() - e.at; return age < 2 * 60_000 ? 5_000 : age < 30 * 60_000 ? 30_000 : 5 * 60_000; };
let scopeFailStreak = 0;
async function pollOnce(): Promise<void> {
  const sc = await bpScope();
  if (!sc.project) {
    // 프로젝트 이름을 잠깐 못 받았다(절전에서 깸 · 와이파이 · 게이트웨이 5xx). 처리 중 · 다시 할 것이 남아 있으면 확인을 접지 말고 늘려 가며
    // 다시 잡는다(1.5분 → 3분 → … 15분) — 그냥 끝내면 카드가 '등록 중…' 에 멈춘 채 다시 누를 단추도 없다(리뷰 11/23).
    const left = useAppStore.getState().elementAssets.some((a) => a.images.some((im) => Object.values(im.bpAssets || {}).some((e) => e?.status === 'processing' || e?.status === 'retry')));
    if (left) kickBpPoll(Math.min((SCOPE_MISS_MS + 1000) * 2 ** scopeFailStreak++, 15 * 60_000));
    return;
  }
  scopeFailStreak = 0;
  const scope = sc.project;
  const els = useAppStore.getState().elementAssets;
  const pending: { elementId: string; imageId: string; id: string }[] = [];
  const retryEls = new Set<string>();
  for (const a of els) for (const im of a.images) {
    const e = bpEntryOf(im, scope);
    if (e?.status === 'processing' && e.id) pending.push({ elementId: a.id, imageId: im.id, id: e.id });
    if (e?.status === 'retry' && Date.now() >= (e.next ?? 0)) retryEls.add(a.id);
  }
  for (let i = 0; i < pending.length; i += 20) {
    const chunk = pending.slice(i, i + 20);
    try {
      const r = await fetch('/api/bp-assets/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: chunk.map((p) => p.id) }), signal: AbortSignal.timeout(60000) });
      const j: any = await r.json().catch(() => ({}));
      if (!j?.ok || !Array.isArray(j.items)) continue;
      const byId = new Map<string, any>(j.items.map((it: any) => [it?.id, it]));
      const nowEls = useAppStore.getState().elementAssets;
      const patches = chunk.flatMap((p) => {
        const it = byId.get(p.id);
        if (!it || !settled(it.status)) return [];   // 처리 중 · 일시 오류(Retry) — 그대로 둔다(id 를 지우지 않는다)
        // 묻는 사이 그 사진이 다시 등록돼 다른 에셋을 가리키면(실패 → 새로 만듦) 옛 답으로 덮지 않는다
        const cur = nowEls.find((a) => a.id === p.elementId)?.images.find((im) => im.id === p.imageId);
        const e = cur && bpEntryOf(cur, scope);
        if (!e || e.id !== p.id || e.status !== 'processing') return [];
        return [{ elementId: p.elementId, imageId: p.imageId, scope, entry: toEntry(it) }];
      });
      if (patches.length) useAppStore.getState().setElementImageBp(patches);
    } catch { /* 다음에 */ }
  }
  for (const id of retryEls) await registerElement(id, { onlyRetry: true });   // 하나씩 — 서버도 한 번에 하나만 등록한다
  // 다음 확인: 처리 중이면 5초(오래되면 점점 드물게), 다시 할 것만 남았으면 가장 이른 시각까지
  let wait = Infinity;
  for (const a of useAppStore.getState().elementAssets) for (const im of a.images) {
    const e = bpEntryOf(im, scope);
    if (e?.status === 'processing' && e.id) wait = Math.min(wait, processingWait(e));
    else if (e?.status === 'retry') wait = Math.min(wait, Math.max(2000, (e.next ?? 0) - Date.now()));
  }
  if (wait !== Infinity) kickBpPoll(wait);
}
