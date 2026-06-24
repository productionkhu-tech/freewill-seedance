import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAppStore, AssetRole, flushPersist } from '../store';
import { Send, Loader2, AlertCircle, Play, UploadCloud, Video, Music, Image as ImageIcon, Download, RefreshCw, X, Trash2, Search, LayoutGrid, ArrowUp, ArrowDown, Eye, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';
import { getAssetNames } from './SettingsPanel';
import { motion, AnimatePresence } from 'motion/react';
import { downloadViaProxy, buildDownloadFilename, validateImageFile, validateImageDimensions, validateVideoFile, validateAudioFile, getMediaDurationSec, totalDurationError, createThumbnail, createVideoThumbnail, reuploadFromCache, reuploadFromPath, getFilePath, getCachedBlob, setCachedBlob, cacheFile, cacheFromPath } from '../lib/utils';

/* ─── Korean error translation ─── */
function translateError(error: string): string {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  if (error.includes('API Key is required')) return 'API 키 오류: 서버를 재시작해주세요. (start.bat)';
  if (error.includes('Payload Too Large')) return '파일 크기 초과: 이미지 개당 30MB, 전체 요청 64MB 이하여야 합니다.';
  if (error.includes('resource download failed')) return '리소스 다운로드 실패: 이미지에 접근할 수 없습니다. 파일을 다시 업로드해주세요.';
  if (error.includes('real person') || error.includes('PrivacyInformation')) return '실사 인물 감지: Seedance 2.0은 실제 사람 얼굴이 담긴 레퍼런스 이미지·영상을 받지 않습니다. Seedance로 생성한 결과물이나 비실사(스타일라이즈) 캐릭터 이미지를 사용해주세요.';
  if (error.includes('SensitiveContentDetected') || error.includes('SensitiveContent')) return '민감 콘텐츠 감지: 레퍼런스 이미지 또는 프롬프트가 BytePlus 콘텐츠 정책에 의해 거부되었습니다.';
  if (error.includes('rate limit') || error.includes('429')) return 'API 요청 한도 초과: 잠시 후 다시 시도해주세요.';
  if (error.includes('No task ID')) return 'Task ID를 받지 못했습니다. API 응답을 확인해주세요.';
  if (error.includes('1080p is not supported for this account')) return '1080p는 현재 계정에서 사용할 수 없습니다. BytePlus 콘솔에서 1080p 권한을 활성화하거나 480p/720p를 사용해주세요.';
  if (error.includes('not supported for this account')) return `현재 계정에서 사용할 수 없는 옵션입니다: ${error}`;
  if (error.includes('not valid')) return `잘못된 파라미터: ${error}`;
  if (error.includes('timeout') || error.includes('ETIMEDOUT')) return '요청 시간 초과: 네트워크 연결을 확인해주세요.';
  if (error.includes('Failed to fetch') || error.includes('NetworkError')) return '네트워크 오류: 인터넷 연결을 확인해주세요.';
  return error;
}

/* ─── Video player: lazy mount + blob fetch (single GET → smooth playback over high-latency CDN) ─── */
function VideoPlayer({ src, className, eager }: { src: string; className?: string; eager?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(eager === true);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (eager) return; // eager mode: skip observer, mount immediately
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true);
        } else if (videoRef.current) {
          videoRef.current.pause();
        }
      },
      { threshold: 0, rootMargin: '500px' }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [eager]);

  // Hover-to-play with sound. Leaving the card just pauses — we keep the current
  // playback position so the next hover resumes from where the user was watching.
  const handleMouseEnter = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.play().catch(() => {
      // Browser autoplay policy may block unmuted playback without an explicit click.
      // Fall back to muted playback so the user at least sees motion; they can click
      // the volume control to unmute manually.
      if (videoRef.current) {
        videoRef.current.muted = true;
        videoRef.current.play().catch(() => {});
      }
    });
  };
  const handleMouseLeave = () => {
    videoRef.current?.pause();
  };

  // Use shared blob cache (populated by store on success). Fetch + cache if missing.
  useEffect(() => {
    if (!mounted || !src) return;
    const cached = getCachedBlob(src);
    if (cached) {
      const url = URL.createObjectURL(cached);
      blobUrlRef.current = url;
      setBlobSrc(url);
      setLoading(false);
      setFailed(false);
      return () => {
        if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
        setBlobSrc(null);
      };
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetch(src)
      .then(r => { if (!r.ok) throw new Error(`status ${r.status}`); return r.blob(); })
      .then(b => {
        if (cancelled) return;
        setCachedBlob(src, b); // share with download flow
        const url = URL.createObjectURL(b);
        blobUrlRef.current = url;
        setBlobSrc(url);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setFailed(true);
      });
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobSrc(null);
    };
  }, [src, mounted]);

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={`${className} aspect-video bg-black flex items-center justify-center relative`}
    >
      {!mounted && <Play size={40} className="text-white/30" />}
      {mounted && loading && !blobSrc && (
        <Loader2 size={32} className="text-white/60 animate-spin" />
      )}
      {mounted && (blobSrc || failed) && (
        <video
          ref={videoRef}
          src={blobSrc || src}
          controls
          playsInline
          preload="auto"
          className="w-full h-full object-contain"
        />
      )}
    </div>
  );
}

