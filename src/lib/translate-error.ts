// 오류 → 사람 말(한국어). 카드 · 미니 창 · 에이전트가 같이 쓴다(26.11.2301~ ChatArea 에서 옮김). UI · 스토어를 들이지 말 것.

import { PERSONAL } from './edition';

// 실사 얼굴 차단 때 쓸 수 있는 길(BytePlus 문서 seedance-portrait-asset-guide, 2026-11-19 — 오류 코드
// InputImageSensitiveContentDetected.PrivacyInformation · InputVideoSensitiveContentDetected.PrivacyInformation, HTTP 400).
// 실존 인물만이 아니다 — GPT 이미지로 만든 실사풍 AI 인물도 막혔다(11/23 실측). 가장 쉬운 길(라이브러리 인증)을 먼저 적는다.
// 실존 인물(배우 본인) 에셋을 만드는 곳 — BytePlus 콘솔 Model Playground › 아래 My assets › Real-human(문서 upload-real-person-portrait-assets 의 링크, 11/24).
export const REAL_HUMAN_URL = 'https://ai.byteplus.com/ark/region:ap-southeast-1/experience/gen_video?model=dreamina-seedance-2-0-260128';
const FACE_WAYS = (personal: boolean) => [
  ...(personal ? [] : ['AI 로 만든 인물 — 레퍼런스 칸이나 어셋 라이브러리 카드의 방패를 눌러 직접 인증할 수도 있어요(한 번 하면 계속).']),
  'BytePlus 에셋 ID — 설정 패널 "URL / Asset ID로 추가" 에 asset-… 를 넣으세요(지금 키의 BytePlus 프로젝트에 등록된 것만).',
  '같은 계정이 30일 안에 만든 원본 — Seedance 영상 · 그 영상의 마지막 프레임 · Seedream 5.0 텍스트→이미지. 받은 그대로여야 해요(캡처 · 편집 · 재압축 안 됨).',
  '실사가 아닌(스타일라이즈) 캐릭터 이미지.',
  `실존 배우 본인 — BytePlus 콘솔 Model Playground › My assets › Real-human 에서 그룹을 만들고 배우가 QR 로 본인 인증 · 업로드한 뒤 그 asset ID 를 넣으세요(${REAL_HUMAN_URL}).`,
];
// 자동 인증을 못 한 이유는 원문 뒤에 이 표로 붙는다(send-request failed).
const NO_CERT = '[자동 인증 못 함]';
/** 실사 얼굴 차단(Seedance 2.0 · 2.5 공통)이면 카드가 나눠 그릴 조각 — 한 줄 설명 · 다음에 할 일(또는 자동 인증을 못 한 이유) · 다른 길 · 원문. 아니면 null. */
export function faceBlock(error: string): { head: string; next: string; ways: string[]; raw: string } | null {
  if (!/real person|PrivacyInformation/.test(error || '')) return null;
  const [raw, why] = error.split(NO_CERT).map((x) => x.trim());
  // 코드에 Image / Video 가 들어 있어 어느 쪽 레퍼런스인지 말해 준다.
  const which = /InputVideo|input video/i.test(raw) ? '레퍼런스 영상' : /InputImage|input image/i.test(raw) ? '레퍼런스 이미지' : '레퍼런스';
  return {
    head: `${which}에 실사 얼굴이 있어 BytePlus 가 막았어요(AI 로 만든 실사풍 인물도 포함 · 과금 없음).`,
    // 이유가 없는 카드 = 자동 인증이 생기기 전(26.11.1802 까지)에 막힌 카드이거나 만드는 도중 실패 — 다시 만들면 자동 인증을 거친다. 개인판에는 자동 인증이 없다.
    next: why ? `자동 인증도 하지 못했어요 — ${why}` : PERSONAL ? '아래 방법 가운데 하나로 넣어 주세요.' : '재생성(✦)하면 앱이 자동으로 인증해서 보내요.',
    ways: FACE_WAYS(PERSONAL), raw,
  };
}

