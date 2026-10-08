// 영상 파일 속 생성 설정 (26.10.801~). ComfyUI 가 PNG 에 워크플로 JSON 을 넣어 두고 끌어다 놓으면 되살리듯, 앱에서 받은
// 영상 끝에 그 영상을 만든 설정(프롬프트 · 파라미터 · 레퍼런스 정보)을 넣고, 앱에 끌어다 놓으면 작성 칸을 다시 채운다.
//
// 모양: MP4/MOV 맨 끝의 top-level 'free' 상자 — [크기 4바이트][free][FWSD][판 1바이트][IV 12][암호문 + 태그 16]. 재생기·편집기는
//   free 상자를 건너뛴다. ★ 끝에만 붙인다. 앞·중간에 넣으면 mdat 위치가 밀려 moov 의 오프셋 표를 고쳐야 하고, BytePlus · 구글 영상의
//   C2PA 증명서(AI 생성 표시)도 깨진다 — 끝의 free 상자는 증명서 지문에서 빠지는 칸이라 그대로 유효하다(c2patool 실측).
// ★ 탐색기 '속성' 에는 아무것도 안 보인다 — 광고주에게 영상을 넘기면 프롬프트가 다 보이는 건 보안상 안 된다(사용자 결정
//   2026-10-08). JSON 은 이 앱만 아는 열쇠로 AES-256-GCM 암호화 — 이 앱에 끌어다 놓아야 보인다. 판 1(평문)은 배포 전 시험판뿐.
// 쓰기: electron/main.cjs embedSettings(다운로드가 다 끝난 파일에). 읽기: readSettingsFromFile(끌어다 놓은 영상).
// 카톡처럼 다시 압축하는 곳을 거치면 상자가 지워져 되살릴 수 없다 — 따로 .json 으로 저장하는 버튼은 두지 않기로 했다(2026-10-08).
//
// 레퍼런스 원본은 넣지 않는다 — 테이크마다 같은 원본이 한 벌씩 또 들어가고(10개면 10배), base64 로 넣으면 1.33배다.
// 이름 · 종류 · 순서 · 식별값(cacheId = 내용 md5)과 작은 미리보기만 넣고 원본은 그 PC 에서 찾는다. 받은 영상의 레퍼런스
// 원본은 30일 캐시 정리에서 빼 둔다(server.ts /api/cache/pin).

export const SETTINGS_KIND = 'freewill-seedance/settings';
export const SETTINGS_VERSION = 1;
const MAGIC = 'FWSD';
const MAX_JSON = 8 * 1024 * 1024;          // 프롬프트 3만 자가 약 90KB — 이보다 크면 우리 것이 아니다
const LIB_ID = /^[0-9a-f]{12}\.[a-z0-9]{2,5}$/;
const LIB_URL = /\/api\/library\/([0-9a-f]{12}\.[a-z0-9]{2,5})/g;

// handleReuse(ChatArea)가 그대로 먹는 모양 — 카드 메시지에서 이 PC 에만 의미 있는 값을 뺀 것.
export interface SettingsMessage {
  taskId?: string;
  timestamp?: number;
  endTime?: number;
  promptHtml?: string;
  promptText?: string;
  apiPrompt?: string;                       // BytePlus·구글에 실제로 보낸 문장([Image N] · <IMAGE_REF_N>) — 26.10.801~ 카드만
  usedSettings?: Record<string, any>;
  usedAssets?: any[];
  usedElementImages?: any[];
  usedCollection?: { id: string; name: string };   // 그때 이 채팅에 연결된 어셋 컬렉션 — '그때 설정 그대로' 가 다시 연결한다
}

export interface SettingsPayload {
  kind: typeof SETTINGS_KIND;
  v: number;
  app: string;                               // 넣은 앱 버전
  savedAt: number;
  taskId: string;
  project: { id?: string; name?: string };
  message: SettingsMessage;
  thumbs: Record<string, string>;            // 라이브러리 id → base64. 이름이 곧 내용(md5)이라 다른 PC 에 넣어도 같은 주소
}

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

