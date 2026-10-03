// ─── 에이전트 작업함 — 무엇을 받아 주는가 (26.10.302~) ────────────────────────────────────
// 같은 PC 의 에이전트(Claude·Codex 의 freewill 커넥터가 내려 주는 send-to-seedance)가 넣는 생성 요청을 위해
//   · agentSettings    요청의 설정을 프로젝트 설정 위에 얹는다 — 설정 패널에서 고를 수 있는 값만 받는다.
//   · buildAgentManual 에이전트가 읽는 '사용 설명서'. MODELS 와 패널의 목록(store.ts)에서 그때그때 만든다 —
//                      모델을 추가하거나 한도를 바꾸면 설명서도 저절로 바뀐다. 사람이 쓰는 건 MODELS 의 guide·notes 뿐.
// 설명서 버전(앱 버전 + 내용 지문)은 server.ts 가 작업함 응답마다 붙이고, 에이전트가 예전에 읽은 버전으로 보내면
// "업데이트됐으니 다시 읽어" 로 돌려보낸다 — 한 채팅방을 몇 달 써도 보낼 때마다 지금 앱에 맞춰진다.
// 화면(ChatArea)이 만들어 서버에 올린다 — 서버는 store 를 import 하지 않는다.
import {
  MODELS, GENERATION_MODES, SEEDANCE_RATIOS, OMNI_RATIO_IDS, OMNI_TASK_NAMES, OUTPUT_FORMAT_LABEL,
  RETURN_LAST_FRAME_MODES, OUTPUT_COUNT_MAX, OMNI_VIDEO_MAX_MB, DRAFT_RESOLUTION, DRAFT_FINAL_RESOLUTION,
  modelProvider, modelDurationRange, modelResolutions, modelSupportsDraft, draftEffective, modelOutputFormats,
  modelOutputFormat, modelRefVideoSec, modelRefAudioSec, refVideoMinSecFor, modelAllowsAudioOnly, modelOmniTasks,
  resolveOmniTask, modelHasFirstLastFrame, modelExtendMaxSrcSec, ratioLockedFor, durationLockedFor, modelGrant,
  modeRefCaps, omniTaskRefCaps, settingsDefaultsFor, GenerationMode, GenerationSettings,
} from '../store';
import { resolveModelId } from './model-access';
import { API_LIMITS } from './utils';

export const AGENT_MODES: GenerationMode[] = GENERATION_MODES.map(m => m.id);

