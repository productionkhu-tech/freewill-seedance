import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Plus, MessageSquare, Trash2, Edit2, Search, Loader2, PanelLeftClose, PanelLeftOpen, Sparkles, BarChart3, FolderDown, FolderOpen, AlertTriangle, LayoutGrid, Upload, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore, type Project } from '../store';
import { cn, getBlobCacheStats, clearBlobCache } from '../lib/utils';
import { GlobalGallery } from './GlobalGallery';

// ─── Project icon ────────────────────────────────────────────────────────────
// Emoji are just characters — the OS font draws them (Apple emoji on macOS, Segoe UI
// Emoji on Windows), so "기본 이모티콘" costs literally nothing to ship and always
// matches the platform the user is on.
const ICON_EMOJIS = [
  '🎬', '🎥', '📹', '🎞️', '🍿', '✨', '🔥', '⭐',
  '💡', '🎨', '🖌️', '🧪', '🚀', '🛠️', '📦', '🗂️',
  '📌', '🏷️', '🎯', '✅', '⏳', '🐣', '🐳', '🦊',
  '🐼', '🌊', '🌋', '🌙', '☀️', '🌈', '🍀', '🌸',
  '🍎', '🍕', '☕', '🎧', '🎸', '🕹️', '💎', '👑',
];

// Downscale an uploaded image to a 64px square PNG data URL.
// 64px because the icon renders at 16px (≈32px on a 2x display) — anything larger is
// bytes that live in the persisted blob forever and never reach a pixel. Center-crop
// rather than letterbox: the slot is square, and fitting a wide logo into it would
// shrink the logo to an unreadable band.
function fileToIconDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const S = 64;
      const canvas = document.createElement('canvas');
      canvas.width = S; canvas.height = S;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('canvas 사용 불가'));
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다')); };
    img.src = url;
  });
}

// The icon itself: uploaded PNG › emoji › default chat glyph.
function ProjectIcon({ icon, size = 16 }: { icon?: string; size?: number }) {
  if (icon?.startsWith('data:')) {
    return <img src={icon} alt="" className="rounded-[4px] object-cover shrink-0" style={{ width: size, height: size }} />;
  }
  if (icon) {
    return <span className="shrink-0 leading-none text-center" style={{ fontSize: size - 1, width: size }}>{icon}</span>;
  }
  return <MessageSquare size={size} className="shrink-0 opacity-70" />;
}

// Emoji/PNG picker, portaled and anchored to the icon that opened it. Portaled for the
// same reason as the delete modal: the sidebar is overflow-hidden and width-animated,
// which clips (and can re-anchor) fixed children.
function IconPicker({ anchor, current, onPick, onClose }: {
  anchor: DOMRect; current?: string;
  onPick: (icon: string | undefined) => void;
  onClose: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const PANEL_W = 268, PANEL_H = 250;
  // Keep the panel on screen when the row is near the bottom / right edge.
  const left = Math.min(anchor.left, window.innerWidth - PANEL_W - 8);
  const top = anchor.bottom + PANEL_H > window.innerHeight
    ? Math.max(8, anchor.top - PANEL_H - 6)
    : anchor.bottom + 6;

  return createPortal(
    <div className="fixed inset-0 z-[110]" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        onClick={(e) => e.stopPropagation()}
        style={{ left, top, width: PANEL_W }}
        className="absolute bg-white rounded-xl shadow-2xl border border-gray-200 p-2.5 text-gray-900"
      >
        <div className="grid grid-cols-8 gap-0.5 max-h-[152px] overflow-y-auto">
          {ICON_EMOJIS.map(e => (
            <button key={e} onClick={() => { onPick(e); onClose(); }}
              className={`h-[30px] rounded-md text-[17px] leading-none transition-colors ${current === e ? 'bg-indigo-100 ring-1 ring-indigo-300' : 'hover:bg-gray-100'}`}>
              {e}
            </button>
          ))}
        </div>
        {err && <p className="text-[11px] text-red-500 mt-1.5 px-0.5">{err}</p>}
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-100">
          <label className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11.5px] font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer transition-colors">
            <Upload size={12} /> PNG 업로드
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0]; e.target.value = '';
                if (!f) return;
                try { onPick(await fileToIconDataUrl(f)); onClose(); }
                catch (x: any) { setErr(x?.message || '변환 실패'); }
              }} />
          </label>
          <button onClick={() => { onPick(undefined); onClose(); }}
            title="기본 아이콘으로"
            className="flex items-center gap-1.5 px-2 py-1.5 text-[11.5px] font-medium text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
            <RotateCcw size={12} /> 기본
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

