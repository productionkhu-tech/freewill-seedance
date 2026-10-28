// ─── 보내기 — 화면의 전송 버튼과 에이전트 작업함이 같이 쓴다 (26.10.2002~ ChatArea 에서 떼어 냄) ─────────────────────
// 예전에는 보내기(handleSend)가 '열린 프로젝트의 작성 칸' 을 읽었다. 그래서 에이전트는 작성 칸을 빌려 쓰고(설정 · 레퍼런스 ·
// 프롬프트를 덮어썼다 되돌림) 프로젝트를 열어야만 보낼 수 있었다 — 사용자 화면이 바뀌고, 입력 중이면 기다렸다.
// 이제 보내기는 '값' 만 받는다: 어느 프로젝트에(projectId) · 무슨 글(promptHtml) · 어떤 설정 · 어떤 레퍼런스. 화면은 그 프로젝트의
// 지금 값을 넘기고, 에이전트는 메모리에서 합친 값을 넘긴다 — 같은 함수라 검사 · 권한 · 시트 보고 · NCP 보관 · 폴링이 똑같다.
// ★ 이 함수는 프로젝트의 작성 칸 · 설정 · 레퍼런스에 쓰지 않는다(화면이 부탁한 4K 되쓰기만 예외). 카드는 그 프로젝트에 붙는다.
// ★ 과금(프로젝트 코드)은 처음에 한 번 읽고, 요청을 띄우기 직전에 다시 확인한다 — 그 사이 프로젝트가 지워졌거나 코드가
//   바뀌었으면 보내지 않는다(recheckBeforePost). 확인과 요청 사이에는 await 가 없다.
import { PERSONAL } from './edition';
import { personalR2Ready, R2_NEEDED_MSG } from './personal-keys';
import {
  useAppStore, Asset, ElementImage, GenerationSettings,
  clampResolution, isFourKAllowed, modelImageMax, modelVideoMax, modelAudioMax, modelRefVideoSec, modelRefAudioSec,
  modelAllowsAudioOnly, resolveOutputFormat, refTaskTypeFor, applyTaskConstraints, isModelAllowed, MODELS, modelProvider,
  resolveOmniTask, modelResolutions, modelHasFirstLastFrame, modelExtendMaxSrcSec, modelExtendMaxOutSec, refVideoMinSecFor,
  modeRefCaps, omniTaskRefCaps, OMNI_VIDEO_MAX_MB, OUTPUT_COUNT_MAX, projectBilling, billingOf, boundCollectionOf,
} from '../store';
import {
  validateImageFile, validateImageDimensions, validateVideoFile, validateAudioFile, getMediaDurationSec, totalDurationError,
  createThumbnail, createVideoThumbnail, reuploadFromCache, reuploadFromPath, getFilePath, cacheFile, dataUrlToFile,
  readCacheAsDataUrl, SourceChangedError,
} from './utils';

type ElementAssetT = ReturnType<typeof useAppStore.getState>['elementAssets'][number];

export type SendInput = {
  projectId: string;
  promptHtml: string;               // 알약이 든 작성 칸 HTML(화면) 또는 agentPromptHtml 이 만든 것(에이전트)
  settings: GenerationSettings;
  assets: Asset[];
  writeBack4k?: boolean;            // 화면의 보내기만 — 4K 권한이 풀려 낮춰 보낼 때 프로젝트 설정에도 되쓴다
  expectBillingKey?: string;        // 에이전트 — 가져갈 때 본 프로젝트 코드(key). 다르면 보내지 않는다
};
export type SendIO = {
  warn: (msg: string) => void;
  busy?: (on: boolean) => void;     // 화면의 작성 칸 잠금(isGenerating). 에이전트는 없음 — 사용자 보내기와 서로 막지 않는다
  sent?: () => void;                // 카드를 붙인 뒤(화면은 맨 아래로 내린다)
};

// 요청을 띄우기 직전 확인 — 빈 문자열이면 보내도 된다. 업로드(기다림) 사이에 바뀔 수 있는 것을 다시 본다:
// 프로젝트가 아직 있나 · 코드가 그대로인가 · 그 코드에 이 모델 · 4K 권한이 아직 있나(60초 확인이 권한을 바꿀 수 있다 —
// 26.10.2004 감사: 4K 권한은 업로드 전에 한 번만 읽어서, 그 사이 풀리면 4K 로 과금될 수 있었다).
function recheckBeforePost(projectId: string, billingKey: string, model: string, resolution?: string): string {
  const st = useAppStore.getState();
  if (!st.projects.some(p => p.id === projectId)) return '보내는 사이 프로젝트가 지워져 보내지 않았습니다.';
  const now = projectBilling(st, projectId);
  if (!now || now.key !== billingKey) {
    return `보내는 사이 프로젝트 코드가 바뀌어 보내지 않았습니다(지금 ${now ? `"${now.project}"` : '고르지 않음 — 종료됐을 수 있어요'}).\n코드를 확인한 뒤 다시 보내 주세요.`;
  }
  const bo = billingOf(st, projectId);
  if (!isModelAllowed(model, bo)) {
    return `보내는 사이 프로젝트 코드 "${now.project}" 의 ${MODELS.find(m => m.id === model)?.name || '이 모델'} 권한이 풀려 보내지 않았습니다.`;
  }
  if (resolution === '4k' && !isFourKAllowed(bo)) return `보내는 사이 4K 권한이 풀려 보내지 않았습니다.\n해상도를 낮춰 다시 보내 주세요.`;
  return '';
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

// Resolve one element-library image to a fresh R2 URL for the API payload — always the
// ORIGINAL bytes, never the JPG preview. 26.9.3001~ the original is a file in the server
// library (libId) and the server uploads that file untouched. Older assets may still carry
// a media-cache id, or the base64 original itself while it is being moved to disk — both
// still work. Same R2 path panel assets use, so element images reach the API identically.
async function resolveElementImageUrl(img: ElementImage): Promise<string> {
  for (const id of [img.libId, img.cacheId]) {
    if (!id) continue;
    try { return await reuploadFromCache(id); } catch { /* next source */ }
  }
  if (img.url && img.url.startsWith('data:')) {
    const file = await dataUrlToFile(img.url, img.file_name || 'element.png');
    const cacheId = await cacheFile(file);
    return await reuploadFromCache(cacheId);
  }
  throw new Error('원본 이미지를 찾을 수 없습니다');
}

// Block-level tags that occupy their own line when the prompt HTML is serialized.
// contentEditable writes <div> per line; pasted rich text can add <p>/<li>/headings.
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'TABLE', 'TR', 'TBODY', 'FIGURE', 'DL', 'DT', 'DD',
  'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ASIDE']);

// elementTagMap (send only): element-pill id → "[Image N]" reference marker.
// When given, element mentions become the BytePlus positional marker so the
// model binds the name to its reference image (same as panel [Image N]). When
// omitted (display / draft / copy), they resolve to the bare asset name so the
// prompt reads naturally ("김현우가 걷는다").
export const getPlainText = (html: string, elementTagMap?: Map<string, string>, mentionTagMap?: Map<string, string>) => {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  temp.querySelectorAll('.mention-pill').forEach(pill => {
    // Panel-asset mention. mentionTagMap (Omni only) rebinds it to <IMAGE_REF_N>; without
    // it (Seedance / display) it stays the [Image N] positional marker.
    const id = pill.getAttribute('data-asset-id');
    const tag = id ? mentionTagMap?.get(id) : undefined;
    pill.replaceWith(tag != null ? tag : `[${pill.getAttribute('data-name')}]`);
  });
  temp.querySelectorAll('.element-pill').forEach(pill => {
    const id = pill.getAttribute('data-element-id');
    const tag = id ? elementTagMap?.get(id) : undefined;
    pill.replaceWith(tag != null ? tag : (pill.getAttribute('data-name') || ''));
  });
  // Serialize by walking the DOM — deliberately NOT innerText. innerText emitted one
  // newline for the block boundary AND another for the placeholder <br> Chromium puts
  // inside an empty <div>, so every intentional blank line came back doubled (a 3300-char
  // prompt copied out as ~3800, and the model was fed the doubled version too). Walking
  // gives exactly one line per block, so blank lines survive as the user wrote them —
  // one stays one, three stay three. No layout needed either (no body append/reflow).
  const lines: string[] = [''];
  const walk = (parent: Node) => {
    parent.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        const data = node.nodeValue || '';
        // Whitespace-only text containing a newline is markup indentation from pasted
        // HTML, never user content — our editor stores blank lines as empty blocks.
        if (/^\s*$/.test(data) && /[\n\r]/.test(data)) return;
        lines[lines.length - 1] += data;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === 'BR') {
        // A <br> with no next sibling is Chromium's filler for an empty/last line; the
        // block boundary already accounts for it. Only a real mid-block break adds one.
        if (el.nextSibling) lines.push('');
        return;
      }
      if (BLOCK_TAGS.has(el.tagName)) {
        if (lines[lines.length - 1] !== '') lines.push('');
        walk(el);
        lines.push('');
        return;
      }
      walk(el);
    });
  };
  walk(temp);
  // NBSP → plain space: contentEditable stores runs of spaces as alternating
  // "&nbsp; &nbsp; ", so this restores the exact spacing the user typed (and keeps
  // platforms that choke on U+00A0 happy). Trailing blank lines are structural.
  return lines.join('\n').replace(/\n+$/, '').replace(/\u00A0/g, ' ');
};

