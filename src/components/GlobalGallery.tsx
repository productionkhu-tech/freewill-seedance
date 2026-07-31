import { useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Star, Download, RefreshCw, FolderOpen, LayoutGrid, ArrowRight, Filter, MessageSquare } from 'lucide-react';
import { useAppStore, MODELS, type ChatMessage } from '../store';
import { VideoPlayer, ClipStamp, downloadClip, revealClipFile } from './ChatArea';
import { formatStamp, formatStampFull } from '../lib/utils';

// ─────────────────────────────────────────────────────────────────────────────
// All-projects gallery.
//
// Every finished clip in the app, in one grid, filterable. The per-project gallery
// inside ChatArea answers "what did I make in THIS project"; this answers "where is
// that clip I made last Tuesday", which is the question you actually have when a
// project list has grown past a screenful.
//
// The Sidebar portals this to <body> (and owns the AnimatePresence) so it covers the
// whole window instead of being trapped inside the 256px rail.
//
// Perf, in three layers — opening used to hitch visibly:
//   1. PAGE_SIZE batching. The first paint renders 24 cards, not 500. More arrive as you
//      scroll (sentinel below the grid). Mounting 500 cards means 500 IntersectionObservers
//      constructed in one frame, which is the hitch — not the video loading.
//   2. content-visibility:auto per card. The browser skips layout+paint for cards that are
//      scrolled out, and contain-intrinsic-size keeps the scrollbar honest meanwhile.
//   3. VideoPlayer already lazy-mounts on intersection, so bytes only move for what's visible.
// ─────────────────────────────────────────────────────────────────────────────

type Row = ChatMessage & { projectId: string; projectName: string; projectIcon?: string };

const ALL = '전체';

// Quick buckets cover the common case; '직접' opens a from/to pair for anything else.
const PERIODS = [
  { id: 'all', label: '전체' },
  { id: 'today', label: '오늘' },
  { id: '7d', label: '7일' },
  { id: '30d', label: '30일' },
  { id: 'custom', label: '직접' },
] as const;
type PeriodId = typeof PERIODS[number]['id'];

const PAGE_SIZE = 24;

