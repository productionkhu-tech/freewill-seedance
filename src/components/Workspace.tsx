// ─── 작업창 (26.10.2001~ 나누기) ─────────────────────────────────────────────────
// 프로젝트 목록(사이드바)과 설정 패널 사이. 한 칸이면 예전과 똑같이 ChatArea 하나, 나누면 둘 — 규칙은 src/lib/split.ts.
//
// ★ 칸마다 ChatArea 가 하나씩 붙어 있고, 칸의 '자리' 는 CSS order 로만 정한다. 자리를 바꿔도 두 ChatArea 는 그대로
//   있으므로 쓰던 글 · 스크롤 · 갤러리가 칸째로 옮겨 간다. 0번 칸은 늘 같은 자리(첫 자식)에 있어서 나누고 닫아도
//   다시 만들어지지 않는다 — 그래서 받은 영상 다운로드 표시(0번 칸 몫)가 끊기지 않는다.
// ★ 칸 안을 누르면(포인터 · 포커스) 그 칸이 '손대는 칸' 이 된다. 앱 전체의 지금 프로젝트(설정 패널 · 목록 강조 ·
//   에이전트)가 그 칸의 것으로 바뀐다.
// ★ 메모리: 칸은 둘까지만. 닫은 칸의 ChatArea 는 통째로 내려가 그 안의 영상 · 이미지가 함께 풀린다. 스토어(작업 기록 ·
//   어셋 목록)는 두 칸이 같이 본다 — 칸이 늘어도 복사본은 생기지 않는다.

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { useAppStore } from '../store';
import { ChatArea } from './ChatArea';
import { slotAt, type PaneSide, type PaneSlot } from '../lib/split';
import { registerPaneDropTarget, onPaneDrag, paneSideAt } from '../lib/pane-drag';

const RATIO_KEY = 'seedance-split-ratio';   // 왼쪽 칸의 너비 비율 — 이 PC 의 화면 취향이라 브라우저 저장소에 둔다
const MIN_PANE = 360;                       // px. 이보다 좁으면 머리줄 · 작성 칸 버튼이 겹친다(창이 더 좁으면 반반으로 줄어든다)

function readRatio(): number {
  try {
    const v = Number(localStorage.getItem(RATIO_KEY));
    return v > 0.1 && v < 0.9 ? v : 0.5;
  } catch { return 0.5; }
}