export const OMNI_TASK_LABELS: Record<string, string> = {
  text_to_video: 'Text→Video', image_to_video: 'Image→Video',
  reference_to_video: 'Reference→Video', edit: 'Edit Video', extend: 'Extend Video',
};

// ─── 레퍼런스 받는 곳 — 프로젝트(오른쪽 레퍼런스 칸) 또는 메모리(에이전트) ───
// attachFilesTo 는 붙일 때의 검사(형식 · 크기 · 길이 · 개수 · 모드)를 한 곳에서 한다. 드래그 · 붙여넣기는 프로젝트에,
// 에이전트는 메모리에 붙인다 — 에이전트가 사용자의 레퍼런스 칸을 건드리지 않게. 모델 · 모드는 파일마다 받는 곳에서 새로 읽는다.
export type AssetSink = {
  settings: () => GenerationSettings | undefined;
  assets: () => Asset[];
  add: (a: Omit<Asset, 'id'>) => void;
  replace: (id: string, updates: Partial<Omit<Asset, 'id'>>) => void;
};
export const projectAssetSink = (projectId: string): AssetSink => ({
  settings: () => useAppStore.getState().projects.find(p => p.id === projectId)?.settings,
  assets: () => useAppStore.getState().projects.find(p => p.id === projectId)?.assets || [],
  add: (a) => useAppStore.getState().addAsset(projectId, a),
  replace: (id, updates) => useAppStore.getState().replaceAsset(projectId, id, updates),
});
export function memoryAssetSink(settings: GenerationSettings): AssetSink & { list: Asset[] } {
  const list: Asset[] = [];
  return {
    list,
    settings: () => settings,
    assets: () => list,
    add: (a) => { list.push({ ...a, id: crypto.randomUUID() }); },
    replace: (id, updates) => { const i = list.findIndex(x => x.id === id); if (i >= 0) list[i] = { ...list[i], ...updates, id }; },
  };
}

