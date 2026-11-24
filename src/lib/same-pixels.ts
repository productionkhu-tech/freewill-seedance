// 화소가 전부 같은 사진이면 인증을 이어 준다 — 파일이 새로 포장됐거나 이름이 달라도(26.11.25~, 사용자 "원래 썼던 에셋을 복사해서 다시 썼어 … 어쩔 수 없는
// 거임?" → "무거워지지 않는다면 넣어도" → "드래그앤드랍할 수도 있잖아 로컬에서 변수가 많음").
// 앱은 내용 md5(contentKey)로 같은 사진을 안다. 클립보드 · 다시 저장을 거치면 그림은 그대로인데 파일이 달라져 다른 사진으로 보고 보관함 칸 · 카드를 하나 더 썼다.
// 여기는 '이 내용 key 들은 화소가 같다' 만 안다(sameKeys). 파일은 건드리지 않는다 — 칸의 이름 · 원본 폴더는 넣은 파일 그대로, 보낼 때 에셋만 같은 사진의 것.
// 점 하나의 값이 1 만 달라도 다른 사진이다(고친 사진을 원본으로 보내지 않는다). 비교는 파일 속 값이 아니라 '화면에 보이는 색'(캔버스 — 색 프로필 · 회전 적용 뒤).
// 움직이는 그림(gif · APNG · 움직이는 webp)은 첫 장면만 같을 수 있어 아예 빼고, 크기를 못 읽는 형식도 뺀다.
// ★ 이 PC 에 아무것도 남기지 않는다(사용자 11/25 "개인 pc에 이거 남기는 건 비추") — 앱이 켜져 있는 동안의 기억뿐. 다시 켜면 라이브러리의 등록 사진에서 다시 만든다.
// 가볍게: 등록한 사진이 없으면 아무것도 안 한다 → 파일 머리만 읽어 크기를 본다 → 크기가 같을 때만 → 작은 미리보기가 비슷할 때만 원본을 풀어 지문(사진마다 한 번).
// UI · 스토어를 들이지 말 것 — 등록한 사진 목록은 부르는 쪽(bp-assets)이 준다.
import { imageDims } from './asset-image-spec';

export type Registered = { libId?: string; thumbnailUrl?: string };
const MAX_PIXELS = 40_000_000;      // 이보다 크면 재지 않는다(BytePlus 에셋 규격 6000px 보다 큼)
const STRIP = 256;                  // 이 줄 수씩 나눠 — 한 번에 하면 큰 사진에서 화면이 멈칫한다
const HEAD = 4 * 1024, HEAD_MORE = 256 * 1024;   // 크기를 읽을 머리(JPEG 는 EXIF · ICC 뒤에 크기가 온다)
const GRID = 16, FAR = 14;          // 미리보기 16×16 의 평균 밝기 차가 이보다 크면 다른 사진(넉넉하게 — 확실히 다른 것만 거른다)
const MAX_REG = 1000;               // 비교할 등록 사진 수(최근 것부터)

const keyOf = (id: string | undefined) => /^([0-9a-f]{12})/.exec(id || '')?.[1] || '';

const table = new Map<string, string>();                 // key → 지문
const byPx = new Map<string, string[]>();                // 지문 → key 들
let version = 0;
const listeners = new Set<() => void>();
function add(k: string, px: string) {
  table.set(k, px);
  const l = byPx.get(px);
  if (l) { if (!l.includes(k)) l.push(k); } else byPx.set(px, [k]);
}
export function subscribeSame(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export const sameVersion = (): number => version;

/** 이 내용 key 와 화소가 전부 같은 다른 key 들(없으면 빈 배열). */
export function sameKeys(key: string): string[] {
  const px = key ? table.get(key) : undefined;
  return px ? (byPx.get(px) || []).filter((k) => k !== key) : [];
}

/** 멈춘 그림의 크기. 움직이는 그림 · 모르는 형식 · 크기를 못 읽으면 null, 머리가 모자라면 'more'. */
function stillSize(b: Uint8Array): { w: number; h: number } | null | 'more' {
  const d = imageDims(b);
  if (!d || !['png', 'jpeg', 'webp'].includes(d.format)) return null;
  if (!d.width || !d.height) return 'more';
  if (d.format === 'webp' && b[15] === 0x58 && (b[20] & 0x02)) return null;   // VP8X + 움직임 표시
  if (d.format === 'png') {                                                    // APNG — acTL 은 IDAT 앞에 온다
    let seen = false;
    for (let p = 8; p + 8 <= b.length;) {
      const t = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (t === 'acTL') return null;
      if (t === 'IDAT') { seen = true; break; }
      p += 12 + (((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]));
    }
    if (!seen) return 'more';
  }
  return { w: d.width, h: d.height };
}
async function sizeAt(url: string): Promise<{ w: number; h: number } | null> {
  for (const n of [HEAD, HEAD_MORE]) {
    const r = await fetch(url, { headers: { Range: `bytes=0-${n - 1}` } });
    if (!r.ok) return null;
    const s = stillSize(new Uint8Array(await r.arrayBuffer()));
    if (s !== 'more') return s;
  }
  return null;
}

/** 16×16 로 줄인 모습(가운데 정사각형 — createThumbnail 과 같은 자르기). */
function gridOf(src: ImageBitmap): Uint8ClampedArray | null {
  const c = new OffscreenCanvas(GRID, GRID);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  const side = Math.min(src.width, src.height);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, GRID, GRID);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, GRID, GRID);
  return ctx.getImageData(0, 0, GRID, GRID).data;
}
/** 화면에 보이는 화소의 지문 '너비x높이:…' 과 작은 모습. 못 읽거나 너무 크면 null. */
async function lookAt(b: Blob): Promise<{ px: string; grid: Uint8ClampedArray | null } | null> {
  let bm: ImageBitmap | null = null;
  try {
    bm = await createImageBitmap(b);
    const { width: w, height: h } = bm;
    if (!w || !h || w * h > MAX_PIXELS) return null;
    const c = new OffscreenCanvas(w, Math.min(STRIP, h));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const all = new Uint8Array(Math.ceil(h / STRIP) * 32);
    for (let y = 0, i = 0; y < h; y += STRIP, i++) {
      const sh = Math.min(STRIP, h - y);
      ctx.clearRect(0, 0, w, sh);
      ctx.drawImage(bm, 0, y, w, sh, 0, 0, w, sh);
      all.set(new Uint8Array(await crypto.subtle.digest('SHA-256', ctx.getImageData(0, 0, w, sh).data)), i * 32);
      await new Promise((r) => setTimeout(r));   // 띠 사이에 화면에 자리를 내준다
    }
    const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
    return { px: `${w}x${h}:${Array.from(sum.slice(0, 16), (x) => x.toString(16).padStart(2, '0')).join('')}`, grid: gridOf(bm) };
  } catch { return null; } finally { bm?.close(); }
}
/** 라이브러리 미리보기가 이 사진과 확실히 다른가 — 모르겠으면 false(원본을 풀어 본다). */
async function farFrom(grid: Uint8ClampedArray | null, thumb: string | undefined): Promise<boolean> {
  if (!grid || !thumb?.startsWith('data:image')) return false;
  let bm: ImageBitmap | null = null;
  try {
    bm = await createImageBitmap(await (await fetch(thumb)).blob());
    const g = gridOf(bm);
    if (!g) return false;
    let d = 0;
    for (let i = 0; i < g.length; i += 4) d += Math.abs(g[i] - grid[i]) + Math.abs(g[i + 1] - grid[i + 1]) + Math.abs(g[i + 2] - grid[i + 2]);
    return d / (GRID * GRID * 3) > FAR;
  } catch { return false; } finally { bm?.close(); }
}

