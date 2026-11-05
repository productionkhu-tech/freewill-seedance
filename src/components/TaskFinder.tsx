// ─── 태스크 찾기 (Ctrl+F, 26.11.401~) ─────────────────────────────────────────────
// 태스크 ID(받은 파일 이름 · 경로째도)를 붙여 넣거나 쳐서 그 카드로 바로 간다. 프로젝트를 가리지 않는다. 맞는 규칙은 다른 검색창과
// 같고(src/lib/search-match.ts) 가는 길도 같다(store requestFindMessage).
//
// ★ ID 는 앞이 겹친다. 시댄스 ID 의 앞부분은 만든 시각이라(cgt-20261006233359-…) 같이 보낸 테이크는 끝 다섯 글자만 다르고, 조각으로
//   찾으면 여러 장이 걸린다. 그래서 ① 여럿이면 저절로 가지 않고 목록을 보여 준다 ② 후보끼리 같은 앞부분은 흐리고 갈리는 부분을 진하게
//   ③ 썸네일 · 프로젝트 · 시각 · 프롬프트를 같이 ④ 닫아도 검색어와 고른 줄을 남긴다 — 가 보고 아니면 Ctrl+F 로 돌아와 다음 줄로.
//   통째 ID 를 붙여 넣어 한 장만 걸릴 때만 바로 간다.
// ★ 키는 e.code 로 본다 — 자판이 한글이면 e.key 가 'ㄹ' 이다. 자판이 한글인 채로 친 글자도 영문으로 되돌려 찾는다(normalizeTaskQuery).
// ★ 줄 고르기는 mousemove 로만 받는다 — mouseenter 면 화살표로 목록이 굴러 가만한 커서 밑에 들어온 줄이 선택을 뺏는다(§7-47 과 같은 이유).
// ★ 여닫는 애니메이션은 없다. 단축키로 하루에도 여러 번 여는 창이라 움직이면 느리게만 보인다.
// ★ 스토어를 구독하지 않는다. 검색어가 바뀔 때 · 열 때 한 번 훑는다 — 켜 둔 동안 다른 카드 갱신으로 다시 그려지지 않게.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, CornerDownLeft, Loader2, Search } from 'lucide-react';
import { useAppStore, MODELS, requestFindMessage, type ChatMessage } from '../store';
import { PairThumb } from './ChatArea';
import { formatStamp } from '../lib/utils';
import { normalizeTaskQuery, taskIdMatch, TASK_QUERY_MIN, type TaskIdMatch } from '../lib/search-match';

type Hit = { projectId: string; projectName: string; msg: ChatMessage; match: TaskIdMatch };

const MAX_ROWS = 50;   // 이만큼 걸리면 고르는 게 아니라 더 쳐야 할 때다
const HANGUL = /[ㄱ-ㅣ가-힣]/;

function findTasks(q: string): Hit[] {
  if (q.length < TASK_QUERY_MIN) return [];
  const out: Hit[] = [];
  for (const p of useAppStore.getState().projects) {
    for (const m of p.messages) {
      const match = taskIdMatch(m.taskId, q);
      if (match) out.push({ projectId: p.id, projectName: p.name, msg: m, match });
    }
  }
  return out.sort((a, b) => a.match.rank - b.match.rank || b.msg.timestamp - a.msg.timestamp);
}

// 후보끼리 같은 앞부분의 길이. 전부 같은 ID 면(한 ID 가 여러 카드에) 흐릴 것이 없다.
function sharedPrefix(hits: Hit[]): number {
  if (hits.length < 2) return 0;
  const ids = hits.map(h => h.msg.taskId!.toLowerCase());
  let n = 0;
  while (n < ids[0].length && ids.every(s => s[n] === ids[0][n])) n++;
  return n === ids[0].length && ids.every(s => s.length === n) ? 0 : n;
}

// ID 한 줄 — 찾은 조각은 밝은 바탕, 후보끼리 같은 앞부분은 흐리게, 갈리는 부분은 진하게.
function IdText({ id, match, shared }: { id: string; match: TaskIdMatch; shared: number }) {
  const end = match.start + match.len;
  const cuts = [...new Set([0, shared, match.start, end, id.length])].filter(c => c <= id.length).sort((a, b) => a - b);
  return (
    <>
      {cuts.slice(0, -1).map((a, i) => {
        const b = cuts[i + 1];
        const cls = a >= match.start && b <= end ? 'bg-amber-200 text-gray-900 rounded-[3px]'
          : b <= shared ? 'text-gray-400'
          : 'text-gray-900 font-semibold';
        return <span key={a} className={cls}>{id.slice(a, b)}</span>;
      })}
    </>
  );
}