/** BytePlus 응답 몸통 → 카드에 남길 오류 글. 코드가 메시지에 없으면 '코드: 메시지' 로 — 원인(PrivacyInformation 등)은 코드에 있다(26.11.2301~). */
export function byteplusErrorText(data: any): string {
  const e = data?.error;
  if (e && typeof e === 'object' && typeof e.message === 'string' && e.message) {
    return typeof e.code === 'string' && e.code && !e.message.includes(e.code) ? `${e.code}: ${e.message}` : e.message;
  }
  return (typeof data?.msg === 'string' && data.msg) || (typeof e === 'string' && e) || JSON.stringify(data);
}

/** ctx.hasAsset — 그 요청에 BytePlus 에셋(asset://) 레퍼런스가 있었나. 에셋 쪽 오류 문구는 BytePlus 가 정확히 밝히지 않아 이것으로 덧붙인다. */
export function translateError(error: string, ctx?: { hasAsset?: boolean }): string {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
  // 에셋을 썼는데 '못 받음 · 잘못된 값' 류로 거절되면 흔한 원인을 덧붙인다(정확한 문구는 아직 본 적 없음 — 단정하지 않는다).
  // 좁게: 에셋 · 레퍼런스 주소(…_url) · 리소스를 말하는 오류만 — 비율 · 길이 · 4K 같은 다른 거절에는 붙이지 않는다.
  const assetHint = ctx?.hasAsset && /asset|_url|resource|not found|NotFound|permission|Forbidden|access denied/i.test(error)
    ? '\n\nBytePlus 에셋(asset://)을 넣었다면: ID 가 맞는지 · 에셋이 Active 인지(처리 중 · 실패 · 거절이면 못 씀) · 지금 프로젝트 코드의 BytePlus 프로젝트에 등록된 것인지 확인해 주세요. 에셋은 등록한 프로젝트의 키로만 써져요.'
    : '';
  return translateErrorBase(error) + assetHint;
}

