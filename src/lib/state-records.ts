// 작업 기록을 카드마다 따로 저장한다 (26.11.1802~).
//
// 왜: 그 전에는 무엇이 하나 바뀌어도 기록 전체(실측 86MB · 카드 2,771장)를 IndexedDB 한 칸에 다시 썼다. 배포판에서 한 번에
// 화면이 ≈0.27초 멈췄고(조각 잇기 50ms + put 215ms), MCP 로 20건을 몰아 보내면 진행 상태가 바뀔 때마다 저장이 돌아 1분에
// 34번 — 1분 중 ≈9초가 멈춘 시간이었다(2026-11-18 사용자 데이터 사본으로 격리 실측, 사용자 "MCP 쓸 때 랙").
// 이제 칸이 둘이다:
//   · root — 카드를 뺀 나머지 전부(프로젝트 칸 · 카드 순서 id · 최상위 칸). 실측 ≈0.2MB.
//   · 카드 하나 = 칸 하나. 키는 JSON.stringify([프로젝트 id, 카드 id]).
// 저장은 '바뀐 카드 + (바뀌었으면) root + 지워진 카드' 만 한 트랜잭션으로 쓴다 — 반쯤 쓴 상태가 디스크에 남지 않는다.
// 바뀐 카드는 참조로 안다(스토어는 불변 갱신 — §7 '저장 칸 제자리 수정 금지'). 참조가 바뀌었어도 글이 같으면 쓰지 않는다.
//
// 어디에: IndexedDB 'seedance-records' / 'kv'. 옛 한 덩어리 키(keyval-store / 'seedance-app-storage')는 처음 통째로 옮긴 뒤
// 지운다. 옛 키가 남아 있으면 그쪽이 더 새 것이다(옛 판으로 되돌렸다 다시 온 경우) — 그것을 읽고 다시 통째로 옮긴다.
// 옛 판(26.11.1801 이하)으로 되돌리면 그 판은 옛 키가 없어 문서 폴더 백업에서 되살린다(백업 파일 모양은 그대로다).
//
// 순수 함수만 둔다(IDB 는 store.ts) — 노드에서 실제 백업으로 시험한다.
import type { StorageValue } from 'zustand/middleware';

export const RECORDS_DB = 'seedance-records';
export const RECORDS_STORE = 'kv';
export const ROOT_KEY = 'root';

export const msgKey = (pid: string, mid: string): string => JSON.stringify([pid, mid]);

/** root 의 프로젝트 하나 — 보통은 칸 + 카드 순서. id 가 없거나 겹치는 이상한 프로젝트는 통째로(whole) root 안에. */
type RootProject = { meta: Record<string, unknown>; ids: string[] } | { whole: unknown };

/** 마지막으로 디스크에 들어간 것 — root 글과, 카드 키마다 그때의 카드 객체 */
export type Written = { root: string | null; msgs: Map<string, object> };

export type RecordsPlan = {
  rootJson: string;
  puts: [string, string][];
  dels: string[];
  /** 이번 저장이 끝나면 Written.msgs 가 될 것(지금 기록의 카드 키 → 카드 객체) */
  next: Map<string, object>;
};

const plainObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).toJSON !== 'function';

/**
 * 지금 상태를 칸으로 나누고 디스크와 다른 것만 고른다. full 이면 전부 쓴다(부르는 쪽이 칸을 비우고 쓴다).
 * msgJsonOf 는 카드 객체 → JSON 글(같은 객체면 다시 만들지 않는 캐시) — JSON.stringify(m) 와 같아야 한다.
 */