// 카드 메시지 → 넣을 설정. 미리보기는 메시지가 가리키는 라이브러리 그림(칩 · 레퍼런스 줄 — 장당 수 KB)을 함께 담는다.
export async function buildSettingsPayload(m: any, project: { id?: string; name?: string }, app: string): Promise<SettingsPayload> {
  // 원본 경로는 뺀다 — 만든 사람 PC 의 폴더 이름이 영상에 그대로 실려 나가고, 다른 PC 에서는 쓸모도 없다.
  // 영상·오디오 레퍼런스의 url 은 생성 때 올린 임시 링크라(곧 죽는다) 비운다. 그림 url 은 미리보기 주소라 둔다.
  const usedAssets = (Array.isArray(m.usedAssets) ? m.usedAssets : []).map((a: any) => {
    const { originalPath: _local, ...rest } = a || {};
    return rest.type === 'image_url' ? rest : { ...rest, url: '' };
  });
  const message: SettingsMessage = {
    taskId: m.taskId, timestamp: m.timestamp, endTime: m.endTime,
    promptHtml: m.promptHtml, promptText: m.promptText, apiPrompt: m.apiPrompt,
    usedSettings: m.usedSettings, usedAssets,
    usedElementImages: Array.isArray(m.usedElementImages) ? m.usedElementImages : [],
    usedCollection: m.usedCollection,
  };
  const ids = new Set<string>();
  const scan = (s: unknown) => { if (typeof s === 'string') for (const x of s.matchAll(LIB_URL)) ids.add(x[1]); };
  scan(message.promptHtml);
  for (const a of usedAssets) { scan(a.url); scan(a.thumbnailUrl); }
  for (const e of message.usedElementImages || []) scan(e?.url);
  const thumbs: Record<string, string> = {};
  let total = 0;
  for (const id of ids) {
    try {
      const r = await fetch(`/api/library/${id}`);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > 512 * 1024 || total + buf.length > 4 * 1024 * 1024) continue;   // 미리보기가 아닌 큰 그림은 안 싣는다
      total += buf.length;
      thumbs[id] = bytesToBase64(buf);
    } catch { /* 미리보기는 없어도 된다 */ }
  }
  return {
    kind: SETTINGS_KIND, v: SETTINGS_VERSION, app, savedAt: Date.now(),
    taskId: m.taskId || '', project: { id: project.id, name: project.name }, message, thumbs,
  };
}

