import { useState, useRef, useEffect, useLayoutEffect, useMemo, Fragment, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, MessageSquare, Trash2, Edit2, Search, Loader2, PanelLeftClose, PanelLeftOpen, Sparkles, BarChart3, FolderDown, FolderOpen, Folder, FolderPlus, ChevronRight, AlertTriangle, LayoutGrid, Upload, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore, groupTree, type Project, type ProjectGroup } from '../store';
import { cn, getBlobCacheStats, clearBlobCache } from '../lib/utils';
import { GlobalGallery } from './GlobalGallery';

// ─── Project icon ────────────────────────────────────────────────────────────
// Emoji are just characters — the OS font draws them (Apple emoji on macOS, Segoe UI
// Emoji on Windows), so "기본 이모티콘" costs literally nothing to ship and always
// matches the platform the user is on.
// Numbers and letters come from contiguous Unicode blocks, so they're generated rather
// than typed out — 56 characters of literal for nothing, and easy to typo.
const codeRange = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i));

const ICON_CATEGORIES: { id: string; label: string; items: string[] }[] = [
  { id: 'work', label: '작업', items: [
    '🎬','🎥','📹','📽️','🎞️','📷','📸','🎦','🍿','🎭','🎪','🎨','🖌️','🖍️','✏️','📝',
    '💡','✨','🔥','⭐','🌟','💫','⚡','🚀','🛠️','🔧','🔩','⚙️','🧪','🔬','🧲','🧰',
    '📦','🗂️','📁','📂','🗃️','📋','📌','📍','🏷️','🔖','🎯','✅','☑️','⏳','⌛','🕐',
  ]},
  { id: 'face', label: '표정', items: [
    '😀','😃','😄','😁','😆','🥹','😊','🙂','😉','😍','🥰','😘','😗','😋','😛','🤪',
    '🤨','🧐','🤓','😎','🥸','🤩','🥳','😏','😒','😞','😔','😟','😕','🙁','😣','😖',
    '😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰',
    '🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😴','🤤','😪','🤢','🤮','🤧',
  ]},
  { id: 'people', label: '사람', items: [
    '👋','🤚','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇',
    '👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🙏','✍️','💪','🦾','🦿','🦵',
    '👀','👁️','👂','👃','🧠','🫀','🦷','👤','👥','🗣️','👶','🧒','👦','👧','🧑','👨',
    '👩','🧓','👴','👵','🤴','👸','🦸','🦹','🧙','🧚','🧛','🧜','🧝','🧞','🧟','👻',
  ]},
  { id: 'animal', label: '동물', items: [
    '🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈',
    '🙉','🙊','🐔','🐧','🐦','🐤','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛',
    '🦋','🐌','🐞','🐜','🦗','🕷️','🦂','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞',
    '🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛',
    '🐪','🦒','🦘','🐃','🐄','🐎','🐖','🐏','🐑','🦙','🐐','🦌','🐕','🐩','🦮','🐈',
  ]},
  { id: 'nature', label: '자연', items: [
    '🌵','🎄','🌲','🌳','🌴','🪵','🌱','🌿','☘️','🍀','🎍','🎋','🍃','🍂','🍁','🍄',
    '🌾','💐','🌷','🌹','🥀','🌺','🌸','🌼','🌻','🌞','🌝','🌛','🌜','🌚','🌕','🌖',
    '🌗','🌘','🌑','🌒','🌓','🌔','🌙','🌎','🌍','🌏','🪐','💫','⭐','🌟','✨','⚡',
    '☄️','💥','🔥','🌪️','🌈','☀️','🌤️','⛅','🌥️','☁️','🌦️','🌧️','⛈️','🌩️','🌨️','❄️',
    '☃️','⛄','🌬️','💨','💧','💦','🌊','🌋','🏔️','⛰️','🏕️','🏝️','🏜️','🌅','🌄','🌇',
  ]},
  { id: 'food', label: '음식', items: [
    '🍏','🍎','🍐','🍊','🍋','🍌','🍉','🍇','🍓','🫐','🍈','🍒','🍑','🥭','🍍','🥥',
    '🥝','🍅','🍆','🥑','🥦','🥬','🥒','🌶️','🌽','🥕','🧄','🧅','🥔','🍠','🥐','🥯',
    '🍞','🥖','🧀','🥚','🍳','🧈','🥞','🧇','🥓','🍔','🍟','🍕','🌭','🥪','🌮','🌯',
    '🥙','🧆','🥘','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🥠','🍢',
    '🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍿','🧂','☕','🍵',
    '🧃','🥤','🍺','🍻','🥂','🍷','🥃','🍸','🍹','🍾',
  ]},
  { id: 'object', label: '사물', items: [
    '⌚','📱','💻','⌨️','🖥️','🖨️','🖱️','💽','💾','💿','📀','🧮','🎥','📞','☎️','📟',
    '📺','📻','🎙️','🎚️','🎛️','🧭','⏱️','⏲️','⏰','🕰️','🔋','🔌','💡','🔦','🕯️','🧯',
    '🛢️','💸','💵','💴','💶','💷','🪙','💰','💳','💎','⚖️','🪜','🧰','🪛','🔧','🔨',
    '⛏️','🪚','🔩','⚙️','🧱','⛓️','🧲','🔫','💣','🧨','🪓','🔪','🗡️','⚔️','🛡️','🚬',
    '⚰️','🪦','🏺','🔮','📿','🧿','💈','⚗️','🔭','🔬','🕳️','🩹','🩺','💊','💉','🩸',
    '🚪','🪑','🛏️','🛋️','🚽','🚿','🛁','🧴','🧷','🧹','🧺','🧻','🪣','🧼','🪥','🧽',
  ]},
  { id: 'symbol', label: '기호', items: [
    '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖',
    '💘','💝','☮️','✝️','☪️','🕉️','☸️','✡️','🔯','🕎','☯️','☦️','🛐','⛎','♈','♉',
    '♊','♋','♌','♍','♎','♏','♐','♑','♒','♓','🆔','⚛️','🉑','☢️','☣️','📴','📳','🈶',
    '🔰','⭕','✅','☑️','✔️','❌','❎','➰','➿','〽️','✳️','✴️','❇️','‼️','⁉️','❓','❔',
    '❕','❗','〰️','©️','®️','™️','🔺','🔻','🔸','🔹','🔶','🔷','🔳','🔲','▪️','▫️',
    '◾','◽','◼️','◻️','🟥','🟧','🟨','🟩','🟦','🟪','⬛','⬜','🟫','🔈','🔊','🔔',
  ]},
  { id: 'number', label: '숫자·문자', items: [
    ...Array.from({ length: 10 }, (_, i) => `${i}️⃣`),          // 0️⃣–9️⃣
    '🔟', '#️⃣', '*️⃣',
    ...codeRange(0x2460, 0x2473),                                          // ①–⑳
    ...codeRange(0x24B6, 0x24CF),                                          // Ⓐ–Ⓩ
    '🔠','🔡','🔢','🔣','🔤','🅰️','🅱️','🅾️','🅿️','ℹ️','Ⓜ️','🆎','🆑','🆒','🆓','🆕',
    '🆖','🆗','🆘','🆙','🆚','🔴','🟠','🟡','🟢','🔵','🟣','🟤','⚫','⚪',
  ]},
];

// Upload limits. These are enforced, not just advertised — this data URL is written into
// the persisted blob, which is re-serialized on every save, so an unbounded image here
// would tax every future write, not just this one.
const ICON_MAX_BYTES = 5 * 1024 * 1024; // 5MB — generous for a logo, cheap to decode
const ICON_MIN_PX = 48;                 // below this the 64px output is an upscale (blurry)
const ICON_OUT_PX = 64;                 // rendered at 16px, so 64 covers 4x displays
const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const ICON_SPEC = `PNG·JPG·WebP · 정사각 권장 · ${ICON_MIN_PX}px 이상 · 5MB 이하`;

// Downscale an uploaded image to a 64px square PNG data URL.
// Center-crop rather than letterbox: the slot is square, and fitting a wide logo into it
// would shrink the logo to an unreadable band.
function fileToIconDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('이미지 파일이 아닙니다'));
    if (file.size > ICON_MAX_BYTES) {
      return reject(new Error(`파일이 너무 큽니다 (${(file.size / 1048576).toFixed(1)}MB · 최대 5MB)`));
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const side = Math.min(img.width, img.height);
      if (side < ICON_MIN_PX) {
        return reject(new Error(`너무 작습니다 (${img.width}×${img.height} · 짧은 변 ${ICON_MIN_PX}px 이상)`));
      }
      const canvas = document.createElement('canvas');
      canvas.width = ICON_OUT_PX; canvas.height = ICON_OUT_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('canvas 사용 불가'));
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, ICON_OUT_PX, ICON_OUT_PX);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('이미지를 읽을 수 없습니다 (손상되었거나 지원하지 않는 형식)')); };
    img.src = url;
  });
}

