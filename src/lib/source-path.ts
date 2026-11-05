// ─── 레퍼런스 · 어셋 이미지의 원본 파일 찾기 · 열기 (26.11.501~) ───────────────────────────
// 경로는 그 바이트가 이 PC 어디서 왔는지다. 레퍼런스(Asset.originalPath)와 어셋 이미지(ElementImage.originalPath)가 들고 있고,
// 없으면 이 PC 기록에서 '같은 내용(캐시 id 앞 12자리 md5)' 이 어디서 왔는지 찾는다. 받은 영상의 설정 상자에는 일부러 경로를 안 넣으므로
// (settings-box — 만든 사람의 폴더 이름이 영상에 실려 나간다) 받은 영상에서 되살린 레퍼런스도 이 길로 경로를 되찾는다.
// 그래도 없거나 파일이 옮겨졌으면 디스크에서 내용으로 찾는다(26.11.502~, server /api/find-sources) — 이름이 바뀌어도 찾는다.
// 어셋 이미지는 501 전에는 경로를 저장하지 않았는데, 이 길로 이 PC 에서 224개 중 214개를 찾았다(33초, 2026-11-05 실측).
import { contentKey, useAppStore } from '../store';

type Seen = { path: string; at: number };

const baseName = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() || '';

// 내용 → 그 내용이 왔던 경로들. 스토어가 바뀐 뒤 처음 물을 때 한 번만 짓는다(1만 건 안팎이라 ~2ms).
let built: { projects: unknown; elements: unknown; index: Map<string, Seen[]> } | null = null;
function sourceIndex(): Map<string, Seen[]> {
  const { projects, elementAssets } = useAppStore.getState();
  if (built?.projects === projects && built.elements === elementAssets) return built.index;
  const index = new Map<string, Seen[]>();
  const note = (id: string | undefined, p: string | undefined, at: number) => {
    const key = p && contentKey(id);
    if (!key) return;
    const list = index.get(key);
    if (!list) { index.set(key, [{ path: p!, at }]); return; }
    const same = list.find(x => x.path === p);
    if (!same) list.push({ path: p!, at });
    else if (at > same.at) same.at = at;
  };
  for (const p of projects) {
    for (const a of p.assets || []) note(a.cacheId, a.originalPath, p.updatedAt || 0);
    for (const m of p.messages || []) for (const a of (m.usedAssets as any[]) || []) note(a?.cacheId, a?.originalPath, m.timestamp || 0);
  }
  for (const e of elementAssets) for (const im of e.images) note(im.libId || im.cacheId, im.originalPath, e.updatedAt || 0);
  built = { projects, elements: elementAssets, index };
  return index;
}

// 이 내용이 이 PC 에서 어디서 왔는가. 같은 내용을 여러 폴더에서 넣었으면 파일 이름이 같은 것 중 가장 최근 것, 없으면 그냥 가장 최근 것.
export function findSourcePath(id?: string | null, fileName?: string): string | undefined {
  const key = contentKey(id);
  const list = key ? sourceIndex().get(key) : undefined;
  if (!list?.length) return undefined;
  const name = fileName?.toLowerCase();
  const pool = (name && list.filter(x => baseName(x.path) === name)) || [];
  return (pool.length ? pool : list).reduce((a, b) => (b.at >= a.at ? b : a)).path;   // 시각이 같으면 뒤에 쌓인 쪽(메시지는 오래된 순)
}

// 이 레퍼런스의 원본 경로 — 들고 있는 값이 먼저다(내용 찾기는 받은 영상 · 옛 기록을 위한 것).
export const sourcePathOf = (a: { originalPath?: string; cacheId?: string; file_name?: string } | null | undefined) =>
  a ? a.originalPath || findSourcePath(a.cacheId, a.file_name) : undefined;

export const canRevealFiles = () => !!(window as any).electronAPI?.revealFile;

// 파일이 든 폴더. 'D:\a.png' 의 폴더는 'D:' 가 아니라 'D:\' 다('D:' 는 그 드라이브의 현재 폴더라는 뜻이 된다).
export function parentDir(p: string): string {
  const dir = p.replace(/[\\/]+[^\\/]*$/, '');
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir;
}

