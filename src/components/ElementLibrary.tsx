import { useState, useMemo, useEffect, useCallback, memo } from 'react';
import { useAppStore, AssetCategory, ElementAsset, ElementImage, MODELS, modelImageMax, mentionKey, uniqueElementName, groupElementFiles } from '../store';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Search, Trash2, Image as ImageIcon, Upload, Check, Link2, Pencil, Layers, User, MapPin, Package, AlertTriangle, Share2, Copy, Loader2 } from 'lucide-react';
import { validateImageFile, validateImageDimensions, createThumbnail, readFileAsDataUrl, cacheFile, createElementPackLink, fetchElementPackByLink } from '../lib/utils';
import { HoverZoom } from './HoverZoom';

// Category visuals — shared with ChatArea mention pills. `accent` is the solid
// dot color used in the prompt pills (kept emoji-free for a cleaner look).
export const CATEGORY_META: Record<AssetCategory, { name: string; bg: string; border: string; text: string; accent: string }> = {
  // Values are CSS variables (defined light+dark in index.css) rather than literals: these
  // are spread into inline style={{}} at ~10 sites, where a dark: class can never reach.
  character: { name: '캐릭터',  bg: 'var(--cat-character-bg)', border: 'var(--cat-character-border)', text: 'var(--cat-character-text)', accent: 'var(--cat-character-accent)' },
  location:  { name: '로케이션', bg: 'var(--cat-location-bg)',  border: 'var(--cat-location-border)',  text: 'var(--cat-location-text)',  accent: 'var(--cat-location-accent)' },
  prop:      { name: '프랍',    bg: 'var(--cat-prop-bg)',      border: 'var(--cat-prop-border)',      text: 'var(--cat-prop-text)',      accent: 'var(--cat-prop-accent)' },
};
const CATEGORY_ICON: Record<AssetCategory, any> = { character: User, location: MapPin, prop: Package };
const CATEGORIES = Object.keys(CATEGORY_META) as AssetCategory[];

// How many images ONE element may store. This is storage, not the send limit — the library
// is global and an element outlives whichever project is open, so it cannot be capped by
// the model that happens to be selected right now. It is therefore the largest any model
// allows (2.5 → 30); what actually gates a request is modelImageMax at send time, which
// still blocks a 20-image element on 2.0. Was 9, copied from 2.0's cap, which quietly made
// 2.5's 30-image allowance unreachable through the library.
const MAX_ELEMENT_IMAGES = 30;

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
  // 256, not the 80 default: the thumbnail is what the editor grid and the drop dialog
  // actually paint now, and 80px was sized for prompt pills. Costs ~15KB per image in the
  // persisted blob, against a full-res `url` measured in megabytes — noise.
  const [thumbnailUrl, url] = await Promise.all([createThumbnail(file, 256), readFileAsDataUrl(file)]);
  let cacheId: string | undefined;
  try { cacheId = await cacheFile(file); } catch { /* cache is opportunistic — base64 is the durable source */ }
  return { id: crypto.randomUUID(), url, thumbnailUrl, cacheId, ...(file.name ? { file_name: file.name } : {}) };
}

/* ─── Drag & drop intake: OS files → assets named after the files ─── */
// Every other way into this library makes you retype a name that is already sitting on the
// file. This one reads the name off the file and asks the two things a filename cannot
// settle: which category, and whether these files are one asset or several.
//
// ★ Names are unique per collection, enforced on mentionKey (store.ts). Not a tidiness
// rule: paste-to-mention resolves a typed name to an asset by that exact key, so two
// assets sharing it inside one collection would make the resolver pick one at random and
// send the wrong images. Collisions are therefore never silently accepted — each
// conflicting group is skipped or renamed, and the result is on screen before saving.
// Across collections names may repeat, unchanged: only the bound collection feeds mentions.
type GroupMode = 'auto' | 'each' | 'single';
const GROUP_MODES: { id: GroupMode; label: string; hint: string }[] = [
  { id: 'auto',   label: '자동',      hint: '이름 뒤 번호만 다른 파일은 한 어셋으로 (hero_1, hero_2 → hero)' },
  { id: 'each',   label: '각각',      hint: '파일 하나당 어셋 하나' },
  { id: 'single', label: '전부 하나', hint: '끌어온 파일 전부를 한 어셋의 이미지로' },
];

type IntakeGroup = { key: string; files: number[]; name: string; category: AssetCategory; rename: boolean };

