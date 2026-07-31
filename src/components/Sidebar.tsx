import { useState, useRef, useEffect, useMemo, Fragment, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Plus, MessageSquare, Trash2, Edit2, Search, Loader2, PanelLeftClose, PanelLeftOpen, Sparkles, BarChart3, FolderDown, FolderOpen, Folder, FolderPlus, ChevronRight, AlertTriangle, LayoutGrid, Upload, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore, type Project } from '../store';
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
  const PANEL_W = 300, PANEL_H = 330; // keep in step with the real height (tabs + grid + actions + spec)
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

// Right-click menu for a project row. Portaled and pinned to the cursor, with the same
// edge-flip as the icon picker so it never opens off-screen.
// Exists because drag-and-drop is the wrong and only way to file a project when the list
// is long: dragging across a scrolling sidebar to reach a folder is fiddly, and there was
// no way at all to make a folder *around* the project you're looking at.
function ProjectMenu({ at, project, groups, onPick, onNewGroup, onClose }: {
  at: { x: number; y: number };
  project: Project;
  groups: { id: string; name: string }[];
  onPick: (groupId: string | undefined) => void;
  onNewGroup: () => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const searchable = groups.length > 7;   // same threshold as the gallery filters
  const shown = q.trim() ? groups.filter(g => g.name.toLowerCase().includes(q.trim().toLowerCase())) : groups;
  // Height estimate drives the edge-flip only; keep it in step with the real layout so the
  // menu doesn't get pushed off-screen. header 28 + new-group 36 + rule 9 + label 18
  // + list (capped 190) + search 30? + ungroup 45?
  const W = 220;
  const LIST_MAX = 190;
  const H = 91 + Math.min(LIST_MAX, Math.max(28, groups.length * 28))
    + (searchable ? 30 : 0) + (project.groupId ? 45 : 0);
  const left = Math.min(at.x, window.innerWidth - W - 8);
  const top = Math.min(at.y, window.innerHeight - H - 8);
  return createPortal(
    <div className="fixed inset-0 z-[115]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.1, ease: 'easeOut' }}
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
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left transition-colors ${
                project.groupId === g.id ? 'text-indigo-600 font-medium bg-indigo-50/60 cursor-default' : 'text-gray-700 hover:bg-gray-100'}`}>
              <Folder size={13} className="shrink-0 opacity-60" />
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
    projectGroups, createProjectGroup, renameProjectGroup, deleteProjectGroup, deleteProjectGroupWithProjects, toggleProjectGroup, setProjectGroup, moveProjectBefore, moveProjectToEnd,
    autoDownload, setAutoDownload } = useAppStore();
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editGroupName, setEditGroupName] = useState('');
  // Drag state for reordering / refiling. dropTarget is a tagged id ('p:<id>' | 'g:<id>'
  // | 'root') so one piece of state can highlight rows, groups and the empty area.
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [pendingGroupDelete, setPendingGroupDelete] = useState<{ id: string; name: string; count: number } | null>(null);
  // ── Why dropTarget is set through these two helpers ──────────────────────────
  // HTML5 drag fires dragleave every time the pointer crosses into a CHILD of the row
  // (icon button, name span, action buttons). Clearing on each of those made the
  // insertion line strobe on and off while the cursor sat still over one row.
  // So: a leave only *schedules* the clear, and the next dragover cancels it. The line
  // then only disappears when the pointer has genuinely been off every target for a
  // moment — which is also what makes moving between rows read as the line sliding.
  const dropClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aimAt = (key: string) => {
    if (dropClearRef.current) { clearTimeout(dropClearRef.current); dropClearRef.current = null; }
    setDropTarget(prev => (prev === key ? prev : key));
  };
  const releaseAim = () => {
    if (dropClearRef.current) clearTimeout(dropClearRef.current);
    dropClearRef.current = setTimeout(() => { setDropTarget(null); dropClearRef.current = null; }, 70);
  };
  const endDrag = () => {
    if (dropClearRef.current) { clearTimeout(dropClearRef.current); dropClearRef.current = null; }
    setDragId(null); setDropTarget(null);
  };
  useEffect(() => () => { if (dropClearRef.current) clearTimeout(dropClearRef.current); }, []);
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

  // A project whose groupId points at a group that no longer exists counts as ungrouped.
  // Without that fallback a stale id would make the project invisible — present in the
  // data, absent from every list, and unreachable.
  const ungroupedProjects = useMemo(() => {
    const live = new Set(projectGroups.map(g => g.id));
    return projects.filter(p => !p.groupId || !live.has(p.groupId));
  }, [projects, projectGroups]);

  // The strip at the end of a section. Only exists while something is being dragged —
  // it's an affordance, not furniture. It also fills a real gap: dropping on a row inserts
  // BEFORE that row, so without this there is no way to reach the last slot of a list.
  const TailDrop = ({ groupId, label }: { groupId?: string; label: string }) => {
    if (!dragId) return null;
    const key = 'end:' + (groupId ?? '');
    const on = dropTarget === key;
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); aimAt(key); }}
        onDragLeave={releaseAim}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation();
          const id = e.dataTransfer.getData('text/plain');
          if (id) moveProjectToEnd(id, groupId);
          endDrag();
        }}
        className={cn(
          'mx-1 mt-1 h-[26px] rounded-[7px] border border-dashed flex items-center justify-center text-[10px] transition-colors',
          on ? 'border-[#0071e3] bg-[#0071e3]/15 text-[#4da3ff]' : 'border-white/15 text-white/30'
        )}
      >
        {label}
      </div>
    );
  };

  // One project row. Extracted so the grouped list and the flat/search list render the
  // exact same thing — two copies of 60 lines of row markup would drift within a week.
  // A row, preceded by the gap that opens where it would land.
  // ★ The gap is itself a drop target aiming at the SAME key as its row. Without that the
  // list oscillates: opening the gap pushes the row down, the cursor ends up over the gap
  // rather than the row, the aim clears, the gap closes, the row slides back under the
  // cursor, and it opens again — forever.
  const renderProjectRow = (project: Project) => {
    const aimed = dropTarget === 'p:' + project.id;
    const dragging = dragId ? projects.find(p => p.id === dragId) : null;
    const dropHere = (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault(); e.stopPropagation();
      const id = e.dataTransfer.getData('text/plain');
      if (id && id !== project.id) moveProjectBefore(id, project.id);
      endDrag();
    };
    return (
      <Fragment key={project.id}>
        <div
          onDragOver={(e) => { if (dragId && dragId !== project.id) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; aimAt('p:' + project.id); } }}
          onDragLeave={releaseAim}
          onDrop={dropHere}
          // Height, not opacity — the point is that the list physically makes room.
          className={cn('overflow-hidden transition-[height] duration-150 ease-out', aimed ? 'h-[38px]' : 'h-0')}
        >
          <div className="h-[34px] flex items-center gap-2 px-3 rounded-[8px] border border-dashed border-[#0071e3]/70 bg-[#0071e3]/10">
            <ProjectIcon icon={dragging?.icon} size={14} />
            <span className="truncate text-[12px] text-[#4da3ff]">{dragging ? `${dragging.name} 여기로` : '여기로'}</span>
          </div>
        </div>
            <div
              draggable={editingId !== project.id}
              onDragStart={(e) => { e.dataTransfer.setData('text/plain', project.id); e.dataTransfer.effectAllowed = 'move'; setDragId(project.id); }}
              onDragEnd={endDrag}
              // stopPropagation is load-bearing: without it this bubbles to the group block
              // and then the list container, whose own dragover handlers overwrite
              // dropTarget with 'g:…'/'root' — so the insertion line would never appear even
              // though the drop itself worked. (onDrop already stops; onDragOver must too.)
              onDragOver={(e) => { if (dragId && dragId !== project.id) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move'; aimAt('p:' + project.id); } }}
              onDragLeave={releaseAim}
              onDrop={dropHere}
              className={cn(
                "group flex items-center justify-between px-3 py-2 rounded-[8px] cursor-pointer transition-colors",
                dragId === project.id && "opacity-40",
                currentProjectId === project.id ? "bg-[#2a2a2d] text-white" : "text-white/70 hover:bg-[#2a2a2d]/50 hover:text-white"
              )}
              onClick={() => { if (editingId !== project.id) setCurrentProjectId(project.id); }}
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
      <div className="relative flex-1 overflow-y-auto p-2 space-y-1 dark-scrollbar"
        // Dropping on the empty area below everything releases a project from its folder.
        onDragOver={(e) => { if (dragId) { e.preventDefault(); aimAt('root'); } }}
        onDragLeave={releaseAim}
        onDrop={(e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData('text/plain');
          if (id) setProjectGroup(id, undefined);
          endDrag();
        }}
      >
        {/* Groups are skipped entirely while searching — see the note on `renderProjectRow`
            callers below. */}
        {!searchQuery.trim() && projectGroups.map((g) => {
          const inGroup = projects.filter(p => p.groupId === g.id);
          // ★ The badge appears in exactly ONE place at a time. Folded: the header carries
          // the group's total. Unfolded: the header shows nothing and each row carries its
          // own. Showing both would double-count the same clips in the same glance.
          const groupUnseen = inGroup.reduce((n, p) => n + unseenDoneCount(p, currentProjectId === p.id), 0);
          const groupRunning = inGroup.some(p => p.messages.some(m => m.status === 'running' || m.status === 'queued'));
          const isDropTarget = dropTarget === 'g:' + g.id;
          return (
            <div key={g.id}
              onDragOver={(e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); aimAt('g:' + g.id); } }}
              onDragLeave={releaseAim}
              onDrop={(e) => {
                e.preventDefault(); e.stopPropagation();
                const id = e.dataTransfer.getData('text/plain');
                if (id) setProjectGroup(id, g.id);
                endDrag();
              }}
              className={cn('rounded-[8px]', isDropTarget && 'ring-1 ring-[#0071e3] ring-inset bg-[#0071e3]/5')}
            >
              <div className="group/g flex items-center gap-1.5 px-2 py-1.5 rounded-[8px] cursor-pointer text-white/50 hover:text-white/80 hover:bg-[#2a2a2d]/40 transition-colors"
                onClick={() => toggleProjectGroup(g.id)}
                onDoubleClick={(e) => { e.stopPropagation(); setEditingGroupId(g.id); setEditGroupName(g.name); }}>
                <ChevronRight size={13} className={cn('shrink-0 transition-transform', !g.collapsed && 'rotate-90')} />
                {g.collapsed ? <Folder size={13} className="shrink-0" /> : <FolderOpen size={13} className="shrink-0" />}
                {editingGroupId === g.id ? (
                  <input autoFocus value={editGroupName}
                    onChange={(e) => setEditGroupName(e.target.value)}
                    onBlur={() => { if (editGroupName.trim()) renameProjectGroup(g.id, editGroupName.trim()); setEditingGroupId(null); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { if (editGroupName.trim()) renameProjectGroup(g.id, editGroupName.trim()); setEditingGroupId(null); }
                      if (e.key === 'Escape') setEditingGroupId(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-black border border-[#0071e3] rounded-[5px] px-1 py-0.5 text-[12px] text-white outline-none" />
                ) : (
                  <span className="flex-1 truncate text-[12px] font-semibold tracking-tight">{g.name}</span>
                )}
                <span className="shrink-0 text-[10px] text-white/25 tabular-nums group-hover/g:hidden">{inGroup.length}</span>
                {g.collapsed && groupRunning && <Loader2 size={12} className="shrink-0 text-[#0071e3] animate-spin" />}
                {g.collapsed && !groupRunning && groupUnseen > 0 && (
                  <span title={`이 그룹에 새로 완성된 영상 ${groupUnseen}개`}
                    className="shrink-0 min-w-[16px] h-[16px] px-1 rounded-full bg-[#30d158] text-[#0b2c16] text-[9px] font-bold leading-[16px] text-center tabular-nums">
                    {groupUnseen > 99 ? '99+' : groupUnseen}
                  </span>
                )}
                <div className="shrink-0 hidden group-hover/g:flex items-center gap-0.5">
                  <button onClick={(e) => { e.stopPropagation(); setEditingGroupId(g.id); setEditGroupName(g.name); }}
                    title="그룹 이름 변경" className="p-0.5 text-white/40 hover:text-white transition-colors"><Edit2 size={12} /></button>
                  <button onClick={(e) => { e.stopPropagation(); setPendingGroupDelete({ id: g.id, name: g.name, count: inGroup.length }); }}
                    title="그룹 삭제" className="p-0.5 text-white/40 hover:text-[#ff3b30] transition-colors"><Trash2 size={12} /></button>
                </div>
              </div>
              {!g.collapsed && (
                <div className="pl-3 space-y-1 pb-0.5">
                  {inGroup.length === 0
                    ? <div className="px-3 py-1.5 text-[11px] text-white/25">비어 있음 — 프로젝트를 끌어다 놓으세요</div>
                    : inGroup.map(renderProjectRow)}
                  {inGroup.length > 0 && <TailDrop groupId={g.id} label="이 그룹 맨 아래로" />}
                </div>
              )}
            </div>
          );
        })}
        {(searchQuery.trim()
          // While searching, groups and their collapsed state are ignored — you asked for
          // a name, not for a place. Hiding a match inside a folded folder would be wrong.
          ? filteredProjects
          : ungroupedProjects
        ).map(renderProjectRow)}
        {!searchQuery.trim() && <TailDrop label={projectGroups.length ? '그룹 밖 맨 아래로' : '맨 아래로'} />}
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

    {menu && (() => {
      const p = projects.find(x => x.id === menu.id);
      if (!p) return null;
      return (
        <ProjectMenu
          at={{ x: menu.x, y: menu.y }}
          project={p}
          groups={projectGroups}
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
                    {pendingGroupDelete.count > 0 && <span className="text-gray-400"> · 프로젝트 {pendingGroupDelete.count}개</span>}
                  </p>
                </div>
              </div>
              {pendingGroupDelete.count > 0
                ? <p className="text-[12.5px] text-gray-600 leading-relaxed">
                    안에 있는 프로젝트를 어떻게 할지 골라주세요.
                  </p>
                : <p className="text-[12.5px] text-gray-500">비어 있는 그룹입니다.</p>}
            </div>
            <div className="px-5 pb-5 space-y-2">
              <button
                autoFocus
                onClick={() => { deleteProjectGroup(pendingGroupDelete.id); setPendingGroupDelete(null); }}
                className="w-full px-4 py-2.5 rounded-xl text-[14px] font-semibold text-white bg-[#0071e3] hover:bg-[#0060c0] transition-colors focus:outline-none focus:ring-2 focus:ring-[#0071e3]/40 focus:ring-offset-2">
                그룹만 삭제 {pendingGroupDelete.count > 0 && '(프로젝트는 남김)'}
              </button>
              {pendingGroupDelete.count > 0 && (
                <button
                  onClick={() => { deleteProjectGroupWithProjects(pendingGroupDelete.id); setPendingGroupDelete(null); }}
                  className="w-full px-4 py-2.5 rounded-xl text-[13.5px] font-medium text-[#ff3b30] bg-red-50 hover:bg-red-100 border border-red-100 transition-colors">
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
