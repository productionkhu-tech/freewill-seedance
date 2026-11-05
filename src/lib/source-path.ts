// ─── 레퍼런스 · 어셋 이미지의 원본 파일 찾기 · 열기 (26.11.501~) ───────────────────────────
// 경로는 그 바이트가 이 PC 어디서 왔는지다. 레퍼런스(Asset.originalPath)와 어셋 이미지(ElementImage.originalPath)가 들고 있고,
// 없으면 이 PC 기록에서 '같은 내용(캐시 id 앞 12자리 md5)' 이 어디서 왔는지 찾는다. 받은 영상의 설정 상자에는 일부러 경로를 안 넣으므로
// (settings-box — 만든 사람의 폴더 이름이 영상에 실려 나간다) 받은 영상에서 되살린 레퍼런스도 이 길로 경로를 되찾는다.
import { contentKey, useAppStore } from '../store';

type Seen = { path: string; at: number };

const baseName = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() || '';

// 내용 → 그 내용이 왔던 경로들. 스토어가 바뀐 뒤 처음 물을 때 한 번만 짓는다(1만 건 안팎이라 ~2ms).
let built: { projects: unknown; index: Map<string, Seen[]> } | null = null;
function sourceIndex(): Map<string, Seen[]> {
  const projects = useAppStore.getState().projects;
  if (built?.projects === projects) return built.index;
  const index = new Map<string, Seen[]>();
  const note = (a: any, at: number) => {
    const key = a?.originalPath && contentKey(a.cacheId);
    if (!key) return;
    const list = index.get(key);
    if (!list) { index.set(key, [{ path: a.originalPath, at }]); return; }
    const same = list.find(x => x.path === a.originalPath);
    if (!same) list.push({ path: a.originalPath, at });
    else if (at > same.at) same.at = at;
  };
  for (const p of projects) {
    for (const a of p.assets || []) note(a, p.updatedAt || 0);
    for (const m of p.messages || []) for (const a of (m.usedAssets as any[]) || []) note(a, m.timestamp || 0);
  }
  built = { projects, index };
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

// 탐색기에서 그 파일을 고른 채로 연다. 파일이 없어도 폴더가 남았으면 폴더를 연다 — '어디 있었는지' 가 궁금한 것이라 폴더만으로도 쓸모가 있다.
// 잘 열렸으면 null, 아니면 사람에게 보여 줄 짧은 말 — 경로는 따로 준다(글자 크기를 달리해 보여 준다).
export async function revealSourceFile(filePath: string): Promise<string | null> {
  const api = (window as any).electronAPI;
  if (!api?.revealFile) return '이 환경에서는 폴더를 열 수 없어요';
  const r = await api.revealFile(filePath);
  if (r?.ok) return null;
  if (r?.reason === 'timeout') return '드라이브에 연결되지 않아요';
  if (r?.reason !== 'missing') return '폴더를 열지 못했어요';
  const dir = parentDir(filePath);
  const o = dir ? await api.openFolder?.(dir) : null;
  if (o?.ok) return '파일을 못 찾아 원래 폴더를 열었어요';
  if (o?.reason === 'timeout') return '드라이브에 연결되지 않아요';
  return '파일도 원래 폴더도 없어요';
}
