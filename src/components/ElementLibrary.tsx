import { useState, useMemo, useEffect } from 'react';
import { useAppStore, AssetCategory, ElementAsset, ElementImage } from '../store';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Search, Trash2, Image as ImageIcon, Upload, Check, Link2, Pencil, Layers, User, MapPin, Package, AlertTriangle, Share2, Copy, Loader2 } from 'lucide-react';
import { validateImageFile, validateImageDimensions, createThumbnail, readFileAsDataUrl, cacheFile, createElementPackLink, fetchElementPackByLink } from '../lib/utils';
import { HoverZoom } from './HoverZoom';

// Category visuals — shared with ChatArea mention pills. `accent` is the solid
// dot color used in the prompt pills (kept emoji-free for a cleaner look).
export const CATEGORY_META: Record<AssetCategory, { name: string; bg: string; border: string; text: string; accent: string }> = {
  character: { name: '캐릭터',  bg: '#eef2ff', border: '#c7d2fe', text: '#4338ca', accent: '#6366f1' },
  location:  { name: '로케이션', bg: '#ecfdf5', border: '#a7f3d0', text: '#047857', accent: '#10b981' },
  prop:      { name: '프랍',    bg: '#fff7ed', border: '#fed7aa', text: '#c2410c', accent: '#f97316' },
};
const CATEGORY_ICON: Record<AssetCategory, any> = { character: User, location: MapPin, prop: Package };
const CATEGORIES = Object.keys(CATEGORY_META) as AssetCategory[];

const MAX_ELEMENT_IMAGES = 9; // one element's images become reference images at send (shared 9-image cap)

// ─── Sharable asset bundles (share link / file import) ───
const BUNDLE_FORMAT = 'freewill-seedance-elements';
type Bundle = { format: string; version: number; kind: 'collection' | 'asset'; collectionName?: string; assets: any[] };

// Keep durable full-res base64 url + thumbnail so the bundle is self-contained
// (recipient gets the actual images). Volatile ids/cacheId are dropped.
const stripAssetForExport = (a: ElementAsset) => ({
  category: a.category, name: a.name, description: a.description,
  images: a.images.map(im => ({ url: im.url, thumbnailUrl: im.thumbnailUrl, file_name: im.file_name })),
});

// Parse + sanitize a bundle. Only data: image URLs are accepted (never remote/
// script URLs); fresh image ids are assigned. Returns null if invalid/empty.
function parseBundle(text: string): { kind: 'collection' | 'asset'; collectionName?: string; assets: { category: AssetCategory; name: string; description: string; images: ElementImage[] }[] } | null {
  let b: any;
  try { b = JSON.parse(text); } catch { return null; }
  if (!b || b.format !== BUNDLE_FORMAT || !Array.isArray(b.assets)) return null;
  const assets = b.assets
    .filter((a: any) => a && typeof a.name === 'string')
    .map((a: any) => ({
      category: (['character', 'location', 'prop'].includes(a.category) ? a.category : 'character') as AssetCategory,
      name: String(a.name).slice(0, 80),
      description: typeof a.description === 'string' ? a.description.slice(0, 500) : '',
      images: (Array.isArray(a.images) ? a.images : [])
        .filter((im: any) => im && typeof im.url === 'string' && im.url.startsWith('data:'))
        .slice(0, MAX_ELEMENT_IMAGES)
        .map((im: any) => ({
          id: crypto.randomUUID(),
          url: im.url,
          thumbnailUrl: typeof im.thumbnailUrl === 'string' && im.thumbnailUrl.startsWith('data:') ? im.thumbnailUrl : im.url,
          ...(typeof im.file_name === 'string' ? { file_name: im.file_name } : {}),
        })),
    }))
    .filter((a: any) => a.images.length > 0);
  if (assets.length === 0) return null;
  return { kind: b.kind === 'asset' ? 'asset' : 'collection', collectionName: typeof b.collectionName === 'string' ? b.collectionName : undefined, assets };
}