// 에이전트가 준 설정을 프로젝트 설정 위에 얹는다. 패널에서 고를 수 있는 값만 받고, 아니면 이유를 돌려준다.
// 모델·모드가 바뀌면 패널에서 바꿀 때처럼 그 조합의 기본값에서 시작하고(settingsDefaultsFor), 준 값이 그 위에 덮인다.
// 비율은 일부러 검사하지 않는다 — BytePlus 가 작업을 만들기 전에 검증해 과금 없이 거절한다(HANDOFF '무과금 API 프로브').
export function agentSettings(cur: GenerationSettings, req: Record<string, unknown>): { next?: GenerationSettings; error?: string } {
  const next: GenerationSettings = { ...cur };
  const has = (k: string) => req[k] !== undefined && req[k] !== null && req[k] !== '';
  if (has('model')) {
    const m = resolveModelId(String(req.model));
    if (!MODELS.some(x => x.id === m)) return { error: `앱에 없는 모델입니다: ${req.model}\n(있는 모델: ${MODELS.map(x => x.id).join(', ')})` };
    next.model = m;
  }
  const omni = modelProvider(next.model) === 'gemini';
  if (has('mode') && !omni) {
    if (!AGENT_MODES.includes(req.mode as GenerationMode)) return { error: `모르는 모드입니다: ${req.mode}\n(${AGENT_MODES.join(', ')})` };
    next.mode = req.mode as GenerationMode;
  }
  if (omni) {
    const tasks = modelOmniTasks(next.model);
    if (has('omniTask') && !tasks.includes(String(req.omniTask))) return { error: `이 모델에 없는 작업입니다: ${req.omniTask}\n(${tasks.join(', ')})` };
    next.omniTask = resolveOmniTask(next.model, has('omniTask') ? String(req.omniTask) : next.omniTask);
  }
  if (next.model !== cur.model || next.mode !== cur.mode) {
    Object.assign(next, settingsDefaultsFor(next.model, next.mode));
    if (!RETURN_LAST_FRAME_MODES.includes(next.mode)) next.return_last_frame = false;
    if (next.output_format && !modelOutputFormats(next.model).includes(next.output_format)) next.output_format = undefined;
    // Omni 는 정해진 비율 · 3~10초만 — 모델을 Omni 로 바꿀 때 패널이 하는 정리와 같다.
    if (omni && !OMNI_RATIO_IDS.includes(next.ratio)) next.ratio = OMNI_RATIO_IDS[0];
    if (omni && (next.duration === -1 || next.duration < 3 || next.duration > 10)) next.duration = 5;
  }
  if (has('resolution')) {
    const r = String(req.resolution);
    const ok = modelResolutions(next.model);
    if (!ok.includes(r)) return { error: `이 모델에 없는 해상도입니다: ${r}\n(${ok.join(', ')})` };
    next.resolution = r;
  }
  if (has('ratio')) next.ratio = String(req.ratio);
  if (has('duration')) {
    const d = Number(req.duration);
    const [lo, hi] = modelDurationRange(next.model);
    if (!(d === -1 && !omni) && !(Number.isInteger(d) && d >= lo && d <= hi)) return { error: `길이는 ${lo}~${hi}초${omni ? '' : ' 또는 -1(자동)'}입니다: ${req.duration}` };
    next.duration = d;
  }
  if (has('output_count')) {
    const n = Number(req.output_count);
    if (!Number.isInteger(n) || n < 1 || n > OUTPUT_COUNT_MAX) return { error: `개수는 1~${OUTPUT_COUNT_MAX}입니다: ${req.output_count}` };
    next.output_count = n;
  }
  if (has('generate_audio')) {
    if (typeof req.generate_audio !== 'boolean') return { error: 'generate_audio 는 true/false 입니다' };
    next.generate_audio = req.generate_audio;
  }
  if (has('return_last_frame')) {
    if (typeof req.return_last_frame !== 'boolean') return { error: 'return_last_frame 는 true/false 입니다' };
    if (req.return_last_frame && (omni || !RETURN_LAST_FRAME_MODES.includes(next.mode))) return { error: '이 모드에서는 마지막 프레임을 따로 받을 수 없습니다' };
    next.return_last_frame = req.return_last_frame;
  }
  if (has('draft')) {
    if (typeof req.draft !== 'boolean') return { error: 'draft 는 true/false 입니다' };
    if (req.draft && (omni || !modelSupportsDraft(next.model))) return { error: '이 모델은 초안(Draft)이 없습니다' };
    next.draft = req.draft;
  }
  if (has('output_format')) {
    const f = String(req.output_format);
    const ok = modelOutputFormats(next.model);
    if (!ok.includes(f)) return { error: `이 모델에 없는 출력 형식입니다: ${f}${ok.length ? `\n(${ok.join(', ')})` : ''}` };
    next.output_format = f;
  }
  return { next };
}

// ─── 사용 설명서 ─────────────────────────────────────────────────────────────────────────

// 설정 키 — agentSettings 가 받는 것과 같아야 한다(여기 없는 키는 받지 않는다).
const SETTING_DOCS: Record<string, string> = {
  model: '모델 ID — 아래 모델 목록',
  mode: '시댄스 생성 모드 — 모델별 모드 표. Omni 는 mode 대신 omniTask',
  omniTask: 'Omni 작업 — 모델별 작업 목록',
  ratio: '비율 — 공통의 비율 목록',
  duration: '길이(정수 초) — 모델 범위 안. 시댄스는 -1(자동)도',
  resolution: '해상도 — 모델의 목록 중',
  output_count: `한 번에 만드는 개수 1~${OUTPUT_COUNT_MAX}`,
  generate_audio: '오디오 생성 true/false — Omni 는 없음',
  return_last_frame: '마지막 프레임도 받기 true/false — 켜면 오디오는 꺼져서 나간다',
  draft: '초안 true/false — 초안이 있는 모델만',
  output_format: '출력 형식 — 고를 수 있는 모델만',
};

