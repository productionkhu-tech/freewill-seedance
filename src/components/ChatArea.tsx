import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useAppStore, AssetRole } from '../store';
import { Send, Loader2, AlertCircle, Play, UploadCloud, Video, Music, Image as ImageIcon, Download, RefreshCw, X, Trash2, Search, LayoutGrid, ArrowUp, ArrowDown, Eye } from 'lucide-react';
import { getAssetNames } from './SettingsPanel';
import { motion, AnimatePresence } from 'motion/react';
import { downloadViaProxy, buildDownloadFilename, validateImageFile, validateImageDimensions, validateVideoFile, validateAudioFile, createThumbnail, reuploadFromCache, uploadToPublicUrl } from '../lib/utils';

/* ─── Korean error translation ─── */
function translateError(error: string): string {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  if (error.includes('API Key is required')) return 'API 키 오류: 서버를 재시작해주세요. (start.bat)';
  if (error.includes('Payload Too Large')) return '파일 크기 초과: 이미지 개당 30MB, 전체 요청 64MB 이하여야 합니다.';
  if (error.includes('resource download failed')) return '리소스 다운로드 실패: 이미지에 접근할 수 없습니다. 파일을 다시 업로드해주세요.';
  if (error.includes('rate limit') || error.includes('429')) return 'API 요청 한도 초과: 잠시 후 다시 시도해주세요.';
  if (error.includes('No task ID')) return 'Task ID를 받지 못했습니다. API 응답을 확인해주세요.';
  if (error.includes('1080p is not supported for this account')) return '1080p는 현재 계정에서 사용할 수 없습니다. BytePlus 콘솔에서 1080p 권한을 활성화하거나 480p/720p를 사용해주세요.';
  if (error.includes('not supported for this account')) return `현재 계정에서 사용할 수 없는 옵션입니다: ${error}`;
  if (error.includes('not valid')) return `잘못된 파라미터: ${error}`;
  if (error.includes('timeout') || error.includes('ETIMEDOUT')) return '요청 시간 초과: 네트워크 연결을 확인해주세요.';
  if (error.includes('Failed to fetch') || error.includes('NetworkError')) return '네트워크 오류: 인터넷 연결을 확인해주세요.';
  return error;
}