/* ─── Timer ─── */
function LiveTimer({ startTime, endTime }: { startTime?: number, endTime?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endTime]);
  if (!startTime) return null;
  const elapsed = Math.floor(((endTime || now) - startTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  return <span className="font-mono text-[14px] text-indigo-500 font-medium">{mins}:{secs}</span>;
}

/* ─── Helpers ─── */
const textToHtml = (text: string, assets: any[]) => {
  const regex = /(\[(?:Image|Video|Audio) \d+\])/g;
  const parts = text.split(regex);
  return parts.map(part => {
    if (part.match(regex)) {
      const name = part.slice(1, -1);
      const asset = assets.find(a => a.name === name);
      if (asset) {
        const thumbSrc = (asset.type === 'image_url' || asset.type === 'video_url') ? (asset.thumbnailUrl || (asset.type === 'image_url' ? asset.url : '')) : '';
        const iconHtml = thumbSrc
          ? `<img src="${thumbSrc}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;display:inline-block;vertical-align:middle;margin-right:4px;" />`
          : `<span style="display:inline-block;width:16px;height:16px;background:#f0f0f5;border-radius:2px;vertical-align:middle;margin-right:4px;text-align:center;line-height:16px;font-size:10px;">${asset.type === 'video_url' ? '🎥' : '🎵'}</span>`;
        return `<span contenteditable="false" class="mention-pill" data-name="${asset.name}" data-asset-id="${asset.id}" style="display:inline-flex;align-items:center;background:#eef2ff;color:#4338ca;padding:2px 6px;border-radius:6px;font-size:13px;margin:0 2px;vertical-align:middle;border:1px solid #c7d2fe;">${iconHtml}<span style="font-weight:500;">[${asset.name}]</span></span>&nbsp;`;
      }
    }
    return part;
  }).join('');
};

const getPlainText = (html: string) => {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  temp.querySelectorAll('.mention-pill').forEach(pill => {
    pill.replaceWith(`[${pill.getAttribute('data-name')}]`);
  });
  temp.style.cssText = 'position:absolute;left:-9999px;white-space:pre-wrap;';
  document.body.appendChild(temp);
  const text = temp.innerText;
  document.body.removeChild(temp);
  return text.replace(/\n$/, '');
};

const renderMessageContent = (content: string, namedAssets: any[]) => {
  const regex = /(\[(?:Image|Video|Audio) \d+\])/g;
  const parts = content.split(regex);
  return parts.map((part, i) => {
    if (part.match(regex)) {
      const assetName = part.slice(1, -1);
      const asset = namedAssets.find(a => a.name === assetName);
      if (asset) {
        return (
          <span key={i} className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-md px-1.5 py-0.5 mx-0.5 align-middle text-[13px]">
            {asset.type === 'image_url' ? <img src={asset.thumbnailUrl || asset.url} className="w-4 h-4 object-cover rounded-sm" alt="" /> : asset.type === 'video_url' && asset.thumbnailUrl ? <img src={asset.thumbnailUrl} className="w-4 h-4 object-cover rounded-sm" alt="" /> : asset.type === 'video_url' ? <Video size={12} /> : <Music size={12} />}
            <span className="font-medium">[{asset.name}]</span>
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
};

/* ─── Collapsible prompt: 1-line truncated by default, expand/collapse + copy ─── */
function CollapsiblePrompt({ promptText, namedAssets }: { promptText: string; namedAssets: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can fail on insecure contexts — silently noop, UI just won't flash check
    }
  };

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(v => !v);
  };

  return (
    <div className="flex items-start gap-2 min-w-0 w-full">
      <div
        className={
          'flex-1 min-w-0 text-[14px] text-gray-800 font-medium leading-relaxed ' +
          (expanded ? 'whitespace-pre-wrap break-words' : 'truncate')
        }
      >
        {renderMessageContent(promptText, namedAssets)}
      </div>
      <div className="flex items-center gap-0.5 shrink-0 -mt-0.5">
        <button
          onClick={toggleExpand}
          className="p-1 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-colors"
          title={expanded ? '접기' : '펼치기'}
          aria-label={expanded ? '프롬프트 접기' : '프롬프트 펼치기'}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button
          onClick={handleCopy}
          className="p-1 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-colors"
          title={copied ? '복사됨!' : '프롬프트 복사'}
          aria-label="프롬프트 복사"
        >
          {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

/* ─── Main Component ─── */
export function ChatArea() {
  const { projects, currentProjectId, addMessage, updateMessage, addAsset, removeAsset } = useAppStore();
  const project = projects.find((p) => p.id === currentProjectId);
  const [hasText, setHasText] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [headerSearch, setHeaderSearch] = useState('');
  const [showGallery, setShowGallery] = useState(false);
  const [previewItem, setPreviewItem] = useState<any>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const dragCounter = useRef(0);
  const [mentionState, setMentionState] = useState<{ active: boolean, query: string }>({ active: false, query: '' });
  const mentionIndexRef = useRef(0);
  const contentEditableRef = useRef<HTMLDivElement>(null);
  // first/last 모드에서 붙여넣기가 두 슬롯을 번갈아 교체하도록 다음 대상 추적.
  // 슬롯 id를 함께 저장해서, 슬롯이 다른 경로(피커·삭제 후 재추가·프로젝트
  // 전환)로 바뀌었으면 사이클을 버리고 무조건 first부터 다시 시작한다.
  const pasteCycleRef = useRef<{ firstId: string; lastId: string; next: 'first_frame' | 'last_frame' } | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const previousProjectIdRef = useRef<string | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [promptHeight, setPromptHeight] = useState(160);
  const [downloads, setDownloads] = useState<Record<string, { received: number; total: number; state: string }>>({});
  const [downloadsCollapsed, setDownloadsCollapsed] = useState(false);

  // Listen to download events from Electron main process
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.onDownloadStarted) {
      api.onDownloadStarted(({ filename }: { filename: string }) => {
        setDownloads(d => ({ ...d, [filename]: { received: 0, total: 0, state: 'progressing' } }));
      });
      api.onDownloadProgress(({ filename, received, total, state }: any) => {
        setDownloads(d => ({ ...d, [filename]: { received, total, state } }));
      });
      api.onDownloadDone(({ filename, state }: any) => {
        setDownloads(d => {
          const next = { ...d };
          if (state === 'completed') {
            setTimeout(() => setDownloads(curr => { const c = { ...curr }; delete c[filename]; return c; }), 3000);
          }
          next[filename] = { ...(next[filename] || { received: 0, total: 0 }), state };
          return next;
        });
      });
    }

    // Instant downloads served from in-memory blob cache (no Electron will-download fires)
    const onInstant = (e: Event) => {
      const { filename, size } = (e as CustomEvent).detail;
      setDownloads(d => ({ ...d, [filename]: { received: size, total: size, state: 'completed' } }));
      setTimeout(() => setDownloads(curr => { const c = { ...curr }; delete c[filename]; return c; }), 2000);
    };
    window.addEventListener('seedance:download-instant', onInstant);
    return () => window.removeEventListener('seedance:download-instant', onInstant);
  }, []);

  // Save draft for previous project, load draft for new project
  useEffect(() => {
    const prevId = previousProjectIdRef.current;
    if (prevId && prevId !== currentProjectId && contentEditableRef.current) {
      // Flush any pending debounced save then commit current HTML to previous project
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
      useAppStore.getState().updateDraftPrompt(prevId, contentEditableRef.current.innerHTML);
    }
    if (contentEditableRef.current) {
      const newProject = useAppStore.getState().projects.find(p => p.id === currentProjectId);
      const draft = newProject?.draftPrompt || '';
      contentEditableRef.current.innerHTML = draft;
      setHasText(!!contentEditableRef.current.innerText.trim());
    }
    previousProjectIdRef.current = currentProjectId;
    setHeaderSearch('');
    setShowGallery(false);
    setPreviewItem(null);
  }, [currentProjectId]);

  // Persist draft on window close (cache before IndexedDB debounce window)
  useEffect(() => {
    const handler = () => {
      if (currentProjectId && contentEditableRef.current) {
        useAppStore.getState().updateDraftPrompt(currentProjectId, contentEditableRef.current.innerHTML);
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [currentProjectId]);

  // Listen for SettingsPanel reset → also clear prompt
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.projectId !== currentProjectId) return;
      if (contentEditableRef.current) contentEditableRef.current.innerHTML = '';
      setHasText(false);
      if (currentProjectId) useAppStore.getState().updateDraftPrompt(currentProjectId, '');
    };
    window.addEventListener('seedance:reset', handler as EventListener);
    return () => window.removeEventListener('seedance:reset', handler as EventListener);
  }, [currentProjectId]);

  // Track mention pills by asset UUID — remove deleted, renumber shifted, and
  // refresh embedded thumbnails when an image asset is replaced (replaceAsset
  // keeps the id stable but swaps url/thumbnailUrl).
  useEffect(() => {
    if (!contentEditableRef.current || !project) return;
    const named = getAssetNames(project.assets);
    let changed = false;
    contentEditableRef.current.querySelectorAll('.mention-pill').forEach(pill => {
      const assetId = pill.getAttribute('data-asset-id');
      if (assetId) {
        const asset = named.find(a => a.id === assetId);
        if (!asset) {
          // Asset was deleted → remove the pill
          pill.remove(); changed = true;
          return;
        }
        if (asset.name !== pill.getAttribute('data-name')) {
          // Asset was renumbered (e.g. Image 3 → Image 2) → update pill text
          pill.setAttribute('data-name', asset.name);
          const textSpan = pill.querySelector('span[style*="font-weight"]');
          if (textSpan) textSpan.textContent = `[${asset.name}]`;
          changed = true;
        }
        if (asset.type === 'image_url' || asset.type === 'video_url') {
          // Refresh thumbnail src so a replaced image/video shows the new
          // bytes immediately in any pill that references it. Video pills
          // only have an <img> when a thumbnail was successfully captured;
          // otherwise they show the 🎥 emoji span and we skip.
          const img = pill.querySelector('img') as HTMLImageElement | null;
          const newSrc = (asset as any).thumbnailUrl || (asset.type === 'image_url' ? asset.url : '');
          if (img && newSrc && img.getAttribute('src') !== newSrc) {
            img.setAttribute('src', newSrc);
            changed = true;
          }
        }
      } else {
        // No asset ID (legacy pill) — fallback to name matching
        const name = pill.getAttribute('data-name');
        if (name && !named.some(a => a.name === name)) { pill.remove(); changed = true; }
      }
    });
    if (changed) setHasText(!!contentEditableRef.current.innerText.trim());
  }, [project?.assets]);

  const handleMessagesScroll = useCallback(() => {
    if (messagesScrollRef.current) {
      const el = messagesScrollRef.current;
      setShowScrollTop(el.scrollTop > 300);
      // Show "scroll to bottom" when not near the bottom
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBottom(distFromBottom > 300);
    }
  }, []);

  const scrollToTop = () => messagesScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });

  const enterGallery = () => {
    setShowGallery(true);
  };
  const exitGallery = () => {
    setShowGallery(false);
    // Scroll to absolute bottom after returning to chat
    requestAnimationFrame(() => {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: 'auto' }), 50);
    });
  };
  // Find a specific message and scroll to it
  const scrollToMessage = (messageId: string) => {
    setShowGallery(false);
    setPreviewItem(null);
    requestAnimationFrame(() => {
      setTimeout(() => {
        const el = document.getElementById(`msg-${messageId}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    });
  };

  if (!project) return null;

  const namedAssets = useMemo(() => getAssetNames(project.assets), [project.assets]);
  const mentionableAssets = useMemo(() => namedAssets.filter(a => a.role !== 'first_frame' && a.role !== 'last_frame'), [namedAssets]);
  const filteredMentionAssets = useMemo(() => mentionableAssets.filter(a => a.name.toLowerCase().includes(mentionState.query.toLowerCase())), [mentionableAssets, mentionState.query]);

  const displayMessages = useMemo(() => headerSearch.trim()
    ? project.messages.filter(m => m.promptText?.toLowerCase().includes(headerSearch.toLowerCase()))
    : project.messages, [project.messages, headerSearch]);

  const galleryVideos = useMemo(() => project.messages
    .filter(m => m.status === 'succeeded' && m.videoUrl)
    .sort((a, b) => b.timestamp - a.timestamp), [project.messages]);

  // Download + mark the message so the button flips to "다시 다운로드".
  // Marked only after downloadViaProxy resolves (= download handed off OK).
  const handleVideoDownload = async (msgId: string, videoUrl: string, taskId: string) => {
    try {
      await downloadViaProxy(videoUrl, buildDownloadFilename(taskId));
      useAppStore.getState().updateMessage(project.id, msgId, { downloadedAt: Date.now() });
      // Force the mark to disk now — the 1.5s debounced write would be lost
      // if the app quits (or auto-update restarts) right after the download.
      await flushPersist();
    } catch (e) { console.error('download failed:', e); }
  };
  // previewItem is a useState snapshot — read downloadedAt live from the store
  const previewDownloaded = previewItem ? project.messages.find(m => m.id === previewItem.id)?.downloadedAt : undefined;

  /* ─── Drag & Drop ─── */
  const handleDragEnter = (e: React.DragEvent) => { e.preventDefault(); dragCounter.current += 1; if (e.dataTransfer.items?.length) setIsDragging(true); };
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); dragCounter.current -= 1; if (dragCounter.current === 0) setIsDragging(false); };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current = 0; setIsDragging(false);
    const mode = project.settings.mode;
    const allFiles = Array.from(e.dataTransfer.files);
    if (allFiles.length === 0) return;
    if (mode === 'text_to_video') {
      alert('Text to Video 모드에서는 래퍼런스 파일을 사용하지 않습니다.');
      return;
    }

    (async () => {
      const rejected: string[] = [];
      for (const file of allFiles) {
        const freshProject = useAppStore.getState().projects.find(p => p.id === project.id);
        const assets = freshProject?.assets || [];

        if (file.type.startsWith('image/')) {
          if (mode === 'extend_video') { rejected.push(`${file.name}: extend_video 모드는 이미지를 받지 않습니다.`); continue; }
          const imgCount = assets.filter(a => a.type === 'image_url').length;
          const maxImg = mode === 'multimodal_reference' ? 9 : mode === 'edit_video' ? 9 : mode === 'image_to_video_first' ? 1 : mode === 'image_to_video_first_last' ? 2 : 0;
          if (imgCount >= maxImg) { rejected.push(`${file.name}: 이미지 한도 ${maxImg}개 초과`); continue; }
          let role: any = 'reference_image';
          if (mode === 'image_to_video_first') role = 'first_frame';
          else if (mode === 'image_to_video_first_last') role = assets.some(a => a.role === 'first_frame') ? 'last_frame' : 'first_frame';
          const sizeErr = validateImageFile(file);
          if (sizeErr) { rejected.push(`${file.name}: ${sizeErr}`); continue; }
          try {
            const dimErr = await validateImageDimensions(file);
            if (dimErr) { rejected.push(`${file.name}: ${dimErr}`); continue; }
            const thumbnailUrl = await createThumbnail(file);
            const originalPath = getFilePath(file);
            // Attach → media-cache only. R2 upload happens at send time so
            // every R2 object is born with a task to be tied to.
            const cacheId = await cacheFile(file);
            addAsset(project.id, { type: 'image_url', url: '', role, file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
          } catch (e: any) { rejected.push(`${file.name}: 처리 실패 — ${e.message || ''}`); }

        } else if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name)) {
          // Trust the extension regardless of MIME. Chromium reports .mov as '',
          // 'video/quicktime', or even the non-standard 'video/mov' depending on
          // build/OS — checking only video/* MIME drops valid files. The
          // <video> metadata decode in validateVideoFile is the real gatekeeper.
          if (mode === 'image_to_video_first' || mode === 'image_to_video_first_last') {
            rejected.push(`${file.name}: 이 모드는 이미지만 받습니다.`); continue;
          }
          const existingVideos = assets.filter(a => a.type === 'video_url');
          const vidCount = existingVideos.length;
          const maxVid = mode === 'extend_video' ? 3 : mode === 'edit_video' ? 1 : mode === 'multimodal_reference' ? 3 : 0;
          // edit_video has a 1-video cap. When the user drops a new video while one
          // is already attached, treat it as a replace (preserve asset id so any
          // "@[Video 1]" mention keeps pointing to the same slot) rather than
          // rejecting with the over-limit alert.
          const shouldReplace = mode === 'edit_video' && vidCount >= 1;
          if (!shouldReplace && vidCount >= maxVid) {
            rejected.push(`${file.name}: 비디오 한도 ${maxVid}개 초과`); continue;
          }
          const vidErr = await validateVideoFile(file);
          if (vidErr) { rejected.push(`${file.name}: ${vidErr}`); continue; }
          const vidDuration = await getMediaDurationSec(file, 'video');
          // Combined cap: all reference videos in one request ≤ 15s total.
          // When replacing, the outgoing video's duration doesn't count.
          const vidOthers = shouldReplace ? assets.filter(a => a.id !== existingVideos[0].id) : assets;
          const vidTotErr = totalDurationError(vidOthers, 'video_url', vidDuration);
          if (vidTotErr) { rejected.push(`${file.name}: ${vidTotErr}`); continue; }
          try {
            const thumbnailUrl = await createVideoThumbnail(file).catch(() => '');
            const originalPath = getFilePath(file);
            // Attach → media-cache only (R2 upload deferred to send time)
            const cacheId = await cacheFile(file);
            if (shouldReplace) {
              const existing = existingVideos[0];
              useAppStore.getState().replaceAsset(project.id, existing.id, {
                url: '', file_name: file.name, cacheId, thumbnailUrl,
                durationSec: vidDuration ?? undefined,
                ...(originalPath ? { originalPath } : {}),
              });
            } else {
              addAsset(project.id, { type: 'video_url', url: '', role: 'reference_video', file_name: file.name, cacheId, thumbnailUrl, ...(vidDuration != null ? { durationSec: vidDuration } : {}), ...(originalPath ? { originalPath } : {}) });
            }
          } catch (e: any) { rejected.push(`${file.name}: 캐싱 실패 — ${e.message}`); }

        } else if (file.type.startsWith('audio/') || /\.(wav|mp3|mpeg|mpga)$/i.test(file.name)) {
          if (mode !== 'multimodal_reference' && mode !== 'edit_video') {
            rejected.push(`${file.name}: 이 모드에서는 오디오를 사용할 수 없습니다.`); continue;
          }
          const audCount = assets.filter(a => a.type === 'audio_url').length;
          const maxAud = 3;
          if (audCount >= maxAud) { rejected.push(`${file.name}: 오디오 한도 ${maxAud}개 초과`); continue; }
          const audErr = await validateAudioFile(file);
          if (audErr) { rejected.push(`${file.name}: ${audErr}`); continue; }
          const audDuration = await getMediaDurationSec(file, 'audio');
          // Combined cap: all reference audio in one request ≤ 15s total
          const audTotErr = totalDurationError(assets, 'audio_url', audDuration);
          if (audTotErr) { rejected.push(`${file.name}: ${audTotErr}`); continue; }
          try {
            const originalPath = getFilePath(file);
            // Attach → media-cache only (R2 upload deferred to send time)
            const cacheId = await cacheFile(file);
            addAsset(project.id, { type: 'audio_url', url: '', role: 'reference_audio', file_name: file.name, cacheId, ...(audDuration != null ? { durationSec: audDuration } : {}), ...(originalPath ? { originalPath } : {}) });
          } catch (e: any) { rejected.push(`${file.name}: 캐싱 실패 — ${e.message}`); }
        } else {
          rejected.push(`${file.name}: 지원하지 않는 파일 형식 (${file.type || '알 수 없음'})`);
        }
      }
      if (rejected.length > 0) alert(`일부 파일이 추가되지 않았습니다:\n\n${rejected.join('\n')}`);
    })();
  };

  /* ─── Input handlers ─── */
  const highlightMentionItem = useCallback(() => {
    document.querySelectorAll('.mention-item').forEach((item, i) => {
      if (i === mentionIndexRef.current) {
        item.classList.add('bg-indigo-50', 'text-indigo-700');
        item.classList.remove('text-gray-700');
      } else {
        item.classList.remove('bg-indigo-50', 'text-indigo-700');
        item.classList.add('text-gray-700');
      }
    });
  }, []);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    setHasText(!!e.currentTarget.innerText.trim());
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        const match = range.startContainer.textContent?.slice(0, range.startOffset).match(/@(\w*)$/);
        if (match) { mentionIndexRef.current = 0; setMentionState({ active: true, query: match[1] }); }
        else setMentionState(s => ({ ...s, active: false }));
      } else { setMentionState(s => ({ ...s, active: false })); }
    }

    // Auto-scroll caret into view. contentEditable does NOT do this natively
    // (unlike <textarea>/<input>), so long prompts or paste-in-long-text hide
    // the cursor below the visible area and users can't see what they're typing.
    // Run in rAF so layout is finalized before measuring.
    requestAnimationFrame(() => {
      const container = contentEditableRef.current;
      const s = window.getSelection();
      if (!container || !s?.rangeCount) return;
      const r = s.getRangeAt(0).cloneRange();
      r.collapse(true);
      let rect = r.getBoundingClientRect();
      // Collapsed range at an element boundary can return a zero-rect; insert
      // a zero-width marker to get a real position, then immediately remove it.
      if (rect.top === 0 && rect.bottom === 0 && rect.left === 0) {
        const marker = document.createElement('span');
        marker.textContent = '\u200B';
        try {
          r.insertNode(marker);
          rect = marker.getBoundingClientRect();
        } finally {
          marker.remove();
        }
      }
      if (rect.bottom === 0 && rect.top === 0) return;
      const cRect = container.getBoundingClientRect();
      const pad = 8;
      if (rect.bottom > cRect.bottom - pad) {
        container.scrollTop += rect.bottom - cRect.bottom + pad * 2;
      } else if (rect.top < cRect.top + pad) {
        container.scrollTop -= cRect.top - rect.top + pad * 2;
      }
    });

    // Debounced draft save
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      if (contentEditableRef.current && currentProjectId) {
        useAppStore.getState().updateDraftPrompt(currentProjectId, contentEditableRef.current.innerHTML);
      }
    }, 500);
  };

  const insertMention = (asset: any) => {
    if (!contentEditableRef.current) return;
    contentEditableRef.current.focus();
    const sel = window.getSelection(); if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const mentionStart = (range.startContainer.textContent || '').lastIndexOf('@', range.startOffset);
      if (mentionStart !== -1) { range.setStart(range.startContainer, mentionStart); range.deleteContents(); }
    }
    const pill = document.createElement('span');
    pill.contentEditable = 'false'; pill.className = 'mention-pill'; pill.dataset.name = asset.name; pill.dataset.assetId = asset.id;
    pill.style.cssText = 'display:inline-flex;align-items:center;background:#eef2ff;color:#4338ca;padding:2px 6px;border-radius:6px;font-size:13px;margin:0 2px;vertical-align:middle;border:1px solid #c7d2fe;';
    const thumbSrc = (asset.type === 'image_url' || asset.type === 'video_url') ? (asset.thumbnailUrl || (asset.type === 'image_url' ? asset.url : '')) : '';
    const iconHtml = thumbSrc
      ? `<img src="${thumbSrc}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;margin-right:4px;" />`
      : `<span style="width:16px;height:16px;background:#f0f0f5;border-radius:2px;margin-right:4px;text-align:center;line-height:16px;font-size:10px;display:inline-block;">${asset.type === 'video_url' ? '🎥' : '🎵'}</span>`;
    pill.innerHTML = `${iconHtml}<span style="font-weight:500;">[${asset.name}]</span>`;
    const space = document.createTextNode('\u00A0');
    range.insertNode(space); range.insertNode(pill);
    range.setStartAfter(space); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    setMentionState(s => ({ ...s, active: false })); setHasText(true);
  };

  // Clipboard image paste into the prompt box. Default contentEditable
  // behavior inlines the image into the prompt HTML (disaster) — intercept and
  // route to the asset list per mode instead. Text paste falls through.
  const handlePromptPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const imageFiles = Array.from(e.clipboardData?.items || [])
      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imageFiles.length === 0) return; // 텍스트 붙여넣기는 기본 동작 유지
    e.preventDefault(); // 이미지가 프롬프트 HTML에 박히는 것 차단

    const mode = project.settings.mode;
    if (mode === 'text_to_video') { alert('Text to Video 모드에서는 이미지를 첨부할 수 없습니다.'); return; }
    if (mode === 'extend_video') { alert('Extend Video 모드에서는 이미지를 첨부할 수 없습니다.\n(비디오 1~3개만 사용하는 모드입니다)'); return; }

    for (const raw of imageFiles) {
      // 클립보드 이미지는 전부 image.png라는 이름으로 들어옴 → 구분 가능한 이름 부여
      const ext = (raw.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      const file = new File([raw], `clipboard-${stamp}-${Math.random().toString(36).slice(2, 5)}.${ext}`, { type: raw.type });

      const sizeErr = validateImageFile(file);
      if (sizeErr) { alert(sizeErr); continue; }
      const dimErr = await validateImageDimensions(file);
      if (dimErr) { alert(dimErr); continue; }

      // 비동기 검증 사이에 상태가 변했을 수 있으니 매번 fresh 조회
      const assets = useAppStore.getState().projects.find(p => p.id === project.id)?.assets || [];

      try {
        if (mode === 'image_to_video_first') {
          // 슬롯 1개 — 있으면 교체 (id 보존 → 멘션 핀 유지), 없으면 추가
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          const existing = assets.find(a => a.role === 'first_frame');
          if (existing) {
            useAppStore.getState().replaceAsset(project.id, existing.id, { url: '', file_name: file.name, cacheId, thumbnailUrl });
          } else {
            addAsset(project.id, { type: 'image_url', url: '', role: 'first_frame', file_name: file.name, cacheId, thumbnailUrl });
          }
        } else if (mode === 'image_to_video_first_last') {
          // 빈 슬롯부터 채우고(first → last), 둘 다 차면 first → last → first …
          // 순서로 번갈아 교체. 교체 사이클은 항상 first부터 시작한다.
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          const first = assets.find(a => a.role === 'first_frame');
          const last = assets.find(a => a.role === 'last_frame');
          if (!first) {
            addAsset(project.id, { type: 'image_url', url: '', role: 'first_frame', file_name: file.name, cacheId, thumbnailUrl });
            pasteCycleRef.current = null; // 슬롯 구성 변경 → 사이클 리셋
          } else if (!last) {
            addAsset(project.id, { type: 'image_url', url: '', role: 'last_frame', file_name: file.name, cacheId, thumbnailUrl });
            pasteCycleRef.current = null;
          } else {
            const cycle = pasteCycleRef.current;
            // 마지막 붙여넣기 이후 슬롯이 바뀌었으면(피커로 채움, 재추가 등)
            // 이어가지 않고 first부터 새로 시작
            const stale = !cycle || cycle.firstId !== first.id || cycle.lastId !== last.id;
            const targetRole = stale ? 'first_frame' : cycle.next;
            const target = targetRole === 'first_frame' ? first : last;
            useAppStore.getState().replaceAsset(project.id, target.id, { url: '', file_name: file.name, cacheId, thumbnailUrl });
            pasteCycleRef.current = { firstId: first.id, lastId: last.id, next: targetRole === 'first_frame' ? 'last_frame' : 'first_frame' };
          }
        } else {
          // multimodal_reference / edit_video — 레퍼런스 이미지 최대 9장, 초과 시 기존 유지
          const imgCount = assets.filter(a => a.type === 'image_url').length;
          if (imgCount >= 9) {
            alert('이미지는 최대 9장까지만 첨부할 수 있습니다.\n기존 이미지는 그대로 유지됩니다.');
            break;
          }
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          addAsset(project.id, { type: 'image_url', url: '', role: 'reference_image', file_name: file.name, cacheId, thumbnailUrl });
        }
      } catch (err: any) {
        alert(`클립보드 이미지 처리 실패: ${err?.message || ''}`);
      }
    }
  };

  const processFrameFile = async (file: File, role: AssetRole) => {
    if (!file.type.startsWith('image/')) { alert('이미지 파일만 업로드할 수 있습니다.'); return; }
    const sizeErr = validateImageFile(file);
    if (sizeErr) { alert(sizeErr); return; }
    try {
      const dimErr = await validateImageDimensions(file);
      if (dimErr) { alert(dimErr); return; }
      const thumbnailUrl = await createThumbnail(file);
      const originalPath = getFilePath(file);
      // Attach → media-cache only (R2 upload deferred to send time)
      const cacheId = await cacheFile(file);
      addAsset(project.id, { type: 'image_url', url: '', role, file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
    } catch (e) { alert(`이미지 캐싱 실패: ${file.name}`); }
  };
  const handleFrameUpload = (e: React.ChangeEvent<HTMLInputElement>, role: AssetRole) => { const f = e.target.files?.[0]; if (f) processFrameFile(f, role); e.target.value = ''; };
  const handleFrameDrop = (e: React.DragEvent<HTMLInputElement>, role: AssetRole) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); dragCounter.current = 0; const f = e.dataTransfer.files?.[0]; if (f) processFrameFile(f, role); };

  const handlePromptResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = promptHeight;
    const onMove = (ev: MouseEvent) => {
      const next = startH + (startY - ev.clientY); // drag up → grow
      const clamped = Math.max(44, Math.min(window.innerHeight * 0.7, next));
      setPromptHeight(clamped);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (mentionState.active && filteredMentionAssets.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndexRef.current = (mentionIndexRef.current + 1) % filteredMentionAssets.length; highlightMentionItem(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndexRef.current = (mentionIndexRef.current - 1 + filteredMentionAssets.length) % filteredMentionAssets.length; highlightMentionItem(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filteredMentionAssets[mentionIndexRef.current]); return; }
      if (e.key === 'Escape') { setMentionState(s => ({ ...s, active: false })); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleReuse = async (msg: any) => {
    if (msg.usedSettings) useAppStore.getState().updateProjectSettings(project.id, msg.usedSettings);
    if (msg.usedAssets) {
      // Build the full restored list FIRST, then commit in one atomic store call.
      // Old approach (clearAssets + N×addAsset across awaits) could interleave
      // with re-renders or any double-invocation pattern and produce duplicates.
      const restored: any[] = [];
      const failures: string[] = [];
      for (const a of msg.usedAssets) {
        const label = a.file_name || a.type.replace('_url', '');
        // strip snapshot id — replaceAllAssets assigns fresh ones
        const { id, ...rest } = a;
        let recovered = false;

        // Reuse must NOT trigger R2 upload — that's send-time territory. Only
        // verify the asset is reachable (cache hit, or disk re-cache via
        // originalPath) so the next send finds it. Keep url cleared so the
        // send loop unconditionally re-uploads to R2 with a fresh per-task key.
        if (a.cacheId) {
          // Confirm cache is still present; cheap HEAD via cache fetch (404 → fall through)
          try {
            const probe = await fetch(`/api/cache/${a.cacheId}`, { method: 'GET' });
            if (probe.ok) {
              probe.body?.cancel?.(); // don't hold the bytes in memory
              restored.push({ ...rest, url: '' });
              recovered = true;
            }
          } catch { /* fall through to originalPath */ }
        }
        if (!recovered && a.originalPath) {
          try {
            // Disk fallback: re-cache the file (NOT R2) so the next send hits cache
            const cacheId = await cacheFromPath(a.originalPath);
            restored.push({ ...rest, url: '', cacheId });
            recovered = true;
          } catch (err: any) {
            const m = (err?.message || '').replace(/^Error:\s*/, '');
            failures.push(`${label}${m ? ' — ' + m : ''}`);
          }
        }

        if (!recovered && !a.originalPath && !a.cacheId) {
          failures.push(`${label}: 캐시 없음 + 원본 경로 정보 없음 (구버전에서 첨부됨)`);
        } else if (!recovered && a.originalPath) {
          // catch above already pushed the failure
        } else if (!recovered) {
          failures.push(`${label}: 복원 실패`);
        }
      }
      useAppStore.getState().replaceAllAssets(project.id, restored);
      if (failures.length > 0) {
        alert(`일부 래퍼런스 복원 실패:\n\n${failures.join('\n')}\n\n파일을 다시 첨부해주세요.`);
      }
    }
    if (msg.promptText && contentEditableRef.current) {
      contentEditableRef.current.innerHTML = textToHtml(msg.promptText, getAssetNames(msg.usedAssets || []));
      // Sync pill asset IDs with newly restored store assets (old IDs → new IDs)
      const freshAssets = getAssetNames(useAppStore.getState().projects.find(p => p.id === project.id)?.assets || []);
      contentEditableRef.current.querySelectorAll('.mention-pill').forEach(pill => {
        const name = pill.getAttribute('data-name');
        const match = freshAssets.find(a => a.name === name);
        if (match) pill.setAttribute('data-asset-id', match.id);
        else pill.removeAttribute('data-asset-id');
      });
      setHasText(true);
    }
    if (showGallery) exitGallery();
    setPreviewItem(null);
  };

  /* ─── Send ─── */
  const handleSend = async () => {
    if (!contentEditableRef.current || isGenerating) return;
    // Force mention labels to the CURRENT asset order before reading the prompt.
    // The [project.assets] sync effect is async (passive), so if the user
    // reorders/replaces and sends in the same tick, the pills could still hold
    // stale "[Image N]" labels — which would mismatch the (current-order)
    // content[] array sent to the API and point a mention at the wrong asset.
    // Re-resolving each pill by its stable data-asset-id closes that race.
    {
      const namedNow = getAssetNames(project.assets);
      contentEditableRef.current.querySelectorAll('.mention-pill').forEach(pill => {
        const id = pill.getAttribute('data-asset-id');
        const a = id ? namedNow.find(n => n.id === id) : null;
        if (a) {
          pill.setAttribute('data-name', a.name);
          const t = pill.querySelector('span[style*="font-weight"]');
          if (t) t.textContent = `[${a.name}]`;
        }
      });
    }
    const plainText = getPlainText(contentEditableRef.current.innerHTML);
    if (!plainText.trim()) return;

    // Validate required assets BEFORE anything else
    const mode = project.settings.mode;
    if (mode === 'image_to_video_first' && !project.assets.some(a => a.role === 'first_frame')) {
      alert('시작 프레임 이미지를 첨부해주세요.'); return;
    }
    if (mode === 'image_to_video_first_last') {
      if (!project.assets.some(a => a.role === 'first_frame') || !project.assets.some(a => a.role === 'last_frame')) {
        alert('시작 프레임과 끝 프레임 이미지를 모두 첨부해주세요.'); return;
      }
    }
    if ((mode === 'edit_video' || mode === 'extend_video') && !project.assets.some(a => a.type === 'video_url')) {
      alert('비디오를 첨부해주세요.'); return;
    }
    // API rule: audio can never be the only reference — at least one image or
    // video must accompany it. Only multimodal can reach this state (other
    // modes either reject audio or already require an image/video above).
    if (mode === 'multimodal_reference' && project.assets.length > 0 && project.assets.every(a => a.type === 'audio_url')) {
      alert('오디오만으로는 생성할 수 없습니다.\n이미지 또는 비디오를 최소 1개 함께 첨부해주세요.'); return;
    }
    // Re-check combined reference durations at send time — assets can arrive
    // via reuse/restore without passing through the attach-time check.
    for (const refType of ['video_url', 'audio_url'] as const) {
      const totErr = totalDurationError(project.assets, refType, null);
      if (totErr) { alert(totErr); return; }
    }

    const currentSettings = { ...project.settings };
    const currentAssets = [...project.assets];

    // Pre-flight: legacy data URL safety check (only matters for old assets pre-URL migration)
    const totalPayloadBytes = currentAssets.reduce((sum, a) => {
      if (a.url.startsWith('data:')) return sum + a.url.length;
      return sum;
    }, 0);
    const totalMB = totalPayloadBytes / (1024 * 1024);
    if (totalMB > 60) {
      alert(`전체 에셋 크기 초과: ${totalMB.toFixed(1)}MB\n이미지를 다시 첨부해주세요.`);
      return;
    }

    // Refresh each reference before sending — all media types go through R2 now,
    // so a single recovery path: cacheId hit → fresh presigned URL, then
    // originalPath fallback (re-read from disk). User-pasted asset:// URIs and
    // raw public URLs have no cacheId, so they're passed through unchanged.
    setIsGenerating(true);
    for (let i = 0; i < currentAssets.length; i++) {
      const a = currentAssets[i];
      if (!a.cacheId && !a.originalPath) continue;

      let done = false;
      if (a.cacheId) {
        try {
          const newUrl = await reuploadFromCache(a.cacheId);
          currentAssets[i] = { ...a, url: newUrl };
          done = true;
        } catch { /* fall through to originalPath */ }
      }
      if (!done && a.originalPath) {
        try {
          const result = await reuploadFromPath(a.originalPath);
          currentAssets[i] = { ...a, url: result.url, cacheId: result.cacheId };
          done = true;
        } catch { /* handled below */ }
      }

      if (!done) {
        alert(`래퍼런스 파일 재업로드 실패: ${a.file_name || a.type}\n원본 파일이 이동/삭제됐을 수 있습니다. 다시 첨부해주세요.`);
        setIsGenerating(false);
        return;
      }
    }

    // All checks passed — keep prompt/settings/assets intact for fast iteration; user manually clears if needed

    const outputCount = project.settings.output_count || 1;
    const systemMessageIds: string[] = [];

    // Build a snapshot of the assets at send time. Used by past message cards
    // to render the prompt mention pills + side thumbnails *frozen* — replacing
    // an asset later (replaceAsset keeps id stable) must NOT mutate any past
    // message. Keeps id/type/role/file_name/cacheId/thumbnailUrl as-is.
    //
    // For images we additionally bake the thumbnail into url so that the side
    // thumbnail keeps rendering after the original tmpfiles URL expires (~24h).
    // For videos we KEEP the original url — overwriting it with the base64
    // thumbnail (added in 2404) made <video src=…> render a broken element.
    const thumbAssets = await Promise.all(currentAssets.map(async a => {
      const out: any = { ...a };
      if (a.type === 'image_url') {
        out.url = a.thumbnailUrl || (await createThumbnail(a.url)) || a.url;
      }
      return out;
    }));

    for (let i = 0; i < outputCount; i++) {
      const id = crypto.randomUUID();
      systemMessageIds.push(id);
      addMessage(project.id, { id, role: 'system', content: `영상 생성 시작... (${i + 1}/${outputCount})`, status: 'queued', promptText: plainText, usedSettings: currentSettings, usedAssets: thumbAssets } as any);
    }
    setTimeout(() => scrollToBottom(), 150);

    try {
      const content: any[] = [{ type: 'text', text: plainText }];
      content.push(...currentAssets.map(asset => {
        const item: any = { type: asset.type, [asset.type]: { url: asset.url } };
        if (currentSettings.mode !== 'image_to_video_first') item.role = asset.role;
        return item;
      }));
      const payload: any = {
        model: project.settings.model, content,
        generate_audio: currentSettings.return_last_frame ? false : project.settings.generate_audio,
        ratio: project.settings.ratio, duration: project.settings.duration,
        resolution: project.settings.resolution, watermark: false,
      };
      if (currentSettings.return_last_frame) payload.return_last_frame = true;

      // Settings + assets are preserved after send so user can iterate quickly with same setup

      await Promise.allSettled(systemMessageIds.map(async (sysMsgId) => {
        try {
          const res = await fetch('/api/byteplus/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          const text = await res.text();
          let data; try { data = JSON.parse(text); } catch { throw new Error(res.status === 413 ? '파일 크기 초과 (이미지 개당 30MB, 전체 64MB 이하)' : `서버 응답 오류 (${res.status})`); }
          if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new Error(data.error?.message || data.msg || data.error || JSON.stringify(data));
          const taskId = data.id || data.data?.task_id;
          if (!taskId) throw new Error('Task ID를 받지 못했습니다.');
          updateMessage(project.id, sysMsgId, { content: `Task 생성 완료. ID: ${taskId}`, taskId, status: 'running', startTime: Date.now(), usedSettings: currentSettings, usedAssets: thumbAssets, promptText: plainText });
          useAppStore.getState().pollTask(project.id, sysMsgId, taskId);
        } catch (error: any) {
          updateMessage(project.id, sysMsgId, { content: '영상 생성 실패', status: 'failed', error: error.message, endTime: Date.now() });
        }
      }));
    } catch (error: any) {
      systemMessageIds.forEach(id => updateMessage(project.id, id, { content: '영상 생성 실패', status: 'failed', error: error.message, endTime: Date.now() }));
    } finally { setIsGenerating(false); }
  };

  /* ─── Render ─── */
  const downloadEntries = Object.entries(downloads);
  const activeCount = downloadEntries.filter(([, i]) => i.state !== 'completed' && i.state !== 'interrupted' && i.state !== 'cancelled').length;
  const dismissDownload = (filename: string) => setDownloads(d => { const n = { ...d }; delete n[filename]; return n; });
  const dismissAllDownloads = () => setDownloads({});
  return (
    <div className="flex-1 flex flex-col bg-[#fafafa] h-full relative min-w-0" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* Download progress — collapsed pill or expanded list */}
      <AnimatePresence>
      {downloadEntries.length > 0 && (
        downloadsCollapsed ? (
          <motion.button
            key="dl-pill"
            initial={{ opacity: 0, scale: 0.85, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={() => setDownloadsCollapsed(false)}
            className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 bg-white border border-gray-200 shadow-lg rounded-full px-3 py-1.5 hover:border-indigo-300 transition-colors"
          >
            {activeCount > 0 ? <Loader2 size={12} className="text-indigo-500 animate-spin" /> : <Download size={12} className="text-green-500" />}
            <span className="text-[11px] text-gray-700 font-medium">{activeCount > 0 ? `다운로드 ${activeCount}` : '완료'}</span>
          </motion.button>
        ) : (
          <motion.div
            key="dl-list"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-4 right-4 z-[60] flex flex-col gap-1.5 max-w-xs"
          >
            <div className="flex items-center justify-end gap-1">
              <button onClick={() => setDownloadsCollapsed(true)} className="text-[10px] text-gray-500 hover:text-indigo-600 px-2 py-0.5 bg-white border border-gray-200 rounded-full shadow" title="최소화">접기</button>
              <button onClick={dismissAllDownloads} className="text-[10px] text-gray-500 hover:text-red-500 px-2 py-0.5 bg-white border border-gray-200 rounded-full shadow" title="전체 닫기">전체 닫기</button>
            </div>
            <AnimatePresence mode="popLayout">
              {downloadEntries.map(([filename, info]) => {
                const pct = info.total > 0 ? Math.round((info.received / info.total) * 100) : 0;
                const mb = (info.received / 1024 / 1024).toFixed(1);
                const totalMb = info.total > 0 ? (info.total / 1024 / 1024).toFixed(1) : '?';
                const isDone = info.state === 'completed';
                const isFailed = info.state === 'interrupted' || info.state === 'cancelled';
                return (
                  <motion.div
                    key={filename}
                    layout
                    initial={{ opacity: 0, x: 30, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 30, scale: 0.95, transition: { duration: 0.25 } }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className={`bg-white rounded-lg shadow border ${isFailed ? 'border-red-200' : isDone ? 'border-green-200' : 'border-indigo-200'} px-2.5 py-1.5`}
                  >
                    <div className="flex items-center gap-1.5">
                      {isFailed ? <AlertCircle size={11} className="text-red-500 shrink-0" />
                        : isDone ? <Download size={11} className="text-green-500 shrink-0" />
                        : <Loader2 size={11} className="text-indigo-500 shrink-0 animate-spin" />}
                      <span className="text-[10px] text-gray-700 truncate flex-1" title={filename}>{filename}</span>
                      <button onClick={() => dismissDownload(filename)} className="text-gray-300 hover:text-gray-600 shrink-0" title="닫기"><X size={10} /></button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-gray-500">
                      <span className="font-mono">{isDone ? '완료' : isFailed ? '실패' : `${mb}/${totalMb}MB`}</span>
                      {!isDone && !isFailed && (
                        <div className="flex-1 h-0.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-500 transition-all duration-200" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                      {!isDone && !isFailed && info.total > 0 && <span className="font-mono">{pct}%</span>}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        )
      )}
      </AnimatePresence>

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-50 bg-indigo-50/90 flex flex-col items-center justify-center border-4 border-dashed border-indigo-400 m-4 rounded-2xl animate-fade-in">
          <UploadCloud size={64} className="text-indigo-500 mb-4" />
          <h2 className="text-2xl font-bold text-indigo-700">파일을 여기에 놓으세요</h2>
          <p className="text-indigo-500 mt-2">이미지 / 비디오 / 오디오 래퍼런스로 추가됩니다</p>
        </div>
      )}

      {/* Header */}
      <div className="h-14 border-b border-gray-200/80 bg-white/90 backdrop-blur-xl flex items-center justify-between px-6 shrink-0 z-10 sticky top-0">
        {showGallery ? (
          <button onClick={exitGallery} className="flex items-center gap-2 text-[15px] font-medium text-gray-500 hover:text-indigo-600 transition-colors">
            ← 채팅으로 돌아가기
          </button>
        ) : (
          <h1 className="text-[20px] font-semibold text-[#1d1d1f] tracking-tight truncate">{project.name}</h1>
        )}
        <div className="flex items-center gap-2">
          {!showGallery && (
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input type="text" value={headerSearch} onChange={(e) => setHeaderSearch(e.target.value)} placeholder="프롬프트 검색..."
                className="w-44 pl-8 pr-3 py-1.5 bg-gray-50 border border-gray-200 focus:border-indigo-400 focus:bg-white rounded-lg text-[13px] outline-none transition-all" />
            </div>
          )}
          <button onClick={showGallery ? exitGallery : enterGallery} className={`p-2 rounded-lg transition-all ${showGallery ? 'bg-indigo-500 text-white shadow-md' : 'text-gray-400 hover:bg-gray-100 hover:text-indigo-600'}`} title="갤러리">
            <LayoutGrid size={18} />
          </button>
        </div>
      </div>

      {/* Preview Modal */}
      {previewItem && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={() => setPreviewItem(null)}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="aspect-video bg-black rounded-t-2xl overflow-hidden">
              <VideoPlayer src={previewItem.videoUrl} className="w-full h-full" eager />
            </div>
            <div className="p-6 space-y-4">
              <div>
                <p className="text-[11px] font-semibold text-indigo-500 uppercase tracking-wider">{project.name}</p>
                <p className="text-[15px] text-gray-800 mt-1 leading-relaxed whitespace-pre-wrap">{previewItem.promptText || '프롬프트 없음'}</p>
              </div>
              {previewItem.usedAssets?.length > 0 && (
                <div>
                  <p className="text-[12px] font-semibold text-gray-500 mb-2">래퍼런스</p>
                  <div className="flex gap-2 flex-wrap">
                    {previewItem.usedAssets.map((a: any, i: number) => (
                      <div key={i} className="w-16 h-16 rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
                        {a.type === 'image_url' ? (
                          <img src={a.url} className="w-full h-full object-cover" />
                        ) : a.type === 'video_url' && a.thumbnailUrl ? (
                          <img src={a.thumbnailUrl} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">{a.type === 'audio_url' ? <Music size={20} /> : <Video size={20} />}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {previewItem.usedSettings && (
                <div className="flex flex-wrap gap-2">
                  {[previewItem.usedSettings.mode, previewItem.usedSettings.resolution, previewItem.usedSettings.ratio, previewItem.usedSettings.duration === -1 ? 'Auto' : `${previewItem.usedSettings.duration}s`].map((tag, i) => (
                    <span key={i} className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-[11px] font-medium">{tag}</span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                <button onClick={() => { if (previewItem.videoUrl && previewItem.taskId) handleVideoDownload(previewItem.id, previewItem.videoUrl, previewItem.taskId); }}
                  className={`flex items-center gap-1.5 px-4 py-2 text-white text-[13px] font-medium rounded-lg transition-colors ${previewDownloaded ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-indigo-500 hover:bg-indigo-600'}`}>
                  {previewDownloaded ? <RefreshCw size={14} /> : <Download size={14} />} {previewDownloaded ? '다시 다운로드' : '다운로드'}
                </button>
                <button onClick={() => scrollToMessage(previewItem.id)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-gray-100 text-gray-700 text-[13px] font-medium rounded-lg hover:bg-gray-200 transition-colors">
                  <Search size={14} /> 프롬프트 찾기
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Gallery */}
      {showGallery ? (
        <div className="flex-1 overflow-y-auto p-6 bg-[#f5f5f7]">
          {galleryVideos.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 animate-fade-in">
              <LayoutGrid size={48} className="text-gray-300" />
              <p className="text-lg">아직 생성된 영상이 없습니다.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
              {galleryVideos.map((item, idx) => (
                <div key={item.id} className="bg-white rounded-xl shadow-sm border border-gray-200/80 overflow-hidden hover:shadow-md hover:border-gray-300 transition-all duration-200 animate-fade-in-up" >
                  <div className="aspect-video bg-black relative group">
                    <VideoPlayer src={item.videoUrl!} className="w-full h-full" />
                  </div>
                  <div className="p-3 space-y-2">
                    <p className="text-[11px] font-semibold text-indigo-500">{project.name}</p>
                    <p className="text-[13px] text-gray-700 line-clamp-2 leading-snug h-[2.5em]">{item.promptText || '프롬프트 없음'}</p>
                    <div className="flex items-center gap-1 pt-1 flex-wrap">
                      <button onClick={() => { if (item.videoUrl && item.taskId) handleVideoDownload(item.id, item.videoUrl, item.taskId); }}
                        className={`flex items-center gap-1 text-[11px] font-medium px-1.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 ${item.downloadedAt
                          ? 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50'
                          : 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50'}`}>
                        {item.downloadedAt ? <RefreshCw size={12} /> : <Download size={12} />} {item.downloadedAt ? '다시 다운로드' : '다운로드'}
                      </button>
                      <button onClick={() => setPreviewItem(item)}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors whitespace-nowrap shrink-0">
                        <Eye size={12} /> 상세
                      </button>
                      <button onClick={() => scrollToMessage(item.id)}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors whitespace-nowrap shrink-0">
                        <Search size={12} /> 찾기
                      </button>
                      <span className="text-[10px] text-gray-400 ml-auto whitespace-nowrap shrink-0">{new Date(item.timestamp).toLocaleDateString()}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Messages */}
          <div ref={messagesScrollRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto p-6 space-y-5 bg-[#f5f5f7]">
            {displayMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 animate-fade-in">
                {headerSearch ? <><Search size={44} className="text-gray-300" /><p className="text-lg">검색 결과가 없습니다.</p></> : <><Play size={44} className="text-gray-300" /><p className="text-lg">프롬프트를 입력하여 영상을 생성하세요.</p></>}
              </div>
            ) : (
              displayMessages.map((msg, idx) => (
                <div key={msg.id} id={`msg-${msg.id}`} className="flex justify-center animate-fade-in-up" >
                  <div className="w-full max-w-3xl bg-white rounded-2xl shadow-sm border border-gray-200/80 overflow-hidden hover:shadow-md transition-shadow duration-300">
                    {/* Card Header */}
                    <div className="p-4 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-white">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0 flex flex-col sm:flex-row gap-3">
                          {msg.usedAssets?.length > 0 && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              {msg.usedAssets.map((asset: any, i: number) => (
                                <div key={asset.id || i} className="w-11 h-11 rounded-lg overflow-hidden border border-gray-200 shadow-sm bg-white relative group shrink-0">
                                  {asset.type.startsWith('video') ? (
                                    asset.thumbnailUrl
                                      ? <img src={asset.thumbnailUrl} alt="" className="w-full h-full object-cover" />
                                      : <div className="w-full h-full flex items-center justify-center bg-purple-50 text-purple-400"><Video size={14} /></div>
                                  ) : asset.type.startsWith('audio') ? (
                                    <div className="w-full h-full flex items-center justify-center bg-indigo-50 text-indigo-400"><Music size={14} /></div>
                                  ) : (
                                    <img src={asset.url} alt="" className="w-full h-full object-cover" />
                                  )}
                                  <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[7px] text-center py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">{asset.role?.replace('_', ' ')}</div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            {msg.promptText
                              ? <CollapsiblePrompt promptText={msg.promptText} namedAssets={getAssetNames((msg.usedAssets as any) || [])} />
                              : <div className="text-[14px] text-gray-400 italic">프롬프트 없음</div>}
                            {msg.usedSettings && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {[msg.usedSettings.mode, msg.usedSettings.resolution, msg.usedSettings.ratio, msg.usedSettings.duration === -1 ? 'Auto' : `${msg.usedSettings.duration}s`].map((tag, i) => (
                                  <span key={i} className="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-[10px] font-medium">{tag}</span>
                                ))}
                              </div>
                            )}
                            {msg.taskId && (
                              <button
                                onClick={() => { navigator.clipboard.writeText(msg.taskId!); }}
                                className="mt-2 text-[10px] font-mono text-indigo-500/70 bg-indigo-50/50 hover:bg-indigo-100/60 rounded-md px-2 py-0.5 w-fit transition-colors cursor-pointer text-left break-all"
                                title="클릭하여 복사"
                              >
                                Task: {msg.taskId}
                              </button>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button onClick={() => handleReuse(msg)} className="p-1.5 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors" title="프롬프트 재사용"><RefreshCw size={15} /></button>
                          <button onClick={() => useAppStore.getState().deleteMessage(project.id, msg.id)} className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="삭제"><Trash2 size={15} /></button>
                        </div>
                      </div>
                    </div>
                    {/* Card Body */}
                    <div className="p-4">
                      {(msg.status === 'running' || msg.status === 'queued') ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2 text-sm text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg">
                            <div className="flex items-center gap-2">
                              <Loader2 size={16} className="animate-spin" />
                              {msg.status === 'queued' ? '대기열에서 대기 중...' : '영상 생성 중...'}
                            </div>
                            {msg.taskId && (
                              <button
                                onClick={() => useAppStore.getState().cancelTask(project.id, msg.id, msg.taskId!)}
                                className="text-[12px] font-medium text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded-md transition-colors"
                              >
                                취소
                              </button>
                            )}
                          </div>
                          <div className="w-full aspect-video bg-gradient-to-br from-gray-100 to-gray-50 animate-pulse rounded-xl flex flex-col items-center justify-center border border-gray-200/50">
                            <Loader2 size={28} className="animate-spin text-indigo-400 mb-2" />
                            <LiveTimer startTime={msg.startTime} endTime={msg.endTime} />
                          </div>
                        </div>
                      ) : msg.status === 'failed' ? (
                        <div className="flex items-start gap-2.5 text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">
                          <AlertCircle size={16} className="shrink-0 mt-0.5" />
                          <div>
                            <p className="font-medium">생성 실패</p>
                            <p className="text-red-500 mt-0.5 text-[13px]">{translateError(msg.error || '')}</p>
                            {msg.error && msg.error !== translateError(msg.error) && <p className="text-red-400 mt-1 text-[11px] font-mono">{msg.error}</p>}
                          </div>
                        </div>
                      ) : msg.status === 'succeeded' && (msg.videoUrl || msg.imageUrl) ? (
                        <div className="space-y-3">
                          {msg.videoUrl && (
                            <VideoPlayer src={msg.videoUrl} className="rounded-xl overflow-hidden border border-gray-200/80 bg-black" />
                          )}
                          {msg.imageUrl && (
                            <div className="rounded-xl overflow-hidden border border-gray-200/80 bg-black">
                              <img src={msg.imageUrl} alt="Last Frame" className="w-full max-h-[400px] object-contain" />
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              {msg.videoUrl && (
                                <button onClick={() => handleVideoDownload(msg.id, msg.videoUrl!, msg.taskId || 'unknown')}
                                  className={`flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-lg border transition-all whitespace-nowrap shrink-0 ${msg.downloadedAt
                                    ? 'text-emerald-600 hover:text-emerald-700 bg-emerald-50/70 hover:bg-emerald-50 border-emerald-200'
                                    : 'text-gray-500 hover:text-indigo-600 bg-gray-50 hover:bg-indigo-50 border-gray-200 hover:border-indigo-200'}`}>
                                  {msg.downloadedAt ? <RefreshCw size={14} /> : <Download size={14} />} {msg.downloadedAt ? '다시 다운로드' : '영상 다운로드'}
                                </button>
                              )}
                              {msg.imageUrl && (
                                <button onClick={() => downloadViaProxy(msg.imageUrl!, buildDownloadFilename(msg.taskId || 'unknown', '.png'))}
                                  className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-indigo-600 px-3 py-1.5 bg-gray-50 hover:bg-indigo-50 rounded-lg border border-gray-200 hover:border-indigo-200 transition-all whitespace-nowrap shrink-0">
                                  <Download size={14} /> 이미지
                                </button>
                              )}
                            </div>
                            <div className="text-[11px] text-gray-400 whitespace-nowrap shrink-0">소요 시간: <LiveTimer startTime={msg.startTime} endTime={msg.endTime} /></div>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />

            {showScrollBottom ? (
              <button onClick={scrollToBottom} className="sticky bottom-4 float-right mr-2 flex items-center gap-1.5 px-3 py-2 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-full shadow-lg text-[12px] font-medium text-gray-500 hover:text-indigo-600 hover:border-indigo-300 transition-all z-20">
                <ArrowDown size={14} /> 맨 아래로
              </button>
            ) : showScrollTop ? (
              <button onClick={scrollToTop} className="sticky bottom-4 float-right mr-2 flex items-center gap-1.5 px-3 py-2 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-full shadow-lg text-[12px] font-medium text-gray-500 hover:text-indigo-600 hover:border-indigo-300 transition-all z-20">
                <ArrowUp size={14} /> 맨 위로
              </button>
            ) : null}
          </div>

          {/* Input */}
          <div className="p-4 bg-white border-t border-gray-200/80 shrink-0 relative">
            {/* Resize grabber — sits above the prompt box */}
            <div className="max-w-4xl mx-auto flex justify-center mb-1.5">
              <div
                onMouseDown={handlePromptResize}
                title="드래그해서 크기 조절"
                className="h-1.5 w-14 rounded-full bg-gray-300 hover:bg-indigo-400 active:bg-indigo-500 cursor-ns-resize transition-colors"
              />
            </div>

            {mentionState.active && filteredMentionAssets.length > 0 && (
              <div className="absolute bottom-full mb-2 left-4 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden z-50 min-w-[250px] animate-slide-up">
                <div className="px-3 py-2 bg-gray-50 border-b border-gray-100 text-xs font-semibold text-gray-500">에셋 선택</div>
                <div className="max-h-48 overflow-y-auto">
                  {filteredMentionAssets.map((asset, idx) => (
                    <button key={asset.id} onClick={() => insertMention(asset)}
                      className={`mention-item w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-indigo-50 transition-none ${idx === mentionIndexRef.current ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'}`}>
                      {asset.type === 'image_url' && (asset.thumbnailUrl || asset.url) ? <img src={asset.thumbnailUrl || asset.url} className="w-6 h-6 object-cover rounded shrink-0 border border-gray-200" alt="" /> : asset.type === 'image_url' ? <div className="w-6 h-6 bg-blue-50 flex items-center justify-center rounded shrink-0"><ImageIcon size={14} className="text-blue-500" /></div> : asset.type === 'video_url' ? <div className="w-6 h-6 bg-purple-50 flex items-center justify-center rounded shrink-0"><Video size={14} className="text-purple-500" /></div> : <div className="w-6 h-6 bg-green-50 flex items-center justify-center rounded shrink-0"><Music size={14} className="text-green-500" /></div>}
                      <span className="font-medium">[{asset.name}]</span>
                      <span className="text-xs text-gray-400 ml-auto">{asset.role}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="max-w-4xl mx-auto relative flex flex-col gap-2 bg-gray-50 border-2 border-gray-200 rounded-2xl p-2 focus-within:border-indigo-400 focus-within:bg-white transition-all duration-200">
              <AnimatePresence>
              {(project.settings.mode === 'image_to_video_first' || project.settings.mode === 'image_to_video_first_last') && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: 'easeInOut' }} className="overflow-hidden">
                <div className="flex gap-3 px-2 pt-2 pb-1">
                  {/* Start Frame */}
                  <div className="relative w-20 h-20 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center overflow-hidden group hover:border-indigo-400 transition-colors bg-white">
                    {project.assets.find(a => a.role === 'first_frame') ? (
                      <>
                        <img src={(project.assets.find(a => a.role === 'first_frame') as any)?.thumbnailUrl || project.assets.find(a => a.role === 'first_frame')?.url} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button onClick={() => removeAsset(project.id, project.assets.find(a => a.role === 'first_frame')!.id)} className="text-white bg-red-500 p-1 rounded-full hover:bg-red-600"><X size={12} /></button>
                        </div>
                        <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] text-center py-0.5">시작</div>
                      </>
                    ) : (
                      <>
                        <input type="file" accept="image/*" onChange={(e) => handleFrameUpload(e, 'first_frame')} onDrop={(e) => handleFrameDrop(e, 'first_frame')} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }} className="absolute inset-0 opacity-0 cursor-pointer" />
                        <ImageIcon className="text-gray-400 mb-0.5" size={16} />
                        <span className="text-[9px] text-gray-400 text-center px-1">시작 프레임</span>
                      </>
                    )}
                  </div>
                  {/* End Frame */}
                  {project.settings.mode === 'image_to_video_first_last' && (
                    <div className="relative w-20 h-20 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center overflow-hidden group hover:border-indigo-400 transition-colors bg-white">
                      {project.assets.find(a => a.role === 'last_frame') ? (
                        <>
                          <img src={(project.assets.find(a => a.role === 'last_frame') as any)?.thumbnailUrl || project.assets.find(a => a.role === 'last_frame')?.url} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button onClick={() => removeAsset(project.id, project.assets.find(a => a.role === 'last_frame')!.id)} className="text-white bg-red-500 p-1 rounded-full hover:bg-red-600"><X size={12} /></button>
                          </div>
                          <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] text-center py-0.5">끝</div>
                        </>
                      ) : (
                        <>
                          <input type="file" accept="image/*" onChange={(e) => handleFrameUpload(e, 'last_frame')} onDrop={(e) => handleFrameDrop(e, 'last_frame')} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }} className="absolute inset-0 opacity-0 cursor-pointer" />
                          <ImageIcon className="text-gray-400 mb-0.5" size={16} />
                          <span className="text-[9px] text-gray-400 text-center px-1">끝 프레임</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                </motion.div>
              )}
              </AnimatePresence>
              <div className="flex items-end gap-2 w-full">
                <div ref={contentEditableRef} contentEditable onInput={handleInput} onKeyDown={handleKeyDown} onPaste={handlePromptPaste}
                  style={{ minHeight: 44, maxHeight: `min(${promptHeight}px, 70vh)` }}
                  className="w-full overflow-y-auto bg-transparent border-none focus:ring-0 resize-none py-2 px-3 text-[16px] text-[#1d1d1f] outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
                  data-placeholder="영상을 설명해주세요... (@로 에셋 멘션)" />
                <button onClick={handleSend} disabled={!hasText || isGenerating}
                  className="shrink-0 bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white p-2.5 rounded-xl transition-all duration-200 mb-0.5 mr-0.5 active:scale-95">
                  {isGenerating ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                </button>
              </div>
            </div>
          </div>
        </>
      )}

    </div>
  );
}