// 에이전트 명령 (26.10.305~). 앱 버튼과 같은 함수로 화면(ChatArea 의 agentCommands)이 실행한다. 여기 적힌 것이
// 설명서에 나가고, 에이전트는 이것만 부를 수 있다 — 명령을 더하면 ChatArea 의 처리기도 같이 더한다.
// ★ 지우기(카드·엘리먼트·컬렉션·프로젝트)와 과금 프로젝트 고르기는 일부러 없다(사용자 결정 2026-10-03 — 되돌리기
//   어렵거나 돈이 가는 곳을 정하는 일은 사람이 앱에서). costs = 과금되는 명령(확인 카드를 받은 뒤에만).
export const AGENT_COMMANDS: { name: string; args: string; does: string; costs?: boolean; composer?: boolean }[] = [
  { name: 'projects.list', args: '{}', does: '프로젝트(사이드바) 목록 — 이름 · 그룹 · 카드 수 · 연결된 컬렉션 · 지금 열린 것' },
  { name: 'project.open', args: '{ "project": "이름" }', does: '그 프로젝트를 연다(사이드바 클릭과 같음)' },
  { name: 'project.create', args: '{ "name": "이름", "group"?: "그룹 이름" }', does: '새 프로젝트를 만들고 연다. 같은 이름이 있으면 앱 규칙대로 (1) 이 붙는다' },
  { name: 'billing.list', args: '{}', does: '과금 프로젝트 목록과 지금 선택 — 프로젝트별 영상 수 · 토큰 · 2.5/4K 권한(크레딧 대시보드의 숫자). 고르는 건 사람이 앱에서' },
  { name: 'collections.list', args: '{}', does: '어셋 라이브러리 — 컬렉션과 엘리먼트(이름 · 분류 · 설명 · 이미지 수), 연결된 프로젝트' },
  { name: 'collection.create', args: '{ "name": "이름" }', does: '컬렉션을 만든다. 같은 이름이 있으면 그걸 돌려준다(existed)' },
  { name: 'collection.bind', args: '{ "collection": "이름", "project"?: "이름(없으면 지금 프로젝트)" }', does: '프로젝트에 컬렉션을 연결한다 — 프롬프트의 @{이름} 은 연결된 컬렉션에서 찾는다' },
  { name: 'elements.add', args: '{ "collection": "이름", "items": [{ "name": "이름", "category": "character|location|prop", "description"?: "설명", "images": ["이미지 경로", …] }] }', does: '엘리먼트를 등록한다(화면 등록과 같은 검사 · 원본 보관). 컬렉션에 같은 이름이 있으면 그 항목은 건너뛰고 알린다' },
  { name: 'element.update', args: '{ "collection": "이름", "name": "이름", "newName"?, "category"?, "description"?, "addImages"?: [경로], "replaceImages"?: [경로] }', does: '엘리먼트를 고친다' },
  { name: 'cards.list', args: '{ "project"?: "이름", "limit"?: 20, "status"?: "succeeded|failed|running|queued", "starred"?: true }', does: '카드(생성 결과) 목록 — 최신순. 프롬프트 · 설정 · 상태 · 초안 여부 · 채택 · 다운로드 경로' },
  { name: 'card.get', args: '{ "id": "카드 id" }', does: '카드 하나의 지금 상태 — 진행을 지켜볼 때' },
  { name: 'card.star', args: '{ "id": "카드 id", "on": true }', does: '채택(★)을 켜거나 끈다' },
  { name: 'card.download', args: '{ "id": "카드 id" }', does: '영상을 다운로드 폴더에 저장한다(카드의 다운로드 버튼과 같음) — 저장한 경로를 돌려준다' },
  { name: 'card.final', args: '{ "id": "초안 카드 id" }', does: '초안(480p) 카드로 1080p 본편을 만든다(같은 시드 · 구도) — 과금된다', costs: true },
  { name: 'card.regenerate', args: '{ "id": "카드 id" }', does: '그 카드와 같은 설정 · 레퍼런스 · 프롬프트로 다시 만든다 — 과금된다', costs: true, composer: true },
  { name: 'card.cancel', args: '{ "id": "카드 id" }', does: '대기 중(queued) 작업을 취소한다 — 이미 돌기 시작했으면 앱이 거절한다(그때는 과금된다)' },
];