/* ─── Video player: lazy mount + active preload when near viewport ─── */
function VideoPlayer({ src, className, eager }: { src: string; className?: string; eager?: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(eager === true);

  useEffect(() => {
    if (eager) return; // eager mode: skip observer, mount immediately
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true); // mount + preload when within 500px of viewport
        } else if (videoRef.current) {
          videoRef.current.pause();
        }
      },
      { threshold: 0, rootMargin: '500px' }
    );
    observer.observe(container);
    return () => observer.disconnect();
  }, [eager]);

  return (
    <div ref={containerRef} className={`${className} aspect-video bg-black flex items-center justify-center`}>
      {mounted ? (
        <video
          ref={videoRef}
          src={src}
          controls
          muted
          playsInline
          preload={eager ? 'auto' : 'metadata'}
          className="w-full h-full object-contain"
        />
      ) : (
        <Play size={40} className="text-white/30" />
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
        const imgSrc = asset.type === 'image_url' ? (asset.thumbnailUrl || asset.url) : '';
        const iconHtml = asset.type === 'image_url'
          ? `<img src="${imgSrc}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;display:inline-block;vertical-align:middle;margin-right:4px;" />`
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
            {asset.type === 'image_url' ? <img src={asset.url} className="w-4 h-4 object-cover rounded-sm" alt="" /> : asset.type === 'video_url' ? <Video size={12} /> : <Music size={12} />}
            <span className="font-medium">[{asset.name}]</span>
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
};

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
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const previousProjectIdRef = useRef<string | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [promptHeight, setPromptHeight] = useState(44);
  const [downloads, setDownloads] = useState<Record<string, { received: number; total: number; state: string }>>({});

  // Listen to download events from Electron main process
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api?.onDownloadStarted) return;
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
          // Auto-dismiss completed downloads after 3s
          setTimeout(() => setDownloads(curr => { const c = { ...curr }; delete c[filename]; return c; }), 3000);
        }
        next[filename] = { ...(next[filename] || { received: 0, total: 0 }), state };
        return next;
      });
    });
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

  // Track mention pills by asset UUID — remove deleted, renumber shifted
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
        } else if (asset.name !== pill.getAttribute('data-name')) {
          // Asset was renumbered (e.g. Image 3 → Image 2) → update pill
          pill.setAttribute('data-name', asset.name);
          const textSpan = pill.querySelector('span[style*="font-weight"]');
          if (textSpan) textSpan.textContent = `[${asset.name}]`;
          changed = true;
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
            const result = await uploadToPublicUrl(file);
            addAsset(project.id, { type: 'image_url', url: result.url, role, file_name: file.name, cacheId: result.cacheId, thumbnailUrl });
          } catch (e: any) { rejected.push(`${file.name}: 처리 실패 — ${e.message || ''}`); }

        } else if (file.type.startsWith('video/')) {
          if (mode === 'image_to_video_first' || mode === 'image_to_video_first_last') {
            rejected.push(`${file.name}: 이 모드는 이미지만 받습니다.`); continue;
          }
          const vidCount = assets.filter(a => a.type === 'video_url').length;
          const maxVid = mode === 'extend_video' ? 3 : mode === 'edit_video' ? 1 : mode === 'multimodal_reference' ? 3 : 0;
          if (vidCount >= maxVid) { rejected.push(`${file.name}: 비디오 한도 ${maxVid}개 초과`); continue; }
          const vidErr = await validateVideoFile(file);
          if (vidErr) { rejected.push(`${file.name}: ${vidErr}`); continue; }
          try {
            const result = await uploadToPublicUrl(file);
            addAsset(project.id, { type: 'video_url', url: result.url, role: 'reference_video', file_name: file.name, cacheId: result.cacheId });
          } catch (e: any) { rejected.push(`${file.name}: 업로드 실패 — ${e.message}`); }

        } else if (file.type.startsWith('audio/')) {
          if (mode !== 'multimodal_reference' && mode !== 'edit_video') {
            rejected.push(`${file.name}: 이 모드에서는 오디오를 사용할 수 없습니다.`); continue;
          }
          const audCount = assets.filter(a => a.type === 'audio_url').length;
          const maxAud = 3;
          if (audCount >= maxAud) { rejected.push(`${file.name}: 오디오 한도 ${maxAud}개 초과`); continue; }
          const audErr = await validateAudioFile(file);
          if (audErr) { rejected.push(`${file.name}: ${audErr}`); continue; }
          try {
            const result = await uploadToPublicUrl(file);
            addAsset(project.id, { type: 'audio_url', url: result.url, role: 'reference_audio', file_name: file.name, cacheId: result.cacheId });
          } catch (e: any) { rejected.push(`${file.name}: 업로드 실패 — ${e.message}`); }
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
    const imgSrc = asset.type === 'image_url' ? (asset.thumbnailUrl || asset.url) : '';
    const iconHtml = asset.type === 'image_url'
      ? `<img src="${imgSrc}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;margin-right:4px;" />`
      : `<span style="width:16px;height:16px;background:#f0f0f5;border-radius:2px;margin-right:4px;text-align:center;line-height:16px;font-size:10px;display:inline-block;">${asset.type === 'video_url' ? '🎥' : '🎵'}</span>`;
    pill.innerHTML = `${iconHtml}<span style="font-weight:500;">[${asset.name}]</span>`;
    const space = document.createTextNode('\u00A0');
    range.insertNode(space); range.insertNode(pill);
    range.setStartAfter(space); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    setMentionState(s => ({ ...s, active: false })); setHasText(true);
  };

  const processFrameFile = async (file: File, role: AssetRole) => {
    if (!file.type.startsWith('image/')) { alert('이미지 파일만 업로드할 수 있습니다.'); return; }
    const sizeErr = validateImageFile(file);
    if (sizeErr) { alert(sizeErr); return; }
    try {
      const dimErr = await validateImageDimensions(file);
      if (dimErr) { alert(dimErr); return; }
      const thumbnailUrl = await createThumbnail(file);
      const result = await uploadToPublicUrl(file);
      addAsset(project.id, { type: 'image_url', url: result.url, role, file_name: file.name, cacheId: result.cacheId, thumbnailUrl });
    } catch (e) { alert(`이미지 업로드 실패: ${file.name}`); }
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
      useAppStore.getState().clearAssets(project.id);
      let needReattach: string[] = [];
      for (const a of msg.usedAssets) {
        if (a.cacheId) {
          try {
            // Re-upload original bytes from server cache → new public URL (works for image/video/audio)
            const newUrl = await reuploadFromCache(a.cacheId);
            useAppStore.getState().addAsset(project.id, { ...a, id: crypto.randomUUID(), url: newUrl });
          } catch {
            needReattach.push(a.file_name || a.type.replace('_url', ''));
          }
        } else {
          // No cache → can't restore
          needReattach.push(a.file_name || a.type.replace('_url', ''));
        }
      }
      if (needReattach.length > 0) {
        alert(`일부 래퍼런스 복원 실패: ${needReattach.join(', ')}\n파일을 다시 첨부해주세요.`);
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

    // Re-upload assets if their public URLs may have expired (all types now use URLs)
    setIsGenerating(true);
    for (let i = 0; i < currentAssets.length; i++) {
      const a = currentAssets[i];
      if (a.cacheId && a.url.includes('tmpfiles.org')) {
        try {
          const newUrl = await reuploadFromCache(a.cacheId);
          currentAssets[i] = { ...a, url: newUrl };
        } catch {
          alert(`래퍼런스 파일 재업로드 실패: ${a.file_name || a.type}\n파일을 다시 첨부해주세요.`);
          setIsGenerating(false);
          return;
        }
      }
    }

    // All checks passed — now clear input and create messages
    contentEditableRef.current.innerHTML = ''; setHasText(false);
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    useAppStore.getState().updateDraftPrompt(project.id, '');

    const outputCount = project.settings.output_count || 1;
    const systemMessageIds: string[] = [];

    // Pre-computed thumbnail (image upload time) used as-is; for legacy/non-image just pass through
    const thumbAssets = await Promise.all(currentAssets.map(async a => ({
      ...a,
      url: a.thumbnailUrl || (await createThumbnail(a.url)) || a.url,
    })));

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
  return (
    <div className="flex-1 flex flex-col bg-[#fafafa] h-full relative min-w-0" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* Download progress toasts (bottom-right) */}
      {downloadEntries.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 max-w-sm">
          {downloadEntries.map(([filename, info]) => {
            const pct = info.total > 0 ? Math.round((info.received / info.total) * 100) : 0;
            const mb = (info.received / 1024 / 1024).toFixed(1);
            const totalMb = info.total > 0 ? (info.total / 1024 / 1024).toFixed(1) : '?';
            const isDone = info.state === 'completed';
            const isFailed = info.state === 'interrupted' || info.state === 'cancelled';
            return (
              <div key={filename} className={`bg-white rounded-xl shadow-lg border ${isFailed ? 'border-red-200' : isDone ? 'border-green-200' : 'border-indigo-200'} p-3 animate-slide-up`}>
                <div className="flex items-center gap-2 mb-1">
                  {isFailed ? <AlertCircle size={14} className="text-red-500 shrink-0" />
                    : isDone ? <Download size={14} className="text-green-500 shrink-0" />
                    : <Loader2 size={14} className="text-indigo-500 shrink-0 animate-spin" />}
                  <span className="text-[12px] font-medium text-gray-700 truncate flex-1" title={filename}>{filename}</span>
                </div>
                <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                  <span>{isDone ? '완료' : isFailed ? '실패' : `${mb}MB / ${totalMb}MB`}</span>
                  <span>{!isDone && !isFailed && info.total > 0 ? `${pct}%` : ''}</span>
                </div>
                {!isDone && !isFailed && (
                  <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 transition-all duration-200" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

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
                        {a.type === 'image_url' ? <img src={a.url} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-gray-400"><Video size={20} /></div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {previewItem.usedSettings && (
                <div className="flex flex-wrap gap-2">
                  {[previewItem.usedSettings.mode, previewItem.usedSettings.resolution, previewItem.usedSettings.ratio, `${previewItem.usedSettings.duration}s`].map((tag, i) => (
                    <span key={i} className="px-2.5 py-1 bg-gray-100 text-gray-600 rounded-full text-[11px] font-medium">{tag}</span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                <button onClick={() => { if (previewItem.videoUrl && previewItem.taskId) downloadViaProxy(previewItem.videoUrl, buildDownloadFilename(previewItem.taskId)); }}
                  className="flex items-center gap-1.5 px-4 py-2 bg-indigo-500 text-white text-[13px] font-medium rounded-lg hover:bg-indigo-600 transition-colors">
                  <Download size={14} /> 다운로드
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
                    <div className="flex items-center gap-1.5 pt-1">
                      <button onClick={() => { if (item.videoUrl && item.taskId) downloadViaProxy(item.videoUrl, buildDownloadFilename(item.taskId)); }}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors">
                        <Download size={12} /> 다운로드
                      </button>
                      <button onClick={() => setPreviewItem(item)}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors">
                        <Eye size={12} /> 상세
                      </button>
                      <button onClick={() => scrollToMessage(item.id)}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-2 py-1 rounded-md hover:bg-indigo-50 transition-colors">
                        <Search size={12} /> 찾기
                      </button>
                      <span className="text-[10px] text-gray-400 ml-auto">{new Date(item.timestamp).toLocaleDateString()}</span>
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
                        <div className="flex-1 flex flex-col sm:flex-row gap-3">
                          {msg.usedAssets?.length > 0 && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              {msg.usedAssets.map((asset: any, i: number) => (
                                <div key={asset.id || i} className="w-11 h-11 rounded-lg overflow-hidden border border-gray-200 shadow-sm bg-white relative group shrink-0">
                                  {asset.type.startsWith('video') ? <video src={asset.url} className="w-full h-full object-cover" /> : asset.type.startsWith('audio') ? <div className="w-full h-full flex items-center justify-center bg-indigo-50 text-indigo-400"><Music size={14} /></div> : <img src={asset.url} alt="" className="w-full h-full object-cover" />}
                                  <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[7px] text-center py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">{asset.role?.replace('_', ' ')}</div>
                                </div>
                              ))}
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="text-[14px] text-gray-800 font-medium whitespace-pre-wrap leading-relaxed">{msg.promptText ? renderMessageContent(msg.promptText, namedAssets) : '프롬프트 없음'}</div>
                            {msg.usedSettings && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {[msg.usedSettings.mode, msg.usedSettings.resolution, msg.usedSettings.ratio, `${msg.usedSettings.duration}s`].map((tag, i) => (
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
                                <button onClick={() => downloadViaProxy(msg.videoUrl!, buildDownloadFilename(msg.taskId || 'unknown'))}
                                  className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-indigo-600 px-3 py-1.5 bg-gray-50 hover:bg-indigo-50 rounded-lg border border-gray-200 hover:border-indigo-200 transition-all">
                                  <Download size={14} /> 영상 다운로드
                                </button>
                              )}
                              {msg.imageUrl && (
                                <button onClick={() => downloadViaProxy(msg.imageUrl!, buildDownloadFilename(msg.taskId || 'unknown', '.png'))}
                                  className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-indigo-600 px-3 py-1.5 bg-gray-50 hover:bg-indigo-50 rounded-lg border border-gray-200 hover:border-indigo-200 transition-all">
                                  <Download size={14} /> 이미지
                                </button>
                              )}
                            </div>
                            <div className="text-[11px] text-gray-400">소요 시간: <LiveTimer startTime={msg.startTime} endTime={msg.endTime} /></div>
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
                      {asset.type === 'image_url' ? <img src={asset.url} className="w-6 h-6 object-cover rounded shrink-0 border border-gray-200" alt="" /> : asset.type === 'video_url' ? <div className="w-6 h-6 bg-purple-50 flex items-center justify-center rounded shrink-0"><Video size={14} className="text-purple-500" /></div> : <div className="w-6 h-6 bg-green-50 flex items-center justify-center rounded shrink-0"><Music size={14} className="text-green-500" /></div>}
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
                <div ref={contentEditableRef} contentEditable onInput={handleInput} onKeyDown={handleKeyDown}
                  style={{ minHeight: promptHeight, maxHeight: '70vh' }}
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
