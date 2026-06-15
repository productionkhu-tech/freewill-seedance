import { useState, useRef, useEffect, useMemo } from 'react';
import { Plus, MessageSquare, Trash2, Edit2, Search, Loader2, PanelLeftClose, PanelLeftOpen, Sparkles, BarChart3, FolderDown } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppStore } from '../store';
import { cn, getBlobCacheStats, clearBlobCache } from '../lib/utils';

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '...';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const { projects, currentProjectId, setCurrentProjectId, createProject, deleteProject, renameProject, autoDownload, setAutoDownload } = useAppStore();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const [diskCacheSize, setDiskCacheSize] = useState<number | null>(null);
  const [memCacheBytes, setMemCacheBytes] = useState<number>(0);
  // Download folder — session-only. Resets to OS Downloads on every app restart.
  const [downloadDir, setDownloadDir] = useState<string>('');
  const [isDefaultDir, setIsDefaultDir] = useState(true);

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
        <div className="flex-1" />
        <button onClick={pickDownloadFolder}
          className="p-2 text-white/40 hover:text-white hover:bg-[#2a2a2d] rounded-[8px] transition-colors"
          title={`다운로드 폴더 선택${isDefaultDir ? ' (현재: 기본 Downloads)' : `\n현재: ${downloadDir}`}`}>
          <FolderDown size={18} />
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
              {project.messages.some(m => m.status === 'running' || m.status === 'queued') ? (
                <Loader2 size={16} className="shrink-0 text-[#0071e3] animate-spin" />
              ) : (
                <MessageSquare size={16} className="shrink-0 opacity-70" />
              )}
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
                <button onClick={(e) => { e.stopPropagation(); deleteProject(project.id); }} className="p-1 text-white/40 hover:text-[#ff3b30] transition-colors" title="Delete">
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
    </motion.div>
  );
}