const RULES = [
  '안 준 설정은 앱의 지금 설정을 따른다. 모델·모드를 바꾸면 그 조합의 기본값에서 시작한다.',
  '레퍼런스는 프롬프트에서 [Image N] · [Video N] · [Audio N] 으로 부른다 — 번호는 refs 에 넘긴 순서대로 종류별로 센다. 첫·끝 프레임은 refs 의 role(first_frame / last_frame)로 정한다.',
  '어셋 라이브러리의 엘리먼트는 프롬프트에서 @{이름} 으로 부른다 — 프로젝트에 연결된 컬렉션에서 찾고(collection.bind), 앱이 그 엘리먼트 이미지를 레퍼런스로 붙인다. 못 찾으면 보내지 않는다. 레퍼런스→영상 · 영상 편집 모드에서만 된다.',
  '비율·길이·해상도·개수·오디오는 프롬프트에 쓰지 말고 설정으로 넘긴다.',
  '프롬프트 본문에 소수 길이 지시(예: "4.5초로")를 쓰지 않는다 — BytePlus 가 내부 오류로 실패한다.',
  '오디오 생성과 마지막 프레임 받기는 같이 못 켠다 — 마지막 프레임을 켜면 오디오는 꺼져서 나간다.',
  '과금 프로젝트(비용이 가는 곳)는 사람이 앱에서 고른다. 권한이 필요한 모델과 4K 는 그 프로젝트에 권한이 있어야 한다 — 지금 쓸 수 있는 것은 앱 상태(allowedModels · fourK)에 나온다.',
  '비율은 앱이 미리 거르지 않는다 — 틀리면 BytePlus 가 과금 없이 거절한다.',
  '레퍼런스를 하나라도 못 붙이거나 앱이 경고로 멈추면 보내지 않고, 그 이유가 그대로 돌아온다.',
];

type Caps = { image: number; video: number; audio: number };
const capsText = (c: Caps) => [c.image ? `이미지 ${c.image}` : '', c.video ? `영상 ${c.video}` : '', c.audio ? `오디오 ${c.audio}` : '']
  .filter(Boolean).join(' · ') || '없음';

// 내용 지문 — 같은 내용이면 같은 값. 버전 비교에만 쓴다(보안 용도 아님).
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

export type AgentManual = { version: string; manual: Record<string, unknown>; text: string };