// 디스크에서 먼저 볼 폴더 — 옮겨진 파일의 원래 폴더 쪽, 그다음 이 PC 기록에서 파일이 많이 왔던 폴더 순. 사람마다 쓰는 폴더가 달라 고정 목록으로는 못 찾는다.
function hintDirs(missing?: string): string[] {
  const count = new Map<string, number>();
  for (const list of sourceIndex().values()) for (const s of list) {
    const d = parentDir(s.path);
    count.set(d, (count.get(d) || 0) + 1);
  }
  const near: string[] = [];
  for (let d = missing ? parentDir(missing) : ''; d; ) {
    near.push(d);
    const up = parentDir(d);
    if (up === d) break;
    d = up;
  }
  return [...new Set([...near, ...[...count.entries()].sort((a, b) => b[1] - a[1]).map(([d]) => d)])].slice(0, 300);
}

// 디스크에서 내용으로 찾기. 한 번 훑을 때 아직 경로가 없는 어셋 이미지도 같이 찾아 저장한다 — 다음부터는 누르자마자 열린다.
// 방금 못 찾은 것은 2분 동안 다시 훑지 않는다(디스크를 또 돌리는 동안 사람이 기다리게 된다).
const missedAt = new Map<string, number>();
let searching: Promise<unknown> | null = null;
async function findOnDisk(id: string, fileName?: string, missing?: string): Promise<string | undefined> {
  const key = contentKey(id) || id;
  if (Date.now() - (missedAt.get(key) || 0) < 120_000) return undefined;
  while (searching) await searching.catch(() => {});   // 한 번에 하나 — 앞 검색이 이미 찾았을 수 있다
  const st = useAppStore.getState();
  const known = st.elementAssets.flatMap(e => e.images).find(i => (i.libId === id || i.cacheId === id) && i.originalPath && i.originalPath !== missing);
  if (known) return known.originalPath;
  const others = st.elementAssets.flatMap(e => e.images).filter(i => !i.originalPath && i.libId && i.libId !== id).map(i => ({ id: i.libId!, name: i.file_name }));
  const run = (async () => {
    const res = await fetch('/api/find-sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [{ id, name: fileName }, ...others], dirs: hintDirs(missing) }),
    });
    return res.ok ? ((await res.json()).found as Record<string, string>) : {};
  })();
  searching = run.finally(() => { searching = null; });
  const found = await run.catch(() => ({} as Record<string, string>));
  if (Object.keys(found).length) useAppStore.getState().setElementSourcePaths(found);
  if (!found[id]) missedAt.set(key, Date.now());
  return found[id];
}

export type RevealResult = { msg: string; sub?: string; ok?: boolean } | null;

// 탐색기에서 그 파일을 고른 채로 연다. 없으면 내용으로 찾고, 그래도 없으면 남아 있는 가장 가까운 폴더를 연다 — '어디 있었는지' 가 궁금한 것이라 근처 폴더만으로도 쓸모가 있다.
// 잘 열렸으면 null, 아니면 사람에게 보여 줄 짧은 말과 경로(글자 크기를 달리해 보여 준다).
export async function revealSource({ path, id, fileName }: { path?: string; id?: string | null; fileName?: string }): Promise<RevealResult> {
  const api = (window as any).electronAPI;
  if (!api?.revealFile) return { msg: '이 환경에서는 폴더를 열 수 없어요' };
  if (path) {
    const r = await api.revealFile(path);
    if (r?.ok) return null;
    if (r?.reason === 'timeout') return { msg: '드라이브에 연결되지 않아요', sub: path };
    if (r?.reason !== 'missing') return { msg: '폴더를 열지 못했어요', sub: path };
  }
  if (id) {
    const found = await findOnDisk(id, fileName, path);
    if (found && (await api.revealFile(found))?.ok) return path ? { msg: '파일이 옮겨져 있어 새 위치를 열었어요', sub: found, ok: true } : null;
  }
  if (!path) return { msg: '이 PC에서 원본을 찾지 못했어요', sub: fileName };
  let first = true;
  for (let dir = parentDir(path); dir; first = false) {
    const o = await api.openFolder?.(dir);
    if (o?.ok) return { msg: first ? '파일을 못 찾아 원래 폴더를 열었어요' : '원래 폴더도 없어 가장 가까운 폴더를 열었어요', sub: path };
    if (o?.reason === 'timeout') return { msg: '드라이브에 연결되지 않아요', sub: path };
    const up = parentDir(dir);
    if (up === dir) break;
    dir = up;
  }
  return { msg: '파일도 폴더도 없어요', sub: path };
}