// The icon itself: uploaded PNG › emoji › default chat glyph.
// ★ All three variants MUST sit in one identical box or the column zig-zags — they are
// three different layout species: <img> is a replaced block, an emoji is inline TEXT
// (baseline-positioned, and its glyph advance is wider than the font-size), and a lucide
// <svg> is a third thing again. Sizing each one separately can't line them up.
// So: one fixed flex-centred square, and whatever goes inside centres within it.
function ProjectIcon({ icon, size = 16 }: { icon?: string; size?: number }) {
  return (
    // No overflow-hidden: an emoji glyph measures ~19px in this 16px box (its advance
    // exceeds the em), and clipping it would shave the edges off wide emoji. Overflow is
    // symmetric so the CENTRES still line up — which is what makes the column look straight —
    // and ~1.5px of bleed is well inside the 8px gap to the project name.
    <span className="inline-flex items-center justify-center shrink-0 leading-none"
      style={{ width: size, height: size }}>
      {icon?.startsWith('data:')
        ? <img src={icon} alt="" className="w-full h-full rounded-[4px] object-cover" />
        : icon
          // 0.86× because an emoji glyph overshoots its em box; at 1× it visually
          // outgrows the 16px column that the svg/img variants respect.
          ? <span className="leading-none" style={{ fontSize: Math.round(size * 0.86) }}>{icon}</span>
          : <MessageSquare size={size} className="opacity-70" />}
    </span>
  );
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
  // Open on the tab that already holds the current icon, so re-picking doesn't start
  // you on a page that doesn't contain what you chose last time.
  // '커스텀' is a tab like any other — uploading a PNG is just another way to pick an
  // icon, so it belongs beside the emoji pages rather than as a permanent footer that
  // steals height from every category.
  const CUSTOM = 'custom';
  const [tab, setTab] = useState(() =>
    current?.startsWith('data:') ? CUSTOM
      : ICON_CATEGORIES.find(c => current && c.items.includes(current))?.id ?? ICON_CATEGORIES[0].id);
  const items = ICON_CATEGORIES.find(c => c.id === tab)?.items ?? [];
  // PANEL_H is now only a HINT for which side of the row to prefer. Being on screen is
  // guaranteed by useClampToViewport from the real measured box, so this drifting out of
  // step with the contents can no longer put the panel where it cannot be seen.
  const PANEL_W = 300, PANEL_H = 330;
  const boxRef = useRef<HTMLDivElement>(null);
  const { left, top } = useClampToViewport(
    boxRef,
    anchor.left,
    anchor.bottom + PANEL_H > window.innerHeight ? anchor.top - PANEL_H - 6 : anchor.bottom + 6,
    tab,
  );

  return createPortal(
    <div className="fixed inset-0 z-[110]" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.12, ease: 'easeOut' }}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        style={{ left, top, width: PANEL_W }}
        className="absolute bg-white rounded-xl shadow-2xl border border-gray-200 p-2.5 text-gray-900"
      >
        {/* Category tabs. A single flat grid of ~600 glyphs is a scroll-hunt; tabs keep
            any one page to a couple of screenfuls. */}
        <div className="flex gap-0.5 mb-1.5 overflow-x-auto pb-0.5 -mx-0.5 px-0.5">
          {[...ICON_CATEGORIES.map(c => ({ id: c.id, label: c.label })), { id: CUSTOM, label: '커스텀' }].map(c => (
            <button key={c.id} onClick={() => { setTab(c.id); setErr(null); }}
              className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors ${
                tab === c.id ? 'bg-indigo-500 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
              {c.label}
            </button>
          ))}
        </div>
        {tab === CUSTOM ? (
          <div className="h-[168px] flex flex-col items-center justify-center gap-2.5 px-2">
            {current?.startsWith('data:') && (
              <img src={current} alt="" className="w-14 h-14 rounded-lg object-cover border border-gray-200" />
            )}
            <label className="flex items-center justify-center gap-1.5 px-3 py-2 text-[12px] font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-lg cursor-pointer transition-colors">
              <Upload size={13} /> {current?.startsWith('data:') ? '다른 이미지로 교체' : '이미지 업로드'}
              <input type="file" accept={ICON_ACCEPT} className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0]; e.target.value = '';
                  if (!f) return;
                  setErr(null);
                  try { onPick(await fileToIconDataUrl(f)); onClose(); }
                  catch (x: any) { setErr(x?.message || '변환 실패'); }
                }} />
            </label>
            {/* State the spec where the upload is, and say what happens to the file
                (crop + downscale) — otherwise a rejected upload reads as a bug. */}
            <p className={`text-[10px] leading-snug text-center ${err ? 'text-red-500' : 'text-gray-400'}`}>
              {err || `${ICON_SPEC}\n가운데를 정사각으로 잘라 ${ICON_OUT_PX}px로 저장합니다`}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-8 gap-0.5 h-[168px] overflow-y-auto content-start">
            {items.map(e => (
              <button key={e} onClick={() => { onPick(e); onClose(); }} title={e}
                className={`h-[32px] rounded-md text-[18px] leading-none transition-colors ${current === e ? 'bg-indigo-100 ring-1 ring-indigo-300' : 'hover:bg-gray-100'}`}>
                {e}
              </button>
            ))}
          </div>
        )}
        <div className="mt-2 pt-2 border-t border-gray-100">
          <button onClick={() => { onPick(undefined); onClose(); }}
            className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11.5px] font-medium text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors">
            <RotateCcw size={12} /> 기본 아이콘으로
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

// Put a portalled popup where it was asked to go, then CORRECT it once the browser has
// actually laid it out.
// Every popup here used to position itself against a hard-coded height constant, and a
// constant is a promise to update it whenever the contents change — a promise nobody keeps.
// Measured after adding subgroup indentation to the project menu: the constant said 356px,
// the real panel was 367px, and it hung 3px off the bottom of the screen. The estimate is
// now only a hint for the nicer of two placements; THIS is what guarantees it is on screen.
// useLayoutEffect, not useEffect: the correction lands before paint, so nothing jumps.
function useClampToViewport(ref: RefObject<HTMLElement | null>, wantLeft: number, wantTop: number, dep?: unknown) {
  const [pos, setPos] = useState({ left: wantLeft, top: wantTop });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // ★ offsetWidth/offsetHeight, NOT getBoundingClientRect(). These popups mount with a
    // scale-up entrance animation, and getBoundingClientRect reports the TRANSFORMED box —
    // at scale 0.97 a 367px panel measures 356px, and the clamp politely leaves it 3px off
    // the bottom of the screen. Measured exactly that. offset* are layout metrics and
    // ignore transforms, so they give the size the panel will actually settle at.
    const w = el.offsetWidth, h = el.offsetHeight;
    const left = Math.max(8, Math.min(wantLeft, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(wantTop, window.innerHeight - h - 8));
    setPos(p => (p.left === left && p.top === top ? p : { left, top }));
  }, [ref, wantLeft, wantTop, dep]);
  return pos;
}