// 읽은 JSON 이 우리 설정인지 보고 모양을 맞춘다. ★ 남이 만든 파일일 수 있다 — 열쇠는 앱 안에 있으니 꺼내서 위조할 수 있다.
// 그래서 값마다 '알려진 모양' 만 통과시킨다(26.10.801 검토): 레퍼런스는 종류 · 역할 · cacheId(경로가 될 수 없는 모양) ·
// 미리보기 주소(SAFE_IMG)만, 설정은 아는 키와 범위만(개수 1~3 — 안 막으면 개수 50 이면 50건이 과금된다), 원본 경로는 버린다
// (그 PC 의 아무 파일이나 레퍼런스로 읽어 보내게 만들 수 있다). HTML 은 되살릴 때 sanitizePromptHtml 로.
const CACHE_ID = /^[0-9a-f]{12}(\.[^\\/:*?"<>|#%\s\u0000-\u001f]{1,16})?$/;   // 캐시 id = 내용 해시 12자 + 원래 확장자(대소문자 그대로)
const ASSET_TYPES = new Set(['image_url', 'video_url', 'audio_url']);
const ASSET_ROLES = new Set(['reference_image', 'reference_video', 'reference_audio', 'first_frame', 'last_frame']);
const MODES = new Set(['text_to_video', 'image_to_video_first', 'image_to_video_first_last', 'multimodal_reference', 'edit_video', 'extend_video']);
const OMNI_TASKS = new Set(['text_to_video', 'image_to_video', 'reference_to_video', 'edit', 'extend']);
const RATIOS = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']);
const RESOLUTIONS = new Set(['360p', '480p', '720p', '1080p', '4k']);
const CATEGORIES = new Set(['character', 'location', 'prop']);
function cleanSettings(s: any): Record<string, any> | undefined {
  if (!s || typeof s !== 'object') return undefined;
  const out: Record<string, any> = {};
  const int = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) ? x : undefined);
  if (typeof s.model === 'string' && /^[a-z0-9][a-z0-9.\-]{0,79}$/i.test(s.model)) out.model = s.model;
  if (MODES.has(s.mode)) out.mode = s.mode;
  if (OMNI_TASKS.has(s.omniTask)) out.omniTask = s.omniTask;
  if (RATIOS.has(s.ratio)) out.ratio = s.ratio;
  if (RESOLUTIONS.has(s.resolution)) out.resolution = s.resolution;
  const d = int(s.duration); if (d === -1 || (d != null && d >= 1 && d <= 60)) out.duration = d;
  const n = int(s.output_count); if (n != null) out.output_count = Math.min(3, Math.max(1, n));
  for (const k of ['generate_audio', 'return_last_frame', 'use_asset_id', 'draft']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (s.output_format === 'mov' || s.output_format === 'mp4') out.output_format = s.output_format;
  const seed = int(s.seed); if (seed != null) out.seed = seed;
  return out;
}
export function parseSettingsJson(text: string): SettingsPayload | null {
  let j: any;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || j.kind !== SETTINGS_KIND || typeof j.v !== 'number' || !j.message || typeof j.message !== 'object') return null;
  const m = j.message;
  const str = (x: unknown, max = 200_000) => (typeof x === 'string' ? x.slice(0, max) : undefined);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const label = (x: unknown, max: number) => str(x, max)?.replace(/[\u0000-\u001f<>]/g, '');
  const thumbs: Record<string, string> = {};
  if (j.thumbs && typeof j.thumbs === 'object') {
    for (const [k, v] of Object.entries(j.thumbs)) if (LIB_ID.test(k) && typeof v === 'string' && v.length < 1_000_000) thumbs[k] = v;
  }
  const usedAssets = (Array.isArray(m.usedAssets) ? m.usedAssets : []).slice(0, 60).flatMap((a: any) => {
    if (!a || typeof a !== 'object' || !ASSET_TYPES.has(a.type)) return [];
    const out: any = {
      type: a.type,
      role: ASSET_ROLES.has(a.role) ? a.role : a.type === 'video_url' ? 'reference_video' : a.type === 'audio_url' ? 'reference_audio' : 'reference_image',
      url: a.type === 'image_url' && typeof a.url === 'string' && SAFE_IMG.test(a.url) ? a.url : '',
    };
    if (typeof a.cacheId === 'string' && CACHE_ID.test(a.cacheId)) out.cacheId = a.cacheId;
    const fn = label(a.file_name, 200); if (fn) out.file_name = fn;
    if (typeof a.thumbnailUrl === 'string' && SAFE_IMG.test(a.thumbnailUrl)) out.thumbnailUrl = a.thumbnailUrl;
    const d = num(a.durationSec); if (d != null && d > 0 && d < 3600) out.durationSec = d;
    return [out];
  });
  const usedElementImages = (Array.isArray(m.usedElementImages) ? m.usedElementImages : []).slice(0, 200).flatMap((e: any) => {
    if (!e || typeof e !== 'object' || !label(e.name, 200)) return [];
    const out: any = { id: label(e.id, 260) || '', elementId: label(e.elementId, 120) || '', imageId: label(e.imageId, 120) || '', name: label(e.name, 200)! };
    if (CATEGORIES.has(e.category)) out.category = e.category;
    if (typeof e.libId === 'string' && CACHE_ID.test(e.libId)) out.libId = e.libId;
    if (typeof e.cacheId === 'string' && CACHE_ID.test(e.cacheId)) out.cacheId = e.cacheId;
    out.url = typeof e.url === 'string' && SAFE_IMG.test(e.url) ? e.url : '';
    return [out];
  });
  return {
    kind: SETTINGS_KIND, v: j.v, app: str(j.app, 40) || '', savedAt: num(j.savedAt) || 0,
    taskId: str(j.taskId, 120) || str(m.taskId, 120) || '',
    project: { id: str(j.project?.id, 120), name: label(j.project?.name, 300) },
    message: {
      taskId: str(m.taskId, 120), timestamp: num(m.timestamp), endTime: num(m.endTime),
      promptHtml: str(m.promptHtml), promptText: str(m.promptText), apiPrompt: str(m.apiPrompt),
      usedSettings: cleanSettings(m.usedSettings), usedAssets, usedElementImages,
      usedCollection: str(m.usedCollection?.id, 120) ? { id: str(m.usedCollection.id, 120)!, name: label(m.usedCollection.name, 300) || '' } : undefined,
    },
    thumbs,
  };
}
// 평문 프롬프트 → 작성 칸 HTML(글자는 모두 글자로 — 태그가 되지 않게). 줄마다 <div>, 빈 줄은 <div><br></div>.
export function plainTextToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.replace(/\r\n?/g, '\n').split('\n').map(l => `<div>${l ? esc(l) : '<br>'}</div>`).join('');
}