function translateErrorBase(error: string): string {
  // Windows runs the packaged exe (start.bat); Mac runs from source (start.command).
  // Naming the wrong one is a dead end for whoever reads it.
  if (error.includes('API Key is required'))
    return `API 키 오류: 서버를 재시작해주세요. (${navigator.platform.startsWith('Mac') ? 'start.command' : 'start.bat'})`;
  if (error.includes('Payload Too Large')) return '파일 크기 초과: 이미지 개당 30MB, 전체 요청 64MB 이하여야 합니다.';
  // Gemini Omni's input filter. Its wording ("sensitive words that violate Google's
  // Prohibited Use policy") sends people hunting for a forbidden word, and that is not
  // what it keys on. Measured 2026-08-28 on one unchanged clip: asking for the
  // OPERATION is refused in any language (연장 · 확장 · 늘려줘 · 뒤에 이어붙여줘 ·
  // extend the video · lengthen · extension), while a scene description passed
  // (강아지가 고개를 돌린다 · 카메라가 천천히 뒤로 빠진다 · Continue.).
  // ★ But that is a tendency, not the rule: a plain scene description was blocked in
  // real use and the SAME sentence then passed against a different source clip. So the
  // filter reads the whole request, video included, and is not reproducible from the
  // text alone. Say both, or the message sends someone to rewrite a prompt that was
  // already fine.
  // Gemini rejects the key itself. The raw string names no cause, and the cause here is
  // almost never a bad key on disk: the server reads NANOBANANA_STUDIO_KEY from the
  // process environment ONCE at launch, and an auto-updated app inherits its environment
  // block from the process it replaced — so a key rotated at any point keeps travelling
  // as the old value through every later update until someone starts the app fresh.
  if (error.includes('API key not valid') || error.includes('API_KEY_INVALID'))
    return 'Gemini API 키가 거부되었습니다.\n앱은 켤 때 환경변수(NANOBANANA_STUDIO_KEY)를 한 번만 읽고, 자동 업데이트는 이전 프로세스의 환경을 그대로 물려받습니다. 키를 바꾼 적이 있다면 앱이 옛 값을 계속 쓰고 있을 수 있습니다.\n→ 작업 관리자에서 앱을 완전히 종료한 뒤 다시 실행해보세요. 그래도 같으면 키가 만료·삭제된 것입니다.';
  if (error.includes('Input blocked') || error.includes('Prohibited Use'))
    return '프롬프트가 Google 정책 필터에 막혔습니다. (생성 전 단계라 과금은 없습니다.)\n"연장 / 늘려줘 / extend" 처럼 작업을 지시하면 거의 항상 막힙니다 — 이어질 장면을 묘사로 적어주세요.\n장면 묘사인데도 막혔다면 필터가 원본 영상까지 함께 본 경우입니다. 같은 문장이 다른 영상에서는 통과하니, 문장을 조금 바꾸거나 다시 시도해보세요.';
  if (error.includes('resource download failed')) return '리소스 다운로드 실패: 이미지에 접근할 수 없습니다. 파일을 다시 업로드해주세요.';
  const face = faceBlock(error);
  if (face) return [face.head, face.next, '다른 방법:', ...face.ways.map((w) => `  · ${w}`)].join('\n');
  // 저작권(유명 인물 · 캐릭터 · 장면) — PrivacyInformation(아직 인증 안 된 인물)과 다르다. 에셋 인증으로 풀리지 않고, 앱도 자동 인증하지 않는다
  // (send-request fixPlan 은 PrivacyInformation 만 본다). 문서 error-codes(11/24): Input{Image,Video,Audio}SensitiveContentDetected.PolicyViolation
  // = "may be related to copyright restrictions".
  if (/SensitiveContentDetected\.PolicyViolation|copyright restriction/i.test(error)) {
    const which = /InputVideo|input video/i.test(error) ? '레퍼런스 영상' : /InputAudio|input audio/i.test(error) ? '레퍼런스 오디오'
      : /InputImage|input image/i.test(error) ? '레퍼런스 이미지' : /Output/i.test(error) ? '만들어진 결과물' : '레퍼런스';
    return `저작권 · 유명인 관련으로 막혔어요: ${which}가 저작권(유명 인물 · 유명 캐릭터 · 영화 장면 등)에 걸릴 수 있다고 BytePlus 가 판단했어요(PolicyViolation).\n`
      + '실사 얼굴 차단(인증 안 된 인물)과 달리 에셋 인증으로 풀리지 않아요 — 다른 소재로 바꿔 주세요. 실제 배우 본인이라면 본인 인증(Real-human) 에셋으로만 쓸 수 있어요.';
  }
  if (error.includes('SensitiveContentDetected') || error.includes('SensitiveContent')) return '민감 콘텐츠 감지: 레퍼런스 이미지 또는 프롬프트가 BytePlus 콘텐츠 정책에 의해 거부되었습니다.';
  if (error.includes('rate limit') || error.includes('429')) return 'API 요청 한도 초과: 잠시 후 다시 시도해주세요.';
  if (error.includes('No task ID')) return 'Task ID를 받지 못했습니다. API 응답을 확인해주세요.';
  if (error.includes('1080p is not supported for this account')) return '1080p는 현재 계정에서 사용할 수 없습니다. BytePlus 콘솔에서 1080p 권한을 활성화하거나 480p/720p를 사용해주세요.';
  if (error.includes('4k is not supported for this account')) return '4K는 현재 팀의 API 키에서 사용할 수 없습니다. BytePlus 콘솔에서 4K를 활성화하거나 1080p 이하를 사용해주세요.';
  if (error.includes('not supported for this account')) return `현재 계정에서 사용할 수 없는 옵션입니다: ${error}`;
  // 2.5 re-classifies the task from the PROMPT TEXT, not from the mode we send, and the
  // label varies — "video editing", "video extension", possibly others. Whatever it picks,
  // the output must inherit framing (and sometimes length) from the source clip, so `ratio`
  // has to be `adaptive` and `duration` sometimes -1. Match the family, not one label, and
  // read the required values out of the API's own "Issues:" list so the guidance is exactly
  // what this request needs. (Seen 2026-07-29: editing → ratio+duration, extension → ratio.)
  if (error.includes('identified your task as')) {
    const kind = /identified your task as ([a-z ]+?) based/i.exec(error)?.[1] || '';
    const ko = kind.includes('editing') ? '영상 편집' : kind.includes('extension') ? '영상 연장' : kind || '다른 작업';
    const fixes: string[] = [];
    if (/`ratio` must be `adaptive`/.test(error)) fixes.push('  · Ratio → adaptive');
    if (/`duration` must be -1/.test(error)) fixes.push('  · Duration → Auto');
    const what = fixes.length ? fixes.join('\n') : '  · Ratio → adaptive';
    return `프롬프트가 "${ko}"으로 해석되었습니다.\n이 작업은 비율·길이를 원본 영상에서 그대로 가져가므로 아래를 바꿔주세요.\n${what}\n(레퍼런스로 쓰려던 거라면 프롬프트에서 "원본 영상을 그대로/이어서 사용" 같은 표현을 빼주세요.)`;
  }

  // 초안 → 본편 거절. 만료된 초안의 정확한 문구는 아직 본 적이 없다(일부러 만들 수가 없다).
  // 그래서 원인을 단정하지 않고 규칙만 말한다 — 원문은 카드에 그대로 한 줄 더 남는다.
  // 'draft task' 를 말하는 거절만 받는다. 그냥 'draft' 로 잡으면 초안 '생성' 쪽 거절까지
  // 본편 이야기로 둔갑한다. 'not valid' 규칙보다 먼저 와야 한다 — 실측한 본편 거절이 모두
  // 그 문구를 달고 온다 (2026-09-23, 둘 다 동기 400 · 태스크 안 생김):
  //   물려받는 값 재전송 → "generate_audio is not supported for draft_task"
  //   없는 초안 id     → "`content[0].draft_task.id` ... is not valid: the parameter
  //                       'draft_task_id' must be a draft task with status 'succeeded'"
  if (/draft[_ ]?task/i.test(error)) return 'Draft → 본편 요청이 거절되었습니다.\nDraft는 만든 뒤 14일(2026-10-29 오전 9시 전에 만든 Draft는 7일)까지만 본편으로 만들 수 있습니다. 아래 원문을 확인해주세요.';
  // 4k is flagship-only: Fast/Mini reject it at parameter validation, before a task exists.
  if (error.includes('parameter resolution') && error.includes('not valid')) return '이 모델은 선택한 해상도를 지원하지 않습니다. 4K는 Seedance 2.0(플래그십) 전용입니다.';
  // 2.5 에 넣은 4096×2160 영상을 그대로 두고 2.0 으로 바꿔 보냈을 때(붙일 때의 검사를 지나간 것) — 생성 전 거절이라 과금 없음.
  const px = /video pixel count[^.]*less than or equal to (\d+)/i.exec(error);
  if (px) return `레퍼런스 영상 해상도 초과: 이 모델은 ${Number(px[1]) >= 8847360 ? '4096x2160' : '3840x2160'} 상당까지 받아요.${Number(px[1]) < 8847360 ? ' Seedance 2.5 는 4096x2160 까지예요.' : ''}`;
  if (error.includes('not valid')) return `잘못된 파라미터: ${error}`;
  if (error.includes('timeout') || error.includes('ETIMEDOUT')) return '요청 시간 초과: 네트워크 연결을 확인해주세요.';
  if (error.includes('Failed to fetch') || error.includes('NetworkError')) return '네트워크 오류: 인터넷 연결을 확인해주세요.';
  return error;
}
