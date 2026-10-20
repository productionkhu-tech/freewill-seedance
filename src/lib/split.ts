// ─── 작업창 나누기 (26.10.2001~) ───────────────────────────────────────────────
// 프로젝트 목록은 왼쪽에 그대로 두고, 작업창(ChatArea)만 두 칸으로 나눈다. 여기에는 '어느 칸에 어느 프로젝트'
// 규칙만 있다(순수 함수) — store.ts 가 부르고, scripts/split_check.ts 가 무작위 조작으로 불변식을 검사한다.
//
// 칸(slot)은 화면 위치가 아니라 칸 자체다. 칸마다 작업창이 하나씩 붙어 있어서(0번은 늘, 1번은 나눴을 때만)
// 자리를 바꿔도(firstOnRight) 쓰던 글 · 스크롤 · 갤러리가 칸째로 따라간다 — 두 작업창이 프로젝트를 맞바꾸면
// 둘 다 '프로젝트 전환' 을 하게 되고(초안을 다시 읽고 맨 아래로), 그게 '자리 바꾸기' 로 보이지 않는다.
//
// 불변식(나눴을 때):
//   ① 두 칸의 프로젝트는 서로 다르다. 같은 프로젝트를 두 칸에 띄우면 초안 하나를 두 편집기가 번갈아 덮는다.
//   ② currentProjectId === slots[paneFocus]. 앱 전체의 '지금 프로젝트'(설정 패널 · 목록 강조 · 에이전트 ·
//      뒤로/앞으로)는 지금 손대는 칸의 것이다 — 그래서 그쪽 코드는 나누기를 몰라도 그대로 돈다.
//   ③ 두 칸 모두 있는 프로젝트다. 한쪽이 지워지면 남은 칸 하나로 돌아간다.
// 나누지 않았으면 split = null, paneFocus = 0 — 예전과 똑같다.

export type PaneSide = 'left' | 'right';
export type PaneSlot = 0 | 1;
export interface SplitLayout {
  slots: [string, string];   // 0번 · 1번 칸의 프로젝트 id
  firstOnRight: boolean;     // 0번 칸이 오른쪽에 있다(자리 바꾸기)
}
export interface PaneState {
  split: SplitLayout | null;
  paneFocus: PaneSlot;
  currentProjectId: string | null;
}

const other = (k: PaneSlot): PaneSlot => (k === 0 ? 1 : 0);

/** 화면의 그쪽에 있는 칸. */
export const slotAt = (sp: SplitLayout, side: PaneSide): PaneSlot =>
  (side === 'left') !== sp.firstOnRight ? 0 : 1;

/** 그 칸이 화면의 어느 쪽에 있나. */
export const sideOf = (sp: SplitLayout, slot: PaneSlot): PaneSide =>
  (slot === 0) !== sp.firstOnRight ? 'left' : 'right';

/** 화면에 떠 있는 프로젝트 — 한 칸이면 하나, 나눴으면 둘. */
export function visibleProjectIds(s: { split: SplitLayout | null; currentProjectId: string | null }): string[] {
  if (s.split) return [s.split.slots[0], s.split.slots[1]];
  return s.currentProjectId ? [s.currentProjectId] : [];
}

/** 프로젝트를 '지금 손대는 칸' 에 띄운다 — 목록 클릭 · 새 프로젝트 · 뒤로/앞으로 · 찾기 · 에이전트 project.open.
 *  다른 칸에 이미 떠 있으면 그 칸으로 옮겨 갈 뿐이다(①). */
export function pointAt(s: PaneState, id: string): PaneState {
  const sp = s.split;
  if (!sp) return { split: null, paneFocus: 0, currentProjectId: id };
  const f = s.paneFocus;
  if (sp.slots[f] === id) return { split: sp, paneFocus: f, currentProjectId: id };
  if (sp.slots[other(f)] === id) return { split: sp, paneFocus: other(f), currentProjectId: id };
  const slots: [string, string] = [sp.slots[0], sp.slots[1]];
  slots[f] = id;
  return { split: { ...sp, slots }, paneFocus: f, currentProjectId: id };
}

/** 목록에서 끌어다 그쪽에 놓기 · 메뉴의 '왼쪽/오른쪽 창에 열기'. 놓은 칸이 손대는 칸이 된다. */
export function openAt(s: PaneState, id: string, side: PaneSide): PaneState {
  const sp = s.split;
  const cur = s.currentProjectId;
  if (!sp) {
    if (!cur || cur === id) return s;   // 한 칸에 이미 그 프로젝트 — 나눌 것이 없다
    // 지금 칸(0번)은 그대로 두고 새 칸(1번)에 연다. 왼쪽에 놓았으면 새 칸이 왼쪽이다(0번이 오른쪽으로 비켜난다).
    return { split: { slots: [cur, id], firstOnRight: side === 'left' }, paneFocus: 1, currentProjectId: id };
  }
  const k = slotAt(sp, side);
  if (sp.slots[k] === id) return { split: sp, paneFocus: k, currentProjectId: id };
  if (sp.slots[other(k)] === id) {
    // 반대쪽에 떠 있던 것을 이쪽에 놓았다 — 두 칸의 자리를 바꾼다(칸째로 옮겨 가니 쓰던 글도 따라간다).
    return { split: { ...sp, firstOnRight: !sp.firstOnRight }, paneFocus: other(k), currentProjectId: id };
  }
  const slots: [string, string] = [sp.slots[0], sp.slots[1]];
  slots[k] = id;
  return { split: { ...sp, slots }, paneFocus: k, currentProjectId: id };
}