export function buildAgentManual(appVersion: string): AgentManual {
  const models = MODELS.map(m => {
    const id = m.id;
    const omni = modelProvider(id) === 'gemini';
    const [dMin, dMax] = modelDurationRange(id);
    const res = modelResolutions(id);
    const { resolution, ratio, duration } = settingsDefaultsFor(id, 'text_to_video');
    return {
      id, name: m.name, provider: omni ? 'gemini' : 'byteplus',
      guide: m.guide ?? null,
      needsGrant: !!modelGrant(id),
      duration: { min: dMin, max: dMax, auto: !omni },
      resolutions: res,
      fourKNeedsGrant: !omni && res.includes('4k'),
      defaults: { resolution, ratio, duration },
      draft: modelSupportsDraft(id) ? { defaultOn: draftEffective(id, undefined), resolution: DRAFT_RESOLUTION, final: DRAFT_FINAL_RESOLUTION } : null,
      outputFormats: modelOutputFormats(id).map(f => ({ id: f, label: OUTPUT_FORMAT_LABEL[f] || f, isDefault: f === modelOutputFormat(id) })),
      audioOnly: !omni && modelAllowsAudioOnly(id),
      refSeconds: omni ? null : { video: modelRefVideoSec(id), audio: modelRefAudioSec(id) },
      modes: omni ? null : GENERATION_MODES.map(mo => ({
        id: mo.id, name: mo.name, refs: modeRefCaps(id, mo.id),
        ratioLocked: ratioLockedFor(id, mo.id), durationLocked: durationLockedFor(id, mo.id),
        minRefVideoSec: mo.id === 'edit_video' ? refVideoMinSecFor(id, mo.id) : null,
        returnLastFrame: RETURN_LAST_FRAME_MODES.includes(mo.id),
      })),
      tasks: omni ? modelOmniTasks(id).map(t => ({ id: t, name: OMNI_TASK_NAMES[t] || t, refs: omniTaskRefCaps(id, t) })) : null,
      firstLastFrame: omni ? (modelHasFirstLastFrame(id) ? 'official' : 'unofficial') : null,
      extendMaxSourceSec: omni ? (modelExtendMaxSrcSec(id) ?? null) : null,
      notes: m.notes ?? [],
    };
  });
  const v = API_LIMITS.video, im = API_LIMITS.image, au = API_LIMITS.audio;
  const manual = {
    app: 'Freewill Seedance', appVersion,
    settings: SETTING_DOCS,
    ratios: { seedance: SEEDANCE_RATIOS, omni: OMNI_RATIO_IDS },
    outputCount: { min: 1, max: OUTPUT_COUNT_MAX },
    files: {
      image: { maxMB: im.maxSizeMB, minPx: im.minPx, maxPx: im.maxPx, types: 'JPEG·PNG·WebP·BMP·GIF·TIFF' },
      video: { maxMB: v.maxSizeMB, omniMaxMB: OMNI_VIDEO_MAX_MB, minSec: v.minDuration, minPx: v.minPx, maxPx: v.maxPx, ratio: [v.minRatio, v.maxRatio], types: 'MP4·MOV·M4V·WebM' },
      audio: { maxMB: au.maxSizeMB, minSec: au.minDuration, types: 'WAV·MP3' },
    },
    rules: RULES,
    commands: AGENT_COMMANDS,
    models,
  };
  // 구분자는 - — + 는 주소(쿼리)에 넣으면 공백으로 바뀌어 버전이 어긋난다(PowerShell 로 시험하다 걸림).
  const version = `${appVersion}-${fingerprint(JSON.stringify(manual))}`;
  return { version, manual: { ...manual, version }, text: manualText(manual, version) };
}