export function Workspace() {
  const split = useAppStore((s) => s.split);
  const paneFocus = useAppStore((s) => s.paneFocus);
  const currentProjectId = useAppStore((s) => s.currentProjectId);
  const areaRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(readRatio);
  const ratioRef = useRef(ratio);
  ratioRef.current = ratio;
  // 목록에서 프로젝트를 끄는 중이고 포인터가 작업창 위에 있으면 그쪽(왼쪽 · 오른쪽).
  const [drag, setDrag] = useState<{ projectId: string; side: PaneSide } | null>(null);

  // 놓을 곳 등록 — 나눠 보는 중이면 칸 경계(구분선)로, 아니면 가운데로 왼쪽/오른쪽을 가른다.
  useEffect(() => registerPaneDropTarget(
    (x, y) => {
      const el = areaRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const mid = r.left + r.width * (useAppStore.getState().split ? ratioRef.current : 0.5);
      return x < mid ? 'left' : 'right';
    },
    (projectId, side) => useAppStore.getState().openInPane(projectId, side),
  ), []);

  useEffect(() => onPaneDrag((d) => {
    const side = d ? paneSideAt(d.x, d.y) : null;
    setDrag(prev => {
      if (!d || !side) return prev ? null : prev;
      return prev && prev.projectId === d.projectId && prev.side === side ? prev : { projectId: d.projectId, side };
    });
  }), []);

  // 칸 안을 누르면 그 칸에 손댄다. 값이 같으면 스토어가 아무것도 하지 않는다(focusPane).
  const focus = (slot: PaneSlot) => {
    const st = useAppStore.getState();
    if (st.split && st.paneFocus !== slot) st.focusPane(slot);
  };

  // 구분선 끌기 — 두 칸이 MIN_PANE 아래로 줄지 않는 데까지. 두 번 누르면 반반.
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = areaRef.current;
    if (!el) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return;
      const lo = Math.min(0.5, MIN_PANE / r.width);
      setRatio(Math.max(lo, Math.min(1 - lo, (ev.clientX - r.left) / r.width)));
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      try { localStorage.setItem(RATIO_KEY, String(ratioRef.current)); } catch { /* 다음에 반반으로 */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const resetRatio = () => {
    setRatio(0.5);
    try { localStorage.setItem(RATIO_KEY, '0.5'); } catch { /* 그대로 */ }
  };

  const leftSlot: PaneSlot = split ? slotAt(split, 'left') : 0;
  // 칸의 크기와 자리. 나누지 않았으면 예전처럼 꽉 채운다. 최소 너비는 '반' 을 넘지 않게 — 창이 좁으면 둘 다 반으로 준다.
  const paneStyle = (slot: PaneSlot): CSSProperties => {
    if (!split) return { flex: '1 1 0%' };
    const isLeft = slot === leftSlot;
    return { order: isLeft ? 0 : 2, flex: `${isLeft ? ratio : 1 - ratio} 1 0%`, minWidth: `min(${MIN_PANE}px, calc(50% - 3px))` };
  };
  const slot0 = split ? split.slots[0] : currentProjectId;
  const slot1 = split ? split.slots[1] : null;

  const pane = (slot: PaneSlot, projectId: string | null) => {
    const active = !split || paneFocus === slot;
    return (
      <div key={`pane-${slot}`} style={paneStyle(slot)} className="relative flex min-w-0 h-full"
        data-pane-slot={slot} data-pane-active={active ? '1' : '0'}
        // 파일을 놓아도 그 칸에 손댄다(26.10.2004) — 탐색기에서 끌어다 놓기는 pointerdown 이 없어서, 레퍼런스 · 불러온 설정은
        // 놓은 칸의 프로젝트에 들어가는데 설정 패널은 다른 칸을 보여 줘 붙은 것을 못 본 채 보낼 수 있었다. 지나가기만 할 때
        // (dragenter)는 바꾸지 않는다 — 패널이 따라 출렁이지 않게.
        onPointerDownCapture={() => focus(slot)} onFocusCapture={() => focus(slot)} onDropCapture={() => focus(slot)}>
        {/* 지금 손대는 칸 — 위쪽 가는 띠. 설정 패널이 이 칸의 프로젝트를 보여 준다. */}
        {split && active && <div className="absolute top-0 inset-x-0 h-[3px] bg-indigo-500 z-30 pointer-events-none" />}
        {projectId && <ChatArea projectId={projectId} slot={slot} split={!!split} active={active} />}
      </div>
    );
  };

  return (
    <div ref={areaRef} className="flex-1 flex min-w-0 h-full relative">
      {pane(0, slot0)}
      {split && (
        <div key="divider" style={{ order: 1 }} title="끌어서 너비 조절 · 두 번 누르면 반반"
          onPointerDown={startResize} onDoubleClick={resetRatio}
          className="relative w-[7px] -mx-[3px] shrink-0 z-40 cursor-col-resize group">
          <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-gray-300 dark:bg-white/15 group-hover:w-[3px] group-hover:bg-indigo-400 transition-all" />
        </div>
      )}
      {split && slot1 && pane(1, slot1)}
      {drag && <DropBoard drag={drag} ratio={split ? ratio : 0.5} />}
    </div>
  );
}

// 끄는 동안 작업창 위에 뜨는 판 — 놓으면 무슨 일이 일어나는지 쪽마다 미리 말한다.
function DropBoard({ drag, ratio }: { drag: { projectId: string; side: PaneSide }; ratio: number }) {
  const st = useAppStore.getState();
  const sp = st.split;
  const nameOf = (id: string | null | undefined) => st.projects.find(p => p.id === id)?.name || '';
  const dragged = nameOf(drag.projectId);
  const say = (side: PaneSide): { title: string; sub?: string; off?: boolean } => {
    if (!sp) {
      if (st.currentProjectId === drag.projectId) return { title: '지금 열려 있는 프로젝트예요', off: true };
      return { title: side === 'left' ? '왼쪽에 열기' : '오른쪽에 열기', sub: `${nameOf(st.currentProjectId)} 은(는) ${side === 'left' ? '오른쪽' : '왼쪽'}으로` };
    }
    const k = slotAt(sp, side);
    if (sp.slots[k] === drag.projectId) return { title: '여기 열려 있어요', off: true };
    if (sp.slots[k === 0 ? 1 : 0] === drag.projectId) return { title: '이쪽으로 옮기기', sub: '두 칸의 자리를 바꿔요' };
    return { title: '여기에 열기', sub: `지금 칸: ${nameOf(sp.slots[k])}` };
  };
  return (
    <div className="absolute inset-0 z-[70] flex gap-3 p-3 pointer-events-none">
      {(['left', 'right'] as PaneSide[]).map((side) => {
        const s = say(side);
        const on = drag.side === side && !s.off;
        return (
          <div key={side} style={{ flex: `${side === 'left' ? ratio : 1 - ratio} 1 0%` }}
            className={`min-w-0 rounded-2xl border-4 border-dashed flex flex-col items-center justify-center text-center px-4 transition-colors ${
              s.off ? 'border-gray-300/70 bg-gray-50/70 dark:bg-black/30'
                : on ? 'border-indigo-500 bg-indigo-100/90 dark:bg-indigo-500/25'
                  : 'border-indigo-300/70 bg-indigo-50/60 dark:bg-indigo-500/10'}`}>
            {!s.off && sp && sp.slots.includes(drag.projectId) && <ArrowLeftRight size={28} className="text-indigo-500 mb-2" />}
            <div className={`text-lg font-bold ${s.off ? 'text-gray-400' : 'text-indigo-700 dark:text-indigo-200'}`}>{s.title}</div>
            {dragged && !s.off && <div className="mt-1 text-[13px] text-indigo-600/90 dark:text-indigo-200/80 truncate max-w-full">{dragged}</div>}
            {s.sub && <div className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-300/70 truncate max-w-full">{s.sub}</div>}
          </div>
        );
      })}
    </div>
  );
}
