import { useState, useEffect, useMemo } from 'react';
import { useAppStore, AssetRole, Asset, GenerationMode, defaultSettings, MODELS, modelResolutions, modelProvider } from '../store';
import { Settings, Image as ImageIcon, Video, Music, Trash2, Plus, Upload, ChevronDown, GripVertical, RefreshCw, Layers, FolderOpen } from 'lucide-react';
import { motion, AnimatePresence, Reorder, useDragControls } from 'motion/react';
import { validateImageFile, validateImageDimensions, validateVideoFile, validateAudioFile, getMediaDurationSec, totalDurationError, createThumbnail, createVideoThumbnail, getFilePath, cacheFile } from '../lib/utils';
import { HoverZoom } from './HoverZoom';
import { ElementLibrary } from './ElementLibrary';

const RESOLUTIONS: { id: string; name: string }[] = [
  { id: '480p', name: '480p' },
  { id: '720p', name: '720p' },
  { id: '1080p', name: '1080p' },
];
const RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
// Gemini Omni Flash — its own knobs (see gemini-omni-flash-preview spec).
// The 4 real API tasks only. "Unspecified" (omit task → model infers) is intentionally
// NOT offered: task must be an explicit user choice, never auto-derived.
const OMNI_TASKS: { id: string; name: string }[] = [
  { id: 'text_to_video', name: 'Text to Video' },
  { id: 'image_to_video', name: 'Image to Video' },
  { id: 'reference_to_video', name: 'Reference to Video' },
  { id: 'edit', name: 'Edit Video' },
];
const OMNI_RATIOS: { id: string; name: string }[] = [{ id: '16:9', name: '16:9' }, { id: '9:16', name: '9:16' }];

// File picker accept filter per asset type (used by per-asset replace).
const acceptFor = (type: 'image_url' | 'video_url' | 'audio_url') =>
  type === 'image_url' ? 'image/*'
  : type === 'video_url' ? 'video/mp4,video/quicktime,.mp4,.mov,.m4v,.webm'
  : 'audio/wav,audio/mpeg';

// One reference-asset row. Extracted to a module-level component because each
// row needs its own useDragControls (hooks can't run in a .map loop body).
// - Reorder via framer (POINTER drag from the ⠿ grip only → dragListener=false
//   + dragControls). The grabbed row physically lifts and others slide aside.
// - Replace via native HTML5 file drop on the row (different event channel from
//   framer's pointer drag, so the two never collide). id is preserved on both,
//   so mention pills stay valid.
function AssetRow({ asset, name, onReplaceFile, onRemove, dragOverId, setDragOverId }: {
  asset: Asset; name: string;
  onReplaceFile: (a: Asset, f: File) => void;
  onRemove: (id: string) => void;
  dragOverId: string | null;
  setDragOverId: (updater: string | null | ((c: string | null) => string | null)) => void;
}) {
  const controls = useDragControls();
  const thumb = (asset as any).thumbnailUrl as string | undefined;
  return (
    <Reorder.Item
      value={asset}
      as="div"
      dragListener={false}
      dragControls={controls}
      onDragOver={(e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setDragOverId(asset.id); }}
      onDragLeave={(e: React.DragEvent) => { if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragOverId((c) => c === asset.id ? null : c); }}
      onDrop={(e: React.DragEvent) => {
        e.preventDefault(); e.stopPropagation(); setDragOverId(null);
        const f = e.dataTransfer.files?.[0]; if (f) onReplaceFile(asset, f);
      }}
      className={`flex items-start justify-between p-2 rounded-[11px] border-[3px] transition-colors ${dragOverId === asset.id ? 'bg-indigo-50 border-indigo-300' : 'bg-[#fafafc] border-black/5'}`}
    >
      <div className="flex items-center gap-2 overflow-hidden">
        <span
          onPointerDown={(e) => controls.start(e)}
          title="끌어서 순서 변경"
          className="cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-500 shrink-0 -ml-0.5 select-none touch-none"
        >
          <GripVertical size={15} />
        </span>
        {asset.type === 'image_url' && (
          thumb || asset.url.startsWith('data:image') || asset.url.startsWith('http')
            ? <HoverZoom className="shrink-0 inline-flex" src={thumb || asset.url} fullSrc={asset.cacheId ? `/api/cache/${asset.cacheId}` : undefined}>
                <img src={thumb || asset.url} alt="asset" className="w-8 h-8 object-cover rounded border border-gray-200 cursor-zoom-in" />
              </HoverZoom>
            : <ImageIcon size={14} className="text-blue-500 shrink-0" />
        )}
        {asset.type === 'video_url' && (
          thumb
            ? <HoverZoom className="shrink-0 inline-flex" src={thumb}>
                <img src={thumb} alt="video" className="w-8 h-8 object-cover rounded border border-gray-200 cursor-zoom-in" />
              </HoverZoom>
            : asset.cacheId
              ? <HoverZoom className="shrink-0 inline-flex" src="" videoSrc={`/api/cache/${asset.cacheId}`}>
                  <span className="w-8 h-8 flex items-center justify-center rounded border border-gray-200 bg-purple-50 cursor-zoom-in shrink-0"><Video size={14} className="text-purple-500" /></span>
                </HoverZoom>
              : <Video size={14} className="text-purple-500 shrink-0" />
        )}
        {asset.type === 'audio_url' && <Music size={14} className="text-green-500 shrink-0" />}
        <div className="flex flex-col overflow-hidden">
          <span className="text-xs font-medium text-gray-800">[{name}] {asset.file_name && <span className="text-gray-500 font-normal ml-1 truncate">{asset.file_name}</span>}</span>
          <span className="text-[10px] font-medium text-gray-500">{asset.role}</span>
        </div>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <label title="이 에셋 교체 (클릭하거나 파일을 끌어다 놓기)" className="text-gray-400 hover:text-indigo-500 p-1 cursor-pointer">
          <RefreshCw size={14} />
          <input type="file" accept={acceptFor(asset.type)} className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onReplaceFile(asset, f); e.target.value = ''; }} />
        </label>
        <button onClick={() => onRemove(asset.id)} title="삭제" className="text-gray-400 hover:text-red-500 p-1">
          <Trash2 size={14} />
        </button>
      </div>
    </Reorder.Item>
  );
}