// 붙이지 못한 파일과 이유를 돌려준다 — 알리는 건 부르는 쪽이다.
// src: 파일 객체만으로는 원본 경로를 알 수 없을 때(경로에서 읽어 만든 File) 그 경로와 이미 캐시해 둔 id.
export async function attachFilesTo(sink: AssetSink, allFiles: File[], src?: (f: File) => { path?: string; cacheId?: string } | undefined): Promise<string[]> {
  const rejected: string[] = [];
  for (const file of allFiles) {
    const cur = sink.settings();
    if (!cur) { rejected.push(`${file.name}: 프로젝트가 사라졌습니다`); continue; }
    const assets = sink.assets();
    const model = cur.model;
    const mode = cur.mode;
    const given = src?.(file);
    const pathOf = (f: File) => getFilePath(f) || given?.path || '';
    const cacheOf = (f: File) => (given?.cacheId ? Promise.resolve(given.cacheId) : cacheFile(f));

    // ── Gemini Omni: route drops by the selected Video task (bypasses Seedance mode rules) ──
    if (modelProvider(model) === 'gemini') {
      const task = resolveOmniTask(cur.model, cur.omniTask);
      const isImg = file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name);
      const isVid = file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mpe?g|wmv|3gpp?|flv)$/i.test(file.name);
      if (task === 'text_to_video') { rejected.push(`${file.name}: Text to Video는 에셋을 사용하지 않습니다.`); continue; }
      // Extend takes the same single source clip as Edit — one branch, so the two can
      // never drift apart on size caps, replace-vs-add, or thumbnailing.
      if (task === 'edit' || task === 'extend') {
        if (!isVid) { rejected.push(`${file.name}: ${task === 'extend' ? 'Extend' : 'Edit'} Video는 영상만 받습니다.`); continue; }
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > OMNI_VIDEO_MAX_MB) { rejected.push(`${file.name}: 비디오 크기 초과 ${sizeMB.toFixed(1)}MB (Omni 최대 ${OMNI_VIDEO_MAX_MB}MB)`); continue; }
        // Measure and STORE the length. This path used to skip it entirely, which meant a
        // dropped clip carried no durationSec — so the panel's extend arithmetic and the
        // send-time 30s guard both silently did nothing for anything dropped rather than
        // picked through the panel. Rejecting here matches how every other cap in this
        // app behaves (size, count): refuse at attach, with the reason.
        const dropDur = await getMediaDurationSec(file as File, 'video');
        const dropCap = modelExtendMaxSrcSec(model);
        if (task === 'extend' && dropCap !== undefined && typeof dropDur === 'number' && dropDur > dropCap) {
          rejected.push(`${(file as File).name}: ${dropDur.toFixed(1)}초 — 이어붙일 원본은 ${dropCap}초까지입니다`); continue;
        }
        const existing = assets.find(a => a.type === 'video_url');
        try {
          const thumbnailUrl = await createVideoThumbnail(file).catch(() => '');
          const originalPath = pathOf(file);
          const cacheId = await cacheOf(file);
          const durPatch = dropDur != null ? { durationSec: dropDur } : {};
          if (existing) sink.replace(existing.id, { url: '', file_name: file.name, cacheId, thumbnailUrl, ...durPatch, ...(originalPath ? { originalPath } : {}) });
          else sink.add({ type: 'video_url', url: '', role: 'reference_video', file_name: file.name, cacheId, thumbnailUrl, ...durPatch, ...(originalPath ? { originalPath } : {}) });
        } catch (e: any) { rejected.push(`${file.name}: 캐싱 실패 — ${e.message}`); }
        continue;
      }
      // reference_to_video also accepts video references — 3 verified working 2026-08-28
      // (it was capped at 1 here from an older doc line saying multiple were unsupported,
      // which left the panel showing "비디오 1/3" while a drop was refused at the 2nd file).
      if (task === 'reference_to_video' && isVid) {
        // Count LIVE, not from the `assets` snapshot taken before this loop: dropping
        // three clips at once would otherwise see zero for all three and add them all.
        const vidNow = sink.assets().filter(a => a.type === 'video_url').length;
        const vidCapDrop = omniTaskRefCaps(model, task).video;
        if (vidNow >= vidCapDrop) { rejected.push(`${file.name}: 참조 영상은 ${vidCapDrop}개까지입니다`); continue; }
        const sizeMB = file.size / (1024 * 1024);
        if (sizeMB > OMNI_VIDEO_MAX_MB) { rejected.push(`${file.name}: 비디오 크기 초과 ${sizeMB.toFixed(1)}MB (Omni 최대 ${OMNI_VIDEO_MAX_MB}MB)`); continue; }
        try {
          const thumbnailUrl = await createVideoThumbnail(file).catch(() => '');
          const originalPath = pathOf(file);
          const cacheId = await cacheOf(file);
          sink.add({ type: 'video_url', url: '', role: 'reference_video', file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
        } catch (e: any) { rejected.push(`${file.name}: 캐싱 실패 — ${e.message}`); }
        continue;
      }
      // image tasks: image_to_video (start/end frames) | reference_to_video (≤10 image refs)
      if (!isImg) { rejected.push(`${file.name}: 이 태스크는 이미지만 받습니다. (영상 편집은 Edit Video 태스크)`); continue; }
      const sizeErr = validateImageFile(file);
      if (sizeErr) { rejected.push(`${file.name}: ${sizeErr}`); continue; }
      let role: any = 'reference_image';
      if (task === 'image_to_video') {
        if (!assets.some(a => a.role === 'first_frame')) role = 'first_frame';
        else if (!assets.some(a => a.role === 'last_frame')) role = 'last_frame';
        else { rejected.push(`${file.name}: Image to Video는 시작·끝 프레임 2장까지입니다.`); continue; }
      } else {
        // modelImageMax, not a literal — same reason the reference-video cap moved to
        // modelVideoMax: the panel and this handler each held their own copy and drifted
        // (panel said "비디오 1/3" while a drop was refused at the 2nd file).
        const imgCapDrop = omniTaskRefCaps(model, task).image;
        if (assets.filter(a => a.type === 'image_url').length >= imgCapDrop) {
          rejected.push(`${file.name}: 이미지 한도 ${imgCapDrop}장 초과`); continue;
        }
      }
      try {
        const thumbnailUrl = await createThumbnail(file);
        const originalPath = pathOf(file);
        const cacheId = await cacheOf(file);
        sink.add({ type: 'image_url', url: '', role, file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
      } catch (e: any) { rejected.push(`${file.name}: 처리 실패 — ${e.message || ''}`); }
      continue;
    }

    if (file.type.startsWith('image/')) {
      const imgCount = assets.filter(a => a.type === 'image_url').length;
      const maxImg = modeRefCaps(model, mode).image;   // store.ts — 에이전트 설명서도 같은 수를 읽는다
      if (mode === 'extend_video' && maxImg === 0) { rejected.push(`${file.name}: 이 모델의 extend_video 모드는 이미지를 받지 않습니다.`); continue; }
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
        const originalPath = pathOf(file);
        // Attach → media-cache only. R2 upload happens at send time so
        // every R2 object is born with a task to be tied to.
        const cacheId = await cacheOf(file);
        sink.add({ type: 'image_url', url: '', role, file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
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
      const maxVid = modeRefCaps(model, mode).video;
      // edit_video with a 1-video cap (2.0 계열). When the user drops a new video while one
      // is already attached, treat it as a replace (preserve asset id so any
      // "@[Video 1]" mention keeps pointing to the same slot) rather than
      // rejecting with the over-limit alert. 여러 개 받는 모델(2.5)은 더한다.
      const shouldReplace = mode === 'edit_video' && maxVid === 1 && vidCount >= 1;
      if (!shouldReplace && vidCount >= maxVid) {
        rejected.push(`${file.name}: 비디오 한도 ${maxVid}개 초과`); continue;
      }
      const vidErr = await validateVideoFile(file, modelRefVideoSec(model), refVideoMinSecFor(model, mode));
      if (vidErr) { rejected.push(`${file.name}: ${vidErr}`); continue; }
      const vidDuration = await getMediaDurationSec(file, 'video');
      // Combined cap: all reference videos in one request ≤ 15s total.
      // When replacing, the outgoing video's duration doesn't count.
      const vidOthers = shouldReplace ? assets.filter(a => a.id !== existingVideos[0].id) : assets;
      const vidTotErr = totalDurationError(vidOthers, 'video_url', vidDuration, modelRefVideoSec(model));
      if (vidTotErr) { rejected.push(`${file.name}: ${vidTotErr}`); continue; }
      try {
        const thumbnailUrl = await createVideoThumbnail(file).catch(() => '');
        const originalPath = pathOf(file);
        // Attach → media-cache only (R2 upload deferred to send time)
        const cacheId = await cacheOf(file);
        if (shouldReplace) {
          const existing = existingVideos[0];
          sink.replace(existing.id, {
            url: '', file_name: file.name, cacheId, thumbnailUrl,
            durationSec: vidDuration ?? undefined,
            ...(originalPath ? { originalPath } : {}),
          });
        } else {
          sink.add({ type: 'video_url', url: '', role: 'reference_video', file_name: file.name, cacheId, thumbnailUrl, ...(vidDuration != null ? { durationSec: vidDuration } : {}), ...(originalPath ? { originalPath } : {}) });
        }
      } catch (e: any) { rejected.push(`${file.name}: 캐싱 실패 — ${e.message}`); }

    } else if (file.type.startsWith('audio/') || /\.(wav|mp3|mpeg|mpga)$/i.test(file.name)) {
      if (mode !== 'multimodal_reference' && mode !== 'edit_video') {
        rejected.push(`${file.name}: 이 모드에서는 오디오를 사용할 수 없습니다.`); continue;
      }
      const audCount = assets.filter(a => a.type === 'audio_url').length;
      const maxAud = modeRefCaps(model, mode).audio;
      if (audCount >= maxAud) { rejected.push(`${file.name}: 오디오 한도 ${maxAud}개 초과`); continue; }
      const audErr = await validateAudioFile(file, modelRefAudioSec(model));
      if (audErr) { rejected.push(`${file.name}: ${audErr}`); continue; }
      const audDuration = await getMediaDurationSec(file, 'audio');
      // Combined cap: all reference audio in one request ≤ the model's limit
      // (2.0 15.2s / 2.5 30.2s). Was defaulting to 15 for every model.
      const audTotErr = totalDurationError(assets, 'audio_url', audDuration, modelRefAudioSec(model));
      if (audTotErr) { rejected.push(`${file.name}: ${audTotErr}`); continue; }
      try {
        const originalPath = pathOf(file);
        // Attach → media-cache only (R2 upload deferred to send time)
        const cacheId = await cacheOf(file);
        sink.add({ type: 'audio_url', url: '', role: 'reference_audio', file_name: file.name, cacheId, ...(audDuration != null ? { durationSec: audDuration } : {}), ...(originalPath ? { originalPath } : {}) });
      } catch (e: any) { rejected.push(`${file.name}: 캐싱 실패 — ${e.message}`); }
    } else {
      rejected.push(`${file.name}: 지원하지 않는 파일 형식 (${file.type || '알 수 없음'})`);
    }
  }
  return rejected;
}

/* ─── Send ─── */
export async function sendRequest(input: SendInput, io: SendIO): Promise<string[] | undefined> {
  const { warn } = io;
  // 프로젝트는 스토어에서 새로 읽는다(이름 · 코드 · 아직 있는지). 보낼 설정 · 레퍼런스 · 프롬프트는 input 의 것 —
  // 화면은 그 프로젝트의 지금 값을, 에이전트는 메모리에서 합친 값을 준다. 이 함수는 어느 쪽도 프로젝트에 쓰지 않는다
  // (4K 되쓰기만 화면이 writeBack4k 로 부탁할 때).
  const project = useAppStore.getState().projects.find(p => p.id === input.projectId);
  if (!project) return;
  const settings = input.settings;
  const assets = input.assets;

  // ─── Project gate (strict) — applies to ALL providers, Gemini Omni included ───
  // A project MUST be selected to generate — no exceptions, even if the list is
  // empty / offline (no project → no send). Every send path (Enter / 전송 버튼 /
  // 재생성) funnels through here. Read FRESH from the store (never a stale closure)
  // → a just-picked code is always honored. 코드는 앱 전체에 하나(공동 코드, 26.10.2004~) — projectBilling 이 정책을 안다.
  // 선택은 key 로 들고 있다 — 이름·id 는 지금 목록에서 찾는다(이름이 바뀌었으면 새 이름).
  const bill = projectBilling(useAppStore.getState(), project.id);
  if (!bill) {
    warn(useAppStore.getState().billingProjectKey
      ? '골라 둔 프로젝트 코드를 목록에서 찾을 수 없습니다(종료됐을 수 있어요).\n코드를 다시 골라 주세요.'
      : '프로젝트 코드를 먼저 골라 주세요.\n(설정 패널 맨 위 "프로젝트 코드")');
    return;
  }
  // 에이전트: 가져갈 때 본 코드와 지금 코드가 같아야 한다 — 그 사이 사람이 바꿨으면 보내지 않는다(과금은 사람이 정한다).
  if (input.expectBillingKey !== undefined && bill.key !== input.expectBillingKey) {
    warn(`프로젝트 코드가 바뀌어(지금 "${bill.project}") 보내지 않았습니다.\n확인한 뒤 다시 보내 주세요.`);
    return;
  }
  // ★ Model grant (tracker sheet column G → allow25). Blocks rather than downgrading:
  // clamping 4k→1080p is a graceful loss of a knob, but silently swapping 2.5 for 2.0
  // would hand back a different model's output under the user's own settings. And the
  // stored settings.model is left ALONE — permission can be false before the tracker list
  // lands or while a project has no code yet, so rewriting it here would knock a saved 2.5
  // project back to 2.0. Same rule as the 4k hydration clamp in §5-2.
  if (!isModelAllowed(settings.model, billingOf(useAppStore.getState(), project.id))) {
    const label = MODELS.find(m => m.id === settings.model)?.name || '이 모델';
    warn(`프로젝트 코드 "${bill.project}" 는 ${label} 권한이 없습니다.\n(다른 모델로 바꾸면 바로 생성할 수 있습니다.)`);
    return;
  }

  // Gemini Omni = separate provider → its own send path (no BytePlus payload).
  // (Success reporting to the sheet is Seedance-only; Omni still requires the gate above.)
  if (modelProvider(settings.model) === 'gemini') { return await sendOmni(input, bill, io); }
  // Force mention labels to the CURRENT asset order before reading the prompt.
  // The [project.assets] sync effect (ChatArea) is async (passive), so if the user
  // reorders/replaces and sends in the same tick, the pills could still hold
  // stale "[Image N]" labels — which would mismatch the (current-order)
  // content[] array sent to the API and point a mention at the wrong asset.
  // Re-resolving each pill by its stable data-asset-id closes that race.
  // 작성 칸이 아니라 떨어진 사본에서 — 보내는 쪽(화면 · 에이전트)의 칸을 건드리지 않는다.
  const box = document.createElement('div');
  box.innerHTML = input.promptHtml;
  {
    const namedNow = getAssetNames(assets);
    box.querySelectorAll('.mention-pill').forEach(pill => {
      const id = pill.getAttribute('data-asset-id');
      const a = id ? namedNow.find(n => n.id === id) : null;
      if (a) {
        pill.setAttribute('data-name', a.name);
        const t = pill.querySelector('span[style*="font-weight"]');
        if (t) t.textContent = `[${a.name}]`;
      }
    });
  }
  const plainText = getPlainText(box.innerHTML);
  if (!plainText.trim()) return;
  // Snapshot the pill-bearing HTML so 재사용 can restore mentions exactly —
  // element mentions resolve to bare names in plainText and are otherwise lost.
  const promptHtml = box.innerHTML;

  // Validate required assets BEFORE anything else
  const mode = settings.mode;
  if (mode === 'image_to_video_first' && !assets.some(a => a.role === 'first_frame')) {
    warn('시작 프레임 이미지를 첨부해주세요.'); return;
  }
  if (mode === 'image_to_video_first_last') {
    if (!assets.some(a => a.role === 'first_frame') || !assets.some(a => a.role === 'last_frame')) {
      warn('시작 프레임과 끝 프레임 이미지를 모두 첨부해주세요.'); return;
    }
  }
  if ((mode === 'edit_video' || mode === 'extend_video') && !assets.some(a => a.type === 'video_url')) {
    warn('비디오를 첨부해주세요.'); return;
  }
  // API rule: on 2.0 audio can never be the only reference — at least one image or
  // video must accompany it. Only multimodal can reach this state (other
  // modes either reject audio or already require an image/video above).
  // 2.5 lifted this ("newly supports generating videos with pure audio references"),
  // so it is a per-model capability now, not a blanket rule.
  if (mode === 'multimodal_reference' && !modelAllowsAudioOnly(settings.model)
      && assets.length > 0 && assets.every(a => a.type === 'audio_url')) {
    warn('이 모델은 오디오만으로 생성할 수 없습니다.\n이미지 또는 비디오를 최소 1개 함께 첨부하거나, Seedance 2.5 로 바꿔주세요.'); return;
  }
  // Re-check combined reference durations at send time — assets can arrive
  // via reuse/restore without passing through the attach-time check.
  for (const refType of ['video_url', 'audio_url'] as const) {
    // Each type has its OWN per-model cap. Passing the video one for both meant a 2.5
    // project summed its audio against the video limit — same number by luck on 2.5,
    // but wrong on 2.0 the moment the two ever differ.
    const cap = refType === 'audio_url'
      ? modelRefAudioSec(settings.model)
      : modelRefVideoSec(settings.model);
    const totErr = totalDurationError(assets, refType, null, cap);
    if (totErr) { warn(totErr); return; }
  }

  // ─── Element-library mentions → reference images (merged at send only) ───
  // Collect distinct .element-pill ids in document order, resolve to assets.
  const mentionedElementIds: string[] = [];
  {
    const seen = new Set<string>();
    box.querySelectorAll('.element-pill').forEach(p => {
      const id = p.getAttribute('data-element-id');
      if (id && !seen.has(id)) { seen.add(id); mentionedElementIds.push(id); }
    });
  }
  const elementById = new Map(useAppStore.getState().elementAssets.map(e => [e.id, e] as const));
  const mentionedElements = mentionedElementIds
    .map(id => elementById.get(id))
    .filter(Boolean) as ElementAssetT[];
  if (mentionedElements.length > 0) {
    // Reference images only carry in modes that take them — reference · edit, and extend on a
    // model whose extend takes images (2.5, 26.10.2801~).
    const takesImages = mode === 'multimodal_reference' || mode === 'edit_video'
      || (mode === 'extend_video' && modeRefCaps(settings.model, mode).image > 0);
    if (!takesImages) {
      warn('어셋 멘션은 레퍼런스 이미지를 받는 모드(Multimodal Reference · Edit Video · 2.5 의 Extend Video)에서만 전송됩니다.\n해당 모드로 바꾸거나 프롬프트의 어셋 멘션을 지워주세요.');
      return;
    }
  }
  // Image cap — deliberately OUTSIDE the mention branch above. It used to run only when
  // element mentions existed, so a panel full of images sailed straight through to an
  // API 400. That became reachable once caps differ per model: switch 2.5 (30 images)
  // → 2.0 (9) and the leftovers are over the limit with no mention involved.
  {
    const panelImageCount = assets.filter(a => a.type === 'image_url').length;
    const elementImageCount = mentionedElements.reduce((n, e) => n + e.images.length, 0);
    const cap = mode === 'extend_video' ? modeRefCaps(settings.model, mode).image : modelImageMax(settings.model);
    if (panelImageCount + elementImageCount > cap) {
      warn(`이미지 합산 ${panelImageCount + elementImageCount}장 — 최대 ${cap}장까지만 보낼 수 있습니다.\n(래퍼런스 패널 ${panelImageCount}장 + 어셋 멘션 ${elementImageCount}장)\n이미지를 줄이거나 모델을 바꿔주세요.`);
      return;
    }
  }
  // Same story for video/audio COUNT. Attach-time already caps these, but a model switch
  // can strand assets that were legal under the previous model (2.5 allows 10 videos,
  // 2.0 only 3) — without this the request goes out and BytePlus 400s with an English
  // message the user can't act on. Edit/extend counts vary by model too since 26.10.2801
  // (2.5 edit 10 · extend 10, 2.0 edit 1 · extend 3) — the same stranding applies, so they
  // read their own caps from modeRefCaps.
  if (mode === 'multimodal_reference' || mode === 'edit_video' || mode === 'extend_video') {
    const vCount = assets.filter(a => a.type === 'video_url').length;
    const aCount = assets.filter(a => a.type === 'audio_url').length;
    const caps = modeRefCaps(settings.model, mode);
    const vCap = mode === 'multimodal_reference' ? modelVideoMax(settings.model) : caps.video;
    const aCap = mode === 'multimodal_reference' ? modelAudioMax(settings.model) : caps.audio;
    if (vCount > vCap) { warn(`비디오 ${vCount}개 — 최대 ${vCap}개까지만 보낼 수 있습니다.\n비디오를 줄이거나 모델을 바꿔주세요.`); return; }
    if (aCount > aCap) { warn(`오디오 ${aCount}개 — 최대 ${aCap}개까지만 보낼 수 있습니다.\n오디오를 줄이거나 모델을 바꿔주세요.`); return; }
  }

  // ★ Task-type constraints BEFORE anything reads these settings, so the payload, the
  // stored usedSettings and the card tag all show what was actually sent. Getting this
  // wrong is expensive in a way a 400 is not: the API accepts the request, queues it,
  // classifies it, and only then fails with InvalidParameter.TaskTypeConstraint — the
  // wait and the slot are already spent. Applied here rather than in the panel because a
  // project restored by 재사용 never passes through the panel at all.
  // ★ Deliberately NOT written back to the project. The constraint belongs to (model,
  // mode), not to the project: writing it would leave Edit Video's forced -1 sitting in
  // the settings after the user moves to a mode that allows a duration, with nothing to
  // restore their own value. Same rule the 4k clamp follows in reverse — that one writes
  // back because the permission really did change; this one must not, because nothing
  // about the user's choice changed. usedSettings below still records what was SENT.
  const currentSettings = applyTaskConstraints(settings.model, settings.mode, { ...settings });
  // Clamp resolution up-front so the payload, the stored usedSettings, the card tag,
  // and 재사용 all agree on the value actually sent. Two things are enforced here:
  //   · model capability (Fast/Mini have no 1080p; 4k is flagship-only)
  //   · the live per-project 4k permission from the tracker sheet
  // This is the ONLY place the 4k grant is enforced. The settings panel deliberately
  // never rewrites the setting when permission disappears — doing that mid-typing
  // would yank the config out from under the user. Instead it shows a locked chip and
  // we clamp here, at the moment the queue is fired, exactly as intended.
  {
    const allow4k = isFourKAllowed(billingOf(useAppStore.getState(), project.id));
    const clamped = clampResolution(currentSettings.model, currentSettings.resolution, allow4k);
    if (clamped !== currentSettings.resolution) {
      const was4k = currentSettings.resolution === '4k';
      currentSettings.resolution = clamped;
      // Write back ONLY now, so the panel visibly returns to the allowed tier once the
      // user actually sends — never while they're still composing.
      if (input.writeBack4k) useAppStore.getState().updateProjectSettings(project.id, { resolution: clamped });
      if (was4k) warn(`4K 권한이 해제되어 ${clamped}로 전송합니다.`);
    }
  }
  const currentAssets = [...assets];

  // Pre-flight: legacy data URL safety check (only matters for old assets pre-URL migration)
  const totalPayloadBytes = currentAssets.reduce((sum, a) => {
    if (a.url.startsWith('data:')) return sum + a.url.length;
    return sum;
  }, 0);
  const totalMB = totalPayloadBytes / (1024 * 1024);
  if (totalMB > 60) {
    warn(`전체 에셋 크기 초과: ${totalMB.toFixed(1)}MB\n이미지를 다시 첨부해주세요.`);
    return;
  }

  // 개인판(26.10.2005~): 레퍼런스는 사용자의 R2 로 올린다. R2 를 안 넣었으면 아래 실패 문구('원본이 지워졌을 수 있다')
  // 대신 R2 가 필요하다고 말한다 — 레퍼런스 없는 텍스트 → 영상은 R2 없이 그대로 간다.
  if (PERSONAL && (currentAssets.some(a => a.cacheId || a.originalPath) || mentionedElements.some(el => el.images.length > 0))
      && !(await personalR2Ready())) {
    warn(R2_NEEDED_MSG);
    return;
  }

  // Refresh each reference before sending — all media types go through R2 now,
  // so a single recovery path: cacheId hit → fresh presigned URL, then
  // originalPath fallback (re-read from disk). User-pasted asset:// URIs and
  // raw public URLs have no cacheId, so they're passed through unchanged.
  io.busy?.(true);
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
        // 첨부 때의 cacheId 로 '패널에 보이는 그 파일' 인지 확인한다. 같은 이름의 수정본이
        // 덮어써져 있으면 패널 썸네일과 다른 것이 나가므로, 대신 보내지 않고 멈춘다.
        const result = await reuploadFromPath(a.originalPath, a.cacheId);
        currentAssets[i] = { ...a, url: result.url, cacheId: result.cacheId };
        done = true;
      } catch (err: any) {
        if (err instanceof SourceChangedError) {
          warn(`래퍼런스 '${a.file_name || a.type}' 의 원본 파일이 첨부한 뒤 수정됐습니다.\n첨부할 때의 내용은 캐시가 지워져 되살릴 수 없어서, 수정본을 대신 보내지 않고 멈췄습니다.\n지금 파일로 보내려면 ↻로 다시 첨부해주세요.`);
          io.busy?.(false);
          return;
        }
        /* 그 밖의 실패는 아래에서 한꺼번에 알린다 */
      }
    }

    if (!done) {
      warn(`래퍼런스 파일 재업로드 실패: ${a.file_name || a.type}\n원본 파일이 이동/삭제됐을 수 있습니다. 다시 첨부해주세요.`);
      io.busy?.(false);
      return;
    }
  }

  // Resolve mentioned element images → fresh R2 URLs (same cache→R2 path as
  // panel assets). Built as reference_image content items, appended AFTER the
  // panel assets so the panel's own [Image N] numbering is unaffected.
  const elementContent: any[] = [];
  for (const el of mentionedElements) {
    for (const img of el.images) {
      try {
        const url = await resolveElementImageUrl(img);
        elementContent.push({ type: 'image_url', image_url: { url }, role: 'reference_image' });
      } catch {
        warn(`어셋 '${el.name}'의 이미지 업로드에 실패했습니다. 다시 시도해주세요.`);
        io.busy?.(false);
        return;
      }
    }
  }

  // All checks passed — keep prompt/settings/assets intact for fast iteration; user manually clears if needed

  // 1~3 으로 막는다 — 설정은 받은 영상이나 에이전트 요청에서도 들어온다(26.10.801 검토: 50 이 들어오면 50번 결제된다).
  const outputCount = Math.min(Math.max(1, Math.floor(Number(settings.output_count) || 1)), OUTPUT_COUNT_MAX);
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

  // Mentioned-element images for the card's reference strip. Kept separate from
  // usedAssets (panel refs) because reuse restores usedAssets to the panel,
  // whereas element images must ride the mention, not the panel. Thumbnails only.
  const usedElementImages = mentionedElements.flatMap(el =>
    el.images.map((img) => ({ id: `${el.id}__${img.id}`, elementId: el.id, imageId: img.id, name: el.name, category: el.category, cacheId: img.cacheId, libId: img.libId, url: img.thumbnailUrl || img.url }))
  );

  // 보내기 직전 — 위의 기다림(업로드) 사이에 프로젝트가 지워졌거나 프로젝트 코드가 바뀌었으면(종료로 비워졌으면) 보내지 않는다.
  // 여기부터 요청을 띄울 때까지는 await 가 없다 — 확인한 코드 그대로 카드 · 요청에 찍힌다.
  {
    const why = recheckBeforePost(project.id, bill.key, currentSettings.model, currentSettings.resolution);
    if (why) { warn(why); io.busy?.(false); return; }
  }
  for (let i = 0; i < outputCount; i++) {
    const id = crypto.randomUUID();
    systemMessageIds.push(id);
    // 보낼 때의 프로젝트 코드를 메시지에 굽는다. 프로젝트의 코드는 나중에 바뀔 수 있고 시트에서 이름이
    // 바뀔 수도 있다 — 이 카드가 어디로 찍혔는지 · NCP 폴더를 되찾는 힌트다.
    useAppStore.getState().addMessage(project.id, { id, role: 'system', content: `영상 생성 시작... (${i + 1}/${outputCount})`, status: 'queued', promptText: plainText, promptHtml, usedSettings: currentSettings, usedAssets: thumbAssets, usedElementImages, usedCollection: boundCollectionOf(project.id), videoStorage: { project: bill.project, projectId: bill.id, projectKey: bill.key } } as any);
  }
  io.sent?.();

  try {
    // Bind each element mention to its reference image via the BytePlus
    // positional marker [Image N]. N continues AFTER the panel images and is
    // computed fresh from the CURRENT panel here (never cached) — so trimming
    // the panel 8→7 shifts the asset to [Image 8] correctly. Multi-image
    // assets take consecutive numbers ([Image 8][Image 9]). Numbering walks
    // mentionedElements in the SAME order their images are appended to
    // content below, so labels and images line up exactly. The displayed pill
    // and stored promptText stay the bare name; only this API text changes.
    let imgN = currentAssets.filter(a => a.type === 'image_url').length;
    const elementTagMap = new Map<string, string>();
    for (const el of mentionedElements) {
      elementTagMap.set(el.id, el.images.map(() => `[Image ${++imgN}]`).join(''));
    }
    const apiText = getPlainText(promptHtml, elementTagMap);
    const content: any[] = [{ type: 'text', text: apiText }];
    content.push(...currentAssets.map(asset => {
      const item: any = { type: asset.type, [asset.type]: { url: asset.url } };
      if (currentSettings.mode !== 'image_to_video_first') item.role = asset.role;
      return item;
    }));
    content.push(...elementContent); // element-library mentions as extra reference images
    const payload: any = {
      model: currentSettings.model, content,
      generate_audio: currentSettings.return_last_frame ? false : currentSettings.generate_audio,
      ratio: currentSettings.ratio, duration: currentSettings.duration,
      resolution: currentSettings.resolution, watermark: false,
      // app-only fields; server.ts strips both before BytePlus + maps them to the task for credit
      // reporting. project_id 가 있으면 트래커가 그것으로 프로젝트를 찾아 '지금 이름' 으로 적는다.
      project: bill.project, project_id: bill.id,
    };
    // Only models that declare one send output_format at all — omitting it keeps every
    // 2.0 request byte-for-byte what it has always been.
    // User's pick when this model offers one, else the model's default. Models that
    // never declared a format still send nothing at all — unchanged requests.
    const outFmt = resolveOutputFormat(currentSettings.model, currentSettings.output_format);
    if (outFmt) payload.output_format = outFmt;
    // The mode the user picked, stated outright. reference / edit / extend all travel as
    // the same reference_* role, so without this the API had to read the intent out of the
    // prompt's wording — meaning the mode dropdown never actually reached the server, and a
    // plainly-worded prompt in Edit Video quietly generated a brand-new clip instead.
    // Read from `content` (already fully built above, elements included) and from
    // `currentSettings` — the same constrained copy the rest of the payload uses — so the
    // declared task can't disagree with either the attachments or the ratio/duration
    // going with it. Nothing to assert → omitted, and the API infers as it always did.
    const refTask = refTaskTypeFor(currentSettings.model, currentSettings.mode, content);
    if (refTask) payload.omni_reference_task_type = refTask;
    if (currentSettings.return_last_frame) payload.return_last_frame = true;
    // 초안. 해상도는 applyTaskConstraints 가 이미 480p 로 바꿔 두었고, 초안을 모르는 모델이면
    // 거기서 draft 자체가 꺼진다. 나머지(모델·토큰 과금·트래커 보고)는 일반 생성과 똑같다.
    if (currentSettings.draft) payload.draft = true;

    // Settings + assets are preserved after send so user can iterate quickly with same setup

    await Promise.allSettled(systemMessageIds.map(async (sysMsgId) => {
      try {
        const res = await fetch('/api/byteplus/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const text = await res.text();
        let data; try { data = JSON.parse(text); } catch { throw new Error(res.status === 413 ? '파일 크기 초과 (이미지 개당 30MB, 전체 64MB 이하)' : `서버 응답 오류 (${res.status})`); }
        if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new Error(data.error?.message || data.msg || data.error || JSON.stringify(data));
        const taskId = data.id || data.data?.task_id;
        if (!taskId) throw new Error('Task ID를 받지 못했습니다.');
        useAppStore.getState().updateMessage(project.id, sysMsgId, { content: `Task 생성 완료. ID: ${taskId}`, taskId, status: 'running', startTime: Date.now(), usedSettings: currentSettings, usedAssets: thumbAssets, usedElementImages, promptText: plainText, promptHtml, apiPrompt: apiText });
        useAppStore.getState().pollTask(project.id, sysMsgId, taskId);
      } catch (error: any) {
        useAppStore.getState().updateMessage(project.id, sysMsgId, { content: '영상 생성 실패', status: 'failed', error: error.message, endTime: Date.now() });
      }
    }));
  } catch (error: any) {
    systemMessageIds.forEach(id => useAppStore.getState().updateMessage(project.id, id, { content: '영상 생성 실패', status: 'failed', error: error.message, endTime: Date.now() }));
  } finally { io.busy?.(false); }
  // 만든 카드 id — 에이전트 작업함이 진행을 따라가는 데 쓴다. 위에서 멈춘 경우는 undefined.
  return systemMessageIds;
}

/* ─── Gemini Omni Flash send (separate provider, sync) ─── */
// /api/gemini/generate holds ~30-40s and returns a cached .mp4 URL. No BytePlus
// task/poll — the message goes running → (awaited) → succeeded. Panel images
// (max 10) ride as inline base64; ratio→aspect(16:9|9:16), duration→"Ns"(3-10),
// thinking always high, task always explicit (no Unspecified). Seedance path untouched.
async function sendOmni(input: SendInput, bill: { project: string; id: string; key: string }, io: SendIO): Promise<string[] | undefined> {
  const { warn } = io;
  const projectId = input.projectId;
  const assets = input.assets;   // ★ 이름을 따로 — 아래 Omni 요청의 지역 변수 input 과 겹친다(그 블록 안에서 input 을 읽으면 TDZ)
  let sentIds: string[] | undefined;   // 만든 카드 id (에이전트 작업함용)
  const promptHtml = input.promptHtml;
  const userPrompt = getPlainText(promptHtml);
  const s = input.settings;
  const box = document.createElement('div');
  box.innerHTML = promptHtml;

  // @element mentions — shared across the image tasks
  const mentionedElementIds: string[] = [];
  { const seen = new Set<string>(); box.querySelectorAll('.element-pill').forEach(p => { const id = p.getAttribute('data-element-id'); if (id && !seen.has(id)) { seen.add(id); mentionedElementIds.push(id); } }); }
  const elementById = new Map(useAppStore.getState().elementAssets.map(e => [e.id, e] as const));
  const mentionedElements = mentionedElementIds.map(id => elementById.get(id)).filter(Boolean) as ElementAssetT[];

  // Resolved against THIS model — a stored task the selected model doesn't offer (1.1's
  // Extend on the Flash preview) must never reach the wire. The API validates the request
  // schema, not the model, so it would accept 'extend' addressed to the preview and we
  // would only find out from the output. Never read s.omniTask raw on the send path.
  const task = resolveOmniTask(s.model, s.omniTask);
  // `resolution` for a model that offers more than one, clamped by the 4K grant.
  // Used by every Omni task including edit/extend — verified 2026-08-28 that BOTH honour
  // it (360p source + resolution:'1080p' returned 1920x1080). They reject aspect_ratio,
  // which is what made "geometry comes from the source" look true for resolution too;
  // omitting it actually caps the output at 720p, so a 4K source came back 720p.
  const omniResolution = (): string | undefined => {
    if (modelResolutions(s.model).length <= 1) return undefined;
    const st = useAppStore.getState();
    return clampResolution(s.model, s.resolution, isFourKAllowed(billingOf(st, projectId)));
  };
  // Element @mentions only mean something for reference_to_video, where they become
  // <IMAGE_REF_N>. Switching the task clears the ASSETS but not the PROMPT, so a pill
  // outlives the task it was written for — and the failure was silent in both directions:
  // image_to_video with no start frame quietly promoted the element's image TO the start
  // frame, and edit dropped it while leaving the bare element name sitting in the
  // instruction text. Mirrors the Seedance guard in handleSend (mode !== reference/edit).
  if (mentionedElements.length > 0 && task !== 'reference_to_video') {
    warn(`어셋 멘션은 Reference to Video에서만 레퍼런스로 전송됩니다.\n(현재 ${OMNI_TASK_LABELS[task] || task})\nReference to Video로 바꾸거나 프롬프트의 어셋 멘션을 지워주세요.`);
    return;
  }
  // Read a cached IMAGE as {base64,mime}. (Edit's source video skips this: the server
  // reads it straight off the media-cache disk by id — see _uploadCacheId below.)
  const readCacheB64 = async (cacheId?: string, rawUrl?: string): Promise<{ data: string; mime: string } | null> => {
    let dataUrl = '';
    if (cacheId) { try { dataUrl = await readCacheAsDataUrl(cacheId); } catch { /* fall through */ } }
    if (!dataUrl && typeof rawUrl === 'string' && rawUrl.startsWith('data:')) dataUrl = rawUrl;
    const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    return m ? { data: m[2], mime: m[1] } : null;
  };
  const videoMimeOf = (fn?: string) => { const n = (fn || '').toLowerCase(); return n.endsWith('.mov') ? 'video/quicktime' : n.endsWith('.webm') ? 'video/webm' : n.endsWith('.mpeg') || n.endsWith('.mpg') ? 'video/mpeg' : n.endsWith('.wmv') ? 'video/x-ms-wmv' : n.endsWith('.3gp') || n.endsWith('.3gpp') ? 'video/3gpp' : n.endsWith('.flv') ? 'video/x-flv' : 'video/mp4'; };

  let payload: any;
  let usedImgAssets: any[] = [];
  let usedElementImages: any[] = [];

  if (task === 'extend') {
    // ── Extend Video: 1 source VIDEO → appends to its end ────────────────────────────
    // Same asset shape as Edit on purpose — 1 clip, no images — so Extend never touches
    // the reference/element path. Measured 2026-08-28: response_format.duration is the
    // number of seconds to APPEND (10s source + '3s' → 13.0s), aspect_ratio is REJECTED
    // outright ("Aspect ratio cannot be set in response format for extend task"), and
    // `resolution` IS honoured — omitting it caps the output at 720p regardless of the
    // source, so it must be sent. Source clip must be <= 30s; output tops out at 40s.
    const video = assets.find((a: any) => a.type === 'video_url');
    if (!video) { warn('Extend Video는 이어붙일 원본 영상 1개가 필요합니다. 아래 에셋 영역에서 영상을 올려주세요.'); return; }
    if (!video.cacheId) { warn('원본 영상 캐시를 찾지 못했습니다. 영상을 다시 올려주세요.'); return; }
    // The API refuses a source over 30s outright ("Videos longer than 30s are not supported
    // for extension."), and Omni's call is synchronous — sending anyway costs the user a
    // ~30s wait for a certain failure. Measured 2026-08-28: 30.016s passed, 33.0s did not.
    {
      const srcCap = modelExtendMaxSrcSec(s.model);
      const d = (video as any).durationSec;
      if (srcCap !== undefined && typeof d === 'number' && d > srcCap) {
        warn(`원본이 ${d.toFixed(1)}초입니다 — ${srcCap}초를 넘는 영상은 이어붙일 수 없습니다.
(만들 수 있는 최대 길이는 ${modelExtendMaxOutSec(s.model)}초입니다.)`);
        return;
      }
    }
    if (!userPrompt.trim()) { warn('이어서 무슨 일이 일어날지 설명을 입력해주세요. (예: 그대로 걸어가 문을 연다)'); return; }
    if (assets.some((a: any) => a.type === 'image_url')) { warn('Extend Video는 이미지를 사용하지 않습니다. 원본 영상 1개만 남겨주세요.'); return; }
    // Continuation instruction over 1 clip — no positional markers exist for this task,
    // so strip any Seedance [Image/Video/Audio N] a stray panel mention would leave behind.
    const extText = userPrompt.replace(/\[(?:Image|Video|Audio) \d+\]\s*/g, '').trim();
    const addSec = Math.max(3, Math.min(10, Math.round(s.duration || 5)));
    payload = {
      model: s.model,
      input: [{ type: 'video', _uploadCacheId: video.cacheId, mime_type: videoMimeOf(video.file_name) }, { type: 'text', text: extText }],
      response_format: { type: 'video', duration: `${addSec}s`, delivery: 'uri', ...(omniResolution() ? { resolution: omniResolution() } : {}) }, // no aspect_ratio — the API rejects it for extend
      generation_config: { video_config: { task: 'extend' }, thinking_level: 'high' },
    };
    usedImgAssets = [{ ...video, url: video.thumbnailUrl || video.url }];
    io.busy?.(true);
  } else if (task === 'edit') {
    // ── Edit Video: exactly 1 source VIDEO → Files API (uploaded server-side by cacheId) ──
    const video = assets.find((a: any) => a.type === 'video_url');
    if (!video) { warn('Edit Video는 편집할 소스 영상 1개가 필요합니다. 아래 에셋 영역에서 영상을 올려주세요.'); return; }
    if (!video.cacheId) { warn('소스 영상 캐시를 찾지 못했습니다. 영상을 다시 올려주세요.'); return; }
    if (!userPrompt.trim()) { warn('영상을 어떻게 편집할지 설명을 입력해주세요. (예: 화면 전체에 눈 내리는 효과 추가)'); return; }
    if (assets.some((a: any) => a.type === 'image_url')) { warn('Edit Video는 이미지를 사용하지 않습니다. 소스 영상 1개만 남겨주세요.'); return; }
    // Edit is a plain instruction over the 1 source video — it uses no positional markers,
    // so strip any Seedance [Image/Video/Audio N] that a stray panel mention would leave in.
    const editText = userPrompt.replace(/\[(?:Image|Video|Audio) \d+\]\s*/g, '').trim();
    payload = {
      model: s.model,
      input: [{ type: 'video', _uploadCacheId: video.cacheId, mime_type: videoMimeOf(video.file_name) }, { type: 'text', text: editText }],
      response_format: { type: 'video', delivery: 'uri', ...(omniResolution() ? { resolution: omniResolution() } : {}) }, // edit: duration/aspect rejected by the API; resolution IS honoured
      generation_config: { video_config: { task: 'edit' }, thinking_level: 'high' },
    };
    usedImgAssets = [{ ...video, url: video.thumbnailUrl || video.url }];
    io.busy?.(true);
  } else {
    // ── Text / Image / Reference tasks (+ unofficial end-frame under image_to_video) ──
    const firstFrame = assets.find((a: any) => a.type === 'image_url' && a.role === 'first_frame');
    const lastFrame = assets.find((a: any) => a.type === 'image_url' && a.role === 'last_frame');
    const refImgs = assets.filter((a: any) => a.type === 'image_url' && a.role !== 'first_frame' && a.role !== 'last_frame');
    // reference_to_video may also take a video reference — VERIFIED to work (the clip's scene
    // is reproduced, image refs restyle it). Capped at 1 (doc: multiple videos unsupported).
    const refVideos = task === 'reference_to_video' ? assets.filter((a: any) => a.type === 'video_url') : [];

    // Ordered image inputs = [firstFrame?, lastFrame?, panel refImgs…, element images…].
    // The doc's <IMAGE_REF_N> tags map 1:1 to this array order (0-based), so element
    // @mentions can be bound to their image positionally — the Omni analogue of the
    // Seedance [Image N] marker. A reference video (if any) is appended after the images.
    const imgSources: { asset?: any; img?: any }[] = [];
    if (firstFrame) imgSources.push({ asset: firstFrame });
    if (lastFrame) imgSources.push({ asset: lastFrame });
    for (const a of refImgs) imgSources.push({ asset: a });
    for (const el of mentionedElements) for (const img of el.images) imgSources.push({ img });

    if (!userPrompt.trim() && imgSources.length === 0) return;
    if (lastFrame && !firstFrame) { warn('끝 프레임만은 넣을 수 없습니다 — 시작 프레임을 먼저 넣어주세요.'); return; }
    // modelImageMax, not a literal — the panel counter and this check disagreed (9 vs 10)
    // once before, exactly because one of them held its own copy of the number.
    const omniImgCap = modelImageMax(s.model);
    if (imgSources.length > omniImgCap) { warn(`${MODELS.find(m => m.id === s.model)?.name || 'Omni'}는 이미지 최대 ${omniImgCap}장입니다. 현재 ${imgSources.length}장(프레임 + 래퍼런스 + 어셋멘션 합산) — 줄여주세요.`); return; }

    io.busy?.(true);
    const imageParts: any[] = [];
    try {
      // 원본만 보낸다. 못 읽으면 멈춘다 — 예전에는 빠뜨리고 보내거나(<IMAGE_REF_N> 번호가 밀린다) 썸네일을 대신 보냈다.
      for (const src of imgSources) { const b = await readCacheB64(src.asset?.cacheId || src.img?.libId || src.img?.cacheId, src.asset?.url || src.img?.url); if (!b) throw new Error(`'${src.asset?.file_name || src.img?.file_name || '레퍼런스'}' 원본을 읽지 못했습니다. 다시 넣어주세요.`); imageParts.push({ type: 'image', data: b.data, mime_type: b.mime }); }
    } catch (e: any) { warn('이미지 읽기 실패: ' + e.message); io.busy?.(false); return; }
    if (imgSources.length > 0 && imageParts.length === 0) { warn('첨부 이미지를 읽지 못했습니다. 다시 넣어주세요.'); io.busy?.(false); return; }

    // Gemini's image rules differ from BytePlus's, and every upload route in this app
    // validates against BytePlus (30MB · JPEG/PNG/WebP/BMP/GIF/TIFF). Google's model card
    // says 20MB inline and PNG/JPEG/WebP/HEIC/HEIF — so BMP/GIF/TIFF pass our uploader and
    // fail at Google, and a 21–30MB image does the same. Checked HERE, once, because the
    // eight upload sites (panel, replace, drop, paste, element library…) all converge on
    // this array; putting it in the uploader would mean eight copies of the same rule and
    // would wrongly restrict the element library, whose images are shared with Seedance.
    const GEMINI_IMG_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
    for (const p of imageParts) {
      const mb = (p.data?.length || 0) * 0.75 / (1024 * 1024); // base64 → bytes
      if (mb > 20) { warn(`이미지 하나가 ${mb.toFixed(1)}MB입니다 — Gemini는 20MB까지입니다.\n(Seedance는 30MB라 업로드는 통과했습니다.)`); io.busy?.(false); return; }
      if (!GEMINI_IMG_MIME.includes(p.mime_type)) { warn(`Gemini가 지원하지 않는 이미지 형식입니다: ${p.mime_type}\n(PNG · JPEG · WebP · HEIC · HEIF만 가능. Seedance는 BMP/GIF/TIFF도 받습니다.)`); io.busy?.(false); return; }
    }

    // Documented per-task image rules — fail clearly HERE instead of with a raw API error.
    if (task === 'text_to_video' && imageParts.length > 0) { warn('Text to Video는 이미지를 사용하지 않습니다.\n이미지를 빼거나 Image / Reference to Video로 바꿔주세요.'); io.busy?.(false); return; }
    if (task === 'image_to_video' && imageParts.length === 0) { warn('Image to Video는 이미지가 필요합니다. 시작 프레임을 넣어주세요.'); io.busy?.(false); return; }
    if (task === 'image_to_video' && !lastFrame && imageParts.length > 1) { warn('Image to Video는 시작 프레임 1장만 지원합니다.\n여러 장이면 Reference to Video로 바꾸거나, 끝 프레임을 쓰려면 시작·끝 2장만 두세요.'); io.busy?.(false); return; }
    if (task === 'reference_to_video' && imageParts.length === 0) { warn('Reference to Video는 참조 이미지가 최소 1장 필요합니다.\n위 래퍼런스 영역에서 이미지를 올리거나 @어셋을 멘션해주세요.'); io.busy?.(false); return; }

    // Build the API prompt with the doc's image-role tags (<FIRST_FRAME>, <IMAGE_REF_N>).
    let effTask = task;
    let promptText: string;
    const videoParts: any[] = []; // reference_to_video: optional video reference (server-uploaded)
    if (task === 'image_to_video' && lastFrame && modelHasFirstLastFrame(s.model)) {
      // Documented first+last frame interpolation (model card: "Videos from first and last
      // frames - Supported"). Stays on image_to_video and tags the two frames directly, so it
      // needs none of the reference route's "do not treat these as literal frames" hedging.
      // Verified 2026-08-28 by measurement, not eyeball: a red ball at left as the first
      // image and at right as the second came back as frame 0 and the final frame.
      promptText = ('<FIRST_FRAME> ' + getPlainText(promptHtml) + ' <LAST_FRAME>').replace(/\s+/g, ' ').trim();
    } else if (task === 'image_to_video' && lastFrame) {
      // Models WITHOUT the documented feature (the Flash preview): interpolation is
      // doc-unsupported there, so route as reference_to_video with REAL tags (no fake
      // <LAST_FRAME>). Best-effort only — the UI says so. Unchanged from before 1.1.
      effTask = 'reference_to_video';
      promptText = `${getPlainText(promptHtml)} Begin the video on <IMAGE_REF_0> and finish on <IMAGE_REF_1>, transitioning smoothly between them.`.trim();
    } else if (task === 'image_to_video') {
      // Single start frame → <FIRST_FRAME> binds image[0] (doc: "<FIRST_FRAME> a woman is walking").
      promptText = `<FIRST_FRAME> ${getPlainText(promptHtml)}`.trim();
    } else if (task === 'reference_to_video') {
      // Bind BOTH mention kinds to <IMAGE_REF_N> in place (N = the image's index in the
      // input array), so @mentions carry Omni's tag syntax instead of Seedance's [Image N].
      // Shared counter walks the SAME order the images are appended: panel assets first
      // (each 1 image), then element images (an element may contribute several).
      let refN = 0;
      const mentionTagMap = new Map<string, string>(); // panel-asset id → <IMAGE_REF_N>
      for (const a of [firstFrame, lastFrame, ...refImgs].filter(Boolean) as any[]) mentionTagMap.set(a.id, `<IMAGE_REF_${refN++}>`);
      // Video mentions have NO positional tag (Omni tags are image-only) — replace with a
      // natural-language phrase so an @Video mention never leaks the Seedance "[Video N]" marker.
      // With more than one clip a single shared phrase can't point at a specific one, so
      // number them the way the images are numbered (3 reference videos verified working).
      (refVideos as any[]).forEach((v, i) => mentionTagMap.set(v.id,
        refVideos.length > 1 ? `reference video clip ${i + 1}` : 'the reference video clip'));
      const elementTagMap = new Map<string, string>(); // element id → its <IMAGE_REF_N>(s)
      for (const el of mentionedElements) elementTagMap.set(el.id, el.images.map(() => `<IMAGE_REF_${refN++}>`).join(' '));
      const body = getPlainText(promptHtml, elementTagMap, mentionTagMap);
      // The video reference has NO positional tag (doc defines only <IMAGE_REF_N> for images),
      // and the model IGNORES an attached clip unless the prompt explicitly names it — so when a
      // reference video is present we call it out in the guiding suffix (verified: without this the
      // output used only the images).
      promptText = (refVideos.length
        ? `${body} Use the given image(s) as style/subject references and the given video ${refVideos.length > 1 ? 'clips' : 'clip'} as the scene and motion reference; do not treat any of them as literal initial frames.`
        : `${body} Use the given image(s) as references for the video; do not treat them as literal initial frames.`).trim();
      // Optional reference video → Files API (server uploads by cacheId, appended after images).
      const vidCap = modelVideoMax(s.model);
      if (refVideos.length > vidCap) { warn(`Reference to Video의 참조 영상은 ${vidCap}개까지입니다.`); io.busy?.(false); return; }
      for (const v of refVideos) {
        if (!v.cacheId) { warn(`참조 영상(${v.file_name || ''}) 캐시를 찾지 못했습니다. 다시 올려주세요.`); io.busy?.(false); return; }
        videoParts.push({ type: 'video', _uploadCacheId: v.cacheId, mime_type: videoMimeOf(v.file_name) });
      }
    } else {
      // text_to_video — no images.
      promptText = getPlainText(promptHtml);
    }
    // Safety net: Omni has no [Video N]/[Audio N] markers (Seedance-only syntax). A stray
    // media mention must never leak that into the prompt. (Reference already turns @Video
    // into "the reference video clip"; this catches audio + the other tasks.)
    promptText = promptText.replace(/\[(?:Video|Audio) \d+\]\s*/g, '').trim();

    const parts = [...imageParts, ...videoParts];
    const input = parts.length ? [...parts, { type: 'text', text: promptText }] : promptText;
    const aspect = s.ratio === '9:16' ? '9:16' : '16:9';
    const dur = Math.max(3, Math.min(10, Math.round(s.duration || 5)));
    const rf: any = { type: 'video', aspect_ratio: aspect, duration: `${dur}s`, delivery: 'uri' };
    // `resolution` is sent ONLY by models that declare more than one. The Flash preview
    // declares ['720p'], so its request stays byte-for-byte what it has always been — it
    // has never sent this field and this patch must not be the thing that starts.
    // Measured on 1.1 (2026-08-28): 720p/1080p/4k all return the real pixel dimensions.
    const rres = omniResolution();
    if (rres) rf.resolution = rres;
    payload = {
      model: s.model,
      input,
      response_format: rf,
      generation_config: { video_config: { task: effTask }, thinking_level: 'high' },
    };
    usedImgAssets = [firstFrame, lastFrame, ...refImgs, ...refVideos].filter(Boolean).map((a: any) => ({ ...a, url: a.thumbnailUrl || a.url }));
    usedElementImages = mentionedElements.flatMap(el => el.images.map(img => ({ id: `${el.id}__${img.id}`, elementId: el.id, imageId: img.id, name: el.name, category: el.category, cacheId: img.cacheId, libId: img.libId, url: img.thumbnailUrl || img.url })));
  }

  // 보내기 직전 — 그 사이 프로젝트가 지워졌거나 코드가 바뀌었으면 보내지 않는다(sendRequest 와 같은 확인).
  {
    const why = recheckBeforePost(projectId, bill.key, s.model, payload?.response_format?.resolution);
    if (why) { warn(why); io.busy?.(false); return; }
  }
  const settingsSnapshot = { ...s };
  try {
    const count = Math.min(Math.max(1, Math.floor(Number(s.output_count) || 1)), OUTPUT_COUNT_MAX);   // 위 Seedance 와 같이 1~3
    const ids: string[] = [];
    // 과금 프로젝트는 보낼 때 한 번 정한다(sendRequest 가 읽고 바로 위에서 다시 확인한 그 코드). 이름은 NCP 폴더,
    // id·key 는 이름이 바뀌어도 같은 프로젝트를 가리키는 값.
    const omniStorage = { project: bill.project, projectId: bill.id, projectKey: bill.key };
    for (let i = 0; i < count; i++) {
      const id = crypto.randomUUID(); ids.push(id);
      useAppStore.getState().addMessage(projectId, { id, role: 'system', content: `Omni 생성 중... (${i + 1}/${count})`, status: 'running', startTime: Date.now(), promptText: userPrompt, promptHtml, apiPrompt: typeof payload?.input === 'string' ? payload.input : (payload?.input?.find?.((x: any) => x?.type === 'text')?.text ?? undefined), usedSettings: settingsSnapshot, usedAssets: usedImgAssets, usedElementImages, usedCollection: boundCollectionOf(projectId), videoStorage: omniStorage } as any);
    }
    sentIds = ids;
    io.sent?.();

    // Fire each generation in the BACKGROUND (no await). Omni's HTTP call is synchronous
    // (~40–90s), but we must NOT hold the composer locked that whole time — Seedance only
    // locks it for the ~2s task submit, then the video renders in the background. So we
    // kick the fetches off unawaited and unlock immediately; each card resolves on its own,
    // letting the user queue more Omni prompts while one is still rendering. A 4-min timeout
    // guards against a rare server stall leaving a card spinning "생성 중" forever.
    ids.forEach((id) => { void (async () => {
      const ctrl = new AbortController();
      // 40 minutes. This was 4, which was shorter than the server's own limits — so a slow
      // job was cut off by US before any answer could arrive, and the card said "생성 시간
      // 초과 (4분)" with nothing else to act on. Sized from measurement, not taste:
      // 2026-08-28, same 10s 4K source: +3s returned HTTP 200 after 1311s (21.9 min) and
      // +10s came back in about 10 — the bigger append was faster, so this tracks load
      // rather than output length and cannot be predicted from the request. 40 min leaves
      // room above the slower sample. 360p lands in ~50s and 1080p in ~2min, so this
      // ceiling only ever matters to 4K. Omni is synchronous, but the
      // fetch is fired unawaited, so a long wait holds one card open and nothing else.
      const timer = window.setTimeout(() => ctrl.abort(), 2400000);
      try {
        // project·project_id 는 앱 전용 필드다 — 서버가 NCP 보관 폴더(id 가 있으면 id, 없으면 이름)를 정하는 데만 쓰고 구글로 보내기 전에 지운다.
        const r = await fetch('/api/gemini/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, project: omniStorage.project, project_id: omniStorage.projectId }), signal: ctrl.signal });
        const t = await r.text();
        let d: any; try { d = JSON.parse(t); } catch { throw new Error(`서버 응답 오류 (${r.status})`); }
        if (!r.ok) throw new Error(d.error || `생성 오류 (${r.status})`);
        if (!d.videoUrl) throw new Error('영상 URL을 받지 못했습니다.');
        // Omni 는 서버가 항상 .mp4 로 캐시에 쓴다.
        useAppStore.getState().updateMessage(projectId, id, { status: 'succeeded', videoUrl: d.videoUrl, taskId: d.id, content: 'Omni 완료', videoStorage: { ...omniStorage, ext: '.mp4' }, endTime: Date.now() });
      } catch (error: any) {
        const msg = error.name === 'AbortError'
          ? '응답 없이 40분이 지나 중단했습니다.\n4K 이어붙이기는 20분 이상 걸리는 게 정상이지만 여기까지는 아닙니다 — 요청이 중간에 끊겼거나 앱이 재시작된 경우입니다.'
          : error.message;
        useAppStore.getState().updateMessage(projectId, id, { status: 'failed', content: '생성 실패', error: msg, endTime: Date.now() });
      } finally {
        window.clearTimeout(timer);
      }
    })(); });
  } finally {
    // Brief visible spin (~0.8s) like Seedance's task-submit, THEN unlock — not the whole
    // 40–90s. The delay also un-batches the true→false so the spinner actually renders.
    // The generation keeps rendering in the background card; the composer is free to queue more.
    if (io.busy) window.setTimeout(() => io.busy?.(false), 800);
  }
  return sentIds;
}
