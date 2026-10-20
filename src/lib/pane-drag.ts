// ─── 목록에서 프로젝트를 끌어 작업창 칸에 놓기 (26.10.2001~) ──────────────────────────
// 사이드바의 끌기는 HTML5 드래그가 아니라 포인터 끌기다(Sidebar '왜 POINTER drag' 주석 — 끄는 동안 휠이 돌아야
// 해서). 그래서 작업창은 drop 이벤트를 받지 못한다. 대신 사이드바가 포인터 위치를 여기로 알리고, 작업창(Workspace)은
// 포인터가 자기 위에 오면 '왼쪽 / 오른쪽' 판을 띄운다. 놓을 때 사이드바는 먼저 여기에 묻는다 — 작업창이 받았으면
// 목록 순서는 건드리지 않는다.

import type { PaneSide } from './split';

export type PaneDrag = { projectId: string; x: number; y: number } | null;
type SideAt = (x: number, y: number) => PaneSide | null;

let sideAt: SideAt | null = null;
let onDrop: ((projectId: string, side: PaneSide) => void) | null = null;
const listeners = new Set<(d: PaneDrag) => void>();

/** 작업창이 자기를 놓을 곳으로 등록한다. 돌려준 함수로 푼다. */
export function registerPaneDropTarget(at: SideAt, drop: (projectId: string, side: PaneSide) => void): () => void {
  sideAt = at;
  onDrop = drop;
  return () => { if (sideAt === at) { sideAt = null; onDrop = null; } };
}

/** 그 점이 작업창의 어느 쪽인가(작업창 밖이면 null). */
export function paneSideAt(x: number, y: number): PaneSide | null {
  return sideAt ? sideAt(x, y) : null;
}

export function onPaneDrag(f: (d: PaneDrag) => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

/** 사이드바: 프로젝트를 끄는 중(포인터가 움직일 때마다). */
export function paneDragMove(projectId: string, x: number, y: number): void {
  const d = { projectId, x, y };
  listeners.forEach(f => f(d));
}

/** 사이드바: 끌기가 끝났다(놓았거나 Esc). */
export function paneDragEnd(): void {
  listeners.forEach(f => f(null));
}

/** 사이드바: 놓았다. 작업창 칸 위였으면 그 칸에 열고 true — 아니면 false(목록 안의 순서 바꾸기로). */
export function paneDrop(projectId: string, x: number, y: number): boolean {
  const side = paneSideAt(x, y);
  const drop = onDrop;
  paneDragEnd();
  if (!side || !drop) return false;
  drop(projectId, side);
  return true;
}