const MODES: { id: GenerationMode; name: string }[] = [
  { id: 'text_to_video', name: 'Text to Video' },
  { id: 'image_to_video_first', name: 'Image to Video (First Frame)' },
  { id: 'image_to_video_first_last', name: 'Image to Video (First & Last)' },
  { id: 'multimodal_reference', name: 'Multimodal Reference' },
  { id: 'edit_video', name: 'Edit Video' },
  { id: 'extend_video', name: 'Extend Video' },
];

// Modes where return_last_frame makes sense
const RETURN_LAST_FRAME_MODES: GenerationMode[] = [
  'text_to_video',
  'image_to_video_first',
  'multimodal_reference',
  'edit_video',
  'extend_video',
];

function CustomSelect({ value, options, onChange, placeholder }: { value: string, options: {id: string, name: string}[], onChange: (val: string) => void, placeholder?: string }) {
  const [isOpen, setIsOpen] = useState(false);
  // With a placeholder, an unmatched value (e.g. '') shows the greyed placeholder text
  // instead of silently falling back to the first option (which would look "selected").
  const selected = options.find(o => o.id === value) || (placeholder ? null : options[0]);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#fafafc] border-[3px] border-black/5 rounded-[11px] text-[14px] focus:outline-none focus:border-[#0071e3] transition-colors"
      >
        <span className={`truncate ${selected ? '' : 'text-gray-400'}`}>{selected ? selected.name : placeholder}</span>
        <ChevronDown size={16} className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {isOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.95 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-[11px] shadow-xl overflow-hidden"
            >
              {options.map(opt => (
                <button
                  key={opt.id}
                  onClick={() => { onChange(opt.id); setIsOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-[14px] hover:bg-[#f5f5f7] transition-colors ${value === opt.id ? 'bg-[#f0f0f2] font-medium text-[#0071e3]' : 'text-gray-700'}`}
                >
                  {opt.name}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export function getAssetNames(assets: Asset[]) {
  const counts = { image_url: 0, video_url: 0, audio_url: 0 };
  return assets.map(asset => {
    if (asset.role === 'first_frame') return { ...asset, name: 'Start Frame' };
    if (asset.role === 'last_frame') return { ...asset, name: 'End Frame' };

    counts[asset.type]++;
    const prefix = asset.type === 'image_url' ? 'Image' : asset.type === 'video_url' ? 'Video' : 'Audio';
    return { ...asset, name: `${prefix} ${counts[asset.type]}` };
  });
}

export function SettingsPanel() {
  const { projects, currentProjectId, updateProjectSettings, addAsset, removeAsset, replaceAsset, setAssetOrder, assetCollections, projectCollectionId, mentionedElementImages, billingProject, billingProjects, setBillingProject } = useAppStore();
  const needsBillingSelection = !billingProject; // strict: no project → block generation
  const [assetIdInput, setAssetIdInput] = useState('');
  const [assetIdType, setAssetIdType] = useState<'image_url' | 'video_url' | 'audio_url'>('image_url');
  const [dragOverAssetId, setDragOverAssetId] = useState<string | null>(null);
  const [elementOpen, setElementOpen] = useState(false);

  // Clear the per-row replace highlight when a drag ends anywhere (ESC-cancel
  // or drop), so an abandoned drag doesn't leave a row stuck highlighted.
  useEffect(() => {
    const clear = () => setDragOverAssetId(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear); };
  }, []);

  const project = projects.find((p) => p.id === currentProjectId);

  if (!project) return null;
  const { settings, assets } = project;
  const isOmni = modelProvider(settings.model) === 'gemini'; // Gemini Omni → different settings surface
  const namedAssets = getAssetNames(assets);
  const boundCollectionName = currentProjectId ? assetCollections.find(c => c.id === projectCollectionId[currentProjectId])?.name : undefined;

  const availableTypes = useMemo(() => {
    if (isOmni) {
      // Omni: no audio ever; text→none, edit→video, else images. Coerce any empty/legacy
      // task to text_to_video (Unspecified was removed — task is always explicit).
      const t = OMNI_TASKS.some(x => x.id === settings.omniTask) ? settings.omniTask : 'text_to_video';
      if (t === 'text_to_video') return [];
      if (t === 'edit') return ['video_url'];
      if (t === 'reference_to_video') return ['image_url', 'video_url']; // images (≥1) + optional 1 video ref
      return ['image_url']; // image_to_video
    }
    if (settings.mode === 'extend_video') return ['video_url'];
    if (settings.mode === 'edit_video') return ['image_url', 'video_url', 'audio_url'];
    if (settings.mode === 'multimodal_reference') return ['image_url', 'video_url', 'audio_url'];
    if (settings.mode === 'image_to_video_first' || settings.mode === 'image_to_video_first_last') return ['image_url'];
    return [];
  }, [settings.mode, isOmni, settings.omniTask]);

  useEffect(() => {
    if (availableTypes.length > 0 && !availableTypes.includes(assetIdType)) {
      setAssetIdType(availableTypes[0] as any);
    }
  }, [availableTypes, assetIdType]);

  const handleModeChange = (newMode: GenerationMode) => {
    updateProjectSettings(project.id, { mode: newMode });
    assets.forEach(a => removeAsset(project.id, a.id));
    setAssetIdType('image_url');
    // Disable return_last_frame if not applicable for the new mode
    if (!RETURN_LAST_FRAME_MODES.includes(newMode)) {
      updateProjectSettings(project.id, { return_last_frame: false });
    }
  };

  // Omni task switch — mirror handleModeChange: each task expects different assets
  // (edit=video, reference=images, image_to_video=frame, text=none), so clear the old
  // refs on switch. Without this, stale assets from the previous task block/err the new
  // one (e.g. leftover images make Edit reject, a leftover video blocks a new upload).
  const handleOmniTaskChange = (val: string) => {
    if (val === settings.omniTask) return;
    updateProjectSettings(project.id, { omniTask: val });
    assets.forEach(a => removeAsset(project.id, a.id));
    setAssetIdType('image_url');
  };

  const handleAddAssetId = () => {
    if (!assetIdInput.trim()) return;
    if (settings.mode === 'text_to_video') return;

    let role: AssetRole = 'reference_image';
    if (assetIdType === 'video_url') role = 'reference_video';
    if (assetIdType === 'audio_url') role = 'reference_audio';

    if (settings.mode === 'image_to_video_first' && assetIdType === 'image_url') {
      role = 'first_frame';
      if (assets.some(a => a.role === 'first_frame')) return;
    }

    if (settings.mode === 'image_to_video_first_last' && assetIdType === 'image_url') {
      const hasFirst = assets.some(a => a.role === 'first_frame');
      const hasLast = assets.some(a => a.role === 'last_frame');
      if (hasFirst && hasLast) return;
      role = hasFirst ? 'last_frame' : 'first_frame';
    }

    let currentCount = assets.filter(a => a.type === assetIdType).length;
    let maxAllowed = Infinity;
    if (settings.mode === 'multimodal_reference') {
      if (assetIdType === 'image_url') maxAllowed = 9;
      if (assetIdType === 'video_url') maxAllowed = 3;
      if (assetIdType === 'audio_url') maxAllowed = 3;
    } else if (settings.mode === 'edit_video') {
      if (assetIdType === 'image_url') maxAllowed = 9;
      if (assetIdType === 'video_url') maxAllowed = 1;
      if (assetIdType === 'audio_url') maxAllowed = 3;
    } else if (settings.mode === 'extend_video' && assetIdType === 'video_url') maxAllowed = 3;

    if (currentCount >= maxAllowed) return;

    let finalUrl = assetIdInput.trim();
    if (!finalUrl.startsWith('asset://') && !finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
      finalUrl = `asset://${finalUrl}`;
    }

    addAsset(project.id, { type: assetIdType, url: finalUrl, role, file_name: finalUrl });
    setAssetIdInput('');
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>, role: AssetRole, type: 'image_url' | 'video_url' | 'audio_url') => {
    let files = Array.from(e.target.files || []);

    let currentCount = assets.filter(a => a.type === type).length;
    let maxAllowed = Infinity;

    if (isOmni) {
      // Omni limits (per task): images ≤10; video = edit(1 source) / reference(≤3 refs) / else none;
      // no audio. No Seedance-style 15s total-duration rule (that cap is skipped below).
      if (type === 'image_url') maxAllowed = 10;
      else if (type === 'video_url') maxAllowed = (settings.omniTask === 'edit' || settings.omniTask === 'reference_to_video') ? 1 : 0; // Edit source / 1 reference video
      else maxAllowed = 0;
    } else if (settings.mode === 'multimodal_reference') {
      if (type === 'image_url') maxAllowed = 9;
      if (type === 'video_url') maxAllowed = 3;
      if (type === 'audio_url') maxAllowed = 3;
    } else if (settings.mode === 'edit_video') {
      if (type === 'image_url') maxAllowed = 9;
      if (type === 'video_url') maxAllowed = 1;
      if (type === 'audio_url') maxAllowed = 3;
    } else if (settings.mode === 'extend_video') {
      if (type === 'video_url') maxAllowed = 3;
    } else if (settings.mode === 'image_to_video_first' && type === 'image_url') {
      maxAllowed = 1;
    } else if (settings.mode === 'image_to_video_first_last' && type === 'image_url') {
      maxAllowed = 1;
      currentCount = assets.filter(a => a.role === role).length;
    }

    const availableSlots = Math.max(0, maxAllowed - currentCount);
    const skipped: string[] = [];
    if (files.length > availableSlots) {
      skipped.push(...files.slice(availableSlots).map(f => `${f.name}: 한도 ${maxAllowed}개 초과로 제외됨`));
      files = files.slice(0, availableSlots);
    }

    (async () => {
      const rejected = [...skipped];
      for (const file of files) {
        try {
          const originalPath = getFilePath(file);
          // Attach → media-cache only. R2 upload is deferred to send time so
          // every R2 object is created with a task to be tied to (no orphans).
          if (type === 'image_url') {
            const sizeErr = validateImageFile(file);
            if (sizeErr) { rejected.push(`${file.name}: ${sizeErr}`); continue; }
            const dimErr = await validateImageDimensions(file);
            if (dimErr) { rejected.push(`${file.name}: ${dimErr}`); continue; }
            const thumbnailUrl = await createThumbnail(file);
            const cacheId = await cacheFile(file);
            addAsset(project.id, { type, url: '', role, file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
          } else {
            let vErr: string | null;
            if (type === 'video_url' && isOmni) {
              // Omni edit source: only size (≤50MB) + format matter. No duration/dimension
              // caps (Seedance's 2–15s / 300–6000px rules don't apply); output is always 720p.
              const sizeMB = file.size / (1024 * 1024);
              const okFmt = /\.(mp4|mov|m4v|webm|mpeg|mpg|wmv|3gp|3gpp|flv)$/i.test(file.name) || /^video\//i.test(file.type);
              vErr = sizeMB > 50 ? `비디오 크기 초과: ${sizeMB.toFixed(1)}MB (Omni 최대 50MB)` : !okFmt ? '지원하지 않는 형식 (mp4·mov·webm·mpeg·wmv·3gpp·flv)' : null;
            } else {
              vErr = type === 'video_url' ? await validateVideoFile(file) : await validateAudioFile(file);
            }
            if (vErr) { rejected.push(`${file.name}: ${vErr}`); continue; }
            // Combined cap: reference videos ≤ 15s total, reference audio ≤ 15s
            // total. Read fresh assets — earlier loop iterations add to them.
            // Omni has no 15s rule (edit source can be longer, capped only by 50MB), so skip it there.
            const durationSec = await getMediaDurationSec(file, type === 'video_url' ? 'video' : 'audio');
            if (!isOmni) {
              const freshAssets = useAppStore.getState().projects.find(p => p.id === project.id)?.assets || [];
              const totErr = totalDurationError(freshAssets, type, durationSec);
              if (totErr) { rejected.push(`${file.name}: ${totErr}`); continue; }
            }
            const thumbnailUrl = type === 'video_url' ? await createVideoThumbnail(file).catch(() => '') : undefined;
            const cacheId = await cacheFile(file);
            addAsset(project.id, { type, url: '', role, file_name: file.name, cacheId, ...(durationSec != null ? { durationSec } : {}), ...(thumbnailUrl ? { thumbnailUrl } : {}), ...(originalPath ? { originalPath } : {}) });
          }
        } catch (e: any) {
          console.error('Failed to process file:', e);
          rejected.push(`${file.name}: ${e.message || '처리 실패'}`);
        }
      }
      if (rejected.length > 0) alert(`일부 파일이 추가되지 않았습니다:\n\n${rejected.join('\n')}`);
    })();
    e.target.value = '';
  };

  // Replaces an existing asset's bytes while preserving its id (so mention pills
  // referencing it stay attached). Used in modes with single-slot assets like
  // edit_video's video, so users can swap the source without deleting+re-adding.
  const handleReplaceFile = async (existing: Asset, file: File) => {
    // Replace must keep the SAME media type (so the asset's role/name/mention
    // stay valid). Block obvious cross-category swaps; ambiguous cases fall
    // through to the per-type validators below.
    const isVid = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/i.test(file.name);
    const isAud = file.type.startsWith('audio/') || /\.(wav|mp3|mpeg|mpga)$/i.test(file.name);
    const isImg = file.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp|gif|tiff?|heic|heif)$/i.test(file.name);
    if (existing.type === 'image_url' && (isVid || isAud)) { alert('이미지는 이미지로만 교체할 수 있어요.'); return; }
    if (existing.type === 'video_url' && (isImg || isAud)) { alert('비디오는 비디오로만 교체할 수 있어요.'); return; }
    if (existing.type === 'audio_url' && (isImg || isVid)) { alert('오디오는 오디오로만 교체할 수 있어요.'); return; }
    try {
      const updates: Partial<Asset> = { file_name: file.name };
      const originalPath = getFilePath(file);
      if (originalPath) updates.originalPath = originalPath;
      if (existing.type === 'image_url') {
        const sizeErr = validateImageFile(file);
        if (sizeErr) { alert(sizeErr); return; }
        const dimErr = await validateImageDimensions(file);
        if (dimErr) { alert(dimErr); return; }
        updates.thumbnailUrl = await createThumbnail(file);
        // cache only; R2 upload deferred to send time
        updates.url = '';
        updates.cacheId = await cacheFile(file);
      } else {
        const vErr = existing.type === 'video_url' ? await validateVideoFile(file) : await validateAudioFile(file);
        if (vErr) { alert(vErr); return; }
        // Combined 15s cap — the asset being swapped out doesn't count
        const durationSec = await getMediaDurationSec(file, existing.type === 'video_url' ? 'video' : 'audio');
        const freshAssets = useAppStore.getState().projects.find(p => p.id === project.id)?.assets || [];
        const totErr = totalDurationError(freshAssets.filter(a => a.id !== existing.id), existing.type, durationSec);
        if (totErr) { alert(totErr); return; }
        updates.durationSec = durationSec ?? undefined;
        if (existing.type === 'video_url') {
          updates.thumbnailUrl = await createVideoThumbnail(file).catch(() => '');
        }
        updates.url = '';
        updates.cacheId = await cacheFile(file);
      }
      replaceAsset(project.id, existing.id, updates);
    } catch (e: any) {
      alert(`교체 실패: ${e.message || ''}`);
    }
  };

  const renderReplaceButton = (label: string, existing: Asset, accept: string) => {
    const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const f = e.dataTransfer.files?.[0];
      if (f) handleReplaceFile(existing, f);
    };
    return (
      <label
        className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-[11px] text-[14px] font-medium transition-colors border-[3px] bg-[#fafafc] hover:bg-[#f0f0f2] text-[#1d1d1f] border-black/5 cursor-pointer"
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <RefreshCw size={16} /> {label}
        <input type="file" accept={accept} className="hidden" onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleReplaceFile(existing, f);
          e.target.value = '';
        }} />
      </label>
    );
  };

  const renderUploadButton = (label: string, role: AssetRole, type: 'image_url' | 'video_url' | 'audio_url', accept: string, multiple: boolean = false, disabled: boolean = false) => {
    const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const syntheticEvent = { target: { files: files as unknown as FileList, value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>;
      handleFileUpload(syntheticEvent, role, type);
    };

    return (
      <label
        className={`flex items-center justify-center gap-2 w-full px-3 py-2 rounded-[11px] text-[14px] font-medium transition-colors border-[3px] ${disabled ? 'bg-[#f5f5f7] text-black/20 border-black/5 cursor-not-allowed' : 'bg-[#fafafc] hover:bg-[#f0f0f2] text-[#1d1d1f] border-black/5 cursor-pointer'}`}
        onDrop={handleDrop}
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
      >
        <Upload size={16} /> {label}
        <input type="file" accept={accept} multiple={multiple} disabled={disabled} className="hidden" onChange={(e) => handleFileUpload(e, role, type)} />
      </label>
    );
  };

  return (
    <div className="w-80 bg-[#f5f5f7] border-l border-gray-200/60 flex flex-col h-full overflow-y-auto shrink-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); setDragOverAssetId(null); }}>
      <div className="p-4 border-b border-gray-200/60 flex items-center gap-2 sticky top-0 bg-[#f5f5f7]/80 backdrop-blur-xl z-10">
        <Settings size={18} className="text-gray-500" />
        <h2 className="text-[21px] font-semibold text-[#1d1d1f] tracking-tight">Settings</h2>
      </div>

      <div className="p-4 space-y-6">
        {/* 프로젝트 (시트 연동) — Generation Settings 위. 생성하려면 반드시 선택(strict:
            없으면 생성 불가). 언제든 변경 가능. 큐 전송/로컬 프로젝트 전환엔 안 바뀌고,
            진행→종료되면 자동 해제 후 재선택 요구. */}
        <div className={`bg-white p-4 rounded-[12px] shadow-[0_3px_15px_rgba(0,0,0,0.03)] space-y-2 ${needsBillingSelection ? 'ring-2 ring-amber-400' : ''}`}>
          <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">프로젝트</label>
          {billingProjects.length === 0 ? (
            <p className="text-[12px] text-amber-600">등록된 프로젝트가 없습니다. PM에게 문의하세요.<br />(프로젝트를 선택하기 전까지 생성할 수 없습니다)</p>
          ) : (
            <>
              <CustomSelect
                value={billingProject}
                onChange={(val) => setBillingProject(val)}
                options={billingProjects.map(p => ({ id: p.project, name: p.project }))}
                placeholder="프로젝트 선택…"
              />
              {needsBillingSelection && <p className="text-[11px] text-amber-600">생성하려면 프로젝트를 선택하세요.</p>}
            </>
          )}
        </div>

        {/* Generation Mode */}
        <div className="bg-white p-4 rounded-[12px] shadow-[0_3px_15px_rgba(0,0,0,0.03)] space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <h3 className="text-[14px] font-semibold text-[#1d1d1f] tracking-tight">Generation Settings</h3>
            <button onClick={() => { updateProjectSettings(project.id, { ...defaultSettings, model: settings.model }); assets.forEach(a => removeAsset(project.id, a.id)); window.dispatchEvent(new CustomEvent('seedance:reset', { detail: { projectId: project.id } })); }} className="text-[11px] text-gray-400 hover:text-red-500 px-2 py-1 rounded-md hover:bg-red-50 active:scale-95 transition-all">
              초기화
            </button>
          </div>

          <div className="space-y-2">
            <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Model</label>
            <CustomSelect
              value={settings.model}
              onChange={(val) => {
                // Switching model may drop the current resolution (Fast/Mini have
                // no 1080p) — clamp it in the SAME update so the two never disagree.
                const res = modelResolutions(val).includes(settings.resolution) ? settings.resolution : '720p';
                const patch: any = { model: val, resolution: res };
                // Omni only accepts 16:9/9:16 + duration 3–10s — clamp when switching in.
                if (modelProvider(val) === 'gemini') {
                  if (settings.ratio !== '16:9' && settings.ratio !== '9:16') patch.ratio = '16:9';
                  if (settings.duration === -1 || settings.duration < 3 || settings.duration > 10) patch.duration = 5;
                  // Task is always explicit — normalize any empty/legacy value to a real task.
                  if (!OMNI_TASKS.some(t => t.id === settings.omniTask)) patch.omniTask = 'text_to_video';
                }
                // Provider switch (Seedance ↔ Omni) → clear assets. The two have different
                // asset semantics (roles/types/limits); stale refs otherwise error or block
                // the new provider (e.g. leftover Seedance images make Omni Edit reject).
                if (modelProvider(val) !== modelProvider(settings.model)) {
                  assets.forEach(a => removeAsset(project.id, a.id));
                  setAssetIdType('image_url');
                }
                updateProjectSettings(project.id, patch);
              }}
              options={MODELS}
            />
          </div>

          <div className="space-y-2">
            <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">{isOmni ? 'Video task' : 'Generation Mode'}</label>
            {isOmni
              ? <CustomSelect value={OMNI_TASKS.some(t => t.id === settings.omniTask) ? (settings.omniTask as string) : 'text_to_video'} onChange={handleOmniTaskChange} options={OMNI_TASKS} />
              : <CustomSelect value={settings.mode} onChange={(val) => handleModeChange(val as GenerationMode)} options={MODES} />}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Resolution</label>
              <CustomSelect value={settings.resolution} onChange={(val) => updateProjectSettings(project.id, { resolution: val })} options={RESOLUTIONS.filter(r => modelResolutions(settings.model).includes(r.id))} />
            </div>
            <div className="space-y-2">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Ratio</label>
              {isOmni && settings.omniTask === 'edit'
                ? <div className="text-[12px] text-gray-400 py-1.5 px-1">원본 영상 따라감</div>
                : <CustomSelect value={settings.ratio} onChange={(val) => updateProjectSettings(project.id, { ratio: val })} options={isOmni ? OMNI_RATIOS : RATIOS.map(r => ({ id: r, name: r }))} />}
            </div>
          </div>

          {isOmni ? (
            settings.omniTask === 'edit' ? (
              <div className="space-y-2">
                <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Duration (s)</label>
                <div className="text-[12px] text-gray-400 px-1">원본 영상 길이 그대로 (편집은 길이 지정 불가)</div>
              </div>
            ) : (
            <div className="space-y-2">
              <div className="flex justify-between items-center">
                <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Duration (s)</label>
                <span className="text-[12px] text-gray-500">{Math.max(3, Math.min(10, settings.duration || 5))}s</span>
              </div>
              <input type="range" min="3" max="10" value={Math.max(3, Math.min(10, settings.duration || 5))} onChange={(e) => updateProjectSettings(project.id, { duration: parseInt(e.target.value) })} className="w-full accent-[#0071e3]" />
            </div>
            )
          ) : (
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Duration (s)</label>
              <div className="flex items-center gap-2">
                {/* duration -1 = API 지능형 길이 선택 (모델이 4~15초 중 자동 결정) */}
                <button
                  onClick={() => updateProjectSettings(project.id, { duration: settings.duration === -1 ? 5 : -1 })}
                  className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${settings.duration === -1 ? 'bg-[#0071e3] text-white border-[#0071e3]' : 'bg-white text-gray-400 border-gray-300 hover:border-gray-400 hover:text-gray-600'}`}
                >Auto</button>
                <span className="text-[12px] text-gray-500">{settings.duration === -1 ? '모델 자동' : `${settings.duration}s`}</span>
              </div>
            </div>
            <input type="range" min="4" max="15" value={settings.duration === -1 ? 5 : settings.duration} disabled={settings.duration === -1} onChange={(e) => updateProjectSettings(project.id, { duration: parseInt(e.target.value) })} className={`w-full accent-[#0071e3] ${settings.duration === -1 ? 'opacity-40 cursor-not-allowed' : ''}`} />
            {settings.duration === -1 && <p className="text-[11px] text-gray-400">모델이 콘텐츠에 맞는 길이(4~15초)를 자동 선택합니다. 길이에 따라 과금이 달라지니 주의.</p>}
          </div>
          )}

          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Output Count</label>
              <span className="text-[12px] text-gray-500">{settings.output_count || 1}</span>
            </div>
            <input type="range" min="1" max="3" value={settings.output_count || 1} onChange={(e) => updateProjectSettings(project.id, { output_count: parseInt(e.target.value) })} className="w-full accent-[#0071e3]" />
          </div>

          {isOmni ? (
            <div className="pt-2 text-[11px] text-gray-400 leading-relaxed">
              Thinking <span className="text-gray-600 font-medium">High</span> 고정 · 오디오 자동 생성 · 720p · SynthID 워터마크
            </div>
          ) : (
          <div className="space-y-3 pt-2">
            <div>
              <label className={`flex items-center gap-2 ${settings.return_last_frame ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                <input type="checkbox" checked={settings.generate_audio} disabled={settings.return_last_frame} onChange={(e) => updateProjectSettings(project.id, { generate_audio: e.target.checked })} className="rounded text-[#0071e3] focus:ring-[#0071e3] shrink-0" />
                <span className="text-[14px] text-gray-700">Generate Audio</span>
              </label>
              {settings.return_last_frame && <p className="text-[11px] text-amber-600 mt-1 ml-6">라스트프레임 사용 시 비활성</p>}
            </div>
            <AnimatePresence>
            {RETURN_LAST_FRAME_MODES.includes(settings.mode) && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={settings.return_last_frame} onChange={(e) => {
                    updateProjectSettings(project.id, { return_last_frame: e.target.checked, ...(e.target.checked ? { generate_audio: false } : {}) });
                  }} className="rounded text-[#0071e3] focus:ring-[#0071e3]" />
                  <span className="text-[14px] text-gray-700">Return Last Frame</span>
                </label>
              </motion.div>
            )}
            </AnimatePresence>
          </div>
          )}
        </div>

        {/* Assets */}
        <div className="bg-white p-4 rounded-[12px] shadow-[0_3px_15px_rgba(0,0,0,0.03)] space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <div className="min-w-0">
              <h3 className="text-[14px] font-semibold text-[#1d1d1f] tracking-tight">Reference Assets</h3>
              {boundCollectionName && (
                <button onClick={() => setElementOpen(true)} title="이 채팅의 @멘션에 사용 중인 어셋 컬렉션 (클릭: element 열기)"
                  className="flex items-center gap-1 text-[10px] text-emerald-600 hover:text-emerald-700 font-medium mt-0.5 max-w-full">
                  <FolderOpen size={11} className="shrink-0" /><span className="truncate">어셋: {boundCollectionName}</span>
                </button>
              )}
            </div>
            <button onClick={() => setElementOpen(true)} title="어셋 라이브러리 — 등록해 둔 캐릭터·로케이션·프랍을 @로 멘션"
              className="flex items-center gap-1 text-[12px] font-medium text-[#0071e3] bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg transition-colors active:scale-95 shrink-0">
              <Layers size={13} /> element
            </button>
          </div>

          <div className="space-y-2">
            <Reorder.Group as="div" axis="y" values={assets} onReorder={(newOrder) => setAssetOrder(project.id, (newOrder as Asset[]).map(a => a.id))} className="space-y-2">
              {assets.map((asset, i) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  name={namedAssets[i]?.name ?? ''}
                  onReplaceFile={handleReplaceFile}
                  onRemove={(id) => removeAsset(project.id, id)}
                  dragOverId={dragOverAssetId}
                  setDragOverId={setDragOverAssetId}
                />
              ))}
            </Reorder.Group>
            {assets.length === 0 && <p className="text-xs text-gray-500 text-center py-2">No assets added yet.</p>}
            {assets.length > 0 && <p className="text-[10px] text-gray-400 text-center pt-0.5">⠿ 잡아서 끌면 순서 변경 · ↻ 또는 파일 드롭으로 교체 (멘션 유지)</p>}
          </div>

          <AnimatePresence mode="wait">
            <motion.div key={isOmni ? `omni-${settings.omniTask}` : settings.mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="space-y-2 pt-2">
              {/* ── Gemini Omni asset UI (mirrors the Seedance per-mode pattern, Omni values) ── */}
              {isOmni && (
                <div className="space-y-2">
                  {settings.omniTask === 'text_to_video' ? (
                    <p className="text-xs text-gray-500 text-center">Text to Video는 에셋을 사용하지 않습니다.</p>
                  ) : settings.omniTask === 'edit' ? (
                    <>
                      {(() => {
                        const vidCount = assets.filter(a => a.type === 'video_url').length;
                        return (
                          <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap text-[11px] leading-snug">
                            <span className="w-10 shrink-0 font-semibold text-gray-600">비디오</span>
                            <span className={`w-12 shrink-0 tabular-nums ${vidCount > 1 ? 'text-red-500' : 'text-gray-700'}`}>{vidCount}/1</span>
                            <span className="text-gray-400 min-w-0 break-keep">편집할 소스 영상 1개 · 개당 50MB · mp4·mov·webm</span>
                          </div>
                        );
                      })()}
                      {(() => {
                        const existingVideo = assets.find(a => a.type === 'video_url');
                        return existingVideo
                          ? renderReplaceButton('영상 교체', existingVideo, 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm')
                          : renderUploadButton('영상 추가', 'reference_video', 'video_url', 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm', false, assets.filter(a => a.type === 'video_url').length >= 1);
                      })()}
                      <p className="text-[10px] text-gray-400 leading-snug break-keep">프롬프트에 <b>어떻게 편집할지</b> 적어주세요 (예: 눈 내리는 효과 추가). 길이·비율은 원본 영상을 그대로 따라갑니다.</p>
                    </>
                  ) : settings.omniTask === 'image_to_video' ? (
                    <p className="text-xs text-gray-500 text-center">프레임은 위 입력창 슬롯에서 넣어주세요.</p>
                  ) : (
                    <>
                      {(() => {
                        const imgCount = assets.filter(a => a.type === 'image_url').length + mentionedElementImages;
                        const vidCount = assets.filter(a => a.type === 'video_url').length;
                        return (
                          <>
                            <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap text-[11px] leading-snug">
                              <span className="w-10 shrink-0 font-semibold text-gray-600">이미지</span>
                              <span className={`w-12 shrink-0 tabular-nums ${imgCount > 10 ? 'text-red-500' : imgCount === 10 ? 'text-amber-600' : 'text-gray-700'}`}>{imgCount}/10</span>
                              <span className="text-gray-400 min-w-0 break-keep">png·jpeg·webp·heic·heif · 멘션 합산</span>
                            </div>
                            <div className="flex items-baseline gap-x-2 gap-y-0.5 flex-wrap text-[11px] leading-snug">
                              <span className="w-10 shrink-0 font-semibold text-gray-600">비디오</span>
                              <span className={`w-12 shrink-0 tabular-nums ${vidCount > 1 ? 'text-red-500' : 'text-gray-700'}`}>{vidCount}/1</span>
                              <span className="text-gray-400 min-w-0 break-keep">개당 50MB · 선택(이미지와 함께)</span>
                            </div>
                          </>
                        );
                      })()}
                      {renderUploadButton('이미지 추가', 'reference_image', 'image_url', 'image/png,image/jpeg,image/webp,image/heic,image/heif', true, (assets.filter(a => a.type === 'image_url').length + mentionedElementImages) >= 10)}
                      {(() => {
                        const existingVideo = assets.find(a => a.type === 'video_url');
                        return existingVideo
                          ? renderReplaceButton('영상 교체', existingVideo, 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm')
                          : renderUploadButton('영상 추가', 'reference_video', 'video_url', 'video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm', false, false);
                      })()}
                      <p className="text-[10px] text-gray-400 leading-snug break-keep">비디오는 <b>이미지 1장 이상과 함께</b>일 때만 참조로 쓸 수 있어요(영상만은 불가).</p>
                    </>
                  )}
                </div>
              )}

              {!isOmni && settings.mode === 'text_to_video' && (
                <p className="text-xs text-gray-500 text-center">Text to Video 모드에서는 에셋을 사용하지 않습니다.</p>
              )}

              {!isOmni && settings.mode === 'image_to_video_first' && (
                renderUploadButton('Upload First Frame', 'first_frame', 'image_url', 'image/*', false, assets.length >= 1)
              )}

              {!isOmni && settings.mode === 'image_to_video_first_last' && (
                <>
                  {renderUploadButton('Upload First Frame', 'first_frame', 'image_url', 'image/*', false, assets.some(a => a.role === 'first_frame'))}
                  {renderUploadButton('Upload Last Frame', 'last_frame', 'image_url', 'image/*', false, assets.some(a => a.role === 'last_frame'))}
                </>
              )}

              {!isOmni && settings.mode === 'multimodal_reference' && (
                <div className="space-y-2">
                  <div className="text-[11px] leading-snug space-y-1">
                    {(() => {
                      const panelImgs = assets.filter(a => a.type === 'image_url').length;
                      const total = panelImgs + mentionedElementImages;
                      return (
                        <div className="flex items-baseline gap-2">
                          <span className="w-10 shrink-0 font-semibold text-gray-600">이미지</span>
                          <span className={`w-8 shrink-0 tabular-nums ${total > 9 ? 'text-red-500' : total === 9 ? 'text-amber-600' : 'text-gray-700'}`}>{total}/9</span>
                          <span className="text-gray-400 whitespace-nowrap">개당 30MB · 300~6000px{mentionedElementImages > 0 ? ` · @어셋 ${mentionedElementImages}` : ''}</span>
                        </div>
                      );
                    })()}
                    <div className="flex items-baseline gap-2">
                      <span className="w-10 shrink-0 font-semibold text-gray-600">비디오</span>
                      <span className="w-8 shrink-0 tabular-nums text-gray-700">{assets.filter(a => a.type === 'video_url').length}/3</span>
                      <span className="text-gray-400 whitespace-nowrap">개당 200MB · 2~15초</span>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <span className="w-10 shrink-0 font-semibold text-gray-600">오디오</span>
                      <span className="w-8 shrink-0 tabular-nums text-gray-700">{assets.filter(a => a.type === 'audio_url').length}/3</span>
                      <span className="text-gray-400 whitespace-nowrap">개당 15MB · 2~15초</span>
                    </div>
                  </div>
                  {renderUploadButton('이미지 추가', 'reference_image', 'image_url', 'image/*', true, assets.filter(a => a.type === 'image_url').length >= 9)}
                  {renderUploadButton('비디오 추가', 'reference_video', 'video_url', 'video/mp4,video/quicktime,.mp4,.mov,.m4v,.webm', true, assets.filter(a => a.type === 'video_url').length >= 3)}
                  {renderUploadButton('오디오 추가', 'reference_audio', 'audio_url', 'audio/wav,audio/mpeg', true, assets.filter(a => a.type === 'audio_url').length >= 3)}
                </div>
              )}

              {!isOmni && settings.mode === 'edit_video' && (
                <div className="space-y-2">
                  {renderUploadButton('이미지 추가', 'reference_image', 'image_url', 'image/*', true, assets.filter(a => a.type === 'image_url').length >= 9)}
                  {(() => {
                    const existingVideo = assets.find(a => a.type === 'video_url');
                    return existingVideo
                      ? renderReplaceButton('비디오 교체', existingVideo, 'video/mp4,video/quicktime,.mp4,.mov,.m4v,.webm')
                      : renderUploadButton('비디오 추가', 'reference_video', 'video_url', 'video/mp4,video/quicktime,.mp4,.mov,.m4v,.webm', false, false);
                  })()}
                  {renderUploadButton('오디오 추가', 'reference_audio', 'audio_url', 'audio/wav,audio/mpeg', false, assets.filter(a => a.type === 'audio_url').length >= 3)}
                </div>
              )}

              {!isOmni && settings.mode === 'extend_video' && (
                <div className="space-y-2">
                  <p className="text-[12px] text-gray-500 leading-tight">
                    비디오: {assets.filter(a => a.type === 'video_url').length}/3 (최대 3개 이어붙이기)
                  </p>
                  {renderUploadButton('비디오 추가', 'reference_video', 'video_url', 'video/mp4,video/quicktime,.mp4,.mov,.m4v,.webm', true, assets.filter(a => a.type === 'video_url').length >= 3)}
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          <AnimatePresence>
          {!isOmni && settings.mode !== 'text_to_video' && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden">
            <div className="space-y-3 pt-2 border-t border-gray-100 mt-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={settings.use_asset_id} onChange={(e) => updateProjectSettings(project.id, { use_asset_id: e.target.checked })} className="rounded text-[#0071e3] focus:ring-[#0071e3]" />
                <span className="text-[14px] text-gray-700">URL / Asset ID로 추가</span>
              </label>

              {settings.use_asset_id && (
                <div className="flex flex-col gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <select
                      value={assetIdType}
                      onChange={(e) => setAssetIdType(e.target.value as any)}
                      className="w-20 shrink-0 px-2 py-1.5 bg-[#fafafc] border-[3px] border-black/5 rounded-[8px] text-[12px] outline-none focus:border-[#0071e3]"
                    >
                      {availableTypes.includes('image_url') && <option value="image_url">Image</option>}
                      {availableTypes.includes('video_url') && <option value="video_url">Video</option>}
                      {availableTypes.includes('audio_url') && <option value="audio_url">Audio</option>}
                    </select>
                    <input
                      type="text"
                      value={assetIdInput}
                      onChange={(e) => setAssetIdInput(e.target.value)}
                      placeholder="URL or asset-12345..."
                      className="min-w-0 flex-1 px-2 py-1.5 bg-[#fafafc] border-[3px] border-black/5 rounded-[8px] text-[12px] outline-none focus:border-[#0071e3]"
                    />
                  </div>
                  {assetIdType === 'video_url' && (
                    <p className="text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded">비디오: MP4/MOV, 480p~4k, 2~15초, 200MB 이하, 24~60fps</p>
                  )}
                  {assetIdType === 'audio_url' && (
                    <p className="text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded">오디오: WAV/MP3, 2~15초, 15MB 이하</p>
                  )}
                  <button onClick={handleAddAssetId} disabled={!assetIdInput.trim()} className="w-full py-1.5 bg-[#0071e3] text-white text-[12px] font-medium rounded-[8px] disabled:opacity-50 transition-colors hover:bg-[#0077ed] active:scale-95">
                    추가
                  </button>
                </div>
              )}
            </div>
            </motion.div>
          )}
          </AnimatePresence>
        </div>
      </div>

      <AnimatePresence>
        {elementOpen && <ElementLibrary open={elementOpen} onClose={() => setElementOpen(false)} projectId={project.id} />}
      </AnimatePresence>
    </div>
  );
}
