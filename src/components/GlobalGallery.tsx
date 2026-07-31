import { useMemo, useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Star, Download, RefreshCw, FolderOpen, LayoutGrid, ArrowRight, Filter, MessageSquare, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore, MODELS, groupTree, type ChatMessage } from '../store';
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

// groupId, not groupName. Filter values used to be names, and names are neither stable
// (rename → the filter points at nothing) nor unique (two subfolders called "1차" under
// different parents would merge into one option). Ids are both.
type Row = ChatMessage & { projectId: string; projectName: string; projectIcon?: string; groupId?: string };

const NO_GROUP = '그룹 없음';

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

// `value` is what gets compared; `label` is what gets shown, when the two differ (group
// options carry an id as their value and the folder's name as their label).
type Opt = { value: string; count: number; label?: string };

// Compact filter dropdown.
// A native <select> was wrong here for two reasons: its popup grows with the option
// count (18 projects reaches halfway down the screen, and it only gets worse), and it
// can't show a per-option count. This one caps its height, scrolls, and filters by
// typing once the list is long enough to warrant it.
function FilterSelect({ label, value, options, onChange, searchAfter = 8, hint }: {
  label: string; value: string; options: Opt[]; onChange: (v: string) => void; searchAfter?: number; hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    // capture: beat the gallery's own Escape handler, or one press would close everything
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const text = (o: Opt) => o.label ?? o.value;
  const searchable = options.length > searchAfter;
  const shown = q.trim()
    ? options.filter(o => text(o).toLowerCase().includes(q.trim().toLowerCase()))
    : options;
  const active = value !== ALL;
  const current = text(options.find(o => o.value === value) ?? { value, count: 0 });

  return (
    <div className="flex items-center gap-1.5 text-[12px]" ref={boxRef} title={hint}>
      <span className="text-gray-500 shrink-0">{label}</span>
      <div className="relative">
        <button onClick={() => setOpen(v => !v)}
          className={`flex items-center gap-1 bg-white border rounded-lg pl-2 pr-1.5 py-1 text-[12px] transition-colors max-w-[170px]
            ${active ? 'border-indigo-300 text-indigo-700 font-medium' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
          <span className="truncate">{current}</span>
          <ChevronDown size={13} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-[91]" onClick={() => setOpen(false)} />
            <div className="absolute z-[92] mt-1 min-w-full w-max max-w-[260px] bg-white border border-gray-200 rounded-lg shadow-xl overflow-hidden">
              {searchable && (
                <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="검색…"
                  className="w-full px-2.5 py-1.5 text-[12px] border-b border-gray-100 outline-none placeholder-gray-300" />
              )}
              {/* Height cap is the whole point — the list scrolls instead of growing. */}
              <div className="max-h-[240px] overflow-y-auto">
                {shown.length === 0 && <div className="px-2.5 py-2 text-[12px] text-gray-400">일치하는 항목 없음</div>}
                {shown.map(o => (
                  <button key={o.value} onClick={() => { onChange(o.value); setOpen(false); }}
                    // count 0 is dimmed but still selectable — it answers "is there any
                    // 4K footage at all?" instead of hiding the question.
                    className={`w-full flex items-center gap-2 text-left px-2.5 py-1.5 text-[12px] transition-colors
                      ${value === o.value ? 'bg-indigo-50 text-indigo-700 font-medium' : o.count === 0 ? 'text-gray-300 hover:bg-gray-50' : 'text-gray-700 hover:bg-gray-50'}`}>
                    <span className="truncate flex-1">{text(o)}</span>
                    <span className="shrink-0 tabular-nums text-[11px] opacity-60">{o.count}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function GlobalGallery({ onClose }: { onClose: () => void }) {
  const projects = useAppStore(s => s.projects);
  const projectGroups = useAppStore(s => s.projectGroups);
  const setCurrentProjectId = useAppStore(s => s.setCurrentProjectId);
  const updateMessage = useAppStore(s => s.updateMessage);

  const [groupFilter, setGroupFilter] = useState(ALL);
  const [projectFilter, setProjectFilter] = useState(ALL);
  const [modelFilter, setModelFilter] = useState(ALL);
  const [resFilter, setResFilter] = useState(ALL);
  const [ratioFilter, setRatioFilter] = useState(ALL);
  const [durFilter, setDurFilter] = useState(ALL);
  const [period, setPeriod] = useState<PeriodId>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) setScrolled(el.scrollTop > 300);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Flatten every project's finished clips once. Newest first — the thing you are
  // looking for is almost always recent.
  const allRows = useMemo<Row[]>(() => {
    const live = new Set(projectGroups.map(g => g.id));
    const out: Row[] = [];
    for (const p of projects) {
      for (const m of p.messages) {
        if (m.status !== 'succeeded' || !m.videoUrl) continue;
        out.push({
          ...m, projectId: p.id, projectName: p.name, projectIcon: p.icon,
          // A project filed under a group that no longer exists counts as ungrouped —
          // same rule the sidebar uses, so the two views can't disagree.
          groupId: p.groupId && live.has(p.groupId) ? p.groupId : undefined,
        });
      }
    }
    return out.sort((a, b) => b.timestamp - a.timestamp);
  }, [projects, projectGroups]);

  const modelLabel = (id?: string) =>
    MODELS.find(m => m.id === id)?.name || id || '알 수 없음';
  // API stores '4k' lowercase; show it the way the Resolution dropdown does.
  const resLabel = (r?: string) => (r === '4k' ? '4K' : r);
  // ★ This is the duration that was REQUESTED, not the length of the file that came back.
  // Nothing else exists to filter on: the app never records the actual length (the task
  // response's duration isn't kept), and reading it off the <video> would only work for
  // clips that have already loaded — a filter that quietly skips everything you haven't
  // scrolled past is worse than one with a clear meaning.
  // So -1 stays '자동' rather than being resolved to a number it can't know.
  const durKey = (d?: number) => (d == null ? undefined : d === -1 ? '자동' : `${d}초`);

  // Two kinds of filter, deliberately built differently:
  //   · FIXED vocabularies (resolution, ratio) → show the WHOLE ladder, in its canonical
  //     order, even at count 0. "Is there any 4K in here?" is a real question, and a list
  //     that silently omits 4K answers it by looking broken.
  //   · OPEN sets (project, model) → only what exists. These grow without bound and
  //     listing every model that ever shipped would be noise.
  // Everything carries a count, so an empty choice is visibly empty rather than a dead end.
  const RES_LADDER = ['480p', '720p', '1080p', '4K'];
  const RATIO_LADDER = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  const opts = useMemo(() => {
    const tally = (pick: (r: Row) => string | undefined) => {
      const m = new Map<string, number>();
      for (const r of allRows) { const k = pick(r); if (k) m.set(k, (m.get(k) || 0) + 1); }
      return m;
    };
    const withAll = (m: Map<string, number>, keys: string[]): Opt[] =>
      [{ value: ALL, count: allRows.length }, ...keys.map(k => ({ value: k, count: m.get(k) || 0 }))];

    const mm = tally(r => modelLabel(r.usedSettings?.model));
    const rm = tally(r => resLabel(r.usedSettings?.resolution));
    const am = tally(r => r.usedSettings?.ratio);
    // Any stray value not in the canonical ladder (older clip, future preset) still gets
    // listed — appended after the ladder rather than dropped.
    const extra = (m: Map<string, number>, ladder: string[]) => [...m.keys()].filter(k => !ladder.includes(k));
    // Groups in sidebar order — parent, then its subfolders indented — with '그룹 없음'
    // last, so the filter reads the way the sidebar looks.
    // A PARENT counts (and selects) its whole subtree: asking for "광고" and being shown
    // only the clips that happen to sit directly in it, while its subfolders are excluded,
    // would be a filter that lies about what it contains.
    const byGroup = new Map<string, number>();
    let ungrouped = 0;
    for (const r of allRows) {
      if (r.groupId) byGroup.set(r.groupId, (byGroup.get(r.groupId) || 0) + 1);
      else ungrouped++;
    }
    const t = groupTree(projectGroups);
    const groups: Opt[] = [{ value: ALL, count: allRows.length }];
    for (const root of t.roots) {
      const kids = t.childrenOf(root.id);
      groups.push({
        value: root.id, label: root.name,
        count: (byGroup.get(root.id) || 0) + kids.reduce((n, k) => n + (byGroup.get(k.id) || 0), 0),
      });
      // "부모 › 자식" rather than an indent: the label also has to work as the chip on the
      // closed dropdown, where a bare "1차" says nothing about which folder's 1차 it is.
      for (const k of kids) groups.push({ value: k.id, label: `${root.name} › ${k.name}`, count: byGroup.get(k.id) || 0 });
    }
    if (ungrouped) groups.push({ value: NO_GROUP, count: ungrouped });

    // Duration is an OPEN set spanning three different models' ranges (2.0 is 4–15,
    // 2.5 demo 4–30, 옴니 3–10), so a fixed ladder would either be mostly empty rows or
    // wrong. Only what exists, sorted as numbers — '자동' last, since it isn't one.
    const dm = tally(r => durKey(r.usedSettings?.duration));
    const durKeys = [...dm.keys()].sort((a, b) => {
      if (a === '자동') return 1;
      if (b === '자동') return -1;
      return parseInt(a) - parseInt(b);
    });
    // Projects by id, for the same reason groups are: a name is neither stable nor
    // guaranteed unique. New names can't collide (the store appends "(1)"), but data
    // written before that rule — or restored from an old backup — still can, and a
    // name-keyed filter MERGES those two projects into one option that shows both
    // projects' clips. By id they stay separate whatever they are called.
    const seenP = new Set<string>();
    const projectOpts: Opt[] = [{ value: ALL, count: allRows.length }];
    for (const r of allRows) {
      if (seenP.has(r.projectId)) continue;
      seenP.add(r.projectId);
      projectOpts.push({
        value: r.projectId, label: r.projectName,
        count: allRows.reduce((n, x) => n + (x.projectId === r.projectId ? 1 : 0), 0),
      });
    }
    return {
      groups,
      durations: withAll(dm, durKeys),
      projects: projectOpts,
      models: withAll(mm, MODELS.map(m => m.name).filter(n => mm.has(n)).concat(extra(mm, MODELS.map(m => m.name)))),
      res: withAll(rm, [...RES_LADDER, ...extra(rm, RES_LADDER)]),
      ratios: withAll(am, [...RATIO_LADDER, ...extra(am, RATIO_LADDER)]),
    };
  }, [allRows, projectGroups]);

  // ★ Filter values are NAMES, and names are not stable — rename a group or a project and
  // the selection points at something that no longer exists. The grid then shows 0 of N
  // with a filter chip naming a group you just renamed, which reads as a broken gallery.
  // Whenever a selection falls out of its own option list, drop it back to 전체.
  useEffect(() => {
    const has = (opts: Opt[], v: string) => opts.some(o => o.value === v);
    if (!has(opts.groups, groupFilter)) setGroupFilter(ALL);
    if (!has(opts.projects, projectFilter)) setProjectFilter(ALL);
    if (!has(opts.models, modelFilter)) setModelFilter(ALL);
    if (!has(opts.res, resFilter)) setResFilter(ALL);
    if (!has(opts.ratios, ratioFilter)) setRatioFilter(ALL);
    if (!has(opts.durations, durFilter)) setDurFilter(ALL);
  }, [opts, groupFilter, projectFilter, modelFilter, resFilter, ratioFilter, durFilter]);

  // In 직접 mode an empty box means "unbounded on that side", so you can ask for
  // "everything before the 5th" without inventing a start date.
  const [since, until] = period === 'custom'
    ? [dayStart(fromDate) ?? 0, dayEnd(toDate) ?? Infinity]
    : [presetStart(period), Infinity];

  // Which group ids a group selection accepts. Picking a parent accepts its subfolders
  // too — one set built once, rather than a tree walk per row per render.
  const groupMatch = useMemo(() => {
    if (groupFilter === ALL || groupFilter === NO_GROUP) return null;
    return new Set([groupFilter, ...groupTree(projectGroups).childrenOf(groupFilter).map(g => g.id)]);
  }, [groupFilter, projectGroups]);

  const rows = useMemo(() => allRows.filter(r => {
    if (groupFilter === NO_GROUP) { if (r.groupId) return false; }
    else if (groupMatch && !(r.groupId && groupMatch.has(r.groupId))) return false;
    if (projectFilter !== ALL && r.projectId !== projectFilter) return false;
    if (modelFilter !== ALL && modelLabel(r.usedSettings?.model) !== modelFilter) return false;
    if (resFilter !== ALL) {
      const res = r.usedSettings?.resolution === '4k' ? '4K' : r.usedSettings?.resolution;
      if (res !== resFilter) return false;
    }
    if (ratioFilter !== ALL && r.usedSettings?.ratio !== ratioFilter) return false;
    if (durFilter !== ALL && durKey(r.usedSettings?.duration) !== durFilter) return false;
    if (r.timestamp < since || r.timestamp > until) return false;
    if (starredOnly && !r.starred) return false;
    return true;
  }), [allRows, groupFilter, groupMatch, projectFilter, modelFilter, resFilter, ratioFilter, durFilter, since, until, starredOnly]);

  // Any filter change resets the window — otherwise you narrow to 3 results and still
  // carry a "shown = 96" from before, or worse, land past the end of a shorter list.
  useEffect(() => { setShown(PAGE_SIZE); }, [groupFilter, projectFilter, modelFilter, resFilter, ratioFilter, durFilter, since, until, starredOnly]);

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

  const anyFilter = groupFilter !== ALL || projectFilter !== ALL || modelFilter !== ALL || resFilter !== ALL
    || ratioFilter !== ALL || durFilter !== ALL || period !== 'all' || starredOnly;
  const resetFilters = () => {
    setGroupFilter(ALL); setProjectFilter(ALL); setModelFilter(ALL); setResFilter(ALL);
    setRatioFilter(ALL); setDurFilter(ALL); setPeriod('all'); setFromDate(''); setToDate(''); setStarredOnly(false);
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
          {projectGroups.length > 0 && (
            <FilterSelect label="그룹" value={groupFilter} options={opts.groups} onChange={setGroupFilter} />
          )}
          <FilterSelect label="프로젝트" value={projectFilter} options={opts.projects} onChange={setProjectFilter} />
          <FilterSelect label="모델" value={modelFilter} options={opts.models} onChange={setModelFilter} />
          <FilterSelect label="해상도" value={resFilter} options={opts.res} onChange={setResFilter} />
          <FilterSelect label="비율" value={ratioFilter} options={opts.ratios} onChange={setRatioFilter} />
          <FilterSelect label="길이" value={durFilter} options={opts.durations} onChange={setDurFilter}
            hint="생성할 때 지정한 길이입니다. Auto로 만든 컷은 실제 길이를 앱이 알 수 없어 '자동'으로 따로 묶입니다." />
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
      <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-y-auto p-5">
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
          {/* End marker for the "최하단" button — an element to aim at, so the target
              survives the list growing as content-visibility resolves real card heights. */}
          <div ref={bottomRef} className="h-px" />
          </>
        )}
      </div>

      {/* Jump to top / bottom. Fixed to the viewport, not the scroll container, so it
          can't be dragged out of reach by the content.
          ★ "최하단" first mounts the whole remaining list. Without that it would only
          reach the bottom of the current page and the sentinel would quietly load more —
          i.e. it wouldn't actually be the bottom, which is the one thing the button
          promises. Two frames: one for React to mount the rest, one to measure it. */}
      {rows.length > PAGE_SIZE && (
        <div className="fixed bottom-5 right-5 z-[93] flex flex-col gap-1.5">
          <button
            onClick={() => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
            title="최상단으로"
            className={`w-9 h-9 flex items-center justify-center rounded-full bg-white/95 border border-gray-200 text-gray-500 shadow-md backdrop-blur-sm transition-all hover:text-indigo-600 hover:border-indigo-200
              ${scrolled ? 'opacity-100' : 'opacity-0 pointer-events-none translate-y-1'}`}>
            <ChevronUp size={17} />
          </button>
          <button
            onClick={() => {
              setShown(rows.length);
              // ★ Aim at the END MARKER, not at a pixel offset. content-visibility:auto only
              // ESTIMATES off-screen cards (contain-intrinsic-size); as the scroll passes over
              // them their real heights land and the document grows underneath the animation,
              // so any precomputed scrollTop stops short. An element reference survives that —
              // it's still the last thing in the list however tall the list became.
              // Two passes: one to travel, one to settle after the growth stops.
              // Travel by element, finish by pixel: scrollIntoView gets us to the marker
              // while the list is still resolving, then once heights have settled a plain
              // scrollTo closes the last gap (the marker aligns to its own bottom edge, not
              // past the container's padding).
              const toMarker = (behavior: ScrollBehavior) => bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
              const toEnd = () => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; };
              requestAnimationFrame(() => requestAnimationFrame(() => {
                toMarker('smooth');
                setTimeout(() => toMarker('auto'), 600);
                setTimeout(toEnd, 900);
                setTimeout(toEnd, 1400); // last word, after content-visibility has settled
              }));
            }}
            title={hasMore ? `최하단으로 (남은 ${rows.length - shown}개까지 모두 표시)` : '최하단으로'}
            className="w-9 h-9 flex items-center justify-center rounded-full bg-white/95 border border-gray-200 text-gray-500 shadow-md backdrop-blur-sm transition-colors hover:text-indigo-600 hover:border-indigo-200">
            <ChevronDown size={17} />
          </button>
        </div>
      )}

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
