import { useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X, Star, Download, RefreshCw, FolderOpen, LayoutGrid, ArrowRight, Filter } from 'lucide-react';
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
// Rendered through a portal from the Sidebar so it covers the whole window rather
// than being trapped inside the 256px rail.
//
// Perf: VideoPlayer lazy-mounts on intersection (500px margin), so a 500-clip grid
// still only fetches the handful on screen. That is the only reason this can render
// everything at once without a virtualizer.
// ─────────────────────────────────────────────────────────────────────────────

type Row = ChatMessage & { projectId: string; projectName: string; projectIcon?: string };

const ALL = '전체';

// Date buckets. Deliberately coarse — "which day-ish" is the real question, and a
// date-range picker would be more UI than the job needs.
const PERIODS = [
  { id: 'all', label: '전체' },
  { id: 'today', label: '오늘' },
  { id: '7d', label: '7일' },
  { id: '30d', label: '30일' },
] as const;
type PeriodId = typeof PERIODS[number]['id'];

function periodStart(id: PeriodId): number {
  if (id === 'all') return 0;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (id === 'today') return d.getTime();
  if (id === '7d') return d.getTime() - 6 * 86400_000;  // today + previous 6 days
  return d.getTime() - 29 * 86400_000;
}

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
  const [starredOnly, setStarredOnly] = useState(false);
  const [note, setNote] = useState<string | null>(null);

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

  const since = periodStart(period);
  const rows = useMemo(() => allRows.filter(r => {
    if (projectFilter !== ALL && r.projectName !== projectFilter) return false;
    if (modelFilter !== ALL && modelLabel(r.usedSettings?.model) !== modelFilter) return false;
    if (resFilter !== ALL) {
      const res = r.usedSettings?.resolution === '4k' ? '4K' : r.usedSettings?.resolution;
      if (res !== resFilter) return false;
    }
    if (ratioFilter !== ALL && r.usedSettings?.ratio !== ratioFilter) return false;
    if (r.timestamp < since) return false;
    if (starredOnly && !r.starred) return false;
    return true;
  }), [allRows, projectFilter, modelFilter, resFilter, ratioFilter, since, starredOnly]);

  const anyFilter = projectFilter !== ALL || modelFilter !== ALL || resFilter !== ALL
    || ratioFilter !== ALL || period !== 'all' || starredOnly;
  const resetFilters = () => {
    setProjectFilter(ALL); setModelFilter(ALL); setResFilter(ALL);
    setRatioFilter(ALL); setPeriod('all'); setStarredOnly(false);
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

  return createPortal(
    // No `exit` prop: the parent mounts/unmounts this directly rather than through
    // AnimatePresence (see the note in Sidebar), so an exit animation would never run.
    // Claiming one in the code would just mislead the next reader.
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[90] bg-[#f5f5f7] flex flex-col text-gray-900"
    >
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
          <div className="grid grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-4">
            {rows.map(r => (
              <div key={r.id}
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
                    <span title={`생성 시각 ${formatStampFull(r.timestamp)}`}
                      className="text-[10px] text-gray-400 ml-auto tabular-nums shrink-0">
                      {formatStamp(r.timestamp)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
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
    </motion.div>,
    document.body
  );
}