/** 그 칸에 손대기 시작했다(칸 안을 누름). 칸의 프로젝트는 그대로다. */
export function focusSlot(s: PaneState, slot: PaneSlot): PaneState {
  if (!s.split || s.paneFocus === slot) return s;
  return { split: s.split, paneFocus: slot, currentProjectId: s.split.slots[slot] };
}

/** 두 칸의 자리 바꾸기. 칸은 그대로 — 위치만 바뀐다. */
export function swapSides(s: PaneState): PaneState {
  if (!s.split) return s;
  return { ...s, split: { ...s.split, firstOnRight: !s.split.firstOnRight } };
}

/** 칸 닫기. 0번 칸은 늘 남는다(받은 영상 다운로드 표시가 거기 붙어 있다) — 0번을 닫으면 1번의 프로젝트가 0번 칸으로 온다. */
export function closeSlot(s: PaneState, slot: PaneSlot): PaneState {
  if (!s.split) return s;
  return { split: null, paneFocus: 0, currentProjectId: s.split.slots[other(slot)] };
}

/** 프로젝트를 지운 뒤(하나 · 그룹째). 띄워 둔 칸의 것이 지워졌으면 남은 칸 하나로 — 엉뚱한 프로젝트를 띄우지 않는다.
 *  fallback: 한 칸이었거나 두 칸이 다 지워졌을 때 갈 곳(예전 규칙 — 남은 목록의 첫 프로젝트). */
export function afterRemoval(s: PaneState, alive: (id: string) => boolean, fallback: string | null): PaneState {
  const sp = s.split;
  if (!sp) {
    if (s.currentProjectId && alive(s.currentProjectId)) return s;
    return { split: null, paneFocus: 0, currentProjectId: fallback };
  }
  const a = alive(sp.slots[0]);
  const b = alive(sp.slots[1]);
  if (a && b) return s;
  if (a || b) return { split: null, paneFocus: 0, currentProjectId: a ? sp.slots[0] : sp.slots[1] };
  return { split: null, paneFocus: 0, currentProjectId: fallback };
}

/** 저장해 둔 나누기(켤 때 · 백업에서 되살릴 때) — 모양이 틀리거나 없는 프로젝트를 가리키면 버린다(한 칸으로). */
export function sanitizeSplit(raw: unknown, exists: (id: string) => boolean): SplitLayout | null {
  const r = raw as { slots?: unknown; firstOnRight?: unknown } | null | undefined;
  if (!r || !Array.isArray(r.slots) || r.slots.length !== 2) return null;
  const [a, b] = r.slots as unknown[];
  if (typeof a !== 'string' || typeof b !== 'string' || a === b || !exists(a) || !exists(b)) return null;
  return { slots: [a, b], firstOnRight: r.firstOnRight === true };
}

/** 불변식 ①②③ — 검사와 안전망이 쓴다. */
export function splitValid(s: PaneState, exists: (id: string) => boolean): boolean {
  const sp = s.split;
  if (!sp) return s.paneFocus === 0;
  return sp.slots[0] !== sp.slots[1]
    && exists(sp.slots[0]) && exists(sp.slots[1])
    && s.currentProjectId === sp.slots[s.paneFocus];
}

/** 깨진 상태를 고친다(안전망). 고칠 것이 없으면 같은 객체를 돌려준다. */
export function repairSplit(s: PaneState, exists: (id: string) => boolean, fallback: string | null): PaneState {
  if (splitValid(s, exists)) return s;
  const sp = s.split;
  if (!sp) return { split: null, paneFocus: 0, currentProjectId: s.currentProjectId };
  const a = exists(sp.slots[0]);
  const b = exists(sp.slots[1]);
  if (a && b && sp.slots[0] !== sp.slots[1]) {
    // 칸은 멀쩡한데 '지금 프로젝트' 만 어긋났다 — 지금 프로젝트가 떠 있는 칸으로 손을 옮기거나, 손대던 칸에 띄운다.
    if (s.currentProjectId && s.currentProjectId === sp.slots[other(s.paneFocus)]) {
      return { split: sp, paneFocus: other(s.paneFocus), currentProjectId: s.currentProjectId };
    }
    if (s.currentProjectId && exists(s.currentProjectId)) return pointAt(s, s.currentProjectId);
    return { split: sp, paneFocus: s.paneFocus, currentProjectId: sp.slots[s.paneFocus] };
  }
  if (a) return { split: null, paneFocus: 0, currentProjectId: sp.slots[0] };
  if (b) return { split: null, paneFocus: 0, currentProjectId: sp.slots[1] };
  return { split: null, paneFocus: 0, currentProjectId: fallback };
}