function ResultThumb({ m }: { m: ChatMessage }) {
  if (m.status === 'succeeded' && m.videoUrl) return <PairThumb m={m} className="w-[88px] h-[50px]" />;
  const busy = m.status === 'running' || m.status === 'queued';
  return (
    <div className="w-[88px] h-[50px] rounded-md bg-gray-100 shrink-0 flex items-center justify-center">
      {busy ? <Loader2 size={16} className="animate-spin text-gray-400" /> : <AlertCircle size={16} className="text-gray-400" />}
    </div>
  );
}

function ResultRow({ hit, shared, selected, onPick, onGo }: { key?: string; hit: Hit; shared: number; selected: boolean; onPick: () => void; onGo: () => void }) {
  const m = hit.msg;
  const s = m.usedSettings;
  const model = MODELS.find(x => x.id === s?.model)?.name || s?.model;
  const res = s?.resolution === '4k' ? '4K' : s?.resolution;
  return (
    <button type="button" role="option" aria-selected={selected} onMouseMove={onPick} onClick={onGo}
      className={`w-full flex items-center gap-3 px-2.5 py-2 rounded-lg text-left ${selected ? 'bg-indigo-50' : ''}`}>
      <ResultThumb m={m} />
      <div className="flex-1 min-w-0">
        <div className="font-mono text-[12.5px] leading-[1.35] break-all"><IdText id={m.taskId!} match={hit.match} shared={shared} /></div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-gray-500 min-w-0">
          <span className="font-medium text-gray-700 truncate">{hit.projectName}</span>
          <span className="shrink-0 tabular-nums">· {formatStamp(m.timestamp)}</span>
          {model && <span className="shrink-0">· {model}</span>}
          {res && <span className="shrink-0">· {res}</span>}
          {s?.draft && <span className="shrink-0 px-1 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold">Draft</span>}
          {m.status === 'failed' && <span className="shrink-0 px-1 rounded bg-red-100 text-red-600 text-[10px] font-semibold">실패</span>}
          {(m.status === 'running' || m.status === 'queued') && <span className="shrink-0 px-1 rounded bg-gray-100 text-gray-500 text-[10px] font-semibold">만드는 중</span>}
        </div>
        {m.promptText && <div className="mt-0.5 text-[11.5px] text-gray-400 truncate">{m.promptText.slice(0, 200).replace(/\s+/g, ' ')}</div>}
      </div>
      <CornerDownLeft size={14} className={`shrink-0 text-indigo-500 ${selected ? '' : 'invisible'}`} />
    </button>
  );
}

const Key = ({ children }: { children: string }) => (
  <kbd className="px-1 py-px rounded border border-gray-200 bg-gray-50 font-mono text-[10px] text-gray-500 leading-none">{children}</kbd>
);