// 에이전트가 읽는 글. 위 JSON 과 같은 내용을 사람(과 모델)이 읽기 좋게.
function manualText(m: any, version: string): string {
  const L: string[] = [];
  const mb = (n: number) => `${n}MB`;
  L.push(`# 시댄스 사용 설명서 — 앱 ${m.appVersion}`, '');
  L.push(`설명서 버전 **${version}** — 보낼 때 jobs.json 의 "manual" 에 이 값을 그대로 적는다. 앱이 바뀌면 앱이 "업데이트됐으니 설명서를 다시 읽으라" 고 돌려보낸다.`);
  L.push('이 PC 에 켜진 시댄스가 자기 코드(설정 패널과 같은 목록)에서 만든 것이다. 여기 없는 값은 보내지 않는다.', '');
  L.push('## 공통', '');
  L.push(`- 한 요청에 ${m.outputCount.min}~${m.outputCount.max}개. 비율 — 시댄스: ${m.ratios.seedance.join(', ')} · Omni: ${m.ratios.omni.join(', ')}`);
  for (const r of m.rules) L.push(`- ${r}`);
  L.push('', '## 설정 키', '');
  for (const [k, d] of Object.entries(m.settings)) L.push(`- \`${k}\` — ${d}`);
  L.push('', '## 명령', '');
  L.push('생성 말고도 앱 기능을 명령으로 쓴다 — 앱 버튼과 같은 함수로 실행된다. `send-to-seedance.mjs --do <명령> <JSON 인자 또는 @파일>`');
  L.push('과금되는 명령(💰)은 확인 카드를 받은 뒤에만 부른다. 지우기와 과금 프로젝트 고르기는 명령이 없다 — 사람이 앱에서 한다.', '');
  for (const c of m.commands) L.push(`- \`${c.name}\` \`${c.args}\` — ${c.does}${c.costs ? ' 💰' : ''}`);
  const f = m.files;
  L.push('', '## 파일', '');
  L.push(`- 이미지: ${mb(f.image.maxMB)} 이하 · 한 변 ${f.image.minPx}~${f.image.maxPx}px · ${f.image.types}`);
  L.push(`- 영상: ${mb(f.video.maxMB)} 이하(Omni ${mb(f.video.omniMaxMB)}) · ${f.video.minSec}초 이상(길이 상한은 모델별) · 한 변 ${f.video.minPx}~${f.video.maxPx}px · 가로÷세로 ${f.video.ratio[0]}~${f.video.ratio[1]} · ${f.video.types}`);
  L.push(`- 오디오: ${mb(f.audio.maxMB)} 이하 · ${f.audio.minSec}초 이상(상한은 모델별) · ${f.audio.types}`);
  L.push('', '## 모델');
  for (const x of m.models) {
    L.push('', `### ${x.name} · \`${x.id}\``, '');
    L.push(`- 프롬프트 가이드: ${x.guide || '(연결된 공식 가이드 없음 — 같은 회사의 가장 가까운 가이드)'}${x.needsGrant ? ' · **과금 프로젝트에 이 모델 권한이 있어야 한다**' : ''}`);
    const res = x.resolutions.join(' / ') + (x.fourKNeedsGrant ? ' (4k 는 과금 프로젝트에 4K 권한이 있을 때만 — 없으면 낮춰서 보낸다)' : '');
    L.push(`- 길이 ${x.duration.min}~${x.duration.max}초${x.duration.auto ? ' 또는 -1(자동)' : ''} · 해상도 ${res} · 기본 ${x.defaults.resolution} · ${x.defaults.ratio} · ${x.defaults.duration === -1 ? '자동' : `${x.defaults.duration}초`}`);
    if (x.provider === 'gemini') L.push(`- 비율: ${m.ratios.omni.join(' / ')} · 오디오 레퍼런스 없음 · generate_audio 설정 없음`);
    if (x.draft) L.push(`- 초안(draft): 있음${x.draft.defaultOn ? '(기본 켬)' : ''} — ${x.draft.resolution} 로 나가고, 고른 것만 앱 카드에서 ${x.draft.final} 본편`);
    if (x.outputFormats.length) L.push(`- 출력 형식(output_format): ${x.outputFormats.map((o: any) => `${o.id}(${o.label}${o.isDefault ? ', 기본' : ''})`).join(' / ')}`);
    if (x.refSeconds) L.push(`- 레퍼런스 길이: 영상 ${x.refSeconds.video}초 · 오디오 ${x.refSeconds.audio}초까지(각각, 그리고 합계)${x.audioOnly ? ' · 오디오만으로도 생성 가능' : ' · 오디오만으로는 생성 불가 — 이미지나 영상을 함께'}`);
    if (x.modes) {
      L.push('', '| mode | 이름 | 레퍼런스 | 고정 · 조건 | 마지막 프레임 |', '|---|---|---|---|---|');
      for (const mo of x.modes) {
        const fixed = [mo.ratioLocked ? '비율 adaptive(입력 기준)' : '', mo.durationLocked ? '길이 자동' : '',
          mo.minRefVideoSec && mo.refs.video ? `원본 영상 ${mo.minRefVideoSec}초 이상` : '', mo.id === 'edit_video' ? '영상 1개(교체)' : ''].filter(Boolean).join(' · ');
        L.push(`| \`${mo.id}\` | ${mo.name} | ${capsText(mo.refs)} | ${fixed || '—'} | ${mo.returnLastFrame ? '가능' : '—'} |`);
      }
    }
    if (x.tasks) {
      L.push('', '| omniTask | 이름 | 레퍼런스 |', '|---|---|---|');
      for (const t of x.tasks) {
        const extra = t.id === 'image_to_video' ? ` (시작·끝 프레임 — 끝 프레임 ${x.firstLastFrame === 'official' ? '공식' : '비공식'})`
          : t.id === 'extend' && x.extendMaxSourceSec ? ` (원본 ${x.extendMaxSourceSec}초 이하)` : '';
        L.push(`| \`${t.id}\` | ${t.name} | ${capsText(t.refs)}${extra} |`);
      }
    }
    if (x.notes.length) { L.push(''); for (const n of x.notes) L.push(`- ${n}`); }
  }
  return L.join('\n') + '\n';
}