export function planRecords(value: StorageValue<unknown>, written: Written, msgJsonOf: (m: object) => string, full: boolean): RecordsPlan {
  const st: Record<string, any> = plainObject((value as any)?.state) ? (value as any).state : {};
  const projects: unknown[] = Array.isArray(st.projects) ? st.projects : [];
  const rootProjects: RootProject[] = [];
  const next = new Map<string, object>();
  const seenP = new Set<string>();
  for (const p of projects) {
    const msgs: unknown[] | null = plainObject(p) && Array.isArray(p.messages) ? p.messages : null;
    let ok = !!msgs && typeof (p as any).id === 'string' && !seenP.has((p as any).id);
    if (ok) {
      const seen = new Set<string>();
      for (const m of msgs!) {
        if (!plainObject(m) || typeof m.id !== 'string' || seen.has(m.id)) { ok = false; break; }
        seen.add(m.id);
      }
    }
    if (!ok) { rootProjects.push({ whole: p }); continue; }
    const pid: string = (p as any).id;
    seenP.add(pid);
    const { messages: _messages, ...meta } = p as Record<string, unknown>;
    rootProjects.push({ meta, ids: msgs!.map((m: any) => m.id) });
    for (const m of msgs!) next.set(msgKey(pid, (m as any).id), m as object);
  }
  const rootJson = JSON.stringify({ v: 3, version: (value as any)?.version, state: { ...st, projects: rootProjects } });
  const puts: [string, string][] = [];
  if (full || rootJson !== written.root) puts.push([ROOT_KEY, rootJson]);
  for (const [k, m] of next) {
    const prev = full ? undefined : written.msgs.get(k);
    if (prev === m) continue;
    const j = msgJsonOf(m);
    if (prev && msgJsonOf(prev) === j) continue;   // 새 객체지만 글은 같다 — 쓸 것 없음(next 로 참조만 바뀐다)
    puts.push([k, j]);
  }
  const dels: string[] = [];
  if (!full) for (const k of written.msgs.keys()) if (!next.has(k)) dels.push(k);
  return { rootJson, puts, dels, next };
}

export class RecordsUnreadable extends Error {
  constructor(msg: string) { super(msg); this.name = 'RecordsUnreadable'; }
}

/**
 * 칸들 → 상태. 칸이 하나도 없으면 null. root 가 없거나 못 읽으면 RecordsUnreadable(부르는 쪽이 원본을 남기고 백업으로).
 * remember(카드 객체, 그 글) 로 캐시를 채워 다음 저장이 안 바뀐 카드를 다시 직렬화하지 않게 한다.
 * root 가 가리키는 카드 칸이 없으면 그 카드만 빼고 알린다(missing) — 한 트랜잭션으로 쓰므로 정상이면 0이다.
 */
export function assembleRecords(entries: [IDBValidKey, unknown][], remember: (m: object, json: string) => void):
  { value: StorageValue<unknown>; written: Written; strays: string[]; missing: string[] } | null {
  if (!entries.length) return null;
  const raw = new Map<string, string>();
  for (const [k, v] of entries) {
    if (typeof k !== 'string' || typeof v !== 'string') throw new RecordsUnreadable(`칸 모양이 다름: ${String(k).slice(0, 80)}`);
    raw.set(k, v);
  }
  const rootRaw = raw.get(ROOT_KEY);
  if (rootRaw === undefined) throw new RecordsUnreadable(`root 칸이 없음(칸 ${raw.size}개)`);
  let root: any;
  try { root = JSON.parse(rootRaw); } catch (e) { throw new RecordsUnreadable(`root 칸을 읽지 못함: ${String(e).slice(0, 120)}`); }
  if (!plainObject(root) || root.v !== 3 || !plainObject(root.state) || !Array.isArray(root.state.projects)) throw new RecordsUnreadable('root 칸 형식이 다름');
  const used = new Set<string>([ROOT_KEY]);
  const msgs = new Map<string, object>();
  const missing: string[] = [];
  const projects = root.state.projects.map((rp: any) => {
    if (plainObject(rp) && 'whole' in rp) return rp.whole;
    if (!plainObject(rp) || !plainObject(rp.meta) || typeof rp.meta.id !== 'string' || !Array.isArray(rp.ids)) throw new RecordsUnreadable('프로젝트 칸 형식이 다름');
    const pid: string = rp.meta.id;
    const messages: object[] = [];
    for (const mid of rp.ids) {
      const k = msgKey(pid, String(mid));
      const j = raw.get(k);
      if (j === undefined) { missing.push(`${String(rp.meta.name ?? pid)} / ${String(mid)}`); continue; }
      let m: any;
      try { m = JSON.parse(j); } catch (e) { throw new RecordsUnreadable(`카드 칸을 읽지 못함(${String(rp.meta.name ?? pid)} / ${String(mid)}): ${String(e).slice(0, 120)}`); }
      if (!plainObject(m)) throw new RecordsUnreadable(`카드 칸 형식이 다름(${String(rp.meta.name ?? pid)} / ${String(mid)})`);
      remember(m, j);
      used.add(k);
      msgs.set(k, m);
      messages.push(m);
    }
    return { ...rp.meta, messages };
  });
  const strays = [...raw.keys()].filter((k) => !used.has(k));
  return {
    value: { state: { ...root.state, projects }, version: typeof root.version === 'number' ? root.version : 0 },
    // 빠진 카드가 있으면 root 글이 지금 상태와 달라진다 — root 를 비워 두어 다음 저장이 고쳐 쓰게.
    written: { root: missing.length ? null : rootRaw, msgs },
    strays,
    missing,
  };
}