// Has this project finished something the user hasn't looked at?
// The open project never badges — you are, by definition, looking at it (App.tsx keeps
// its lastSeenAt current), so this is purely about the OTHER projects in the list.
function unseenDoneCount(p: Project, isCurrent: boolean): number {
  if (isCurrent) return 0;
  const seen = p.lastSeenAt || 0;
  let n = 0;
  for (const m of p.messages) {
    if (m.status === 'succeeded' && (m.endTime || m.timestamp) > seen) n++;
  }
  return n;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '...';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { projects, currentProjectId, setCurrentProjectId, createProject, deleteProject, renameProject, setProjectIcon, autoDownload, setAutoDownload } = useAppStore();
  const [galleryOpen, setGalleryOpen] = useState(false);
  // Which project's icon picker is open, plus where to anchor it.
  const [iconPicker, setIconPicker] = useState<{ id: string; rect: DOMRect } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [diskCacheSize, setDiskCacheSize] = useState<number | null>(null);
  const [memCacheBytes, setMemCacheBytes] = useState<number>(0);
  // Download folder — session-only. Resets to OS Downloads on every app restart.
  const [downloadDir, setDownloadDir] = useState<string>('');
  const [isDefaultDir, setIsDefaultDir] = useState(true);
  // Delete confirmation. Deleting a project drops every message + generated video in it
  // and there is no undo, so it can't be a bare click. A custom modal rather than
  // confirm(): a native dialog de-activates the Electron window, which drops the prompt
  // caret and wedges the Korean IME (the same reason alert() was removed app-wide, §6-3).
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  // Focus the destructive button on open so Enter confirms (asked for explicitly) and
  // the dialog is keyboard-reachable. Escape cancels.
  useEffect(() => {
    if (!pendingDelete) return;
    const t = setTimeout(() => deleteBtnRef.current?.focus(), 30);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPendingDelete(null); }
      if (e.key === 'Enter') {
        e.preventDefault();
        deleteProject(pendingDelete.id);
        setPendingDelete(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', onKey); };
  }, [pendingDelete, deleteProject]);

  useEffect(() => {
    const refresh = async () => {
      const api = (window as any).electronAPI;
      if (api?.getCacheSize) {
        try { const r = await api.getCacheSize(); setDiskCacheSize(r.size ?? 0); } catch {}
      }
      setMemCacheBytes(getBlobCacheStats().bytes);
    };
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, []);

  // Load the current (default on startup) download folder once.
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.getDownloadDir) {
      api.getDownloadDir()
        .then((r: any) => { if (r?.dir) { setDownloadDir(r.dir); setIsDefaultDir(!!r.isDefault); } })
        .catch(() => {});
    }
  }, []);

  const pickDownloadFolder = async () => {
    const api = (window as any).electronAPI;
    if (!api?.pickDownloadDir) { alert('이 기능은 데스크톱 앱에서만 사용할 수 있습니다.'); return; }
    const r = await api.pickDownloadDir();
    if (r?.ok && r.dir) { setDownloadDir(r.dir); setIsDefaultDir(false); }
  };

  // Jump straight to the folder downloads are landing in. No argument — main resolves
  // the session folder itself, so this can't point somewhere else than where files go.
  const openDownloadFolder = async () => {
    const api = (window as any).electronAPI;
    if (!api?.openFolder) { alert('이 기능은 데스크톱 앱에서만 사용할 수 있습니다.'); return; }
    const r = await api.openFolder();
    if (!r?.ok) alert(r?.reason === 'missing' ? `폴더를 찾을 수 없습니다.\n${r.path || downloadDir}` : '폴더를 열지 못했습니다.');
  };

  const totalCacheBytes = (diskCacheSize ?? 0) + memCacheBytes;

  const DASHBOARD_URL = 'https://script.google.com/macros/s/AKfycbyC53V4K-CHJnP86qIbBP0WmXZ4cDD9D3CFVmd8otL4ZThzpQ7RKhnCeIXgDu4y7CFrnQ/exec';

  const openDashboard = () => {
    const api = (window as any).electronAPI;
    if (api?.openExternal) api.openExternal(DASHBOARD_URL);
    else window.open(DASHBOARD_URL, '_blank');
  };

  const handleClearCache = async () => {
    const api = (window as any).electronAPI;
    if (!api?.clearCache) { alert('이 기능은 데스크톱 앱에서만 사용할 수 있습니다.'); return; }
    const disk = formatBytes(diskCacheSize ?? 0);
    const mem = formatBytes(memCacheBytes);
    // 레퍼런스 캐시(media-cache) 크기 — 서버에서 조회
    let mediaStats = { count: 0, bytes: 0 };
    try { const r = await fetch('/api/cache/stats'); if (r.ok) mediaStats = await r.json(); } catch {}
    const total = formatBytes(totalCacheBytes + mediaStats.bytes);
    const ok = confirm(
      `총 ${total} 캐시를 전부 비울까요?\n\n` +
      `• 디스크: ${disk} (브라우저 HTTP 캐시)\n` +
      `• 메모리: ${mem} (영상 사전 다운로드 풀)\n` +
      `• 레퍼런스 캐시: ${formatBytes(mediaStats.bytes)} (${mediaStats.count}개 — 재사용용 원본 보관소)\n\n` +
      `⚠ 레퍼런스 캐시를 지우면 과거 메시지 재사용 시 클립보드로 붙여넣었던 ` +
      `이미지는 복구할 수 없습니다. (파일로 첨부한 것은 원본 경로에서 복구 시도)\n\n` +
      `다운로드 받은 mp4 파일은 영향 없습니다.`
    );
    if (!ok) return;
    clearBlobCache();
    setMemCacheBytes(0);
    // 레퍼런스 캐시(media-cache) — 얄짤없이 전부 삭제
    let mediaOk = true;
    try { const r = await fetch('/api/cache/clear', { method: 'POST' }); mediaOk = r.ok && (await r.json()).ok; } catch { mediaOk = false; }
    const result = await api.clearCache();
    if (result.ok && mediaOk) { setDiskCacheSize(0); alert('캐시를 전부 비웠습니다. (레퍼런스 캐시 포함)'); }
    else alert(`일부 캐시 비우기 실패${!mediaOk ? ' — 레퍼런스 캐시' : ''}${!result.ok ? ' — 브라우저 캐시: ' + (result.error || '') : ''}\n나머지는 비웠습니다.`);
  };

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const handleRename = (id: string) => {
    if (editName.trim()) {
      renameProject(id, editName.trim());
    }
    setEditingId(null);
  };

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(p => p.name.toLowerCase().includes(query));
  }, [projects, searchQuery]);

  return (
    <motion.div
      animate={{ width: collapsed ? 48 : 256 }}
      transition={{ duration: 0.2, ease: 'easeInOut' }}
      className="bg-[#1d1d1f] border-r border-[#2a2a2d] flex flex-col h-full shrink-0 overflow-hidden"
    >
    {collapsed ? (
      <div className="flex flex-col items-center py-3 gap-2 h-full">
        <button onClick={onToggle} className="p-2 text-white/60 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors" title="Expand sidebar">
          <PanelLeftOpen size={18} />
        </button>
        <button onClick={createProject} className="p-2 text-white/60 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors" title="New Project">
          <Plus size={18} />
        </button>
        <button onClick={() => setGalleryOpen(true)} className="p-2 text-white/60 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors" title="전체 갤러리">
          <LayoutGrid size={18} />
        </button>
        <div className="flex-1" />
        <button onClick={pickDownloadFolder}
          className="p-2 text-white/40 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors"
          title={`다운로드 폴더 선택${isDefaultDir ? ' (현재: 기본 Downloads)' : `\n현재: ${downloadDir}`}`}>
          <FolderDown size={18} />
        </button>
        <button onClick={openDownloadFolder}
          className="p-2 text-white/40 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors"
          title={`다운로드 폴더 열기\n${downloadDir}`}>
          <FolderOpen size={18} />
        </button>
        <button onClick={openDashboard}
          className="p-2 text-white/40 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors"
          title="크레딧 대시보드 열기">
          <BarChart3 size={18} />
        </button>
        <button onClick={handleClearCache}
          className="p-2 text-white/40 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors mb-2"
          title={`캐시 정리 (${formatBytes(totalCacheBytes)})`}>
          <Sparkles size={18} />
        </button>
      </div>
    ) : (
      <>
      <div className="p-4 border-b border-[#2a2a2d] space-y-3">
        <div className="flex items-center gap-2">
          <button onClick={onToggle} className="p-1.5 text-white/60 hover:text-white hover:bg-[#2a2a2d] rounded-[6px] transition-colors shrink-0" title="Collapse sidebar">
            <PanelLeftClose size={18} />
          </button>
          <button onClick={createProject} className="flex-1 flex items-center justify-center gap-2 bg-[#2a2a2d] hover:bg-[#3a3a3d] text-white px-4 py-2 rounded-[8px] font-medium transition-colors text-[17px]">
            <Plus size={18} />
            New Project
          </button>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            type="text"
            placeholder="Search projects..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#2a2a2d] border border-transparent focus:border-[#0071e3] rounded-[8px] pl-9 pr-3 py-1.5 text-[13px] text-white placeholder-white/40 outline-none transition-colors"
          />
        </div>
        {/* Cross-project gallery. Sits under the search box rather than in the footer:
            it answers the same question the search box does ("where is that thing"),
            just for clips instead of projects. */}
        <button onClick={() => setGalleryOpen(true)}
          className="w-full flex items-center gap-2 px-3 py-1.5 bg-[#2a2a2d]/70 hover:bg-[#2a2a2d] text-white/70 hover:text-white rounded-[8px] transition-colors text-[12.5px]"
          title="모든 프로젝트의 영상을 한 곳에서 (모델·해상도·비율·기간 필터)">
          <LayoutGrid size={14} className="shrink-0" />
          <span className="font-medium">전체 갤러리</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-1 dark-scrollbar">
        {filteredProjects.map((project) => (
          <div
            key={project.id}
            className={cn(
              "group flex items-center justify-between px-3 py-2 rounded-[8px] cursor-pointer transition-colors",
              currentProjectId === project.id ? "bg-[#2a2a2d] text-white" : "text-white/70 hover:bg-[#2a2a2d]/50 hover:text-white"
            )}
            onClick={() => { if (editingId !== project.id) setCurrentProjectId(project.id); }}
            onDoubleClick={() => { setEditingId(project.id); setEditName(project.name); }}
          >
            <div className="flex items-center gap-2 overflow-hidden flex-1">
              {/* Icon slot. The icon itself is always the project's own — the run/done
                  state rides as a small corner overlay instead of replacing it, so
                  picking a 🎬 doesn't mean losing it every time you hit generate. */}
              {(() => {
                const running = project.messages.some(m => m.status === 'running' || m.status === 'queued');
                const unseen = unseenDoneCount(project, currentProjectId === project.id);
                return (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setIconPicker({ id: project.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
                    }}
                    title="아이콘 변경"
                    className="relative shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 transition-colors"
                  >
                    <ProjectIcon icon={project.icon} />
                    {running && (
                      <Loader2 size={10} className="absolute -bottom-0.5 -right-1 text-[#0071e3] animate-spin bg-[#1d1d1f] rounded-full" />
                    )}
                    {!running && unseen > 0 && (
                      // Unread-style dot: this project finished something while you were
                      // elsewhere. Clicking in clears it (App marks the open project seen).
                      <span className="absolute -bottom-0.5 -right-1 min-w-[13px] h-[13px] px-[3px] rounded-full bg-[#30d158] text-[#0b2c16] text-[8px] font-bold leading-[13px] text-center ring-2 ring-[#1d1d1f]">
                        {unseen > 9 ? '9+' : unseen}
                      </span>
                    )}
                  </button>
                );
              })()}
              {editingId === project.id ? (
                <input
                  ref={inputRef}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => handleRename(project.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleRename(project.id); if (e.key === 'Escape') setEditingId(null); }}
                  className="w-full bg-[#000000] border border-[#0071e3] rounded-[6px] px-1 py-0.5 text-[14px] text-white outline-none"
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate text-[14px] font-medium">{project.name}</span>
              )}
            </div>
            {!editingId && (
              <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity shrink-0 ml-2">
                <button onClick={(e) => { e.stopPropagation(); setEditingId(project.id); setEditName(project.name); }} className="p-1 text-white/40 hover:text-white transition-colors" title="Rename">
                  <Edit2 size={14} />
                </button>
                <button onClick={(e) => { e.stopPropagation(); setPendingDelete({ id: project.id, name: project.name }); }} className="p-1 text-white/40 hover:text-[#ff3b30] transition-colors" title="Delete">
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Footer: download folder + dashboard link + cache cleanup */}
      <div className="p-3 border-t border-[#2a2a2d] shrink-0 space-y-2">
        {/* Download folder — session-only, resets to Downloads on restart */}
        <div className="px-3 py-2 bg-[#2a2a2d]/60 rounded-[8px] space-y-1.5">
          <div className="flex items-center gap-2 text-white/70 text-[12px]">
            <FolderDown size={14} />
            <span className="font-medium">다운로드 폴더</span>
            {isDefaultDir && <span className="text-white/35 text-[10px]">(기본)</span>}
          </div>
          <div className="text-[11px] text-white/45 font-mono break-all leading-snug" title={downloadDir}>
            {downloadDir || '...'}
          </div>
          <button onClick={pickDownloadFolder}
            className="w-full px-2 py-1 bg-[#3a3a3d] hover:bg-[#4a4a4d] text-white/80 hover:text-white rounded-[6px] text-[11px] font-medium transition-colors"
            title="다운로드 폴더 선택 (앱 재시작 시 기본 폴더로 초기화)">
            폴더 선택
          </button>
          {/* Open the folder itself — not "reveal a file in it". Different IPC for that
              reason: showItemInFolder on a directory opens its PARENT. */}
          <button onClick={openDownloadFolder}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1 bg-[#3a3a3d] hover:bg-[#4a4a4d] text-white/80 hover:text-white rounded-[6px] text-[11px] font-medium transition-colors"
            title={`탐색기에서 열기\n${downloadDir}`}>
            <FolderOpen size={12} /> 폴더 열기
          </button>
          {/* Auto-download: when on, every video auto-saves to the folder above
              on completion. Manual "다시 다운로드" marker is unaffected. */}
          <label className="flex items-center gap-2 pt-0.5 cursor-pointer select-none"
            title="켜면 생성 완료되는 영상이 위 폴더로 자동 저장됩니다. (이미 만들어진 영상은 영향 없음)">
            <input type="checkbox" checked={autoDownload}
              onChange={(e) => setAutoDownload(e.target.checked)}
              className="accent-[#0071e3] w-3.5 h-3.5 shrink-0" />
            <span className="text-[11px] text-white/70">생성 시 자동 다운로드</span>
          </label>
        </div>
        <button onClick={openDashboard}
          className="w-full flex items-center gap-2 px-3 py-2 bg-[#2a2a2d]/60 hover:bg-[#2a2a2d] text-white/70 hover:text-white rounded-[8px] transition-colors text-[12px]"
          title="크레딧 사용량 대시보드 열기 (외부 브라우저)">
          <BarChart3 size={14} />
          <span className="font-medium">📊 크레딧 대시보드</span>
        </button>
        <button onClick={handleClearCache}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-[#2a2a2d]/60 hover:bg-[#2a2a2d] text-white/70 hover:text-white rounded-[8px] transition-colors text-[12px]"
          title="영상 미리보기 캐시 정리 (다운로드된 mp4는 영향 없음)">
          <div className="flex items-center gap-2">
            <Sparkles size={14} />
            <span className="font-medium">캐시 정리</span>
          </div>
          <span className="font-mono text-[11px] text-white/50">{formatBytes(totalCacheBytes)}</span>
        </button>
      </div>
      </>
    )}

    {iconPicker && (
      <IconPicker
        anchor={iconPicker.rect}
        current={projects.find(p => p.id === iconPicker.id)?.icon}
        onPick={(icon) => setProjectIcon(iconPicker.id, icon)}
        onClose={() => setIconPicker(null)}
      />
    )}

    {/* ★ Deliberately NOT wrapped in <AnimatePresence>.
        GlobalGallery renders through a portal, and an AnimatePresence sitting OUTSIDE a
        portal never receives the exit completion from inside it — the overlay stayed
        mounted at opacity:0, invisible but still `fixed inset-0`, swallowing every click
        in the app. (The delete modal below is fine because it portals FIRST and puts
        AnimatePresence inside.)
        Mounting conditionally also means the all-projects scan doesn't run while closed. */}
    {galleryOpen && <GlobalGallery onClose={() => setGalleryOpen(false)} />}

    {/* Delete confirmation — irreversible, so it states exactly what is lost.
        Rendered through a portal: the sidebar wrapper is overflow-hidden AND runs a
        width animation, and an animated ancestor can establish a containing block that
        clips position:fixed children. Portaling to <body> sidesteps that entirely. */}
    {createPortal(
    <AnimatePresence>
      {pendingDelete && (() => {
        const target = projects.find(p => p.id === pendingDelete.id);
        const videoCount = target?.messages.filter(m => m.status === 'succeeded' && m.videoUrl).length ?? 0;
        return (
          <motion.div
            key="del-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setPendingDelete(null)}
            className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.94, y: 12 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              onClick={(e) => e.stopPropagation()}
              className="w-[min(92vw,26rem)] bg-white rounded-2xl shadow-2xl overflow-hidden text-gray-900"
            >
              <div className="p-5 space-y-3">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-full bg-red-50 flex items-center justify-center">
                    <AlertTriangle size={18} className="text-[#ff3b30]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-[16px] font-semibold tracking-tight leading-snug">프로젝트를 삭제할까요?</h3>
                    <p className="text-[13px] text-gray-500 mt-0.5 break-all">{pendingDelete.name}</p>
                  </div>
                </div>
                <div className="rounded-xl bg-red-50/70 border border-red-100 px-3.5 py-2.5">
                  <p className="text-[12.5px] text-red-700 leading-relaxed">
                    이 작업은 <span className="font-semibold">되돌릴 수 없습니다.</span><br />
                    프롬프트 기록{videoCount > 0 && <> 과 생성된 영상 <span className="font-semibold">{videoCount}개</span></>}가 모두 사라집니다.
                  </p>
                </div>
                {videoCount > 0 && (
                  <p className="text-[11px] text-gray-400 leading-snug">
                    이미 다운로드한 파일은 지워지지 않습니다.
                  </p>
                )}
              </div>
              <div className="flex gap-2 px-5 pb-5">
                <button
                  onClick={() => setPendingDelete(null)}
                  className="flex-1 px-4 py-2.5 rounded-xl text-[14px] font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
                >
                  취소
                </button>
                <button
                  ref={deleteBtnRef}
                  onClick={() => { deleteProject(pendingDelete.id); setPendingDelete(null); }}
                  className="flex-1 px-4 py-2.5 rounded-xl text-[14px] font-semibold text-white bg-[#ff3b30] hover:bg-[#e0332a] transition-colors focus:outline-none focus:ring-2 focus:ring-[#ff3b30]/40 focus:ring-offset-2"
                >
                  삭제
                </button>
              </div>
            </motion.div>
          </motion.div>
        );
      })()}
    </AnimatePresence>,
    document.body)}
    </motion.div>
  );
}