// Right-click menu for a project row. Portaled and pinned to the cursor, with the same
// edge-flip as the icon picker so it never opens off-screen.
// Exists because drag-and-drop is the wrong and only way to file a project when the list
// is long: dragging across a scrolling sidebar to reach a folder is fiddly, and there was
// no way at all to make a folder *around* the project you're looking at.
function ProjectMenu({ at, project, groups, onPick, onNewGroup, onClose }: {
  at: { x: number; y: number };
  project: Project;
  // Already in tree order (parent, then its children) — the menu is a flat list of
  // buttons, so the order and the indent are the only things carrying the hierarchy.
  groups: ProjectGroup[];
  onPick: (groupId: string | undefined) => void;
  onNewGroup: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const searchable = groups.length > 7;   // same threshold as the gallery filters
  const shown = q.trim() ? groups.filter(g => g.name.toLowerCase().includes(q.trim().toLowerCase())) : groups;
  const W = 220;
  const LIST_MAX = 190;
  // No height estimate any more. The menu opens at the cursor and useClampToViewport pulls
  // it back on screen from the real measured box — including after the search box filters
  // the list and the panel shrinks.
  const boxRef = useRef<HTMLDivElement>(null);
  const { left, top } = useClampToViewport(boxRef, at.x, at.y, shown.length);
  return createPortal(
    <div className="fixed inset-0 z-[115]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.1, ease: 'easeOut' }}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
        style={{ left, top, width: W }}
        className="absolute bg-white rounded-xl shadow-2xl border border-gray-200 py-1 text-gray-900 overflow-hidden"
      >
        <div className="px-3 py-1.5 text-[11px] text-gray-400 truncate border-b border-gray-100">{project.name}</div>
        <button onClick={() => { onNewGroup(); onClose(); }}
          className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-100 transition-colors">
          <FolderPlus size={13} className="shrink-0 text-indigo-500" />
          이 프로젝트로 새 그룹 만들기
        </button>
        <div className="border-t border-gray-100 my-1" />
        <div className="px-3 pb-1 text-[10px] text-gray-400">그룹으로 이동</div>
        {searchable && (
          <div className="px-2 pb-1">
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="그룹 검색…"
              onClick={(e) => e.stopPropagation()}
              className="w-full px-2 py-1 text-[12px] bg-gray-100 rounded-md outline-none placeholder-gray-400" />
          </div>
        )}
        {/* Capped + scrollable: the group list is unbounded, and a menu that grows with it
            runs off the bottom of the screen the moment you have a dozen folders. */}
        <div className="overflow-y-auto" style={{ maxHeight: LIST_MAX }}>
          {groups.length === 0 && <div className="px-3 py-1.5 text-[12px] text-gray-300">만들어진 그룹이 없습니다</div>}
          {groups.length > 0 && shown.length === 0 && <div className="px-3 py-1.5 text-[12px] text-gray-300">일치하는 그룹 없음</div>}
          {shown.map(g => (
            <button key={g.id} onClick={() => { onPick(g.id); onClose(); }} disabled={project.groupId === g.id}
              // Subfolders are indented rather than prefixed with their parent's name:
              // a name that doesn't appear in the sidebar would be a second thing to read.
              style={{ paddingLeft: g.parentId ? 26 : 12 }}
              className={`w-full flex items-center gap-2 pr-3 py-1.5 text-[12.5px] text-left transition-colors ${
                project.groupId === g.id ? 'text-indigo-600 font-medium bg-indigo-50/60 cursor-default' : 'text-gray-700 hover:bg-gray-100'}`}>
              <Folder size={13} className={`shrink-0 ${g.parentId ? 'opacity-35' : 'opacity-60'}`} />
              <span className="truncate flex-1">{g.name}</span>
              {project.groupId === g.id && <span className="shrink-0 text-[10px]">현재</span>}
            </button>
          ))}
        </div>
        {project.groupId && (
          <>
            <div className="border-t border-gray-100 my-1" />
            <button onClick={() => { onPick(undefined); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-gray-700 hover:bg-gray-100 transition-colors">
              <RotateCcw size={13} className="shrink-0 opacity-60" />
              그룹에서 빼기
            </button>
          </>
        )}
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
  const { projects, currentProjectId, setCurrentProjectId, createProject, deleteProject, renameProject, setProjectIcon,
    projectGroups, createProjectGroup, renameProjectGroup, deleteProjectGroup, deleteProjectGroupWithProjects, toggleProjectGroup, setProjectGroup, setGroupParent, moveProjectBefore, moveProjectToEnd, moveGroupBefore, moveGroupToEnd,
    autoDownload, setAutoDownload } = useAppStore();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  const groupInputRef = useRef<HTMLInputElement>(null);
  // A folder-name click waiting to see whether it becomes a double-click. See the name span.
  const pendingToggle = useRef<number | null>(null);
  // ── Drag & drop ──────────────────────────────────────────────────────────
  // The drop point is decided from the POINTER'S Y against a snapshot of the list taken at
  // dragstart — never from whichever element is under the cursor. That distinction is the
  // whole design. Element hit-testing feeds back on itself: opening a gap under the cursor
  // pushes everything below down, a different element lands under the pointer, that picks
  // a different slot, the gap moves… at any boundary the list shakes violently.
  // A snapshot can't feed back — rows don't move during a drag, only the gap does, so
  // positions captured before the gap existed stay true for the whole drag.
  const [dragKind, setDragKind] = useState<'project' | 'group' | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // `into` marks the Windows-style "drop ONTO this folder" target — aiming at a folder's
  // header row rather than at a position between rows. Same store call as the tail strip
  // (land last inside it), but it has to be a distinct plan so the two can look different:
  // the folder LIGHTS UP instead of a strip opening somewhere below it. Without that, a
  // folder holding subfolders gave you no way to tell which one you were about to drop in.
  const [plan, setPlan] = useState<{ beforeId: string | null; groupId?: string; into?: boolean } | null>(null);
  const [groupPlan, setGroupPlan] = useState<{ beforeId: string | null; parentId?: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const snapRef = useRef<{
    slots: { y: number; beforeId: string | null; groupId?: string; into?: boolean }[];
    groupSlots: { y: number; beforeId: string | null; parentId?: string }[];
    scrollTop: number;
  } | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pendingGroupDelete, setPendingGroupDelete] = useState<{ id: string; name: string; count: number; subCount: number } | null>(null);
  // ── Why dropTarget is set through these two helpers ──────────────────────────
  // HTML5 drag fires dragleave every time the pointer crosses into a CHILD of the row
  // (icon button, name span, action buttons). Clearing on each of those made the
  // insertion line strobe on and off while the cursor sat still over one row.
  // So: a leave only *schedules* the clear, and the next dragover cancels it. The line
  // then only disappears when the pointer has genuinely been off every target for a
  // moment — which is also what makes moving between rows read as the line sliding.
  // Every place something could land, measured once, before any gap exists.
  const takeSnapshot = () => {
    const list = listRef.current;
    if (!list) return;
    const slots: { y: number; beforeId: string | null; groupId?: string; into?: boolean }[] = [];
    const groupSlots: { y: number; beforeId: string | null; parentId?: string }[] = [];
    list.querySelectorAll<HTMLElement>('[data-row-id]').forEach(el =>
      slots.push({ y: el.getBoundingClientRect().top, beforeId: el.dataset.rowId!, groupId: el.dataset.rowGroup || undefined }));
    list.querySelectorAll<HTMLElement>('[data-section-end]').forEach(el =>
      slots.push({ y: el.getBoundingClientRect().top, beforeId: null, groupId: el.dataset.sectionEnd || undefined }));
    // The folder header itself is a drop target — "put it in here", the way a folder in
    // Explorer highlights when you hover it. Before this, aiming at a folder's header
    // snapped to the first row of whatever was inside it (measured: hovering 광고 aimed
    // at a row inside its subfolder 1차), so you could not tell the two apart.
    list.querySelectorAll<HTMLElement>('[data-into-group]').forEach(el =>
      slots.push({ y: el.getBoundingClientRect().top, beforeId: null, groupId: el.dataset.intoGroup!, into: true }));
    // Folder slots carry the parent they'd file into, exactly like project slots carry
    // their group. Subfolder headers are in here too, so folders reorder within a parent.
    list.querySelectorAll<HTMLElement>('[data-group-id]').forEach(el =>
      groupSlots.push({ y: el.getBoundingClientRect().top, beforeId: el.dataset.groupId!, parentId: el.dataset.groupParent || undefined }));
    // One tail per parent plus the global one — querySelectorAll, not querySelector: the
    // single-element version only ever found the top-level tail, so "last child of this
    // folder" would have been unreachable.
    list.querySelectorAll<HTMLElement>('[data-group-end]').forEach(el =>
      groupSlots.push({ y: el.getBoundingClientRect().top, beforeId: null, parentId: el.dataset.groupEnd || undefined }));
    slots.sort((a, b) => a.y - b.y);
    groupSlots.sort((a, b) => a.y - b.y);
    snapRef.current = { slots, groupSlots, scrollTop: list.scrollTop };
  };

  // What is being dragged, as a ref — the snapshot has to be re-taken from a dragover
  // handler, which closes over stale state.
  const dragRef = useRef<{ kind: 'project' | 'group'; id: string } | null>(null);
  const snapFresh = useRef(false);

  const captureSlots = () => {
    takeSnapshot();
    // A folder that has folders in it can only move at the top level (one level, hard).
    // Drop those targets from the snapshot rather than rejecting the drop at the end:
    // an illegal slot that still lights up promises a move that then doesn't happen, and
    // the user has no way to know why. Deleted from the snapshot, it simply never aims
    // there — the nearest LEGAL slot wins instead.
    const d = dragRef.current;
    if (d?.kind === 'group' && projectGroups.some(x => x.parentId === d.id) && snapRef.current) {
      snapRef.current.groupSlots = snapRef.current.groupSlots.filter(s => !s.parentId);
    }
  };

  const beginDrag = (kind: 'project' | 'group', id: string) => {
    setDragKind(kind); setDragId(id);
    dragRef.current = { kind, id };
    // ★ This snapshot is taken BEFORE React has re-rendered — setDragId above is async.
    // If anything in the list changes size in response to a drag starting, every measured
    // position below it is wrong by that much for the rest of the drag.
    // It happened: empty groups showed a "비어 있음" hint that unmounted on `!dragId`, so
    // two empty folders moved every row below them up by 65px (measured) — about 1.7 rows.
    // You aim at one row, the app aims at another, and dropping "does nothing".
    // Fixed at the source (the hint no longer unmounts), and again here: the first
    // pointermove re-measures, by which time the render has committed. Belt and braces,
    // because the next person to add a drag-conditional element won't know about this.
    snapFresh.current = false;
    captureSlots();
  };

  // Nearest slot to the pointer, corrected for scrolling since the snapshot.
  const planFor = (clientY: number) => {
    const snap = snapRef.current, list = listRef.current;
    if (!snap || !list) return;
    const y = clientY + (list.scrollTop - snap.scrollTop);
    const nearest = (arr: { y: number }[]) => {
      let best = -1, bestD = Infinity;
      arr.forEach((sl, i) => { const d = Math.abs(sl.y - y); if (d < bestD) { bestD = d; best = i; } });
      return best;
    };
    if (dragKind === 'group') {
      const i = nearest(snap.groupSlots);
      const g = i < 0 ? null : snap.groupSlots[i];
      setGroupPlan(prev => (prev && g && prev.beforeId === g.beforeId && prev.parentId === g.parentId
        ? prev : (g ? { beforeId: g.beforeId, parentId: g.parentId } : null)));
    } else {
      const i = nearest(snap.slots);
      const sl = i < 0 ? null : snap.slots[i];
      setPlan(prev => (prev && sl && prev.beforeId === sl.beforeId && prev.groupId === sl.groupId && !!prev.into === !!sl.into
        ? prev : (sl ? { beforeId: sl.beforeId, groupId: sl.groupId, into: sl.into } : null)));
    }
  };

  const applyDrop = () => {
    if (dragId) {
      if (dragKind === 'group' && groupPlan) {
        if (groupPlan.beforeId) moveGroupBefore(dragId, groupPlan.beforeId);
        else moveGroupToEnd(dragId, groupPlan.parentId);
      } else if (dragKind === 'project' && plan) {
        if (plan.beforeId && plan.beforeId !== dragId) moveProjectBefore(dragId, plan.beforeId);
        else if (!plan.beforeId) moveProjectToEnd(dragId, plan.groupId);
      }
    }
    endDrag();
  };
  // ── No dragleave anywhere in the list. This is the whole fix for the stutter. ──
  // dragover REPLACES the aim; drop and dragend CLEAR it. Nothing else touches it.
  // Two earlier attempts failed for the same underlying reason — dragleave fires
  // constantly mid-list as the pointer crosses child elements:
  //   · "schedule a clear in 70ms, cancel it on the next dragover" lost that race
  //     constantly, so the gap closed and reopened — the 벅벅 stutter.
  //   · "only clear if relatedTarget is outside the list" doesn't work either: during a
  //     drag, dragleave's relatedTarget is null in Chromium far more often than not, so
  //     every child crossing read as leaving and wiped the aim (measured: the gap never
  //     opened at all).
  // Leaving the sidebar mid-drag now leaves the last gap open until release. That is the
  // correct trade: it still shows where the drop would land, and dragend tidies it up.
  // ── Edge auto-scroll ─────────────────────────────────────────────────────────
  // Without this a folder cannot be moved past the bottom of the visible list by dragging
  // alone. The wheel works too (see the wheel listener below) — these cover different
  // habits: the wheel for crossing a long list deliberately, the edge for the reflex of
  // just pushing the thing downwards and expecting the list to follow.
  // The loop also re-runs planFor with the last pointer position, so the target keeps
  // updating while the list slides under a stationary cursor. Safe with the snapshot
  // design because planFor already corrects for (scrollTop - snapshot scrollTop).
  const autoScroll = useRef<{ raf: number; vy: number; y: number } | null>(null);
  const stopAutoScroll = () => {
    if (autoScroll.current) cancelAnimationFrame(autoScroll.current.raf);
    autoScroll.current = null;
  };
  const tickAutoScroll = () => {
    const st = autoScroll.current, list = listRef.current;
    if (!st || !list) return;
    const max = list.scrollHeight - list.clientHeight;
    const next = Math.max(0, Math.min(max, list.scrollTop + st.vy));
    // ★ 'instant', and it is load-bearing. index.css sets `scroll-behavior: smooth` on
    // <html>; the list inherits it, so a plain `list.scrollTop = x` starts an ANIMATION
    // and reads back the OLD value immediately afterwards.
    // That killed the first version of this loop: it compared before/after to detect the
    // end, saw "no change" on frame 1, and shut itself down after ~15px — the list nudged
    // once and then sat there. Measured: five `scrollTop += 15` in a row all read back
    // 15.333. A per-frame step must not animate, and the end must be detected from the
    // bounds rather than from a read-back.
    list.scrollTo({ top: next, behavior: 'instant' });
    planFor(st.y);
    if (next === 0 || next === max) { stopAutoScroll(); return; }
    st.raf = requestAnimationFrame(tickAutoScroll);
  };
  const updateAutoScroll = (clientY: number) => {
    const list = listRef.current;
    if (!list) return;
    const r = list.getBoundingClientRect();
    const EDGE = 56;              // deep enough to hit without aiming, shallow enough to sit still mid-list
    const MAX = 18;               // px per frame at the very edge
    let vy = 0;
    if (clientY < r.top + EDGE) vy = -Math.ceil(MAX * Math.min(1, (r.top + EDGE - clientY) / EDGE));
    else if (clientY > r.bottom - EDGE) vy = Math.ceil(MAX * Math.min(1, (clientY - (r.bottom - EDGE)) / EDGE));
    if (!vy) { stopAutoScroll(); return; }
    if (autoScroll.current) { autoScroll.current.vy = vy; autoScroll.current.y = clientY; return; }
    autoScroll.current = { vy, y: clientY, raf: requestAnimationFrame(tickAutoScroll) };
  };

  const endDrag = () => {
    stopAutoScroll();
    setDragKind(null); setDragId(null); setPlan(null); setGroupPlan(null);
    snapRef.current = null; dragRef.current = null; snapFresh.current = false;
  };

  // ── Why this is a POINTER drag and not HTML5 drag-and-drop ──────────────────
  // Native DnD hands the mouse to the operating system's drag loop for the duration, and
  // that loop keeps the wheel. Measured on a real drag: 333 dragover events reached the
  // page and 0 wheel events did — no listener can fix that, because nothing is dispatched.
  // (An earlier attempt "verified" a wheel handler by calling dispatchEvent on it, which
  // only proved the handler runs when called. It never ran in real use.)
  // Pointer events keep the whole gesture inside the page, so the wheel, Escape and
  // everything else behave normally. The OS drag image goes away with it, so we draw our
  // own (see the ghost below) — which is better anyway: it can show the real icon and name.
  // All the planning below is untouched — it was always driven by a clientY and an id.
  const pendingDrag = useRef<{ kind: 'project' | 'group'; id: string; x: number; y: number } | null>(null);
  const justDragged = useRef(false);
  const lastPt = useRef<{ x: number; y: number } | null>(null);

  // The thing under the cursor while you drag. Moved by writing `transform` straight onto
  // the node — putting the pointer position in state would re-render the whole sidebar
  // sixty times a second to move one small box.
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const placeGhost = (x: number, y: number) => {
    const g = ghostRef.current;
    if (g) g.style.transform = `translate3d(${x + 14}px, ${y + 10}px, 0)`;
  };
  // Callback ref, not useEffect: this runs before paint, so the ghost never flashes at the
  // top-left corner on the frame it mounts.
  const attachGhost = (el: HTMLDivElement | null) => {
    ghostRef.current = el;
    if (el && lastPt.current) placeGhost(lastPt.current.x, lastPt.current.y);
  };

  // Press: only ARM. A drag starts on the first few pixels of movement, so an ordinary
  // click still selects a project and a folder still folds.
  const armDrag = (kind: 'project' | 'group', id: string, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // Buttons inside the row (icon, rename, delete, add-subfolder) are their own gestures.
    if ((e.target as HTMLElement).closest('button')) return;
    if (kind === 'project' && (editingId === id || searchQuery.trim())) return;
    if (kind === 'group' && editingGroupId === id) return;
    pendingDrag.current = { kind, id, x: e.clientX, y: e.clientY };
    lastPt.current = { x: e.clientX, y: e.clientY };
  };

  // The live handlers, refreshed every render so the window listeners below can stay bound
  // once and still see current state. Re-binding them on every render would mean adding and
  // removing listeners ~60 times a second mid-drag.
  const dragHandlers = useRef({ move: (_e: PointerEvent) => {}, up: () => {}, key: (_e: KeyboardEvent) => {} });
  dragHandlers.current = {
    move: (e: PointerEvent) => {
      const p = pendingDrag.current;
      if (p && !dragRef.current) {
        // 5px of slop: hands are not perfectly still on a click.
        if (Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) < 5) return;
        beginDrag(p.kind, p.id);
      }
      lastPt.current = { x: e.clientX, y: e.clientY };
      if (!dragRef.current) return;
      e.preventDefault();                       // no text selection while dragging
      placeGhost(e.clientX, e.clientY);
      if (!snapFresh.current) { snapFresh.current = true; captureSlots(); }
      updateAutoScroll(e.clientY);
      planFor(e.clientY);
    },
    up: () => {
      const wasDragging = !!dragRef.current;
      pendingDrag.current = null;
      if (!wasDragging) return;
      // Swallow the click that follows, or letting go on top of a row would also select it.
      justDragged.current = true;
      setTimeout(() => { justDragged.current = false; }, 0);
      applyDrop();
    },
    key: (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      pendingDrag.current = null;
      if (dragRef.current) { e.preventDefault(); endDrag(); }   // drop nothing, put it back
    },
  };
  useEffect(() => {
    const m = (e: PointerEvent) => dragHandlers.current.move(e);
    const u = () => dragHandlers.current.up();
    const k = (e: KeyboardEvent) => dragHandlers.current.key(e);
    window.addEventListener('pointermove', m);
    window.addEventListener('pointerup', u);
    window.addEventListener('pointercancel', u);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('pointermove', m);
      window.removeEventListener('pointerup', u);
      window.removeEventListener('pointercancel', u);
      window.removeEventListener('keydown', k);
    };
  }, []);

  // Keep the gap in step with the list while it scrolls under a stationary cursor.
  // ★ We deliberately do NOT touch the wheel any more. The first version preventDefault'ed
  // it and jumped the list by deltaY per notch, which is exactly what "픽셀 단위로 움직인다"
  // describes — Chromium animates a wheel scroll, and replacing that with a hard jump throws
  // the animation away. Letting the browser scroll natively gives back the same smoothness
  // as everywhere else in the app; all this has to do is re-aim afterwards.
  // Covers the auto-scroll loop too, since that also produces scroll events.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !dragId) return;
    const onScroll = () => { if (lastPt.current) planFor(lastPt.current.y); };
    list.addEventListener('scroll', onScroll, { passive: true });
    return () => list.removeEventListener('scroll', onScroll);
  }, [dragId, dragKind]);
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

  // Same for a group name. autoFocus alone only puts the caret somewhere in the existing
  // text, so renaming meant selecting it by hand first — while the project rename right
  // next to it hands you a selection you can type straight over. Two controls that look
  // identical have to behave identically.
  // Harmless on the create path (the name starts empty, so there is nothing to select).
  useEffect(() => {
    if (editingGroupId && groupInputRef.current) {
      groupInputRef.current.focus();
      groupInputRef.current.select();
    }
  }, [editingGroupId]);

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

  // A project whose groupId points at a group that no longer exists counts as ungrouped.
  // Without that fallback a stale id would make the project invisible — present in the
  // data, absent from every list, and unreachable.
  const ungroupedProjects = useMemo(() => {
    const live = new Set(projectGroups.map(g => g.id));
    return projects.filter(p => !p.groupId || !live.has(p.groupId));
  }, [projects, projectGroups]);

  // ── Folders, one level deep ───────────────────────────────────────────────────
  // The tree is DERIVED at render time rather than trusted from the data — see
  // groupTree() in the store. Anything malformed surfaces at the top level instead of
  // vanishing, and every group renders exactly once.
  const tree = useMemo(() => groupTree(projectGroups), [projectGroups]);
  // Tree order (parent, then its children) for the right-click menu, which has no
  // indentation of its own to fall back on.
  const orderedGroups = useMemo(
    () => tree.roots.flatMap(r => [r, ...tree.childrenOf(r.id)]),
    [tree]);

  // ── Would this drop actually move anything? ─────────────────────────────────
  // An indicator that promises a move and then does nothing is worse than no indicator:
  // you let go, the list sits still, and you conclude the drag is broken. The commonest
  // case is dropping something next to itself — the gap opening directly above the very
  // row being dragged, which can only ever be a no-op.
  // Judged in VISUAL order, not array order. Two projects can be array-neighbours without
  // being screen-neighbours (another folder's project sits between them), and the reverse;
  // what the user is promised is what they can see, so that is what gets checked.
  const liveGroupOf = (gid?: string) => (gid && projectGroups.some(g => g.id === gid) ? gid : undefined);

  const projectDropIsNoop = (p: { beforeId: string | null; groupId?: string }, id: string): boolean => {
    const me = projects.find(x => x.id === id);
    if (!me) return true;
    const myG = liveGroupOf(me.groupId);
    const seq = projects.filter(x => liveGroupOf(x.groupId) === myG); // array order == on-screen order within a container
    const i = seq.findIndex(x => x.id === id);
    if (p.beforeId) {
      if (p.beforeId === id) return true;                       // onto itself
      const t = projects.find(x => x.id === p.beforeId);
      if (!t) return true;
      if (liveGroupOf(t.groupId) !== myG) return false;         // changes folder → real move
      return seq[i + 1]?.id === p.beforeId;                     // already sitting right before it
    }
    if (p.groupId !== myG) return false;                        // into a different folder → real move
    return seq.length > 0 && seq[seq.length - 1].id === id;     // already last in this folder
  };

  const groupDropIsNoop = (gp: { beforeId: string | null; parentId?: string }, id: string): boolean => {
    const me = projectGroups.find(g => g.id === id);
    if (!me) return true;
    const myParent = tree.isSub(me) ? me.parentId : undefined;
    const seq = myParent ? tree.childrenOf(myParent) : tree.roots;
    const i = seq.findIndex(g => g.id === id);
    if (gp.beforeId) {
      if (gp.beforeId === id) return true;
      const t = projectGroups.find(g => g.id === gp.beforeId);
      if (!t) return true;
      const tParent = tree.isSub(t) ? t.parentId : undefined;
      if (tParent !== myParent) return false;
      return seq[i + 1]?.id === gp.beforeId;
    }
    if (gp.parentId !== myParent) return false;
    return seq.length > 0 && seq[seq.length - 1].id === id;
  };

  // The live plans, blanked out when they would achieve nothing. Everything that draws an
  // indicator reads THESE, so there is one place where "this drop is real" is decided.
  const livePlan = dragId && dragKind === 'project' && plan && !projectDropIsNoop(plan, dragId) ? plan : null;
  const liveGroupPlan = dragId && dragKind === 'group' && groupPlan && !groupDropIsNoop(groupPlan, dragId) ? groupPlan : null;

  // The strip at the end of a section. Only exists while something is being dragged —
  // it's an affordance, not furniture. It also fills a real gap: dropping on a row inserts
  // BEFORE that row, so without this there is no way to reach the last slot of a list.
  // ★ A plain function, NOT a component used as <TailDrop/>.
  // Declared inside Sidebar, it would be a NEW component type on every render, so React
  // would unmount and remount it each time — the DOM node is replaced, which resets the
  // CSS transition mid-flight and makes it pop instead of animate. Calling it inlines the
  // JSX into this render, so the same element persists and the transition can run.
  const renderTailDrop = (groupId: string | undefined, label: string) => {
    // Always rendered (zero height when idle) so the snapshot can measure this slot.
    const on = !!livePlan && livePlan.beforeId === null && livePlan.groupId === groupId && !livePlan.into;
    return (
      <div
        data-section-end={groupId ?? ''}
        className={cn(
          'mx-1 rounded-[7px] border border-dashed flex items-center justify-center text-[10px] overflow-hidden',
          'transition-[height,margin,border-color,color] duration-150 ease-out',
          on ? 'h-[26px]' : 'h-0',
          on ? 'border-[#0071e3] bg-[#0071e3]/15 text-[#4da3ff] mt-1' : 'border-transparent text-transparent'
        )}
      >
        {label}
      </div>
    );
  };

  // "광고" or "광고 › 1차" — where a project actually lives. Empty at the top level:
  // that is the default, and labelling it would be noise on every ungrouped row.
  const groupPathOf = (project: Project): string => {
    const g = project.groupId ? projectGroups.find(x => x.id === project.groupId) : undefined;
    if (!g) return '';
    const parent = g.parentId ? projectGroups.find(x => x.id === g.parentId) : undefined;
    // Only a real one-level parent counts — same rule groupTree applies when drawing.
    return parent && !parent.parentId ? `${parent.name} › ${g.name}` : g.name;
  };

  // One project row. Extracted so the grouped list and the flat/search list render the
  // exact same thing — two copies of 60 lines of row markup would drift within a week.
  // A row, preceded by the gap that opens where it would land.
  // ★ The gap is itself a drop target aiming at the SAME key as its row. Without that the
  // list oscillates: opening the gap pushes the row down, the cursor ends up over the gap
  // rather than the row, the aim clears, the gap closes, the row slides back under the
  // cursor, and it opens again — forever.
  const renderProjectRow = (project: Project) => {
    const aimed = !!livePlan && livePlan.beforeId === project.id;
    const dragging = dragId ? projects.find(p => p.id === dragId) : null;
    return (
      <Fragment key={project.id}>
        <div
          // No drag handlers here (nor on the row). The container owns all of them —
          // see the note on the drag state.
          // Height, not opacity — the point is that the list physically makes room.
          className={cn('overflow-hidden transition-[height] duration-150 ease-out', aimed ? 'h-[38px]' : 'h-0')}
        >
          <div className="h-[34px] flex items-center gap-2 px-3 rounded-[8px] border border-dashed border-[#0071e3]/70 bg-[#0071e3]/10">
            <ProjectIcon icon={dragging?.icon} size={14} />
            <span className="truncate text-[12px] text-[#4da3ff]">{dragging ? `${dragging.name} 여기로` : '여기로'}</span>
          </div>
        </div>
            <div
              data-row-id={project.id}
              data-row-group={project.groupId || ''}
              // No dragging while a search is active. The list is flat then — groups
              // aren't drawn — so a drop would silently re-file the project into a group
              // the user can't even see. Moving things is a decision about a place; don't
              // allow it while the places are hidden.
              onPointerDown={(e) => armDrag('project', project.id, e)}
              className={cn(
                "group flex items-center justify-between px-3 py-2 rounded-[8px] cursor-pointer transition-colors",
                dragId === project.id && "opacity-40",
                currentProjectId === project.id ? "bg-[#2a2a2d] text-white" : "text-white/70 hover:bg-[#2a2a2d]/50 hover:text-white"
              )}
              onClick={() => { if (justDragged.current) return; if (editingId !== project.id) setCurrentProjectId(project.id); }}
              onDoubleClick={() => { setEditingId(project.id); setEditName(project.name); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setMenu({ id: project.id, x: e.clientX, y: e.clientY }); }}
            >
              {/* Insertion line, drawn ABOVE the row — because dropping on a row inserts
                  BEFORE it. A ring around the row (what this used to be) reads as "replace
                  this one", which is the wrong promise. */}
              <div className="flex items-center gap-2 overflow-hidden flex-1">
                {/* Icon slot. The icon itself is always the project's own — the run/done
                    state rides as a small corner overlay instead of replacing it, so
                    picking a 🎬 doesn't mean losing it every time you hit generate. */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIconPicker({ id: project.id, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() });
                  }}
                  title="아이콘 변경"
                  className="shrink-0 w-[18px] h-[18px] flex items-center justify-center rounded hover:bg-white/10 transition-colors"
                >
                  <ProjectIcon icon={project.icon} />
                </button>
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
                {/* Which folder this match came from — search flattens the tree, and two
                    projects may legitimately share a name in different folders (that is
                    the whole point of per-folder naming). Without this the two rows are
                    the same row twice. Only while searching: everywhere else the
                    indentation already says it. */}
                {searchQuery.trim() && (() => {
                  const path = groupPathOf(project);
                  return path && <span className="shrink-0 text-[10px] text-white/30 truncate max-w-[84px]" title={path}>{path}</span>;
                })()}
              </div>
              {!editingId && (() => {
                const running = project.messages.some(m => m.status === 'running' || m.status === 'queued');
                const unseen = unseenDoneCount(project, currentProjectId === project.id);
                return (
                  // Status lives on the RIGHT, not on the icon. Stacking a badge on a 16px
                  // icon buries whatever the user picked — the point of choosing an icon is
                  // that you can see it. Status and actions share this slot and cross-fade:
                  // status when idle, rename/delete on hover.
                  <div className="relative shrink-0 ml-2 flex items-center" style={{ minWidth: 44, height: 22 }}>
                    <div className="absolute inset-0 flex items-center justify-end gap-1 opacity-100 group-hover:opacity-0 transition-opacity pointer-events-none">
                      {running && <Loader2 size={14} className="text-[#0071e3] animate-spin" />}
                      {!running && unseen > 0 && (
                        <span title={`새로 완성된 영상 ${unseen}개`}
                          className="min-w-[17px] h-[17px] px-1 rounded-full bg-[#30d158] text-[#0b2c16] text-[10px] font-bold leading-[17px] text-center tabular-nums">
                          {unseen > 99 ? '99+' : unseen}
                        </span>
                      )}
                    </div>
                    <div className="absolute inset-0 flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={(e) => { e.stopPropagation(); setEditingId(project.id); setEditName(project.name); }} className="p-1 text-white/40 hover:text-white transition-colors" title="Rename">
                        <Edit2 size={14} />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setPendingDelete({ id: project.id, name: project.name }); }} className="p-1 text-white/40 hover:text-[#ff3b30] transition-colors" title="Delete">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
      </Fragment>
    );
  };

  // Where a dragged FOLDER lands at the end of a list — the top level, or inside a parent.
  // ★ Plain function, not <GroupTailDrop/>: same remount trap as renderTailDrop.
  const renderGroupTailDrop = (parentId: string | undefined, label: string) => {
    const on = !!liveGroupPlan && liveGroupPlan.beforeId === null && liveGroupPlan.parentId === parentId;
    return (
      <div data-group-end={parentId ?? ''}
        className={cn('overflow-hidden transition-[height] duration-150 ease-out', on ? 'h-[30px]' : 'h-0')}>
        <div className="h-[26px] flex items-center gap-1.5 px-2 rounded-[7px] border border-dashed border-[#0071e3]/70 bg-[#0071e3]/10">
          <Folder size={12} className="shrink-0 text-[#4da3ff]" />
          <span className="truncate text-[11px] text-[#4da3ff]">{label}</span>
        </div>
      </div>
    );
  };

  // One folder and everything under it. depth 0 = top level, depth 1 = subfolder.
  // Recursion stops at depth 0 asking for children, so two levels is structural here, not
  // a convention someone can drift past.
  const renderGroup = (g: ProjectGroup, depth: number) => {
    const kids = depth === 0 ? tree.childrenOf(g.id) : [];
    // The EFFECTIVE parent — where this row actually sits on screen. Reading g.parentId
    // directly would publish a dangling id as a drop target: the slot would light up and
    // then refuse the drop, with nothing on screen explaining why.
    const parentId = depth === 0 ? undefined : g.parentId;
    const own = projects.filter(p => p.groupId === g.id);
    const kidIds = new Set(kids.map(k => k.id));
    const all = kids.length ? [...own, ...projects.filter(p => p.groupId && kidIds.has(p.groupId))] : own;
    // ★ The badge appears in exactly ONE place at a time. Folded: this header carries the
    // total for its whole subtree. Unfolded: it shows nothing, and each child — subfolder
    // header or project row — carries its own. Showing both double-counts the same clips
    // in a single glance; with two levels it would treble-count.
    const unseen = all.reduce((n, p) => n + unseenDoneCount(p, currentProjectId === p.id), 0);
    const running = all.some(p => p.messages.some(m => m.status === 'running' || m.status === 'queued'));
    const aimed = !!liveGroupPlan && liveGroupPlan.beforeId === g.id;
    const dropInto = !!livePlan && livePlan.into === true && livePlan.groupId === g.id;
    const draggedName = projectGroups.find(x => x.id === dragId)?.name;
    const intoName = parentId ? projectGroups.find(x => x.id === parentId)?.name : null;
    return (
      <Fragment key={g.id}>
        {/* Gap for reordering the FOLDERS themselves. */}
        <div className={cn('overflow-hidden transition-[height] duration-150 ease-out', aimed ? 'h-[30px]' : 'h-0')}>
          <div className="h-[26px] flex items-center gap-1.5 px-2 rounded-[7px] border border-dashed border-[#0071e3]/70 bg-[#0071e3]/10">
            <Folder size={12} className="shrink-0 text-[#4da3ff]" />
            {/* Landing beside a subfolder means going INSIDE its parent. Say so on the
                strip — otherwise the only way to find out is to drop and see. */}
            <span className="truncate text-[11px] text-[#4da3ff]">
              {draggedName} {intoName ? `→ ${intoName} 안으로` : '여기로'}
            </span>
          </div>
        </div>
        <div data-group-id={g.id} data-group-parent={parentId ?? ''}
          className={cn('rounded-[8px]', dragId === g.id && 'opacity-40')}>
          <div data-into-group={g.id}
            title="클릭: 접기·펴기 · 더블클릭: 이름 변경"
            className={cn(
              'group/g flex items-center gap-1.5 px-2 py-1.5 rounded-[8px] cursor-pointer transition-colors',
              // Lit as a drop destination. A ring around the folder says "inside this one",
              // which is the promise the drop actually keeps — and it says which one, even
              // when a folder is sitting directly above its own subfolders.
              dropInto
                ? 'bg-[#0071e3]/25 ring-1 ring-[#0071e3] text-white'
                : 'text-white/50 hover:text-white/80 hover:bg-[#2a2a2d]/40')}
            onPointerDown={(e) => armDrag('group', g.id, e)}
            // Chevron / icon / count / padding: fold instantly. Aiming at the chevron is
            // the deliberate "open this" gesture and it should never wait on anything.
            // detail > 1 skips the second click of a double-click so it can't fold twice.
            onClick={(e) => { if (justDragged.current || e.detail > 1) return; toggleProjectGroup(g.id); }}>
            <ChevronRight size={13} className={cn('shrink-0 transition-transform', !g.collapsed && 'rotate-90')} />
            {/* Open the folder while something hovers over it — the same "it will go in
                here" cue Explorer gives. */}
            {g.collapsed && !dropInto ? <Folder size={13} className="shrink-0" /> : <FolderOpen size={13} className="shrink-0" />}
            {editingGroupId === g.id ? (
              <input ref={groupInputRef} autoFocus value={editGroupName}
                onChange={(e) => setEditGroupName(e.target.value)}
                onBlur={() => { if (editGroupName.trim()) renameProjectGroup(g.id, editGroupName.trim()); setEditingGroupId(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { if (editGroupName.trim()) renameProjectGroup(g.id, editGroupName.trim()); setEditingGroupId(null); }
                  if (e.key === 'Escape') setEditingGroupId(null);
                }}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 min-w-0 bg-black border border-[#0071e3] rounded-[5px] px-1 py-0.5 text-[12px] text-white outline-none" />
            ) : (
              // The NAME is the rename target, so its single click has to wait long enough
              // to know a second one isn't coming. Without the wait the folder folds first
              // and the rename box opens on a folder that just shut itself — the rename
              // worked, but it read as "double-click does something random".
              // Only the name pays the 220ms; everything else in the header folds instantly.
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  if (justDragged.current || e.detail > 1) return;
                  if (pendingToggle.current) clearTimeout(pendingToggle.current);
                  pendingToggle.current = window.setTimeout(() => {
                    pendingToggle.current = null;
                    toggleProjectGroup(g.id);
                  }, 220);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (pendingToggle.current) { clearTimeout(pendingToggle.current); pendingToggle.current = null; }
                  setEditingGroupId(g.id); setEditGroupName(g.name);
                }}
                className={cn('flex-1 truncate tracking-tight', depth === 0 ? 'text-[12px] font-semibold' : 'text-[11.5px] font-medium')}>
                {g.name}
              </span>
            )}
            <span className="shrink-0 text-[10px] text-white/25 tabular-nums group-hover/g:hidden">{all.length}</span>
            {g.collapsed && running && <Loader2 size={12} className="shrink-0 text-[#0071e3] animate-spin" />}
            {g.collapsed && !running && unseen > 0 && (
              <span title={`이 그룹에 새로 완성된 영상 ${unseen}개`}
                className="shrink-0 min-w-[16px] h-[16px] px-1 rounded-full bg-[#30d158] text-[#0b2c16] text-[9px] font-bold leading-[16px] text-center tabular-nums">
                {unseen > 99 ? '99+' : unseen}
              </span>
            )}
            <div className="shrink-0 hidden group-hover/g:flex items-center gap-0.5">
              {depth === 0 ? (
                // Only top-level folders can hold folders, so only they offer it. An
                // always-present button that refuses on a subfolder would be worse than
                // no button at all.
                <button onClick={(e) => {
                  e.stopPropagation();
                  const id = createProjectGroup(undefined, g.id);
                  setEditingGroupId(id); setEditGroupName('');
                }} title="하위 그룹 추가" className="p-0.5 text-white/40 hover:text-white transition-colors"><FolderPlus size={12} /></button>
              ) : (
                <button onClick={(e) => { e.stopPropagation(); setGroupParent(g.id, undefined); }}
                  title="상위로 빼기" className="p-0.5 text-white/40 hover:text-white transition-colors"><RotateCcw size={12} /></button>
              )}
              <button onClick={(e) => { e.stopPropagation(); setEditingGroupId(g.id); setEditGroupName(g.name); }}
                title="그룹 이름 변경" className="p-0.5 text-white/40 hover:text-white transition-colors"><Edit2 size={12} /></button>
              <button onClick={(e) => { e.stopPropagation(); setPendingGroupDelete({ id: g.id, name: g.name, count: all.length, subCount: kids.length }); }}
                title="그룹 삭제" className="p-0.5 text-white/40 hover:text-[#ff3b30] transition-colors"><Trash2 size={12} /></button>
            </div>
          </div>
          {g.collapsed ? (
            // A folded folder still has to be a destination. Without a slot here the only
            // way to file something into it was to unfold it first — and people fold
            // folders precisely to get them out of the way.
            // Both strips live here; only one can ever be lit, because a drag is either a
            // project or a folder and each reads its own slot list.
            // The folder header itself now lights up as the destination, so the strip
            // that used to sit under a folded folder is gone — one signal, not two.
            <div className="pl-3">
              {depth === 0 && renderGroupTailDrop(g.id, `${g.name} 안으로`)}
            </div>
          ) : (
            <div className="pl-3 space-y-1 pb-0.5">
              {kids.map(k => renderGroup(k, 1))}
              {depth === 0 && kids.length > 0 && renderGroupTailDrop(g.id, `${g.name} 안 맨 아래로`)}
              {own.map(renderProjectRow)}
              {/* No "이 그룹 맨 아래로" strip any more. "Put it in this folder" is what the
                  glowing header says, and saying it twice in two places was the thing that
                  made it unclear which folder was meant. The strip survives only where
                  there is no header to light up — the ungrouped list at the bottom. */}
              {/* A folder holding only subfolders isn't empty — don't tell the user it is.
                  ★ Stays mounted during a drag. It used to hide on `!dragId`, which shrank
                  the folder the instant a drag began and invalidated every measured
                  position below it (65px with two empty folders — see beginDrag).
                  Keeping it is also just correct: "프로젝트를 끌어다 놓으세요" is exactly
                  what you want to read while dragging a project. */}
              {all.length === 0 && kids.length === 0 && (
                <div className="px-3 py-1.5 text-[11px] text-white/25">비어 있음 — 프로젝트를 끌어다 놓으세요</div>
              )}
              {/* With no children yet, this is the only way in by drag. It has to exist
                  before the folder has anything in it, which is exactly when it's needed. */}
              {depth === 0 && kids.length === 0 && renderGroupTailDrop(g.id, `${g.name} 안으로`)}
            </div>
          )}
        </div>
      </Fragment>
    );
  };

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
          {/* whitespace-nowrap + min-w-0: adding the group button next to this stole enough
              width to wrap "New Project" onto two lines. The label should shrink its padding,
              never break. */}
          <button onClick={createProject} className="flex-1 min-w-0 flex items-center justify-center gap-1.5 bg-[#2a2a2d] hover:bg-[#3a3a3d] text-white px-2 py-2 rounded-[8px] font-medium transition-colors text-[15px] whitespace-nowrap">
            <Plus size={17} className="shrink-0" />
            New Project
          </button>
          <button
            onClick={() => { const id = createProjectGroup(); setEditingGroupId(id); setEditGroupName(''); }}
            title="새 그룹 (프로젝트를 끌어다 넣으세요)"
            className="shrink-0 p-2 text-white/50 hover:text-white bg-[#2a2a2d] hover:bg-[#3a3a3d] rounded-[8px] transition-colors">
            <FolderPlus size={18} />
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
      {/* One dragover handler for the entire list. Children deliberately have none. */}
      <div ref={listRef}
        className={cn('relative flex-1 overflow-y-auto p-2 space-y-1 dark-scrollbar', dragId && 'select-none')}
      >
        {/* Groups are skipped entirely while searching — see the note on `renderProjectRow`
            callers below. */}
        {!searchQuery.trim() && tree.roots.map((g) => renderGroup(g, 0))}
        {/* Tail slot for top-level folder reordering — measurable even when idle. */}
        {!searchQuery.trim() && projectGroups.length > 0 && renderGroupTailDrop(undefined, '맨 아래 그룹으로')}
        {(searchQuery.trim()
          // While searching, groups and their collapsed state are ignored — you asked for
          // a name, not for a place. Hiding a match inside a folded folder would be wrong.
          ? filteredProjects
          : ungroupedProjects
        ).map(renderProjectRow)}
        {!searchQuery.trim() && renderTailDrop(undefined, projectGroups.length ? '그룹 밖 맨 아래로' : '맨 아래로')}
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

    {/* Held by the cursor. Portalled to <body> so the sidebar's overflow-hidden and its
        width animation can't clip it, and pointer-events:none so it never becomes the
        drop target itself. */}
    {createPortal(
      dragId ? (
        <div ref={attachGhost}
          className="fixed left-0 top-0 z-[200] pointer-events-none select-none
                     flex items-center gap-2 max-w-[220px] px-3 py-1.5 rounded-[8px]
                     bg-[#2a2a2d]/95 border border-[#0071e3]/60 shadow-2xl shadow-black/50
                     text-white text-[13px] font-medium backdrop-blur-sm">
          {dragKind === 'group' ? (
            <>
              <Folder size={13} className="shrink-0 text-[#4da3ff]" />
              <span className="truncate">{projectGroups.find(g => g.id === dragId)?.name}</span>
            </>
          ) : (
            <>
              <ProjectIcon icon={projects.find(p => p.id === dragId)?.icon} size={14} />
              <span className="truncate">{projects.find(p => p.id === dragId)?.name}</span>
            </>
          )}
        </div>
      ) : null,
      document.body)}

    {menu && (() => {
      const p = projects.find(x => x.id === menu.id);
      if (!p) return null;
      return (
        <ProjectMenu
          at={{ x: menu.x, y: menu.y }}
          project={p}
          groups={orderedGroups}
          onPick={(gid) => setProjectGroup(p.id, gid)}
          onNewGroup={() => {
            // Make the folder AROUND this project: create it, move the project in, and
            // drop straight into rename — the name is the only thing still missing.
            const gid = createProjectGroup();
            setProjectGroup(p.id, gid);
            setEditingGroupId(gid);
            setEditGroupName('');
          }}
          onClose={() => setMenu(null)}
        />
      );
    })()}

    {iconPicker && (
      <IconPicker
        anchor={iconPicker.rect}
        current={projects.find(p => p.id === iconPicker.id)?.icon}
        onPick={(icon) => setProjectIcon(iconPicker.id, icon)}
        onClose={() => setIconPicker(null)}
      />
    )}

    {/* ★ Exactly the shape of the delete modal below, and it has to be exactly this:
        portal FIRST → AnimatePresence inside it → a KEYED motion element as the direct
        child → the actual content inside that.
        Two ways this goes wrong, both already hit here:
          · AnimatePresence outside the portal — the exit finish never crosses the boundary.
          · A plain function component as the presence child — it animates but never unmounts.
        Both leave the overlay at opacity:0 while it is still `fixed inset-0`, so the app
        looks normal and silently ignores every click. Don't "simplify" this nesting.
        Still conditionally mounted, so the all-projects scan doesn't run while closed. */}
    {createPortal(
      <AnimatePresence>
        {galleryOpen && (
          <motion.div
            key="global-gallery"
            initial={{ opacity: 0, scale: 0.995 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.995 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed inset-0 z-[90] bg-[#f5f5f7] flex flex-col text-gray-900"
          >
            <GlobalGallery onClose={() => setGalleryOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>,
      document.body)}

    {/* Group deletion asks WHICH deletion you meant. "Remove the folder" and "remove the
        folder and everything in it" are different intentions that look like the same click,
        and only one of them is recoverable. The safe option is the primary button; the
        destructive one is styled as destructive and states the count. */}
    {createPortal(
    <AnimatePresence>
      {pendingGroupDelete && (
        <motion.div key="grp-del-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={() => setPendingGroupDelete(null)}
          className="fixed inset-0 z-[120] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 12 }} transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={(e) => e.stopPropagation()}
            className="w-[min(92vw,27rem)] bg-white rounded-2xl shadow-2xl overflow-hidden text-gray-900">
            <div className="p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="shrink-0 w-9 h-9 rounded-full bg-amber-50 flex items-center justify-center">
                  <Folder size={18} className="text-amber-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-[16px] font-semibold tracking-tight leading-snug">그룹을 삭제할까요?</h3>
                  <p className="text-[13px] text-gray-500 mt-0.5 break-all">
                    {pendingGroupDelete.name}
                    {pendingGroupDelete.subCount > 0 && <span className="text-gray-400"> · 하위 그룹 {pendingGroupDelete.subCount}개</span>}
                    {pendingGroupDelete.count > 0 && <span className="text-gray-400"> · 프로젝트 {pendingGroupDelete.count}개</span>}
                  </p>
                </div>
              </div>
              {/* The counts above are for the WHOLE subtree, and so is the destructive
                  button below — the number shown is the number that goes. */}
              {pendingGroupDelete.count > 0
                ? <p className="text-[12.5px] text-gray-600 leading-relaxed">
                    안에 있는 프로젝트를 어떻게 할지 골라주세요.
                    {pendingGroupDelete.subCount > 0 && ' 하위 그룹까지 포함한 숫자입니다.'}
                  </p>
                : <p className="text-[12.5px] text-gray-500">
                    {pendingGroupDelete.subCount > 0 ? '프로젝트는 없고 하위 그룹만 있습니다.' : '비어 있는 그룹입니다.'}
                  </p>}
            </div>
            <div className="px-5 pb-5 space-y-2">
              <button
                autoFocus
                onClick={() => { deleteProjectGroup(pendingGroupDelete.id); setPendingGroupDelete(null); }}
                className="w-full px-4 py-2.5 rounded-xl text-[14px] font-semibold text-white bg-[#0071e3] hover:bg-[#0060c0] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0071e3]/40 focus:ring-offset-2">
                그룹만 삭제 {pendingGroupDelete.subCount > 0
                  ? '(하위 그룹·프로젝트는 밖으로)'
                  : pendingGroupDelete.count > 0 && '(프로젝트는 남김)'}
              </button>
              {pendingGroupDelete.count > 0 && (
                <button
                  onClick={() => { deleteProjectGroupWithProjects(pendingGroupDelete.id); setPendingGroupDelete(null); }}
                  className="w-full px-4 py-2.5 rounded-xl text-[13.5px] font-medium text-[#ff3b30] bg-red-50 hover:bg-red-100 border border-red-100 transition-colors">
                  {pendingGroupDelete.subCount > 0 && `하위 그룹 ${pendingGroupDelete.subCount}개와 `}
                  프로젝트 {pendingGroupDelete.count}개까지 함께 삭제 · 되돌릴 수 없음
                </button>
              )}
              <button
                onClick={() => setPendingGroupDelete(null)}
                className="w-full px-4 py-2.5 rounded-xl text-[14px] font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors">
                취소
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body)}

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