// 끌어다 놓은 영상에서 설정을 꺼낸다. top-level 상자를 머리만 읽으며 건너다 우리 free 상자를 찾는다(mdat 같은 큰 상자는
// 크기만 보고 건너뛴다 — 파일 전체를 읽지 않는다).
export async function readSettingsFromFile(file: File): Promise<SettingsPayload | null> {
  let pos = 0;
  for (let i = 0; i < 4096 && pos + 8 <= file.size; i++) {
    const h = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let size = dv.getUint32(0);
    const type = ascii(h, 4, 4);
    let hl = 8;
    if (size === 1) { if (h.length < 16) return null; size = Number(dv.getBigUint64(8)); hl = 16; }
    else if (size === 0) size = file.size - pos;
    if (size < hl || pos + size > file.size) return null;     // 영상이 아니거나 깨진 파일 — 더 읽지 않는다
    if (type === 'free' && size - hl > 5 && size - hl <= MAX_JSON + 33) {
      const body = new Uint8Array(await file.slice(pos + hl, pos + size).arrayBuffer());
      if (ascii(body, 0, 4) === MAGIC) {
        const text = await openSettingsBody(body).catch(() => null);
        const p = text ? parseSettingsJson(text) : null;
        if (p) return p;
      }
    }
    pos += size;
  }
  return null;
}

// 상자 몸통 [FWSD][판][…] → JSON 글. 판 2 = [IV 12][암호문 + 태그 16](AES-256-GCM). 판 1(평문)은 배포 전 시험판에만 있었고
// 열쇠 없이 위조할 수 있는 길이라 읽지 않는다(26.10.801 검토).
// 열쇠는 electron/main.cjs 의 SETTINGS_KEY 와 같아야 한다 — 바꾸면 그 전에 받은 영상은 못 읽는다.
const SETTINGS_KEY_HEX = '1a124b2cd9f9effdd942e3f8dc661d9f77c6ce9ec23bbf51d881a2e210ef226a';
let settingsKey: Promise<CryptoKey> | null = null;
async function openSettingsBody(body: Uint8Array): Promise<string | null> {
  const ver = body[4];
  if (ver !== 2 || body.length < 5 + 12 + 16) return null;
  settingsKey ??= crypto.subtle.importKey('raw', Uint8Array.from(SETTINGS_KEY_HEX.match(/../g)!.map(h => parseInt(h, 16))),
    'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: body.subarray(5, 17) }, await settingsKey, body.subarray(17));
  return new TextDecoder().decode(plain);
}

// 설정이 없는 영상(이 기능 전에 받은 것)에서 원래 카드를 찾을 단서. 파일 이름의 작업 번호, 영상 안 C2PA 증명서의
// 고유번호(instanceID — 파일마다 다르다, BytePlus 는 'xmp:iid:' 를 붙이고 구글은 맨 UUID)와 만든 시각.
export async function readVideoClues(file: File): Promise<{ taskId?: string; c2paId?: string; madeAt?: number }> {
  const taskId = file.name.match(/cgt-\d{14}-[a-z0-9]{5}/)?.[0];
  let c2paId: string | undefined, madeAt: number | undefined;
  try {
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    let s = '';
    for (let i = 0; i < head.length; i += 0x8000) s += String.fromCharCode(...head.subarray(i, i + 0x8000));
    if (s.includes('c2pa')) {
      c2paId = s.match(/instanceID[\s\S]{0,8}?(?:xmp:iid:)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)?.[1];
      const t = s.match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/)?.[1];
      if (t && !Number.isNaN(Date.parse(t))) madeAt = Date.parse(t);
    }
  } catch { /* 단서가 없을 뿐 */ }
  return { taskId, c2paId, madeAt };
}

