import { useState, useEffect, useMemo } from 'react';
import { useAppStore, AssetRole, Asset, GenerationMode, defaultSettings } from '../store';
import { Settings, Image as ImageIcon, Video, Music, Trash2, Plus, Upload, ChevronDown, GripVertical, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence, Reorder, useDragControls } from 'motion/react';
import { validateImageFile, validateImageDimensions, validateVideoFile, validateAudioFile, getMediaDurationSec, totalDurationError, createThumbnail, createVideoThumbnail, getFilePath, cacheFile } from '../lib/utils';
import { HoverZoom } from './HoverZoom';

const RESOLUTIONS: { id: string; name: string }[] = [
  { id: '480p', name: '480p' },
  { id: '720p', name: '720p' },
  { id: '1080p', name: '1080p' },
];
const RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];

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

function CustomSelect({ value, options, onChange }: { value: string, options: {id: string, name: string}[], onChange: (val: string) => void }) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = options.find(o => o.id === value) || options[0];

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3 py-2 bg-[#fafafc] border-[3px] border-black/5 rounded-[11px] text-[14px] focus:outline-none focus:border-[#0071e3] transition-colors"
      >
        <span className="truncate">{selected.name}</span>
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
  const { projects, currentProjectId, updateProjectSettings, addAsset, removeAsset, replaceAsset, setAssetOrder } = useAppStore();
  const [assetIdInput, setAssetIdInput] = useState('');
  const [assetIdType, setAssetIdType] = useState<'image_url' | 'video_url' | 'audio_url'>('image_url');
  const [dragOverAssetId, setDragOverAssetId] = useState<string | null>(null);

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
  const namedAssets = getAssetNames(assets);

  const availableTypes = useMemo(() => {
    if (settings.mode === 'extend_video') return ['video_url'];
    if (settings.mode === 'edit_video') return ['image_url', 'video_url', 'audio_url'];
    if (settings.mode === 'multimodal_reference') return ['image_url', 'video_url', 'audio_url'];
    if (settings.mode === 'image_to_video_first' || settings.mode === 'image_to_video_first_last') return ['image_url'];
    return [];
  }, [settings.mode]);

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

    if (settings.mode === 'multimodal_reference') {
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
            const vErr = type === 'video_url' ? await validateVideoFile(file) : await validateAudioFile(file);
            if (vErr) { rejected.push(`${file.name}: ${vErr}`); continue; }
            // Combined cap: reference videos ≤ 15s total, reference audio ≤ 15s
            // total. Read fresh assets — earlier loop iterations add to them.
            const durationSec = await getMediaDurationSec(file, type === 'video_url' ? 'video' : 'audio');
            const freshAssets = useAppStore.getState().projects.find(p => p.id === project.id)?.assets || [];
            const totErr = totalDurationError(freshAssets, type, durationSec);
            if (totErr) { rejected.push(`${file.name}: ${totErr}`); continue; }
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
        {/* Generation Mode */}
        <div className="bg-white p-4 rounded-[12px] shadow-[0_3px_15px_rgba(0,0,0,0.03)] space-y-4">
          <div className="flex items-center justify-between border-b border-gray-100 pb-2">
            <h3 className="text-[14px] font-semibold text-[#1d1d1f] tracking-tight">Generation Settings</h3>
            <button onClick={() => { updateProjectSettings(project.id, { ...defaultSettings, model: settings.model }); assets.forEach(a => removeAsset(project.id, a.id)); window.dispatchEvent(new CustomEvent('seedance:reset', { detail: { projectId: project.id } })); }} className="text-[11px] text-gray-400 hover:text-red-500 px-2 py-1 rounded-md hover:bg-red-50 active:scale-95 transition-all">
              초기화
            </button>
          </div>

          <div className="space-y-2">
            <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Generation Mode</label>
            <CustomSelect value={settings.mode} onChange={(val) => handleModeChange(val as GenerationMode)} options={MODES} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Resolution</label>
              <CustomSelect value={settings.resolution} onChange={(val) => updateProjectSettings(project.id, { resolution: val })} options={RESOLUTIONS} />
            </div>
            <div className="space-y-2">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Ratio</label>
              <CustomSelect value={settings.ratio} onChange={(val) => updateProjectSettings(project.id, { ratio: val })} options={RATIOS.map(r => ({ id: r, name: r }))} />
            </div>
          </div>

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

          <div className="space-y-2">
            <div className="flex justify-between">
              <label className="block text-[12px] font-semibold text-black/80 tracking-[-0.12px]">Output Count</label>
              <span className="text-[12px] text-gray-500">{settings.output_count || 1}</span>
            </div>
            <input type="range" min="1" max="3" value={settings.output_count || 1} onChange={(e) => updateProjectSettings(project.id, { output_count: parseInt(e.target.value) })} className="w-full accent-[#0071e3]" />
          </div>

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
        </div>

        {/* Assets */}
        <div className="bg-white p-4 rounded-[12px] shadow-[0_3px_15px_rgba(0,0,0,0.03)] space-y-4">
          <h3 className="text-[14px] font-semibold text-[#1d1d1f] tracking-tight border-b border-gray-100 pb-2">Reference Assets</h3>

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
            <motion.div key={settings.mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }} className="space-y-2 pt-2">
              {settings.mode === 'text_to_video' && (
                <p className="text-xs text-gray-500 text-center">Text to Video 모드에서는 에셋을 사용하지 않습니다.</p>
              )}

              {settings.mode === 'image_to_video_first' && (
                renderUploadButton('Upload First Frame', 'first_frame', 'image_url', 'image/*', false, assets.length >= 1)
              )}

              {settings.mode === 'image_to_video_first_last' && (
                <>
                  {renderUploadButton('Upload First Frame', 'first_frame', 'image_url', 'image/*', false, assets.some(a => a.role === 'first_frame'))}
                  {renderUploadButton('Upload Last Frame', 'last_frame', 'image_url', 'image/*', false, assets.some(a => a.role === 'last_frame'))}
                </>
              )}

              {settings.mode === 'multimodal_reference' && (
                <div className="space-y-2">
                  <p className="text-[12px] text-gray-500 leading-tight">
                    이미지: {assets.filter(a => a.type === 'image_url').length}/9 (개당 30MB, 300~6000px)
                    &nbsp;&middot;&nbsp;비디오: {assets.filter(a => a.type === 'video_url').length}/3 (개당 50MB, 2~15초)
                    &nbsp;&middot;&nbsp;오디오: {assets.filter(a => a.type === 'audio_url').length}/3 (개당 15MB, 2~15초)
                  </p>
                  {renderUploadButton('이미지 추가', 'reference_image', 'image_url', 'image/*', true, assets.filter(a => a.type === 'image_url').length >= 9)}
                  {renderUploadButton('비디오 추가', 'reference_video', 'video_url', 'video/mp4,video/quicktime,.mp4,.mov,.m4v,.webm', true, assets.filter(a => a.type === 'video_url').length >= 3)}
                  {renderUploadButton('오디오 추가', 'reference_audio', 'audio_url', 'audio/wav,audio/mpeg', true, assets.filter(a => a.type === 'audio_url').length >= 3)}
                </div>
              )}

              {settings.mode === 'edit_video' && (
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

              {settings.mode === 'extend_video' && (
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
          {settings.mode !== 'text_to_video' && (
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
                    <p className="text-[10px] text-amber-600 bg-amber-50 px-2 py-1 rounded">비디오: MP4/MOV, 480p~720p, 2~15초, 50MB 이하, 24~60fps</p>
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
    </div>
  );
}