function DropIntake({ files, existing, collectionName, sendCap, modelName, onCancel, onCommit }: {
  files: File[];
  existing: ElementAsset[];     // assets already in the target collection
  collectionName: string;
  sendCap: number;              // modelImageMax of the host project's model
  modelName: string;
  onCancel: () => void;
  onCommit: (items: { name: string; category: AssetCategory; images: ElementImage[] }[]) => void;
}) {
  const [mode, setMode] = useState<GroupMode>('auto');
  const [groups, setGroups] = useState<IntakeGroup[]>(
    () => groupElementFiles(files.map(f => f.name), 'auto').map((g, i) => ({ ...g, key: `g${i}`, category: 'character' as AssetCategory, rename: false })),
  );
  const [busy, setBusy] = useState(0);          // 0 = idle, else 1-based progress
  const [failed, setFailed] = useState<string[]>([]);

  // One object URL per FILE, made once. Regrouping reshuffles which group shows which
  // file — recreating URLs there would leak one per switch.
  const [previews] = useState<string[]>(() => files.map(f => URL.createObjectURL(f)));
  useEffect(() => () => { previews.forEach(u => URL.revokeObjectURL(u)); }, []);

  const applyMode = (m: GroupMode) => {
    setMode(m);
    setGroups(groupElementFiles(files.map(f => f.name), m).map((g, i) => ({ ...g, key: `g${i}`, category: 'character', rename: false })));
  };

  const existingKeyList: string[] = useMemo(() => existing.map(a => mentionKey(a.name)), [existing]);
  const existingKeys: Set<string> = useMemo(() => new Set(existingKeyList), [existingKeyList]);

  // ONE top-down pass produces everything the rows render, including the name a conflicted
  // group WOULD take if renamed. Computing that inside the row markup instead meant
  // rebuilding a set over every other group, per group, on every keystroke — O(n²) per
  // render, and the reason a 20-file drop felt sluggish.
  const resolved = useMemo(() => {
    const taken = new Set(existingKeyList);
    return groups.map(g => {
      const base = g.name.trim();
      const key = mentionKey(base);
      const conflict: null | 'existing' | 'batch' = !base ? null
        : existingKeys.has(key) ? 'existing'
        : taken.has(key) ? 'batch'
        : null;
      const suggestion = conflict ? uniqueElementName(base, taken) : base;
      if (!base) return { group: g, conflict: null, finalName: '', suggestion: '', skipped: true };
      if (conflict && !g.rename) return { group: g, conflict, finalName: base, suggestion, skipped: true };
      taken.add(mentionKey(suggestion));
      return { group: g, conflict, finalName: suggestion, suggestion, skipped: false };
    });
  }, [groups, existingKeyList, existingKeys]);

  const willAdd = resolved.filter(r => !r.skipped);
  const skippedCount = resolved.filter(r => r.skipped).length;
  const overSized = resolved.filter(r => !r.skipped && r.group.files.length > MAX_ELEMENT_IMAGES);
  const patch = (key: string, up: Partial<IntakeGroup>) => setGroups(gs => gs.map(g => (g.key === key ? { ...g, ...up } : g)));
  const setAllCategories = (c: AssetCategory) => setGroups(gs => gs.map(g => ({ ...g, category: c })));

  const commit = async () => {
    if (!willAdd.length || overSized.length) return;
    const out: { name: string; category: AssetCategory; images: ElementImage[] }[] = [];
    const bad: string[] = [];
    const total = willAdd.reduce((n, r) => n + r.group.files.length, 0);
    let done = 0;
    // Sequential on purpose: each file becomes a full-res base64 string, and firing dozens
    // of those in parallel spikes memory hard enough to take the renderer with it.
    for (const r of willAdd) {
      const imgs: ElementImage[] = [];
      for (const fi of r.group.files) {
        setBusy(++done);
        try { imgs.push(await fileToElementImage(files[fi])); }
        catch (e: any) { bad.push(`${files[fi].name}: ${e?.message || '처리 실패'}`); }
      }
      if (imgs.length) out.push({ name: r.finalName, category: r.group.category, images: imgs });
    }
    setBusy(0);
    void total;
    if (bad.length && !out.length) { setFailed(bad); return; }
    if (bad.length) setFailed(bad);
    onCommit(out);
  };

  const totalImages = willAdd.reduce((n, r) => n + r.group.files.length, 0);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="absolute inset-0 z-30 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={busy ? undefined : onCancel}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <motion.div initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 10 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-xl max-h-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 shrink-0">
          <div className="leading-tight min-w-0">
            <h3 className="text-[15px] font-semibold text-[#1d1d1f] dark:text-gray-900">파일 {files.length}개 추가</h3>
            <p className="text-[11px] text-gray-400 -mt-0.5 truncate">‘{collectionName}’ · 파일 이름이 그대로 어셋 이름이 됩니다</p>
          </div>
          <button onClick={onCancel} disabled={!!busy} className="p-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 disabled:opacity-40 transition-colors shrink-0"><X size={18} /></button>
        </div>

        <div className="px-5 py-3 border-b border-gray-100 shrink-0 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-black/70 dark:text-white/75 shrink-0 w-14">묶기</span>
            <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
              {GROUP_MODES.map(m => (
                <button key={m.id} onClick={() => applyMode(m.id)} disabled={!!busy} title={m.hint}
                  className={`px-2.5 py-1 text-[12px] font-medium rounded-md transition-colors disabled:opacity-40 ${mode === m.id ? 'bg-white dark:bg-[#1c1c1e] shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>
                  {m.label}
                </button>
              ))}
            </div>
            <span className="text-[10px] text-gray-400 truncate">{GROUP_MODES.find(m => m.id === mode)?.hint}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-black/70 dark:text-white/75 shrink-0 w-14">분류</span>
            <div className="flex items-center gap-1.5">
              {CATEGORIES.map(c => {
                const Icon = CATEGORY_ICON[c]; const m = CATEGORY_META[c];
                return (
                  <button key={c} onClick={() => setAllCategories(c)} disabled={!!busy}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-[12px] font-medium border transition-colors disabled:opacity-40"
                    style={{ background: m.bg, borderColor: m.border, color: m.text }}>
                    <Icon size={12} /> {m.name}
                  </button>
                );
              })}
            </div>
            <span className="text-[10px] text-gray-400">전체 지정 · 아래에서 개별 변경</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-1.5 min-h-0">
          {resolved.map(({ group, conflict, suggestion, skipped }) => {
            const meta = CATEGORY_META[group.category];
            const over = group.files.length > MAX_ELEMENT_IMAGES;
            return (
              <div key={group.key} className={`flex items-center gap-2.5 rounded-xl border p-2 transition-colors ${over ? 'border-red-300 bg-red-50/40' : skipped ? 'border-gray-200 bg-gray-50 opacity-60' : conflict ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`}>
                <div className="relative shrink-0 w-10 h-10">
                  {group.files.slice(0, 3).map((fi, i) => (
                    <img key={fi} src={previews[fi]} alt="" loading="lazy" decoding="async"
                      className="absolute w-10 h-10 rounded-lg object-cover bg-gray-100 border border-white"
                      style={{ left: i * 3, top: i * -2, zIndex: 3 - i }} />
                  ))}
                  {group.files.length > 1 && (
                    <span className="absolute -bottom-1 -right-1 z-10 text-[9px] font-semibold text-white bg-gray-800/85 rounded px-1 leading-[14px]">{group.files.length}</span>
                  )}
                </div>
                <div className="flex-1 min-w-0 space-y-1">
                  <input value={group.name} disabled={!!busy}
                    onChange={(e) => patch(group.key, { name: e.target.value })}
                    className="w-full px-2 py-1 text-[13px] bg-[#fafafc] dark:bg-[#242426] border border-black/5 dark:border-white/10 rounded-lg outline-none focus:border-[#0071e3] transition-colors disabled:opacity-50" />
                  {over && <span className="text-[10px] text-red-600">이미지 {group.files.length}장 — 어셋 하나당 최대 {MAX_ELEMENT_IMAGES}장입니다. 묶기를 바꾸거나 나눠서 넣어주세요.</span>}
                  {!over && conflict && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-amber-700">
                        {conflict === 'existing' ? '이미 이 컬렉션에 있는 이름입니다' : '이번에 끌어온 파일끼리 이름이 겹칩니다'}
                      </span>
                      <button onClick={() => patch(group.key, { rename: !group.rename })} disabled={!!busy}
                        className="text-[10px] font-medium text-[#0071e3] dark:text-[#4da3ff] hover:underline disabled:opacity-40">
                        {group.rename ? '건너뛰기로 변경' : `‘${suggestion}’ 로 추가`}
                      </button>
                    </div>
                  )}
                  {!over && conflict && group.rename && <span className="text-[10px] text-emerald-700">‘{suggestion}’ 로 추가됩니다</span>}
                  {!over && !conflict && !group.name.trim() && <span className="text-[10px] text-gray-400">이름이 비어 건너뜁니다</span>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {CATEGORIES.map(c => {
                    const Icon = CATEGORY_ICON[c]; const on = group.category === c;
                    return (
                      <button key={c} onClick={() => patch(group.key, { category: c })} disabled={!!busy} title={CATEGORY_META[c].name}
                        className={`p-1.5 rounded-lg border transition-colors disabled:opacity-40 ${on ? '' : 'border-transparent text-gray-300 hover:text-gray-500 hover:bg-gray-50'}`}
                        style={on ? { background: meta.bg, borderColor: meta.border, color: meta.text } : undefined}>
                        <Icon size={13} />
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-gray-100 shrink-0 space-y-2">
          {failed.length > 0 && <p className="text-[11px] text-red-500 bg-red-50 rounded-lg px-3 py-2 whitespace-pre-line max-h-20 overflow-y-auto">{failed.join('\n')}</p>}
          {/* The library is global and outlives whichever project is open, so a big
              collection is not itself a problem. What one request can carry is — say the
              number rather than let it surface as a send-time rejection. */}
          {existing.length + willAdd.length > sendCap && (
            <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 flex gap-1.5">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              <span>추가 후 이 컬렉션의 어셋은 {existing.length + willAdd.length}개가 됩니다. 저장에는 문제없지만, 한 번의 프롬프트에 언급할 수 있는 이미지는 {modelName} 기준 {sendCap}장입니다.</span>
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] text-gray-500">
              {busy ? `처리 중… ${busy}/${totalImages}` :
                `어셋 ${willAdd.length}개 · 이미지 ${totalImages}장${skippedCount ? ` · ${skippedCount}개 건너뜀` : ''}`}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={onCancel} disabled={!!busy} className="text-[13px] font-medium text-gray-500 hover:text-gray-800 px-3 py-2 rounded-lg hover:bg-gray-100 disabled:opacity-40 transition-colors">취소</button>
              <button onClick={commit} disabled={!!busy || willAdd.length === 0 || overSized.length > 0}
                className="flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-40 px-4 py-2 rounded-lg transition-colors active:scale-95">
                {busy ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />} 추가
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─── Asset create/edit form (local draft → committed on save) ─── */
function AssetEditor({ initial, onSave, onDelete, onShare, sharing, onClose, sendCap, modelName }: {
  initial: ElementAsset | null;
  onSave: (data: { name: string; description: string; category: AssetCategory; images: ElementImage[] }) => void;
  onDelete: (() => void) | null;
  onShare?: (() => void) | null;
  sharing?: boolean;
  onClose: () => void;
  // The CURRENT project's model decides how many images a request may carry (2.0 → 9,
  // 2.5 → 30). Passed in rather than read here so this editor stays a dumb form.
  sendCap: number;
  modelName: string;
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
      {/* Header / body / footer as a real flex column instead of one scrolling box with
          sticky ends: the sticky footer used to float OVER the last row of images, so a
          12-image asset read as cut off rather than scrollable.
          ★ max-h-FULL, never a vh value. This overlay is absolute-positioned INSIDE the
          library modal, which is h-[85vh] with overflow-hidden. A max-h-[88vh] child is
          therefore taller than the box it lives in, and items-center splits the overflow
          across the top AND bottom — the parent then clips both, which is the actual
          reason images "got cut off" no matter how the inside scrolled. `full` is 100% of
          the padded parent, so the footer is always reachable and only the body scrolls. */}
      <motion.div
        initial={{ scale: 0.96, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, y: 10 }}
        transition={{ duration: 0.16, ease: 'easeOut' }}
        className="bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-lg max-h-full flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-white dark:bg-[#1c1c1e] shrink-0">
          <h3 className="text-[15px] font-semibold text-[#1d1d1f] dark:text-gray-900 tracking-tight">{initial ? '어셋 편집' : '새 어셋'}</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"><X size={18} /></button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-0">
          {/* Category */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70 dark:text-white/75">카테고리</label>
            <div className="flex gap-2">
              {CATEGORIES.map(c => {
                const Icon = CATEGORY_ICON[c]; const on = category === c;
                return (
                  <button key={c} onClick={() => setCategory(c)}
                    className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-[10px] text-[13px] font-medium border-2 transition-colors ${on ? 'border-current' : 'border-transparent bg-[#f5f5f7] dark:bg-[#242426] text-gray-500 hover:bg-[#ededf0] dark:hover:bg-[#2e2e31]'}`}
                    style={on ? { background: CATEGORY_META[c].bg, color: CATEGORY_META[c].text, borderColor: CATEGORY_META[c].border } : undefined}>
                    <Icon size={14} /> {CATEGORY_META[c].name}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70 dark:text-white/75">이름</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 김현우" autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!busy) save(); } }}
              className="w-full px-3 py-2 bg-[#fafafc] dark:bg-[#242426] border-[3px] border-black/5 dark:border-white/10 rounded-[11px] text-[14px] outline-none focus:border-[#0071e3] transition-colors" />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70 dark:text-white/75">설명 <span className="text-gray-400 font-normal">(선택)</span></label>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="간단한 설명 (검색에 사용됨) · 저장은 Ctrl+Enter"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (!busy) save(); } }}
              className="w-full px-3 py-2 bg-[#fafafc] dark:bg-[#242426] border-[3px] border-black/5 dark:border-white/10 rounded-[11px] text-[13px] outline-none focus:border-[#0071e3] transition-colors resize-none" />
          </div>

          {/* Images — thumbnail in the grid, full-res only on hover.
              These cells are ~96px. Painting the full-res `url` in each of them meant
              decoding every attached image at native size the moment the editor opened:
              a 12-image asset is ~24M pixels ≈ 100MB of bitmap, which is what made this
              dialog crawl. The card grid above keeps full-res deliberately (its cells are
              ~270px and the old 80px thumb looked mushy there) — at this size it does not.
              HoverZoom still gets `fullSrc`, so zooming is as crisp as it ever was. */}
          <div className="space-y-1.5">
            <label className="block text-[12px] font-semibold text-black/70 dark:text-white/75">이미지 <span className="text-gray-400 font-normal">{images.length}/{MAX_ELEMENT_IMAGES}</span></label>
            <div className="grid grid-cols-4 gap-2">
              {images.map(img => (
                <div key={img.id} className="relative aspect-square rounded-[10px] overflow-hidden border border-gray-200 bg-gray-50 group">
                  <HoverZoom className="block w-full h-full" src={img.thumbnailUrl || img.url} fullSrc={img.url}>
                    <img src={img.thumbnailUrl || img.url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover cursor-zoom-in" />
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
              <span>
                전송 시 이 이미지들은 <b>래퍼런스 이미지</b>로 합쳐집니다 — 래퍼런스 패널 이미지와 <b>합산 최대 {sendCap}장</b>, 초과 시 전송 차단.
                {' '}합산 한도는 모델마다 다릅니다 (<b>Seedance 2.5 → 30장</b> · 2.0 계열 → 9장 · Omni → 10장). 지금 프로젝트는 <b>{modelName}</b>.
                {' '}어셋당 {MAX_ELEMENT_IMAGES}장까지 저장 · 개당 30MB · 300~6000px · 원본 화질 그대로 전송.
                {images.length > sendCap && (
                  <><br /><b className="text-amber-600">이 어셋만으로 {images.length}장이라 {modelName}({sendCap}장)에서는 전송이 막힙니다 — 이미지를 줄이거나 Seedance 2.5 로 바꿔주세요.</b></>
                )}
              </span>
            </p>
          </div>

          {error && <p className="text-[12px] text-red-500 bg-red-50 rounded-lg px-3 py-2 whitespace-pre-line">{error}</p>}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3.5 border-t border-gray-100 bg-white dark:bg-[#1c1c1e] shrink-0">
          <div className="flex items-center gap-1">
            {onDelete && <button onClick={onDelete} className="flex items-center gap-1.5 text-[13px] font-medium text-red-500 hover:text-red-700 hover:bg-red-50 px-3 py-2 rounded-lg transition-colors"><Trash2 size={15} /> 삭제</button>}
            {onShare && <button onClick={onShare} disabled={sharing} title="이 어셋을 공유 링크로" className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-[#0071e3] dark:hover:text-[#4da3ff] hover:bg-indigo-50 disabled:opacity-50 px-3 py-2 rounded-lg transition-colors">{sharing ? <Loader2 size={15} className="animate-spin" /> : <Share2 size={15} />} 공유</button>}
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
        className="bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-md max-h-full overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100">
          <h3 className="text-[15px] font-semibold text-[#1d1d1f] dark:text-gray-900">어셋 가져오기</h3>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"><X size={18} /></button>
        </div>

        {!parsed ? (
          <div className="p-5 space-y-4">
            <div className="space-y-1.5">
              <label className="block text-[12px] font-semibold text-black/70 dark:text-white/75">공유 링크로 가져오기</label>
              <div className="flex items-center gap-1.5">
                <input value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') loadLink(); }} placeholder="공유받은 링크를 붙여넣기"
                  className="flex-1 min-w-0 px-3 py-2 bg-[#fafafc] dark:bg-[#242426] border-[3px] border-black/5 dark:border-white/10 rounded-[11px] text-[13px] outline-none focus:border-[#0071e3] transition-colors" />
                <button onClick={loadLink} disabled={busy || !link.trim()} className="flex items-center gap-1 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] disabled:opacity-50 px-3 py-2 rounded-[11px] shrink-0">{busy ? <Loader2 size={14} className="animate-spin" /> : <Link2 size={14} />} 불러오기</button>
              </div>
              <p className="text-[10px] text-gray-400">받은 Freewill 공유 링크를 그대로 붙여넣으면 됩니다.</p>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-gray-300"><div className="flex-1 h-px bg-gray-100" />또는<div className="flex-1 h-px bg-gray-100" /></div>
            <label className="flex items-center justify-center gap-2 w-full px-3 py-2.5 rounded-[11px] text-[13px] font-medium text-gray-600 bg-[#fafafc] dark:bg-[#242426] hover:bg-[#f0f0f2] dark:hover:bg-[#2e2e31] border-[3px] border-black/5 dark:border-white/10 cursor-pointer transition-colors">
              <Upload size={15} /> 파일에서 선택 (.fwsl.json)
              <input type="file" accept="application/json,.json,.fwsl" className="hidden" onChange={(e) => { loadFile(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {error && <p className="text-[12px] text-red-500 bg-red-50 rounded-lg px-3 py-2 whitespace-pre-line">{error}</p>}
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div className="flex items-center gap-3 bg-[#fafafc] dark:bg-[#242426] rounded-xl p-3 border border-gray-100">
              <div className="flex -space-x-2 shrink-0">
                {parsed.assets.slice(0, 3).map((a, i) => (<img key={i} src={a.images[0]?.url} className="w-9 h-9 rounded-lg object-cover border-2 border-white" alt="" />))}
              </div>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold text-gray-800 truncate">{parsed.kind === 'collection' ? (parsed.collectionName || '컬렉션') : parsed.assets[0]?.name}</p>
                <p className="text-[11px] text-gray-400">{parsed.kind === 'collection' ? '컬렉션' : '어셋'} · 어셋 {parsed.assets.length}개</p>
              </div>
            </div>
            <div className="space-y-2">
              <label className="block text-[12px] font-semibold text-black/70 dark:text-white/75">어디에 추가할까요?</label>
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

/* ─── Asset card (memoized) ─── */
// ★ memo 가 여기서 하는 일이 큰 이유: 커버가 원본 base64 라 문자열 하나가 수백 KB 다.
// asset 객체는 편집하지 않는 한 참조가 그대로이므로, memo 가 얕은 비교 한 번으로 subtree 를
// 통째로 건너뛴다. 그러면 그 거대한 문자열이 diff 대상에서 아예 빠진다.
// 부모에서 넘기는 콜백은 전부 useCallback 으로 참조를 고정해야 이 memo 가 의미를 갖는다.
//
// content-visibility:auto — 화면 밖 카드는 레이아웃·페인트를 건너뛴다. 창을 열고 닫을 때의
// 애니메이션이 49장을 한꺼번에 그리느라 끊기던 것을 이걸로 없앤다. 스크롤 시 높이가 튀지
// 않도록 contain-intrinsic-size 로 예상 크기를 알려준다.
const AssetCard = memo(function AssetCard({ asset, sharing, imagesReady, onOpen, onShare, onDelete }: {
  asset: ElementAsset; sharing: boolean;
  // 열기 애니메이션이 끝나기 전에는 false. 커버가 원본 해상도라 디코딩이 무거운데,
  // 그게 애니메이션과 같은 프레임에서 경쟁하면 창이 뚝뚝 끊긴다. 애니메이션을 먼저 끝내고
  // 그 다음에 이미지를 붙인다.
  imagesReady: boolean;
  onOpen: (a: ElementAsset) => void;
  onShare: (a: ElementAsset) => void;
  onDelete: (a: ElementAsset) => void;
}) {
  const meta = CATEGORY_META[asset.category];
  const CatIcon = CATEGORY_ICON[asset.category];
  const cover = asset.images[0];
  return (
    <div onClick={() => onOpen(asset)} role="button"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '260px 300px' } as any}
      className="text-left bg-white dark:bg-[#1c1c1e] rounded-xl border border-gray-200/80 overflow-hidden hover:shadow-md hover:border-gray-300 transition-all group cursor-pointer">
      {/* Cover uses the FULL-RES url: the 80px/q0.5 thumbnailUrl was far too small for this
          ~270px card and rendered visibly mushy (v26.7.2101 regression). loading="lazy" +
          decoding="async" keeps only on-screen covers decoding, off the main thread. */}
      <div className="aspect-square bg-gray-50 relative overflow-hidden">
        {cover && imagesReady
          ? <img src={cover.url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-200" />
          : <div className="w-full h-full flex items-center justify-center text-gray-300"><ImageIcon size={28} /></div>}
        <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full" style={{ background: meta.bg, color: meta.text }}><CatIcon size={10} /> {meta.name}</span>
        {asset.images.length > 1 && <span className="absolute bottom-1.5 right-1.5 text-[10px] font-medium text-white bg-black/55 px-1.5 py-0.5 rounded-full">{asset.images.length}장</span>}
        <div className="absolute top-1 right-1 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button onClick={(e) => { e.stopPropagation(); onShare(asset); }} disabled={sharing} title="이 어셋 공유 링크" className="bg-black/55 hover:bg-[#0071e3] text-white rounded-full p-1">{sharing ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}</button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(asset); }} title="삭제" className="bg-black/55 hover:bg-red-500 text-white rounded-full p-1"><Trash2 size={12} /></button>
        </div>
      </div>
      <div className="px-2.5 py-2">
        <p className="text-[13px] font-semibold text-gray-800 truncate">{asset.name}</p>
        {asset.description && <p className="text-[11px] text-gray-400 truncate">{asset.description}</p>}
      </div>
    </div>
  );
});

/* ─── Element library modal ─── */
export function ElementLibrary({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  // ★ 셀렉터로 좁혀서 구독한다. 예전에는 useAppStore() 를 통째로 구독했는데, 그러면
  // projects 가 바뀔 때마다 — 즉 영상 생성 중 10초 폴링마다 — 이 창 전체가 리렌더됐다.
  // 카드 커버가 수백 KB 짜리 base64 문자열이라 리렌더 한 번에 수십 MB 를 diff 하게 되고,
  // 그게 "생성 중에 엘리먼트 창이 뚝뚝 끊긴다"의 정체였다.
  // 아래 셀렉터들은 전부 원시값이거나 실제로 이 창이 쓰는 슬라이스뿐이다.
  const hostModel = useAppStore((s) => s.projects.find((p) => p.id === projectId)?.settings.model || '');
  const assetCollections = useAppStore((s) => s.assetCollections);
  const elementAssets = useAppStore((s) => s.elementAssets);
  const projectCollectionId = useAppStore((s) => s.projectCollectionId);
  // 액션은 zustand 에서 참조가 고정이라 개별 선택해도 리렌더를 유발하지 않는다.
  const createCollection = useAppStore((s) => s.createCollection);
  const renameCollection = useAppStore((s) => s.renameCollection);
  const deleteCollection = useAppStore((s) => s.deleteCollection);
  const addElementAsset = useAppStore((s) => s.addElementAsset);
  const updateElementAsset = useAppStore((s) => s.updateElementAsset);
  const deleteElementAsset = useAppStore((s) => s.deleteElementAsset);
  const setProjectCollection = useAppStore((s) => s.setProjectCollection);

  // The library is global, but the request it feeds is not: how many images may actually
  // go out is decided by the model of the project this modal was opened from.
  const sendCap = modelImageMax(hostModel);
  const modelName = MODELS.find(m => m.id === hostModel)?.name || '현재 모델';

  // Per-collection asset counts in one O(n) pass, instead of elementAssets.filter().length
  // per collection row per render (O(collections × elementAssets) on every re-render).
  const collectionCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of elementAssets) m[a.collectionId] = (m[a.collectionId] || 0) + 1;
    return m;
  }, [elementAssets]);

  const boundId = projectCollectionId[projectId] || null;
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(boundId);
  const [categoryFilter, setCategoryFilter] = useState<AssetCategory | 'all'>('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ElementAsset | 'new' | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [shareBusy, setShareBusy] = useState<string | null>(null); // key currently generating a link
  const [shareLink, setShareLink] = useState<string | null>(null); // generated link banner
  const [importing, setImporting] = useState(false);              // import dialog open
  const [intake, setIntake] = useState<File[] | null>(null);      // dropped OS files awaiting category
  const [dropHint, setDropHint] = useState(false);                // drag is over the grid
  const [dropNote, setDropNote] = useState('');                   // why a drop was refused / what it added
  // 커버 로딩을 열기 애니메이션 뒤로 미룬다. 모달 트랜지션이 0.18s 라 그보다 조금 뒤.
  const [imagesReady, setImagesReady] = useState(false);

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
      else if (intake) setIntake(null);
      else if (importing) setImporting(false);
      else if (editing) setEditing(null);
      else if (!renaming) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, editing, renaming, shareLink, importing, intake, onClose]);

  // 창이 닫히면 다시 false 로 돌려, 다음에 열 때도 애니메이션이 먼저 끝나게 한다.
  useEffect(() => {
    if (!open) { setImagesReady(false); return; }
    const t = setTimeout(() => setImagesReady(true), 240);
    return () => clearTimeout(t);
  }, [open]);

  // The drop note is an outcome, not a dialog — it goes away on its own.
  useEffect(() => {
    if (!dropNote) return;
    const t = setTimeout(() => setDropNote(''), 4000);
    return () => clearTimeout(t);
  }, [dropNote]);

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

  // ─── Drag & drop from the OS: one element per file, named after the file ───
  // Refused rather than guessed when there is nowhere to put them: silently inventing a
  // collection would bind this chat to it as a side effect (selectCollection does that),
  // which is not what dropping a file asks for.
  const handleDropFiles = (list: FileList | null) => {
    setDropHint(false);
    const files = Array.from(list || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) { setDropNote('이미지 파일만 추가할 수 있습니다.'); return; }
    if (!selectedCollectionId) { setDropNote('먼저 왼쪽에서 컬렉션을 선택하거나 만들어 주세요.'); return; }
    setDropNote('');
    setIntake(files);
  };

  const commitIntake = (items: { name: string; category: AssetCategory; images: ElementImage[] }[]) => {
    if (selectedCollectionId) {
      // addElementAsset assigns the id, so mention pills bind to these exactly like
      // hand-made assets do — nothing about the mention path is special-cased here.
      items.forEach(it => addElementAsset({
        collectionId: selectedCollectionId, category: it.category,
        name: it.name, description: '', images: it.images,
      }));
    }
    setIntake(null);
    const imgs = items.reduce((n, it) => n + it.images.length, 0);
    setDropNote(items.length ? `어셋 ${items.length}개 (이미지 ${imgs}장)를 추가했습니다.` : '');
  };

  // ─── Share: collection or single asset → R2 link (7-day, copied to clipboard) ───
  // ★ 아래 세 핸들러는 참조가 고정돼야 한다. 매 렌더마다 새 함수를 만들면 AssetCard 의
  // memo 가 매번 깨져서, 애초에 memo 를 단 이유(거대한 base64 diff 회피)가 사라진다.
  const openEditor = useCallback((a: ElementAsset) => setEditing(a), []);
  const removeAsset = useCallback((a: ElementAsset) => {
    if (confirm(`'${a.name}' 어셋을 삭제할까요? (앱에 저장된 이미지도 함께 삭제)`)) deleteElementAsset(a.id);
  }, [deleteElementAsset]);

  const shareBundle = useCallback(async (bundle: Bundle, key: string) => {
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
  }, []);
  const shareCollection = (col: { id: string; name: string }) => {
    const assets = elementAssets.filter(a => a.collectionId === col.id);
    if (assets.length === 0) { alert('공유할 어셋이 없습니다.'); return; }
    shareBundle({ format: BUNDLE_FORMAT, version: 1, kind: 'collection', collectionName: col.name, assets: assets.map(stripAssetForExport) }, 'col-' + col.id);
  };
  const shareAsset = useCallback((a: ElementAsset) => {
    shareBundle({ format: BUNDLE_FORMAT, version: 1, kind: 'asset', collectionName: a.name, assets: [stripAssetForExport(a)] }, 'asset-' + a.id);
  }, [shareBundle]);

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
        className="relative bg-[#f5f5f7] dark:bg-[#242426] rounded-2xl shadow-2xl w-full max-w-5xl h-[85vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 bg-white dark:bg-[#1c1c1e] border-b border-gray-200/70 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-[#0071e3]/10 flex items-center justify-center"><Layers size={16} className="text-[#0071e3] dark:text-[#4da3ff]" /></div>
            <div className="leading-tight">
              <h2 className="text-[16px] font-semibold text-[#1d1d1f] dark:text-gray-900 tracking-tight">Element</h2>
              <p className="text-[11px] text-gray-400 -mt-0.5">어셋 라이브러리</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"><X size={20} /></button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Collections sidebar */}
          <div className="w-56 shrink-0 bg-white dark:bg-[#1c1c1e] border-r border-gray-200/70 flex flex-col">
            <div className="px-3 py-2.5 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">컬렉션</span>
              <button onClick={handleNewCollection} title="새 컬렉션" className="p-1 text-gray-400 hover:text-[#0071e3] dark:hover:text-[#4da3ff] rounded-md hover:bg-indigo-50 transition-colors"><Plus size={16} /></button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
              {assetCollections.length === 0 && (
                <p className="text-[11px] text-gray-400 text-center px-2 py-5 leading-relaxed">컬렉션이 없습니다.<br />＋ 로 만들어 주세요.</p>
              )}
              {assetCollections.map(c => {
                const count = collectionCounts[c.id] || 0;
                const active = c.id === selectedCollectionId;
                return (
                  <div key={c.id}
                    onClick={() => selectCollection(c.id)}
                    className={`group flex items-center gap-1.5 px-2.5 py-2 rounded-[9px] cursor-pointer transition-colors ${active ? 'bg-indigo-50 text-[#0071e3] dark:text-[#4da3ff]' : 'text-gray-700 hover:bg-gray-50'}`}>
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
                <div className="px-5 py-3 bg-white/60 dark:bg-[#1c1c1e]/60 border-b border-gray-200/70 space-y-2.5 shrink-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-[15px] font-semibold text-[#1d1d1f] dark:text-gray-900 truncate">{selectedCollection.name}</h3>
                      {isBound
                        ? <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full shrink-0" title="지금 이 채팅의 @멘션이 이 컬렉션의 어셋을 사용합니다"><Check size={11} /> 이 채팅에서 사용 중</span>
                        : <button onClick={() => setProjectCollection(projectId, selectedCollectionId)} className="flex items-center gap-1 text-[11px] font-medium text-[#0071e3] dark:text-[#4da3ff] bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded-full transition-colors shrink-0"><Link2 size={11} /> 이 채팅에 사용</button>}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button onClick={() => shareCollection(selectedCollection)} disabled={shareBusy === 'col-' + selectedCollection.id} title="이 컬렉션 전체를 공유 링크로 (받는 사람은 ‘가져오기’로 추가)" className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-[#0071e3] dark:hover:text-[#4da3ff] bg-white dark:bg-[#1c1c1e] border border-gray-200 hover:border-indigo-300 disabled:opacity-50 px-2.5 py-1.5 rounded-lg transition-colors">{shareBusy === 'col-' + selectedCollection.id ? <Loader2 size={13} className="animate-spin" /> : <Share2 size={13} />} 공유 링크</button>
                      <button onClick={() => setImporting(true)} title="공유 링크 또는 파일로 어셋/컬렉션 가져오기" className="flex items-center gap-1.5 text-[12px] font-medium text-gray-600 hover:text-[#0071e3] dark:hover:text-[#4da3ff] bg-white dark:bg-[#1c1c1e] border border-gray-200 hover:border-indigo-300 px-2.5 py-1.5 rounded-lg transition-colors"><Upload size={13} /> 가져오기</button>
                      <button onClick={() => setEditing('new')} className="flex items-center gap-1.5 text-[13px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] px-3 py-1.5 rounded-lg transition-colors active:scale-95"><Plus size={15} /> 어셋 추가</button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex items-center gap-0.5 bg-gray-100 rounded-lg p-0.5">
                      <button onClick={() => setCategoryFilter('all')} className={`px-2.5 py-1 text-[12px] font-medium rounded-md transition-colors ${categoryFilter === 'all' ? 'bg-white dark:bg-[#1c1c1e] shadow-sm text-gray-800' : 'text-gray-500 hover:text-gray-700'}`}>전체</button>
                      {CATEGORIES.map(c => {
                        const Icon = CATEGORY_ICON[c]; const on = categoryFilter === c;
                        return (
                          <button key={c} onClick={() => setCategoryFilter(c)} className={`flex items-center gap-1 px-2.5 py-1 text-[12px] font-medium rounded-md transition-colors ${on ? 'bg-white dark:bg-[#1c1c1e] shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                            style={on ? { color: CATEGORY_META[c].text } : undefined}>
                            <Icon size={11} /> {CATEGORY_META[c].name}
                          </button>
                        );
                      })}
                    </div>
                    <div className="relative flex-1 max-w-xs ml-auto">
                      <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="어셋 검색..."
                        className="w-full pl-8 pr-3 py-1.5 bg-white dark:bg-[#1c1c1e] border border-gray-200 focus:border-indigo-400 rounded-lg text-[13px] outline-none transition-colors" />
                    </div>
                  </div>
                </div>

                {/* Grid — also the drop target for OS files.
                    Guarded on the overlays: the editor and the import dialog each own their
                    own drop behaviour (images into ONE asset / a bundle file), and they sit
                    above this. Reacting here while one of them is open would mean a drop
                    aimed at the editor quietly created new assets instead. */}
                <div className="flex-1 overflow-y-auto p-5 relative"
                  onDragEnter={(e) => { if (!editing && !importing && !intake && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDropHint(true); } }}
                  onDragOver={(e) => { if (!editing && !importing && !intake && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.stopPropagation(); setDropHint(true); } }}
                  onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropHint(false); }}
                  onDrop={(e) => {
                    if (editing || importing || intake) return;
                    e.preventDefault(); e.stopPropagation();
                    handleDropFiles(e.dataTransfer?.files || null);
                  }}>
                  {dropHint && (
                    <div className="absolute inset-3 z-10 rounded-2xl border-2 border-dashed border-[#0071e3] bg-[#0071e3]/5 flex flex-col items-center justify-center gap-1.5 pointer-events-none">
                      <Upload size={26} className="text-[#0071e3] dark:text-[#4da3ff]" />
                      <p className="text-[13px] font-medium text-[#0071e3] dark:text-[#4da3ff]">놓으면 파일 이름 그대로 어셋이 됩니다</p>
                      <p className="text-[11px] text-[#0071e3]/70 dark:text-[#4da3ff]/70">분류(캐릭터·로케이션·프랍)만 고르면 끝</p>
                    </div>
                  )}
                  {filtered.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 gap-2">
                      <ImageIcon size={40} className="text-gray-300" />
                      <p className="text-[14px]">{collectionAssets.length === 0 ? '아직 어셋이 없습니다. “어셋 추가”로 등록하세요.' : '검색 결과가 없습니다.'}</p>
                      {collectionAssets.length === 0 && <p className="text-[12px] text-gray-300">이미지 파일을 여기로 끌어다 놓아도 됩니다.</p>}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {filtered.map(a => (
                        <AssetCard key={a.id} asset={a} sharing={shareBusy === 'asset-' + a.id}
                          imagesReady={imagesReady}
                          onOpen={openEditor} onShare={shareAsset} onDelete={removeAsset} />
                      ))}
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
                  <button onClick={() => setImporting(true)} className="flex items-center gap-1.5 text-[13px] font-medium text-gray-600 bg-white dark:bg-[#1c1c1e] border border-gray-200 hover:border-indigo-300 px-4 py-2 rounded-lg transition-colors"><Upload size={15} /> 가져오기</button>
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
              className="absolute top-3 left-1/2 -translate-x-1/2 z-30 w-[min(560px,92%)] bg-white dark:bg-[#1c1c1e] rounded-xl shadow-2xl border border-gray-200 px-4 py-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-6 h-6 rounded-full bg-emerald-50 flex items-center justify-center"><Check size={14} className="text-emerald-600" /></div>
                <span className="text-[13px] font-semibold text-gray-800">공유 링크 생성됨 · 클립보드에 복사됨</span>
                <button onClick={() => setShareLink(null)} className="ml-auto text-gray-400 hover:text-gray-600"><X size={16} /></button>
              </div>
              <div className="flex items-center gap-1.5">
                <input readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} className="flex-1 min-w-0 px-2.5 py-1.5 bg-[#fafafc] dark:bg-[#242426] border border-gray-200 rounded-lg text-[12px] text-gray-600 outline-none font-mono" />
                <button onClick={() => { navigator.clipboard.writeText(shareLink).catch(() => {}); }} className="flex items-center gap-1 text-[12px] font-medium text-white bg-[#0071e3] hover:bg-[#0077ed] px-2.5 py-1.5 rounded-lg shrink-0"><Copy size={13} /> 복사</button>
              </div>
              <p className="text-[10px] text-gray-400 mt-2 leading-relaxed">받는 사람이 링크를 열면 어셋 파일이 다운로드됩니다 → element에서 <b>‘가져오기’</b>로 추가. · 링크는 <b>24시간</b> 유효(그 안엔 몇 번이든 다시 받기 가능)하며, 만료되면 서버에서 <b>자동 삭제</b>됩니다.</p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Drop result / refusal note — one line, dismissible, never blocks */}
        <AnimatePresence>
          {dropNote && (
            <motion.div key="drop-note" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.16 }}
              className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 bg-white dark:bg-[#1c1c1e] rounded-xl shadow-xl border border-gray-200 px-3.5 py-2">
              <span className="text-[12px] text-gray-700">{dropNote}</span>
              <button onClick={() => setDropNote('')} className="text-gray-400 hover:text-gray-600"><X size={14} /></button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Dropped-files intake (name from file, category asked) */}
        <AnimatePresence>
          {intake && selectedCollection && (
            <DropIntake
              files={intake}
              existing={collectionAssets}
              collectionName={selectedCollection.name}
              sendCap={sendCap}
              modelName={modelName}
              onCancel={() => setIntake(null)}
              onCommit={commitIntake}
            />
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
              sendCap={sendCap}
              modelName={modelName}
            />
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