// 파일에서 온 프롬프트 HTML 을 작성 칸에 넣을 수 있는 것만 남겨 다시 짓는다. 남이 만든 파일일 수 있다 — 그대로
// innerHTML 에 넣으면 그 안의 스크립트가 이 앱(로컬 서버 권한)에서 돈다. DOMParser 문서는 스크립트도 그림도
// 실행·로드하지 않는다. 알약(mention-pill · element-pill)과 줄 나눔, 굵게 정도만 통과.
const ALLOWED_TAGS = new Set(['DIV', 'P', 'BR', 'SPAN', 'IMG', 'B', 'STRONG', 'I', 'EM', 'U']);
const SAFE_IMG = /^(\/api\/library\/[0-9a-f]{12}\.[a-z0-9]{2,5}|data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+)$/;
export function sanitizePromptHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const out = document.createElement('div');
  const copy = (src: Node, dst: Node) => {
    src.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) { dst.appendChild(document.createTextNode(n.nodeValue || '')); return; }
      if (n.nodeType !== Node.ELEMENT_NODE) return;
      const el = n as Element;
      if (!ALLOWED_TAGS.has(el.tagName)) { copy(el, dst); return; }     // 모르는 태그는 벗기고 안의 글자만
      if (el.tagName === 'IMG' && !SAFE_IMG.test(el.getAttribute('src') || '')) return;
      const c = document.createElement(el.tagName.toLowerCase());
      const cls = el.getAttribute('class');
      if (cls === 'mention-pill' || cls === 'element-pill') c.setAttribute('class', cls);
      for (const a of ['data-name', 'data-asset-id', 'data-element-id', 'data-category', 'src']) {
        const v = el.getAttribute(a);
        if (v != null) c.setAttribute(a, a === 'src' ? v : v.slice(0, 200));
      }
      if (el.hasAttribute('data-el-text')) c.setAttribute('data-el-text', '');
      if (el.getAttribute('contenteditable') === 'false') c.setAttribute('contenteditable', 'false');
      // 알약 모양(색 · 크기)은 인라인 스타일이다. 바깥 주소를 부르는 것(url · import)만 막는다.
      const st = el.getAttribute('style');
      if (st && st.length < 600 && !/url\s*\(|@import|expression|javascript:/i.test(st)) c.setAttribute('style', st);
      dst.appendChild(c);
      copy(el, c);
    });
  };
  copy(doc.body, out);
  return out.innerHTML;
}

// 미리보기(base64)를 이 PC 라이브러리에 넣는다 — 이름이 곧 내용이라 같은 id 가 나오고, 프롬프트 칩 · 레퍼런스 줄의
// /api/library/<id> 주소가 그대로 살아난다. 이미 있으면 서버가 그냥 둔다.
export async function storePayloadThumbs(thumbs: Record<string, string>): Promise<void> {
  for (const [id, b64] of Object.entries(thumbs || {})) {
    try {
      // no-store: 라이브러리 주소는 '영원히 캐시' 로 내보내서, 그냥 물으면 화면이 예전에 받아 둔 사본으로 '있다' 고 답한다
      // (서버에서 지워졌어도). 서버에 직접 묻는다.
      const head = await fetch(`/api/library/${id}`, { method: 'HEAD', cache: 'no-store' });
      if (head.ok) continue;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await fetch('/api/library', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(id) }, body: bytes });
    } catch { /* 미리보기만 빠진다 */ }
  }
}

// 화면에 보여 줄 미리보기 주소 — 이 PC 라이브러리에 없을 수 있으니 상자에 실려 온 것을 data URL 로.
export function thumbSrc(url: string | undefined, thumbs: Record<string, string>): string {
  if (!url) return '';
  const id = url.match(/\/api\/library\/([0-9a-f]{12}\.[a-z0-9]{2,5})/)?.[1];
  if (id && thumbs[id]) {
    const ext = id.split('.').pop();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${thumbs[id]}`;
  }
  return url;
}