// Local-midnight boundaries. `new Date('2026-07-31')` would parse as UTC and silently
// shift the boundary by the timezone offset, dropping or adding a day's worth of clips.
function dayStart(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
}
function dayEnd(iso: string): number | null {
  const s = dayStart(iso);
  return s === null ? null : s + 86400_000 - 1; // inclusive of the whole "to" day
}
function presetStart(id: PeriodId): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (id === 'today') return d.getTime();
  if (id === '7d') return d.getTime() - 6 * 86400_000;  // today + previous 6 days
  if (id === '30d') return d.getTime() - 29 * 86400_000;
  return 0;
}
const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function Select({ label, value, options, onChange }: {
  label: string; value: string; options: string[]; onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-[12px]">
      <span className="text-gray-500 shrink-0">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className={`bg-white border rounded-lg px-2 py-1 text-[12px] outline-none transition-colors cursor-pointer
          ${value === ALL ? 'border-gray-200 text-gray-600' : 'border-indigo-300 text-indigo-700 font-medium'}`}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

export function GlobalGallery({ onClose }: { onClose: () => void }) {
  const projects = useAppStore(s => s.projects);
  const setCurrentProjectId = useAppStore(s => s.setCurrentProjectId);
  const updateMessage = useAppStore(s => s.updateMessage);

  const [projectFilter, setProjectFilter] = useState(ALL);
  const [modelFilter, setModelFilter] = useState(ALL);
  const [resFilter, setResFilter] = useState(ALL);
  const [ratioFilter, setRatioFilter] = useState(ALL);
  const [period, setPeriod] = useState<PeriodId>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Flatten every project's finished clips once. Newest first — the thing you are
  // looking for is almost always recent.
  const allRows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const p of projects) {
      for (const m of p.messages) {
        if (m.status !== 'succeeded' || !m.videoUrl) continue;
        out.push({ ...m, projectId: p.id, projectName: p.name, projectIcon: p.icon });
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }, [projects]);

  // Option lists are built from what actually EXISTS, not from the full catalog —
  // offering "4K" when nothing was ever rendered at 4K is a dead end for the user.
  const modelLabel = (id?: string) =>
    MODELS.find(m => m.id === id)?.name || id || '알 수 없음';
  const opts = useMemo(() => {
    const uniq = (xs: (string | undefined)[]) =>
      [ALL, ...Array.from(new Set(xs.filter(Boolean) as string[]))];
    return {
      projects: [ALL, ...Array.from(new Set(allRows.map(r => r.projectName)))],
      models: uniq(allRows.map(r => modelLabel(r.usedSettings?.model))),
      // API stores '4k' lowercase; show it the way the Resolution dropdown does.
      res: uniq(allRows.map(r => r.usedSettings?.resolution === '4k' ? '4K' : r.usedSettings?.resolution)),
      ratios: uniq(allRows.map(r => r.usedSettings?.ratio)),
    };
  }, [allRows]);

  // In 직접 mode an empty box means "unbounded on that side", so you can ask for
  // "everything before the 5th" without inventing a start date.
  const [since, until] = period === 'custom'
    ? [dayStart(fromDate) ?? 0, dayEnd(toDate) ?? Infinity]
    : [presetStart(period), Infinity];

  const rows = useMemo(() => allRows.filter(r => {
    if (projectFilter !== ALL && r.projectName !== projectFilter) return false;
    if (modelFilter !== ALL && modelLabel(r.usedSettings?.model) !== modelFilter) return false;
    if (resFilter !== ALL) {
      const res = r.usedSettings?.resolution === '4k' ? '4K' : r.usedSettings?.resolution;
      if (res !== resFilter) return false;
    }
    if (ratioFilter !== ALL && r.usedSettings?.ratio !== ratioFilter) return false;
    if (r.timestamp < since || r.timestamp > until) return false;
    if (starredOnly && !r.starred) return false;
    return true;
  }), [allRows, projectFilter, modelFilter, resFilter, ratioFilter, since, until, starredOnly]);

  // Any filter change resets the window — otherwise you narrow to 3 results and still
  // carry a "shown = 96" from before, or worse, land past the end of a shorter list.
  useEffect(() => { setShown(PAGE_SIZE); }, [projectFilter, modelFilter, resFilter, ratioFilter, since, until, starredOnly]);

  const visible = rows.slice(0, shown);
  const hasMore = rows.length > shown;

  // Grow the window when the sentinel below the grid comes into view.
  useEffect(() => {
    if (!hasMore) return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setShown(n => n + PAGE_SIZE);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, rows.length]);

  const anyFilter = projectFilter !== ALL || modelFilter !== ALL || resFilter !== ALL
    || ratioFilter !== ALL || period !== 'all' || starredOnly;
  const resetFilters = () => {
    setProjectFilter(ALL); setModelFilter(ALL); setResFilter(ALL);
    setRatioFilter(ALL); setPeriod('all'); setFromDate(''); setToDate(''); setStarredOnly(false);
  };

  const goToProject = (r: Row) => {
    setCurrentProjectId(r.projectId);
    onClose();
    // The project has to render before the message exists in the DOM to scroll to.
    setTimeout(() => {
      const el = document.getElementById(`msg-${r.id}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('ring-2', 'ring-indigo-400', 'rounded-2xl');
      setTimeout(() => el.classList.remove('ring-2', 'ring-indigo-400', 'rounded-2xl'), 1800);
    }, 180);
  };

  // Presentation lives in the Sidebar: it owns the portal, the AnimatePresence, and the
  // KEYED motion.div shell. This component is just the contents.
  // Why it has to be that way — twice burned:
  //   1. AnimatePresence outside a portal never sees the exit finish inside it.
  //   2. Even portal-first, a plain function component as the presence child doesn't get
  //      removed; the direct child must be a keyed motion element.
  // Both failures look identical and are nasty: the overlay lingers at opacity:0, still
  // `fixed inset-0`, eating every click while looking perfectly fine.
  return (
    <>
      {/* Header + filters */}
      <div className="shrink-0 bg-white border-b border-gray-200">
        <div className="flex items-center gap-3 px-5 py-3">
          <LayoutGrid size={18} className="text-indigo-500 shrink-0" />
          <h2 className="text-[16px] font-semibold tracking-tight">전체 갤러리</h2>
          <span className="text-[12px] text-gray-400 tabular-nums">
            {rows.length}
            {rows.length !== allRows.length && <span className="text-gray-300"> / {allRows.length}</span>}
            개
          </span>
          <div className="flex-1" />
          <button onClick={onClose} title="닫기 (Esc)"
            className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
            <X size={18} />
          </button>
        </div>
        <div className="flex items-center gap-3 px-5 pb-3 flex-wrap">
          <Filter size={13} className="text-gray-400 shrink-0" />
          <Select label="프로젝트" value={projectFilter} options={opts.projects} onChange={setProjectFilter} />
          <Select label="모델" value={modelFilter} options={opts.models} onChange={setModelFilter} />
          <Select label="해상도" value={resFilter} options={opts.res} onChange={setResFilter} />
          <Select label="비율" value={ratioFilter} options={opts.ratios} onChange={setRatioFilter} />
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-0.5">
            {PERIODS.map(p => (
              <button key={p.id} onClick={() => setPeriod(p.id)}
                className={`px-2 py-1 text-[12px] rounded-md transition-colors ${period === p.id
                  ? 'bg-white text-indigo-600 font-medium shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'}`}>
                {p.label}
              </button>
            ))}
          </div>
          <button onClick={() => setStarredOnly(v => !v)}
            className={`flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1 rounded-lg border transition-colors ${starredOnly
              ? 'text-amber-700 bg-amber-50 border-amber-300'
              : 'text-gray-500 bg-white border-gray-200 hover:border-amber-300 hover:text-amber-600'}`}>
            <Star size={13} className={starredOnly ? 'fill-amber-400 text-amber-500' : ''} /> 채택만
          </button>
          {anyFilter && (
            <button onClick={resetFilters}
              className="text-[12px] text-gray-400 hover:text-indigo-600 underline underline-offset-2 transition-colors">
              필터 초기화
            </button>
          )}
        </div>
        {period === 'custom' && (
          <div className="flex items-center gap-2 px-5 pb-3 text-[12px] flex-wrap">
            <span className="text-gray-400 pl-[21px]">기간</span>
            <input type="date" value={fromDate} max={toDate || todayISO()}
              onChange={(e) => setFromDate(e.target.value)}
              className="bg-white border border-gray-200 rounded-lg px-2 py-1 text-[12px] outline-none focus:border-indigo-300 tabular-nums" />
            <span className="text-gray-400">~</span>
            <input type="date" value={toDate} min={fromDate} max={todayISO()}
              onChange={(e) => setToDate(e.target.value)}
              className="bg-white border border-gray-200 rounded-lg px-2 py-1 text-[12px] outline-none focus:border-indigo-300 tabular-nums" />
            {(fromDate || toDate) && (
              <button onClick={() => { setFromDate(''); setToDate(''); }}
                className="text-[11px] text-gray-400 hover:text-indigo-600 underline underline-offset-2">
                날짜 지우기
              </button>
            )}
            <span className="text-gray-400">
              {!fromDate && !toDate ? '양쪽 다 비우면 전체입니다' : !fromDate ? `${toDate} 이전 전부` : !toDate ? `${fromDate} 이후 전부` : '시작·끝 날짜 포함'}
            </span>
          </div>
        )}
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-5">
        {rows.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3">
            <LayoutGrid size={44} className="text-gray-300" />
            <p className="text-[15px]">
              {allRows.length === 0 ? '아직 생성된 영상이 없습니다.' : '조건에 맞는 영상이 없습니다.'}
            </p>
            {anyFilter && allRows.length > 0 && (
              <button onClick={resetFilters} className="text-[13px] text-indigo-500 hover:text-indigo-600 font-medium">
                필터 초기화
              </button>
            )}
          </div>
        ) : (
          <>
          <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
            {visible.map(r => (
              <div key={r.id}
                // content-visibility lets the browser skip layout+paint for cards scrolled
                // out of view; contain-intrinsic-size stops the scrollbar from jumping while
                // they're skipped.
                style={{ contentVisibility: 'auto', containIntrinsicSize: '260px' } as any}
                className="bg-white rounded-xl shadow-sm border border-gray-200/80 overflow-hidden hover:shadow-md hover:border-gray-300 transition-all">
                <div className="aspect-video bg-black relative group">
                  <VideoPlayer src={r.videoUrl!} className="w-full h-full" is4k={r.usedSettings?.resolution === '4k'} />
                  <ClipStamp ms={r.timestamp} />
                  <button
                    onClick={(e) => { e.stopPropagation(); updateMessage(r.projectId, r.id, { starred: !r.starred }); }}
                    title={r.starred ? '채택 해제' : '컷 채택'}
                    className={`absolute top-2 right-2 z-10 p-1.5 rounded-full backdrop-blur-sm transition-all ${r.starred
                      ? 'bg-black/45 text-amber-400 opacity-100'
                      : 'bg-black/45 text-white/70 hover:text-amber-400 opacity-0 group-hover:opacity-100'}`}>
                    <Star size={15} className={r.starred ? 'fill-amber-400' : ''} />
                  </button>
                </div>
                <div className="p-3 space-y-2">
                  {/* Which project this came from — the whole point of a cross-project view */}
                  <button onClick={() => goToProject(r)}
                    title="이 프로젝트로 이동"
                    className="group/p flex items-center gap-1 max-w-full text-[11px] font-semibold text-indigo-500 hover:text-indigo-700 transition-colors">
                    <span className="shrink-0">
                      {r.projectIcon
                        ? (r.projectIcon.startsWith('data:')
                            ? <img src={r.projectIcon} alt="" className="w-3.5 h-3.5 rounded object-cover" />
                            : <span className="leading-none">{r.projectIcon}</span>)
                        : null}
                    </span>
                    <span className="truncate">{r.projectName}</span>
                    <ArrowRight size={11} className="shrink-0 opacity-0 group-hover/p:opacity-100 transition-opacity" />
                  </button>
                  <p className="text-[13px] text-gray-700 line-clamp-2 leading-snug h-[2.5em]">
                    {r.promptText || '프롬프트 없음'}
                  </p>
                  <div className="flex items-center gap-1 flex-wrap">
                    <button onClick={() => { if (r.videoUrl && r.taskId) downloadClip(r.id, r.videoUrl, r.taskId); }}
                      className={`flex items-center gap-1 text-[11px] font-medium px-1.5 py-1 rounded-md transition-colors shrink-0 ${r.downloadedAt
                        ? 'text-emerald-600 hover:bg-emerald-50'
                        : 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50'}`}>
                      {r.downloadedAt ? <RefreshCw size={12} /> : <Download size={12} />}
                      {r.downloadedAt ? '다시' : '다운로드'}
                    </button>
                    {r.downloadedPath && (
                      <button onClick={() => revealClipFile(r.downloadedPath, setNote)} title={r.downloadedPath}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors shrink-0">
                        <FolderOpen size={12} /> 폴더
                      </button>
                    )}
                    {/* Straight back to the message you typed this prompt in — the folder
                        button finds the FILE, this finds the CONVERSATION. */}
                    <button onClick={() => goToProject(r)} title="이 프롬프트를 쓴 곳으로 이동"
                      className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors shrink-0">
                      <MessageSquare size={12} /> 프롬프트
                    </button>
                    <span title={`생성 시각 ${formatStampFull(r.timestamp)}`}
                      className="text-[10px] text-gray-400 ml-auto tabular-nums shrink-0">
                      {formatStamp(r.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {hasMore && (
            <div ref={sentinelRef} className="py-6 flex items-center justify-center gap-2 text-[12px] text-gray-400">
              <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
              {rows.length - shown}개 더 불러오는 중…
            </div>
          )}
          </>
        )}
      </div>

      {/* Local toast — this view is a portal above ChatArea, so it can't use ChatArea's. */}
      <AnimatePresence>
        {note && (
          <motion.div
            initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
            className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[95] max-w-[90vw] flex items-start gap-2.5 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl shadow-lg px-3.5 py-2.5">
            <span className="text-[13px] leading-snug whitespace-pre-line">{note}</span>
            <button onClick={() => setNote(null)} className="shrink-0 text-amber-500 hover:text-amber-800 text-sm font-bold leading-none mt-0.5">✕</button>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