const libSizes = new Map<string, Promise<{ w: number; h: number } | null>>();   // 등록 사진의 크기 — 켜져 있는 동안 한 번
function libSize(libId: string): Promise<{ w: number; h: number } | null> {
  let p = libSizes.get(libId);
  if (!p) {
    p = sizeAt(`/api/library/${libId}`).catch(() => { libSizes.delete(libId); return null; });
    libSizes.set(libId, p);
  }
  return p;
}

const checkedAt = new Map<string, string>();   // 다 본 때의 등록 목록 — 새로 등록된 것이 생기면 다시 본다
const mine = new Map<string, { px: string; grid: Uint8ClampedArray | null }>();   // 칸 사진은 한 번만 푼다
const running = new Map<string, Promise<boolean>>();
/** 이 사진(캐시 id)과 화소가 같은 등록 사진이 있나 — 있으면 기억하고 true(그 뒤 sameKeys 가 안다). */
export function checkSame(cacheId: string | undefined, registered: Registered[]): Promise<boolean> {
  const k = keyOf(cacheId);
  const regs = registered.slice(-MAX_REG).filter((r) => keyOf(r.libId) && keyOf(r.libId) !== k);
  if (!k || !cacheId || !regs.length) return Promise.resolve(false);   // 등록한 것이 없으면 여기까지
  const sig = `${regs.length}:${regs[regs.length - 1].libId}`;
  if (checkedAt.get(k) === sig) return Promise.resolve(sameKeys(k).length > 0);
  const going = running.get(k);
  if (going) return going;
  const p = (async () => {
    try {
      const url = `/api/cache/${encodeURIComponent(cacheId)}`;
      const size = await sizeAt(url);
      if (!size) return false;
      const sizes: ({ w: number; h: number } | null)[] = [];
      for (let i = 0; i < regs.length; i += 6) sizes.push(...await Promise.all(regs.slice(i, i + 6).map((r) => libSize(r.libId!))));
      // 회전 정보(EXIF)가 있으면 가로세로가 뒤집혀 보인다
      const cands = regs.filter((_, i) => { const s = sizes[i]; return !!s && ((s.w === size.w && s.h === size.h) || (s.w === size.h && s.h === size.w)); });
      if (!cands.length) return false;
      let me = mine.get(k);
      if (!me) {
        const r = await fetch(url);
        const got = r.ok ? await lookAt(await r.blob()) : null;
        if (!got) return false;
        me = got;
        mine.set(k, me);
      }
      let hit = false;
      for (const c of cands) {
        const lk = keyOf(c.libId);
        let px = table.get(lk);
        if (!px) {
          if (await farFrom(me.grid, c.thumbnailUrl)) continue;
          const r = await fetch(`/api/library/${c.libId}`);
          const got = r.ok ? await lookAt(await r.blob()) : null;
          if (!got) continue;
          px = got.px;
          add(lk, px);
        }
        if (px === me.px) hit = true;
      }
      if (!hit) return false;
      add(k, me.px);
      version++;
      for (const fn of listeners) fn();
      return true;
    } catch { return false; } finally {
      checkedAt.set(k, sig);
      running.delete(k);
    }
  })();
  running.set(k, p);
  return p;
}