// Process a picked/dropped file into a durable ElementImage: small thumbnail (for
// tiny prompt pills) + FULL-RES lossless base64 in `url` (durable source AND what
// the cards/hover/editor display, so previews stay crisp) + opportunistic cacheId.
async function fileToElementImage(file: File): Promise<ElementImage> {
  const sizeErr = validateImageFile(file);
  if (sizeErr) throw new Error(sizeErr);
  const dimErr = await validateImageDimensions(file);
  if (dimErr) throw new Error(dimErr);
  const [thumbnailUrl, url] = await Promise.all([createThumbnail(file), readFileAsDataUrl(file)]);
  let cacheId: string | undefined;
  try { cacheId = await cacheFile(file); } catch { /* cache is opportunistic — base64 is the durable source */ }
  return { id: crypto.randomUUID(), url, thumbnailUrl, cacheId, ...(file.name ? { file_name: file.name } : {}) };
}

/* ─── Asset create/edit form (local draft → committed on save) ─── */
function AssetEditor({ initial, onSave, onDelete, onShare, sharing, onClose }: {
  initial: ElementAsset | null;
  onSave: (data: { name: string; description: string; category: AssetCategory; images: ElementImage[] }) => void;
  onDelete: (() => void) | null;
  onShare?: (() => void) | null;
  sharing?: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState<AssetCategory>(initial?.category ?? 'character');
  const [images, setImages] = useState<ElementImage[]>(initial?.images ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const addFiles = async (files: File[]) => {
    setError('');
    const room = MAX_ELEMENT_IMAGES - images.length;
    if (room <= 0) { setError(`이미지는 어셋당 최대 ${MAX_ELEMENT_IMAGES}장입니다.`); return; }
    const imgs = files.filter(f => f.type.startsWith('image/'));
    const slice = imgs.slice(0, room);
    if (slice.length === 0) { setError('이미지 파일만 첨부할 수 있습니다.'); return; }
    setBusy(true);
    const next: ElementImage[] = [];
    const rejected: string[] = [];
    for (const f of slice) {
      try { next.push(await fileToElementImage(f)); }
      catch (e: any) { rejected.push(`${f.name}: ${e.message || '처리 실패'}`); }
    }
    if (next.length) setImages(prev => [...prev, ...next]);
    if (imgs.length > room) rejected.push(`${imgs.length - room}장은 ${MAX_ELEMENT_IMAGES}장 한도로 제외됨`);
    if (rejected.length) setError(rejected.join('\n'));
    setBusy(false);
  };

  const save = () => {
    if (!name.trim()) { setError('이름을 입력해주세요.'); return; }
    if (images.length === 0) { setError('이미지를 1장 이상 첨부해주세요.'); return; }
    onSave({ name: name.trim(), description: description.trim(), category, images });
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-20 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <motion.div
        initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 10 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 sticky top-0 bg-white/95 backdrop-blur-xl z-10">
          <h3 className="text-[15px] font-semibold text-[#1d1d1f] tracking-tight">{initial ? '어셋 편집' : '새 어셋'}</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Category */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70">카테고리</label>
            <div className="flex gap-2">
              {CATEGORIES.map(c => {
                const Icon = CATEGORY_ICON[c]; const on = category === c;
                return (
                  <button key={c} onClick={() => setCategory(c)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-[13px] font-medium border-2 transition-colors ${on ? 'border-current' : 'border-transparent bg-[#f5f5f7] text-gray-500 hover:bg-[#ededf0]'}`}
                    style={on ? { background: CATEGORY_META[c].bg, color: CATEGORY_META[c].text, borderColor: CATEGORY_META[c].border } : undefined}>
                    <Icon size={14} /> {CATEGORY_META[c].name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70">이름</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 김현우" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!busy) save(); } }}
              className="w-full px-3 py-2 bg-[#fafafc] border-[3px] border-black/5 rounded-[11px] text-[14px] outline-none focus:border-[#0071e3] transition-colors" />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70">설명 <span className="text-gray-400 font-normal">(선택)</span></label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="간단한 설명 (검색에 사용됨) · 저장은 Ctrl+Enter"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!busy) save(); } }}
              className="w-full px-3 py-2 bg-[#fafafc] border-[3px] border-black/5 rounded-[11px] text-[13px] outline-none focus:border-[#0071e3] transition-colors resize-none" />
          </div>

          {/* Images — full-res `url` for crisp display; thumbnail is only for tiny pills */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70">이미지 <span className="text-gray-400 font-normal">{images.length}/{MAX_ELEMENT_IMAGES}</span></label>
            <div className="grid grid-cols-4 gap-2">
              {images.map(img => (
                <div key={img.id} className="relative aspect-square rounded-[10px] overflow-hidden border border-gray-200 bg-gray-50 group">
                  <HoverZoom className="block w-full h-full" src={img.url}>
                    <img src={img.url} alt="" className="w-full h-full object-cover cursor-zoom-in" />
                  </HoverZoom>
                  <button onClick={() => setImages(prev => prev.filter(i => i.id !== img.id))}
                    className="absolute top-0.5 right-0.5 bg-black/60 hover:bg-red-500 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity" title="제거">
                    <X size={11} />
                  </button>
                </div>
              ))}
              {images.length < MAX_ELEMENT_IMAGES && (
                <label
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); }}
                  onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
                  className={`aspect-square rounded-[10px] border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition-colors ${dragging ? 'border-[#0071e3] bg-indigo-50' : 'border-gray-300 hover:border-[#0071e3] hover:bg-indigo-50/40'}`}>
                  {busy ? <Loader2 size={16} className="text-indigo-400 animate-spin" /> : <Plus size={18} className="text-gray-400" />}
                  <span className="text-[9px] text-gray-400 mt-0.5">추가</span>
                  <input type="file" accept="image/*" multiple className="hidden"
                    onChange={(e) => { addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
                </label>
              )}
            </div>
            <p className="flex items-start gap-1.5 text-[10px] text-amber-700 bg-amber-50 rounded-md px-2 py-1.5 leading-relaxed">
              <AlertTriangle size={12} className="shrink-0 mt-px" />
              <span>전송 시 이 이미지들은 <b>래퍼런스 이미지</b>로 합쳐집니다 — 래퍼런스 패널 이미지와 <b>합산 최대 9장</b>(초과 시 전송 차단). 어셋당 최대 {MAX_ELEMENT_IMAGES}장 · 개당 30MB · 300~6000px · 원본 화질 그대로 전송.</span>
            </p>
          </div>

          {error && <p className="text-[12px] text-red-500 bg-red-50 rounded-lg px-3 py-2 whitespace-pre-line">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-gray-100 sticky bottom-0 bg-white/95 backdrop-blur-xl">
          <div className="flex items-center gap-1">
            {onDelete && <button onClick={onDelete} className="flex items-center gap-1.5 text-[13px] font-medium text-red-500 hover:text-red-700 hover:bg-red-50 px-3 py-2 rounded-lg transition-colors"><Trash2 size={15} /> 삭제</button>}
            {onShare && <button onClick={onShare} disabled={sharing} title="이 어셋을 공유 링크로" className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-[#0071e3] hover:bg-indigo-50 disabled:opacity-50 px-3 py-2 rounded-lg transition-colors">{sharing ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />} 공유</button>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="text-[13px] font-medium text-gray-500 hover:text-gray-800 px-4 py-2 rounded-lg hover:bg-gray-100 transition-colors">취소</button>
            <button onClick={save} disabled={busy} title="저장 (Enter)" className="flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-50 px-4 py-2 rounded-lg transition-colors active:scale-95"><Check size={15} /> 저장</button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

type ParsedBundle = NonNullable<ReturnType<typeof parseBundle>>;

/* ─── Import dialog: paste a share link OR pick a file → choose placement ─── */
function ImportDialog({ currentCollectionName, onCommit, onClose }: {
  currentCollectionName: string | null;
  onCommit: (parsed: ParsedBundle, mode: 'new' | 'merge') => void;
  onClose: () => void;
}) {
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [parsed, setParsed] = useState<ParsedBundle | null>(null);
  const [mode, setMode] = useState<'new' | 'merge'>('new');

  const accept = (p: ParsedBundle | null, failMsg: string) => {
    if (!p) { setError(failMsg); return; }
    setError(''); setParsed(p);
    // default placement: a single asset → merge into current; a whole collection → new
    setMode(p.kind === 'asset' && currentCollectionName ? 'merge' : 'new');
  };
  const loadLink = async () => {
    const url = link.trim(); if (!url) return;
    setBusy(true); setError('');
    try { accept(parseBundle(await fetchElementPackByLink(url)), '가져올 수 없는 링크입니다. (어셋 파일이 아니거나 만료됨)'); }
    catch (e: any) { setError(e?.message || '링크 불러오기 실패'); }
    finally { setBusy(false); }
  };
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true); setError('');
    try { accept(parseBundle(await file.text()), '가져올 수 없는 파일입니다. (Freewill 어셋 파일이 아님)'); }
    catch { setError('파일을 읽을 수 없습니다.'); }
    finally { setBusy(false); }
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-20 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose} onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <motion.div initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 10 }} transition={{ duration: 0.16, ease: 'easeOut' }}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h3 className="text-[15px] font-semibold text-[#1d1d1f]">어셋 가져오기</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"><X size={18} /></button>
        </div>

        {!parsed ? (
          <div className="p-5 space-y-4">
            <div className="space-y-1.5">
              <label className="block text-[12px] font-semibold text-black/70">공유 링크로 가져오기</label>
              <div className="flex items-center gap-1.5">
                <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadLink(); }} placeholder="공유받은 링크를 붙여넣기"
                  className="flex-1 min-w-0 px-3 py-2 bg-[#fafafc] border-[3px] border-black/5 rounded-[11px] text-[13px] outline-none focus:border-[#0071e3] transition-colors" />
                <button onClick={loadLink} disabled={busy || !link.trim()} className="flex items-center gap-1 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-50 px-3 py-2 rounded-[11px] shrink-0">{busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} 불러오기</button>
              </div>
              <p className="text-[10px] text-gray-400">받은 Freewill 공유 링크를 그대로 붙여넣으면 됩니다.</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-300"><div className="flex-1 h-px bg-gray-100" />또는<div className="flex-1 h-px bg-gray-100" /></div>
            <label className="flex items-center justify-center gap-2 w-full px-3 py-2.5 rounded-[11px] text-[13px] font-medium text-gray-600 bg-[#fafafc] hover:bg-[#f0f0f2] border-[3px] border-black/5 cursor-pointer transition-colors">
              <Upload size={15} /> 파일에서 선택 (.fwsl.json)
              <input type="file" accept="application/json,.json,.fwsl" className="hidden" onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {error && <p className="text-[12px] text-red-500 bg-red-50 rounded-lg px-3 py-2 whitespace-pre-line">{error}</p>}
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3 bg-[#fafafc] rounded-xl p-3 border border-gray-100">
              <div className="flex -space-x-2 shrink-0">
                {parsed.assets.slice(0, 3).map((a, i) => (<img key={i} src={a.images[0]?.url} className="w-9 h-9 rounded-lg object-cover border-2 border-white" alt="" />))}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-gray-800 truncate">{parsed.kind === 'collection' ? (parsed.collectionName || '컬렉션') : parsed.assets[0]?.name}</p>
                <p className="text-[11px] text-gray-400">{parsed.kind === 'collection' ? '컬렉션' : '어셋'} · 어셋 {parsed.assets.length}개</p>
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-[12px] font-semibold text-black/70">어디에 추가할까요?</label>
              <button onClick={() => setMode('new')} className={`w-full text-left px-3 py-2.5 rounded-[11px] border-2 transition-colors ${mode === 'new' ? 'border-[#0071e3] bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <div className="flex items-center gap-2"><span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${mode === 'new' ? 'border-[#0071e3] bg-[#0071e3]' : 'border-gray-300'}`} /><span className="text-[13px] font-medium text-gray-800">새 컬렉션으로 추가</span></div>
                <p className="text-[11px] text-gray-400 ml-[22px] mt-0.5">받은 어셋을 별도의 새 컬렉션으로 따로 보관합니다.</p>
              </button>
              <button onClick={() => currentCollectionName && setMode('merge')} disabled={!currentCollectionName} className={`w-full text-left px-3 py-2.5 rounded-[11px] border-2 transition-colors disabled:opacity-40 ${mode === 'merge' ? 'border-[#0071e3] bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50'}`}>
                <div className="flex items-center gap-2"><span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${mode === 'merge' ? 'border-[#0071e3] bg-[#0071e3]' : 'border-gray-300'}`} /><span className="text-[13px] font-medium text-gray-800">현재 컬렉션에 어셋만 추가</span></div>
                <p className="text-[11px] text-gray-400 ml-[22px] mt-0.5">{currentCollectionName ? `지금 보고 있는 ‘${currentCollectionName}’ 컬렉션에 어셋을 합칩니다.` : '먼저 왼쪽에서 컬렉션을 선택하세요.'}</p>
              </button>
            </div>
            <div className="flex items-center justify-between gap-2 pt-1">
              <button onClick={() => { setParsed(null); setError(''); }} className="text-[13px] font-medium text-gray-500 hover:text-gray-800 px-3 py-2 rounded-lg hover:bg-gray-100 transition-colors">뒤로</button>
              <button onClick={() => onCommit(parsed, mode)} className="flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] px-4 py-2 rounded-lg transition-colors active:scale-95"><Check size={15} /> 가져오기</button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

/* ─── Element library modal ─── */
export function ElementLibrary({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const {
    assetCollections, elementAssets, projectCollectionId,
    createCollection, renameCollection, deleteCollection,
    addElementAsset, updateElementAsset, deleteElementAsset, setProjectCollection,
  } = useAppStore();

  const boundId = projectCollectionId[projectId] || null;
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(boundId);
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ElementAsset | 'new' | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [shareBusy, setShareBusy] = useState<string | null>(null); // key currently generating a link
  const [shareLink, setShareLink] = useState<string | null>(null); // generated link banner
  const [importing, setImporting] = useState(false);              // import dialog open

  // Keep the viewed collection valid: prefer current → bound → first.
  useEffect(() => {
    if (!open) return;
    setSelectedCollectionId(cur => {
      if (cur && assetCollections.some(c => c.id === cur)) return cur;
      if (boundId && assetCollections.some(c => c.id === boundId)) return boundId;
      return assetCollections[0]?.id ?? null;
    });
  }, [open, assetCollections, boundId]);

  // Esc closes link banner → editor → modal, in that order.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (shareLink) setShareLink(null);
      else if (importing) setImporting(false);
      else if (editing) setEditing(null);
      else if (!renaming) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, editing, renaming, shareLink, importing, onClose]);

  const collectionAssets = useMemo(
    () => elementAssets.filter(a => a.collectionId === selectedCollectionId),
    [elementAssets, selectedCollectionId]
  );
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return collectionAssets.filter(a =>
      (categoryFilter === 'all' || a.category === categoryFilter) &&
      (!q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
    );
  }, [collectionAssets, categoryFilter, search]);

  if (!open) return null;

  const selectedCollection = assetCollections.find(c => c.id === selectedCollectionId) || null;
  const isBound = !!selectedCollectionId && boundId === selectedCollectionId;

  // Selecting a collection also makes it THE active one for this chat (single
  // active per chat). Names can repeat across collections, so only the bound
  // collection drives the @ menu — no ambiguity.
  const selectCollection = (id: string) => {
    setSelectedCollectionId(id);
    setProjectCollection(projectId, id);
  };

  const handleNewCollection = () => {
    const id = createCollection('새 컬렉션');
    selectCollection(id);
    setRenaming({ id, value: '새 컬렉션' });
  };

  const commitSave = (data: { name: string; description: string; category: AssetCategory; images: ElementImage[] }) => {
    if (editing === 'new') {
      if (!selectedCollectionId) return;
      addElementAsset({ collectionId: selectedCollectionId, ...data });
    } else if (editing && editing !== 'new') {
      updateElementAsset(editing.id, data); // id + collectionId pinned → mention pills + send stay valid
    }
    setEditing(null);
  };

  // ─── Share: collection or single asset → R2 link (7-day, copied to clipboard) ───
  const shareBundle = async (bundle: Bundle, key: string) => {
    setShareBusy(key);
    try {
      const url = await createElementPackLink(JSON.stringify(bundle));
      try { await navigator.clipboard.writeText(url); } catch { /* banner shows the link for manual copy */ }
      setShareLink(url);
    } catch (e: any) {
      alert(`공유 링크 생성 실패: ${e?.message || ''}`);
    } finally {
      setShareBusy(null);
    }
  };
  const shareCollection = (col: { id: string; name: string }) => {
    const assets = elementAssets.filter(a => a.collectionId === col.id);
    if (assets.length === 0) { alert('공유할 어셋이 없습니다.'); return; }
    shareBundle({ format: BUNDLE_FORMAT, version: 1, kind: 'collection', collectionName: col.name, assets: assets.map(stripAssetForExport) }, 'col-' + col.id);
  };
  const shareAsset = (a: ElementAsset) => {
    shareBundle({ format: BUNDLE_FORMAT, version: 1, kind: 'asset', collectionName: a.name, assets: [stripAssetForExport(a)] }, 'asset-' + a.id);
  };

  // ─── Import (receiving end of a share link): link or file → placement choice ───
  const commitImport = (parsed: ParsedBundle, mode: 'new' | 'merge') => {
    if (mode === 'merge' && selectedCollectionId) {
      parsed.assets.forEach(a => addElementAsset({ collectionId: selectedCollectionId, category: a.category, name: a.name, description: a.description, images: a.images }));
    } else {
      const name = parsed.kind === 'collection' ? (parsed.collectionName || '가져온 컬렉션') : (parsed.assets[0]?.name || '가져온 어셋');
      const newId = createCollection(name);
      parsed.assets.forEach(a => addElementAsset({ collectionId: newId, category: a.category, name: a.name, description: a.description, images: a.images }));
      selectCollection(newId);
    }
    setImporting(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 z-[200] bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 text-gray-900"
      onClick={onClose}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <motion.div
        initial={{ scale: 0.97, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.97, y: 12 }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
        className="relative bg-[#f5f5f7] rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-white border-b border-gray-200/70 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#0071e3]/10 flex items-center justify-center"><Layers size={16} className="text-[#0071e3]" /></div>
            <div className="leading-tight">
              <h2 className="text-[16px] font-semibold text-[#1d1d1f] tracking-tight">Element</h2>
              <p className="text-[11px] text-gray-400 -mt-0.5">어셋 라이브러리</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Collections sidebar */}
          <div className="w-56 shrink-0 bg-white border-r border-gray-200/70 flex flex-col">
            <div className="px-3 py-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">컬렉션</span>
              <button onClick={handleNewCollection} title="새 컬렉션" className="p-1 text-gray-400 hover:text-[#0071e3] rounded-md hover:bg-indigo-50 transition-colors"><Plus size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
              {assetCollections.length === 0 && (
                <p className="text-[11px] text-gray-400 text-center px-2 py-5 leading-relaxed">컬렉션이 없습니다.<br />＋ 로 만들어 주세요.</p>
              )}
              {assetCollections.map(c => {
                const count = elementAssets.filter(a => a.collectionId === c.id).length;
                const active = c.id === selectedCollectionId;
                return (
                  <div key={c.id}
                    onClick={() => selectCollection(c.id)}
                    className={`group flex items-center gap-1.5 px-2.5 py-2 rounded-[9px] cursor-pointer transition-colors ${active ? 'bg-indigo-50 text-[#0071e3]' : 'text-gray-700 hover:bg-gray-50'}`}>
                    {renaming?.id === c.id ? (
                      <input autoFocus value={renaming.value}
                        onChange={(e) => setRenaming({ id: c.id, value: e.target.value })}
                        onBlur={() => { renameCollection(c.id, renaming.value); setRenaming(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { renameCollection(c.id, renaming.value); setRenaming(null); } if (e.key === 'Escape') setRenaming(null); }}
                        onClick={(e) => e.stopPropagation()}
                        className="flex-1 min-w-0 px-1.5 py-0.5 text-[13px] border border-indigo-300 rounded outline-none" />
                    ) : (
                      <>
                        {boundId === c.id && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" title="이 채팅에서 사용 중" />}
                        <span className="flex-1 min-w-0 truncate text-[13px] font-medium">{c.name}</span>
                        <span className="text-[10px] text-gray-400 shrink-0 tabular-nums">{count}</span>
                        <button onClick={(e) => { e.stopPropagation(); setRenaming({ id: c.id, value: c.name }); }} title="이름 변경" className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-gray-600 shrink-0"><Pencil size={11} /></button>
                        <button onClick={(e) => { e.stopPropagation(); if (confirm(`'${c.name}' 컬렉션과 그 안의 어셋을 모두 삭제할까요?`)) deleteCollection(c.id); }} title="삭제" className="opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 shrink-0"><Trash2 size={11} /></button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 flex flex-col min-w-0">
            {selectedCollection ? (
              <>
                {/* Toolbar */}
                <div className="px-5 py-3 bg-white/60 border-b border-gray-200/70 space-y-2.5 shrink-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-[15px] font-semibold text-[#1d1d1f] truncate">{selectedCollection.name}</h3>
                      {isBound
                        ? <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full shrink-0" title="지금 이 채팅의 @멘션이 이 컬렉션의 어셋을 사용합니다"><Check size={11} /> 이 채팅에서 사용 중</span>
                        : <button onClick={() => setProjectCollection(projectId, selectedCollectionId)} className="flex items-center gap-1 text-[11px] font-medium text-[#0071e3] bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded-full transition-colors shrink-0"><Link2 size={11} /> 이 채팅에 사용</button>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => shareCollection(selectedCollection)} disabled={shareBusy === 'col-' + selectedCollection.id} title="이 컬렉션 전체를 공유 링크로 (받는 사람은 ‘가져오기’로 추가)" className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-[#0071e3] bg-white border border-gray-200 hover:border-indigo-300 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors">{shareBusy === 'col-' + selectedCollection.id ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />} 공유 링크</button>
                      <button onClick={() => setImporting(true)} title="공유 링크 또는 파일로 어셋/컬렉션 가져오기" className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-[#0071e3] bg-white border border-gray-200 hover:border-indigo-300 px-2.5 py-1.5 rounded-lg transition-colors"><Upload size={13} /> 가져오기</button>
                      <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] px-3 py-1.5 rounded-lg transition-colors active:scale-95"><Plus size={15} /> 어셋 추가</button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
                      <button onClick={() => setCategoryFilter('all')} className={`px-2.5 py-1 text-[12px] font-medium rounded-md transition-colors ${categoryFilter === 'all' ? 'bg-white shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>전체</button>
                      {CATEGORIES.map(c => {
                        const Icon = CATEGORY_ICON[c]; const on = categoryFilter === c;
                        return (
                          <button key={c} onClick={() => setCategoryFilter(c)} className={`flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium rounded-md transition-colors ${on ? 'bg-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                            style={on ? { color: CATEGORY_META[c].text } : undefined}>
                            <Icon size={11} /> {CATEGORY_META[c].name}
                          </button>
                        );
                      })}
                    </div>
                    <div className="relative flex-1 max-w-xs ml-auto">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="어셋 검색..."
                        className="w-full pl-8 pr-3 py-1.5 bg-white border border-gray-200 focus:border-indigo-400 rounded-lg text-[13px] outline-none transition-colors" />
                    </div>
                  </div>
                </div>

                {/* Grid */}
                <div className="flex-1 overflow-y-auto p-5">
                  {filtered.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-2">
                      <ImageIcon size={40} className="text-gray-300" />
                      <p className="text-[14px]">{collectionAssets.length === 0 ? '아직 어셋이 없습니다. “어셋 추가”로 등록하세요.' : '검색 결과가 없습니다.'}</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {filtered.map(a => {
                        const meta = CATEGORY_META[a.category];
                        const CatIcon = CATEGORY_ICON[a.category];
                        const cover = a.images[0];
                        return (
                          <div key={a.id} onClick={() => setEditing(a)} role="button"
                            className="text-left bg-white rounded-xl border border-gray-200/80 overflow-hidden hover:shadow-md hover:border-gray-300 transition-all group cursor-pointer">
                            <div className="aspect-square bg-gray-50 relative overflow-hidden">
                              {cover
                                ? <img src={cover.url} alt="" className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-200" />
                                : <div className="w-full h-full flex items-center justify-center text-gray-300"><ImageIcon size={28} /></div>}
                              <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: meta.bg, color: meta.text }}><CatIcon size={10} /> {meta.name}</span>
                              {a.images.length > 1 && <span className="absolute bottom-1.5 right-1.5 text-[10px] font-medium text-white bg-black/55 px-1.5 py-0.5 rounded-full">{a.images.length}장</span>}
                              <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={(e) => { e.stopPropagation(); shareAsset(a); }} disabled={shareBusy === 'asset-' + a.id} title="이 어셋 공유 링크" className="bg-black/55 hover:bg-[#0071e3] text-white rounded-full p-1">{shareBusy === 'asset-' + a.id ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}</button>
                                <button onClick={(e) => { e.stopPropagation(); if (confirm(`'${a.name}' 어셋을 삭제할까요? (앱에 저장된 이미지도 함께 삭제)`)) deleteElementAsset(a.id); }} title="삭제" className="bg-black/55 hover:bg-red-500 text-white rounded-full p-1"><Trash2 size={12} /></button>
                              </div>
                            </div>
                            <div className="px-2.5 py-2">
                              <p className="text-[13px] font-semibold text-gray-800 truncate">{a.name}</p>
                              {a.description && <p className="text-[11px] text-gray-400 truncate">{a.description}</p>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-3">
                <Layers size={44} className="text-gray-300" />
                <p className="text-[14px]">컬렉션을 만들거나, 공유받은 어셋을 가져오세요.</p>
                <div className="flex items-center gap-2">
                  <button onClick={handleNewCollection} className="flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] px-4 py-2 rounded-lg transition-colors"><Plus size={15} /> 새 컬렉션</button>
                  <button onClick={() => setImporting(true)} className="flex items-center gap-1.5 text-[13px] font-medium text-gray-600 bg-white border border-gray-200 hover:border-indigo-300 px-4 py-2 rounded-lg transition-colors"><Upload size={15} /> 가져오기</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Share-link banner */}
        <AnimatePresence>
          {shareLink && (
            <motion.div key="share-banner" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.16 }}
              className="absolute top-3 left-1/2 -translate-x-1/2 z-30 w-[min(560px,92%)] bg-white rounded-xl shadow-2xl border border-gray-200 px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded-full bg-emerald-50 flex items-center justify-center"><Check size={14} className="text-emerald-600" /></div>
                <span className="text-[13px] font-semibold text-gray-800">공유 링크 생성됨 · 클립보드에 복사됨</span>
                <button onClick={() => setShareLink(null)} className="ml-auto text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </div>
              <div className="flex items-center gap-1.5">
                <input readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 px-2.5 py-1.5 bg-[#fafafc] border border-gray-200 rounded-lg text-[12px] text-gray-600 outline-none font-mono" />
                <button onClick={() => { navigator.clipboard.writeText(shareLink).catch(() => {}); }} className="flex items-center gap-1 text-[12px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] px-2.5 py-1.5 rounded-lg shrink-0"><Copy size={13} /> 복사</button>
              </div>
              <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">받는 사람이 링크를 열면 어셋 파일이 다운로드됩니다 → element에서 <b>‘가져오기’</b>로 추가. · 링크는 <b>24시간</b> 유효(그 안엔 몇 번이든 다시 받기 가능)하며, 만료되면 서버에서 <b>자동 삭제</b>됩니다.</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Import dialog (link or file) */}
        <AnimatePresence>
          {importing && (
            <ImportDialog
              key="import-dialog"
              currentCollectionName={selectedCollection?.name ?? null}
              onCommit={commitImport}
              onClose={() => setImporting(false)}
            />
          )}
        </AnimatePresence>

        {/* Asset editor overlay */}
        <AnimatePresence>
          {editing && (
            <AssetEditor
              key="asset-editor"
              initial={editing === 'new' ? null : editing}
              onSave={commitSave}
              onDelete={editing !== 'new' ? () => { if (confirm(`'${editing.name}' 어셋을 삭제할까요? (앱에 저장된 이미지도 함께 삭제)`)) { deleteElementAsset(editing.id); setEditing(null); } } : null}
              onShare={editing !== 'new' ? () => shareAsset(editing) : null}
              sharing={editing !== 'new' && shareBusy === 'asset-' + editing.id}
              onClose={() => setEditing(null)}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