export function TaskFinder() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');   // 닫아도 남긴다(맨 위 ★)
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const byKeyRef = useRef(false);         // 화살표로 옮겼을 때만 그 줄이 보이게 굴린다
  const openRef = useRef(open);
  openRef.current = open;
  // 열기 전에 글을 쓰던 자리. 작성 칸(contentEditable)은 다른 입력칸에 포커스가 가면 커서 자리를 잃어서 범위째 들고 있다가 돌려준다.
  const backRef = useRef<{ el: HTMLElement; range: Range | null } | null>(null);

  const close = (restore: boolean) => {
    setOpen(false);
    const back = backRef.current;
    backRef.current = null;
    if (!restore || !back?.el.isConnected) return;
    back.el.focus({ preventScroll: true });
    if (back.range) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(back.range);
    }
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyF') {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (openRef.current) { inputRef.current?.focus(); inputRef.current?.select(); return; }
        const el = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        const s = window.getSelection();
        backRef.current = el ? { el, range: el.isContentEditable && s?.rangeCount ? s.getRangeAt(0).cloneRange() : null } : null;
        setOpen(true);
        return;
      }
      // capture: 전체 갤러리 · 어셋 라이브러리의 Esc 보다 먼저 받아, 한 번에 이 창만 닫히게 한다.
      if (e.key === 'Escape' && openRef.current) {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useLayoutEffect(() => {
    if (open) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [open]);

  const q = normalizeTaskQuery(text);
  const hits = useMemo(() => (open ? findTasks(q) : []), [open, q]);
  const shown = hits.length > MAX_ROWS ? hits.slice(0, MAX_ROWS) : hits;
  const shared = useMemo(() => sharedPrefix(shown), [shown]);
  const cur = Math.min(sel, Math.max(shown.length - 1, 0));

  useLayoutEffect(() => {
    if (!byKeyRef.current) return;
    byKeyRef.current = false;
    // instant: 앱 전체가 scroll-behavior:smooth 라 그냥 두면 화살표를 누르고 있을 때 선택이 화면 밖으로 앞서 나간다.
    listRef.current?.children[cur]?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  }, [cur]);

  const go = (h: Hit) => {
    close(false);
    window.dispatchEvent(new Event('seedance:close-overlays'));   // 전체 갤러리 · 어셋 라이브러리에 가리지 않게
    requestFindMessage(h.projectId, h.msg.id);
  };

  // 통째 ID(또는 그것이 든 파일 이름)를 붙여 넣어 딱 한 장이면 묻지 않고 간다.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    const found = findTasks(normalizeTaskQuery(pasted));
    if (found.length === 1 && found[0].match.rank === 0) {
      e.preventDefault();
      setText(pasted.trim());
      setSel(0);
      go(found[0]);
    }
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;   // 한글 조합 중의 Enter · 화살표는 조합을 끝내는 키다
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!shown.length) return;
      byKeyRef.current = true;
      setSel((cur + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[cur]) go(shown[cur]);
    }
  };

  if (!open) return null;

  const tooShort = q.length > 0 && q.length < TASK_QUERY_MIN;
  const none = q.length >= TASK_QUERY_MIN && hits.length === 0;
  // 걸렸을 때만 알린다 — 안 걸렸으면 프롬프트를 친 것일 수 있고, 그때 'djqtsms' 는 잡음이다. 파일 이름 · 경로의 한글도 자판 실수가 아니다.
  const retyped = HANGUL.test(text) && (tooShort || (hits.length > 0 && hits[0].match.rank !== 0)) ? q : '';

  return createPortal(
    <div className="fixed inset-0 z-[300] bg-black/25 flex justify-center items-start px-4 pt-[9vh] text-gray-900"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(true); }}>
      <div className="w-full max-w-[680px] max-h-[74vh] flex flex-col break-keep break-words bg-white dark:bg-[#1c1c1e] border border-gray-200 rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2.5 px-3.5 h-12 shrink-0">
          <Search size={16} className="text-gray-400 shrink-0" />
          <input ref={inputRef} value={text} spellCheck={false} autoComplete="off" aria-label="태스크 ID 찾기"
            onChange={(e) => { setText(e.target.value); setSel(0); }} onKeyDown={onKeyDown} onPaste={onPaste}
            placeholder="태스크 ID 나 받은 파일 이름을 붙여 넣거나 쳐 보세요"
            className="flex-1 min-w-0 bg-transparent outline-none text-[14px] font-mono placeholder:font-sans placeholder:text-gray-400" />
          {hits.length > 1 && (
            <span className="shrink-0 px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700 text-[11px] font-semibold tabular-nums">{hits.length}개 겹침</span>
          )}
          <Key>Esc</Key>
        </div>

        {shown.length > 0 && (
          <div ref={listRef} role="listbox" className="min-h-0 overflow-y-auto border-t border-gray-100 p-1.5">
            {shown.map((h, i) => (
              <ResultRow key={h.msg.id} hit={h} shared={shared} selected={i === cur}
                onPick={() => { if (i !== sel) setSel(i); }} onGo={() => go(h)} />
            ))}
          </div>
        )}

        <div className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 border-t border-gray-100 text-[11.5px] text-gray-500 min-w-0">
          {!q && <span>ID 끝 다섯 글자만 쳐도 찾아요. 모든 프로젝트에서 찾습니다.</span>}
          {tooShort && <span>다섯 글자부터 찾아요 — 앞부분은 모든 ID 가 비슷해서요.</span>}
          {none && <span>이 PC 의 작업 기록에 없는 ID 예요. 프롬프트로 찾으려면 위쪽 검색창을 쓰세요.</span>}
          {shown.length === 1 && <><Key>Enter</Key><span>그 카드로 이동</span></>}
          {shown.length > 1 && <><Key>↑</Key><Key>↓</Key><span>고르기</span><span className="ml-1"><Key>Enter</Key></span><span>이동 · 아니면 Ctrl+F 로 돌아와 다음 줄로</span></>}
          {hits.length > MAX_ROWS && <span className="ml-auto shrink-0 text-amber-700">최근 {MAX_ROWS}개만 보여요 — 더 쳐서 좁혀 보세요</span>}
          {retyped && <span className="ml-auto shrink-0 font-mono text-gray-400 truncate">한글 자판 → {retyped}</span>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
