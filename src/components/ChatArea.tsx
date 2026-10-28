import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Fragment, memo } from 'react';
import { useAppStore, navigateProjectHistory, consumeHistoryNav, consumeFindRequest, AssetRole, flushPersist, AssetCategory, ElementImage, clampResolution, isFourKAllowed, modelImageMax, modelVideoMax, modelAudioMax, modelRefVideoSec, modelRefAudioSec, modelAllowsAudioOnly, resolveOutputFormat, modelOutputFormats, refTaskTypeFor, mentionKey, videoExtFor, applyTaskConstraints, isModelAllowed, MODELS, modelProvider, resolveOmniTask, modelResolutions, modelHasFirstLastFrame, modelExtendMaxSrcSec, modelExtendMaxOutSec, refVideoMinSecFor , downloadFilenameFor, modelSupportsDraft, draftEffective, draftExpiresAt, DRAFT_FINAL_RESOLUTION, billingProjectOfDraft, modelDurationRange, modelOmniTasks, settingsDefaultsFor, GenerationMode, GenerationSettings, modeRefCaps, omniTaskRefCaps, OMNI_VIDEO_MAX_MB, OUTPUT_COUNT_MAX } from '../store';
import { resolveModelId , brandOf } from '../lib/model-access';
import { downloadMetaFor, pinMessageReferences, requestFindMessage, usedCollectionOf, boundCollectionOf, defaultSettings, projectBilling, billingOf, type ChatMessage, type Asset } from '../store';
import { readSettingsFromFile, readVideoClues, sanitizePromptHtml, plainTextToHtml, storePayloadThumbs, thumbSrc, type SettingsPayload } from '../lib/settings-box';
import { messageMatchesQuery, taskIdMatches } from '../lib/search-match';
import { HoverZoom } from './HoverZoom';
import { Send, Loader2, AlertCircle, Play, UploadCloud, Video, Music, Image as ImageIcon, Download, RefreshCw, X, Trash2, Search, LayoutGrid, ArrowUp, ArrowDown, Eye, ChevronDown, ChevronUp, Copy, Check, FolderOpen, Sparkles, Star, ArrowLeftRight } from 'lucide-react';
import { getAssetNames, getPlainText, OMNI_TASK_LABELS, sendRequest, attachFilesTo, projectAssetSink, memoryAssetSink } from '../lib/send-request';
import { agentSettings, buildAgentManual, AGENT_COMMANDS, AGENT_FEATURES } from '../lib/agent-inbox';
import { visibleProjectIds } from '../lib/split';
import { PERSONAL } from '../lib/edition';
import { CATEGORY_META, fileToElementImage, MAX_ELEMENT_IMAGES } from './ElementLibrary';
import { motion, AnimatePresence } from 'motion/react';
import { libraryPreviewSrc, libraryOriginalSrc, formatStamp, formatStampFull, copyImageToClipboard, downloadViaProxy, buildDownloadFilename, validateImageFile, validateImageDimensions, validateVideoFile, validateAudioFile, getMediaDurationSec, totalDurationError, createThumbnail, createVideoThumbnail, reuploadFromCache, reuploadFromPath, getFilePath, getCachedBlob, setCachedBlob, cacheFile, cacheFromPath, dataUrlToFile, readCacheAsDataUrl, SourceChangedError } from '../lib/utils';


/* ─── Korean error translation ─── */
function translateError(error: string): string {
  if (!error) return '알 수 없는 오류가 발생했습니다.';
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
  if (error.includes('real person') || error.includes('PrivacyInformation')) return '실사 인물 감지: Seedance 2.0은 실제 사람 얼굴이 담긴 레퍼런스 이미지·영상을 받지 않습니다. Seedance로 생성한 결과물이나 비실사(스타일라이즈) 캐릭터 이미지를 사용해주세요.';
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
  if (/draft[_ ]?task/i.test(error)) return 'Draft → 본편 요청이 거절되었습니다.\nDraft는 생성 후 7일까지만 본편으로 만들 수 있습니다. 아래 원문을 확인해주세요.';
  // 4k is flagship-only: Fast/Mini reject it at parameter validation, before a task exists.
  if (error.includes('parameter resolution') && error.includes('not valid')) return '이 모델은 선택한 해상도를 지원하지 않습니다. 4K는 Seedance 2.0(플래그십) 전용입니다.';
  if (error.includes('not valid')) return `잘못된 파라미터: ${error}`;
  if (error.includes('timeout') || error.includes('ETIMEDOUT')) return '요청 시간 초과: 네트워크 연결을 확인해주세요.';
  if (error.includes('Failed to fetch') || error.includes('NetworkError')) return '네트워크 오류: 인터넷 연결을 확인해주세요.';
  return error;
}

/* ─── Video player: lazy mount + blob fetch (single GET → smooth playback over high-latency CDN) ─── */
// Can this machine decode the 4k output at all? BytePlus encodes 4k as H.265/HEVC
// **Main10 (10-bit)** — verified on a real output 2026-07-27 (hvc1, yuv420p10le). Chromium
// ships no software HEVC decoder (licensing), so this depends entirely on the OS/GPU
// platform decoder: on Windows that means the HEVC Video Extensions being installed.
// Probe Main10 at 4k level specifically — the 8-bit Main string ("hvc1.1.6…") can report
// supported on machines that still can't handle this content.
const CAN_PLAY_HEVC = (() => {
  try {
    return document.createElement('video')
      .canPlayType('video/mp4; codecs="hvc1.2.4.L150.B0"') !== '';
  } catch { return false; }
})();

// Exported for the all-projects gallery (GlobalGallery). Lazy-mounts on intersection,
// so a grid of hundreds of clips only ever fetches the handful actually on screen.
export function VideoPlayer({ sources, className, eager, is4k, poster, posterOf, failPoster }: {
  /** 재생 소스를 우선순위 순으로. 앞에서부터 쓰고, 실패하면 다음 단으로 내려간다.
   *  목록은 playbackChain() 한 곳에서만 만든다 — 단이 늘어도 호출부는 안 건드린다. */
  sources: string[];
  className?: string; eager?: boolean; is4k?: boolean;
  /** 목록 썸네일 주소. 주면 카드가 이 이미지로 뜨고, 영상은 마우스를 올릴 때 붙는다. */
  poster?: string;
  /** 포스터가 아직 없을 때 만들어 올리기 위한 메시지 정보.
   *  ★ 이걸 넘기면 영상이 뜰 때마다 캔버스로 프레임을 떠서 WebP 로 굽고 업로드한다.
   *  4K HEVC 는 GPU 리드백이라 눈에 띄게 버벅인다 — 목록(갤러리)처럼 포스터가 실제로
   *  필요한 화면에만 넘긴다. 채팅 카드에는 넘기지 않는다. */
  posterOf?: { taskId?: string; usedSettings?: any; videoStorage?: { project?: string } };
  /** 못 불러왔을 때 뒤에 깔 썸네일 주소. 실패했을 때만 <img> 가 생기므로
   *  정상 재생 경로에는 아무 비용도 없다 — 캡처와 무관하다. */
  failPoster?: string;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 포스터 모드: 목록에서는 <img> 만 띄우고 <video> 는 아예 만들지 않는다.
  // content-visibility 는 그리기만 건너뛸 뿐 네트워크와 비디오 디코더는 못 막는다 —
  // 갤러리가 무거웠던 진짜 이유가 그것이고, 여기서 끊는다.
  // posterState: 'checking' 아직 모름 · 'ok' 이미지 있음 · 'none' 없음(영상으로 대체)
  const [posterState, setPosterState] = useState<'checking' | 'ok' | 'none'>(poster ? 'checking' : 'none');
  const [wantVideo, setWantVideo] = useState(!poster);
  const showPoster = posterState === 'ok' && !wantVideo;

  const [mounted, setMounted] = useState(eager === true);
  const [blobSrc, setBlobSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // 실패 화면에 깔 썸네일. 404 면 한 번 꺼두고 다시 안 부른다.
  // 갤러리는 이미 poster 를 들고 있으니 그걸 그대로 쓴다 — 주소가 같다.
  const [failPosterGone, setFailPosterGone] = useState(false);
  const failBg = failPoster || poster || '';
  // 포스터가 실제로 떴다 = 이 영상은 NCP 에 보관되어 있다(포스터는 보관할 때 만든다).
  // 그러면 '만료' 가 아니라 '지금 잠깐 못 가져온 것' 이다. 두 경우를 같은 문구로
  // 덮으면, 멀쩡히 남아 있는 영상을 사라진 줄 알고 다시 만들게 된다.
  const [failPosterOk, setFailPosterOk] = useState(false);
  // 보관본이 '정말 없는' 것과 '지금 못 가져온' 것은 화면에서 구분되지 않는다.
  // 마스터 단계가 404 로 답했다면 NCP 에 없다는 뜻이고(보관 기간 만료), 그때만
  // 이미지 다운로드를 내민다. 네트워크가 끊겨 실패한 것뿐인데 '영상은 없습니다'
  // 라고 말하면, 멀쩡히 남아 있는 것을 포기하게 만든다.
  const [masterGone, setMasterGone] = useState(false);
  // 썸네일 내려받기. 영상이 사라진 뒤 남는 것이 이 한 장뿐이라, 앱 밖으로 꺼낼
  // 길이 있어야 한다. taskId 는 주소에서 뽑는다 — 이 컴포넌트는 메시지를 모른다.
  // 다시 굽지 않고 있는 파일을 그대로 준다(.webp) — 원본을 손대지 않는다는 규칙은
  // 영상에만 적용되는 것이 아니다.
  const saveFailPoster = () => {
    const m = failBg.match(/\/api\/media\/([^/?]+)\/poster/);
    const id = m ? decodeURIComponent(m[1]) : 'thumbnail';
    void downloadViaProxy(failBg, `${id}.webp`);
  };
  const blobUrlRef = useRef<string | null>(null);

  // 재생 소스는 여러 단이고, 한 단이 죽으면 다음 단으로 내려간다. 갓 만든 영상은
  // 프록시도 보관본도 아직 없어 앞 단이 404 인 게 정상이므로, 실패를 오류로 보지 않는다.
  //
  // ★ 예전엔 단이 둘로 고정이었고 내려가는 것도 한 번뿐이었다. 26.9.709 에서 맨 앞에
  //   프록시를 끼우면서 맨 뒤의 원본 URL 이 조용히 목록 밖으로 밀려났다. 그래서 갓
  //   만든 영상이 프록시 404 → 마스터 404 에서 멈춰 검은 상자가 됐다 — 프로젝트를
  //   옮겼다 돌아오면 그 사이 보관이 끝나 있어 재생됐고, 그게 왔다갔다하면 된다 의
  //   정체였다. 원본 바이트는 그동안에도 blobCache 에 들어 있었다(store.ts 가 생성
  //   성공 시 prefetch 한다). 목록 끝까지 갔으면 fetch 없이 즉시 떴을 것이다.
  //   이제 끝까지 걷는다. 단을 늘려도 이 코드는 그대로다.
  const chain = useMemo(
    () => sources.filter((v, i) => v && sources.indexOf(v) === i),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources.join(String.fromCharCode(0))],
  );
  const [srcIdx, setSrcIdx] = useState(0);
  const idxRef = useRef(0);
  const activeSrc = chain[srcIdx] || '';
  useEffect(() => { idxRef.current = 0; setSrcIdx(0); setFailed(false); }, [chain]);
  // 다음 단으로. ref 로 세는 이유는 onError 와 fetch 의 catch 가 같은 렌더의 낡은
  // srcIdx 를 함께 보면 한 단을 건너뛰거나 같은 단을 두 번 쓰기 때문이다.
  const goFallback = () => {
    if (idxRef.current >= chain.length - 1) return false;
    idxRef.current += 1;
    setSrcIdx(idxRef.current);
    return true;
  };
  // 목록을 처음부터 다시 걷는다. 마지막 단까지 실패하는 경우는 두 가지인데 —
  // 링크가 정말 만료됐거나, 그냥 잠깐 네트워크가 끊겼거나 — 화면에서는 구분되지
  // 않는다. 후자를 영구 실패로 굳혀 버리면 방금 만든 영상이 사라진 것처럼 보인다.
  // srcIdx 를 0 으로 되돌리는 것만으로는 activeSrc 가 그대로라 effect 가 안 돈다.
  const [retryTick, setRetryTick] = useState(0);
  const retry = () => {
    idxRef.current = 0; setSrcIdx(0); setFailed(false); setRetryTick(t => t + 1);
    setFailPosterGone(false); setFailPosterOk(false); setMasterGone(false);
  };

  useEffect(() => {
    if (eager) return; // eager mode: skip observer, mount immediately
    const container = containerRef.current;
    if (!container) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true);
        } else if (videoRef.current) {
          videoRef.current.pause();
        }
      },
      { threshold: 0, rootMargin: '500px' }
    );
    observer.observe(container);
    // 멀리 벗어나면 영상을 내린다(26.10.2001~). 예전에는 한 번 붙은 영상이 카드가 사라질 때까지 붙어 있어서, 큰
    // 프로젝트를 끝까지 훑기만 해도 지나간 영상이 전부 메모리에 남았다(실측 2026-10-20: 226편 프로젝트 끝까지 → 렌더러
    // +1.27GB, 붙은 <video> 226개). 작업창을 두 칸으로 나누면 그게 두 배가 된다. 이제 목록(스크롤 영역)에서 위아래로
    // 2000px 넘게 멀어지면 내리고, 다시 보이면 붙인다 — 바이트는 blobCache · 로컬 사본에서 바로 다시 온다.
    // ★ 뿌리(root)를 스크롤 영역으로 잡는다. 뷰포트를 뿌리로 두면 rootMargin 은 뷰포트에만 붙고, 카드는 안쪽 스크롤
    //   영역에서 먼저 잘려서 '화면 밖 = 멀리' 가 된다(벗어나자마자 내렸다 붙였다 깜빡인다).
    let scroller: HTMLElement | null = container.parentElement;
    while (scroller) {
      const oy = getComputedStyle(scroller).overflowY;
      if (oy === 'auto' || oy === 'scroll') break;
      scroller = scroller.parentElement;
    }
    const far = scroller ? new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) return;
        if (videoRef.current && document.fullscreenElement === videoRef.current) return;
        setMounted(false);
      },
      { root: scroller, threshold: 0, rootMargin: '2000px 0px' }
    ) : null;
    far?.observe(container);
    return () => { observer.disconnect(); far?.disconnect(); };
  }, [eager]);

  // ── Keep your place across fullscreen ──────────────────────────────────────
  // Chromium scrolls a fullscreened element into view on the way IN and does not put
  // the page back on the way OUT — measured 421px of drift, so you exit looking at a
  // different clip than the one you opened.
  // The scroll has already happened by the time `fullscreenchange` fires, so the
  // position must be captured EARLIER: entering fullscreen always takes a user gesture
  // on the video (the controls' button, or a double-click), and pointerdown precedes
  // all of them. Restore on the way out.
  const scrollHomeRef = useRef<{ el: Element; top: number } | null>(null);
  const rememberScroll = () => {
    let el: HTMLElement | null = containerRef.current;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        scrollHomeRef.current = { el, top: el.scrollTop };
        return;
      }
      el = el.parentElement;
    }
    scrollHomeRef.current = null;
  };
  useEffect(() => {
    const onFsChange = () => {
      const v = videoRef.current;
      if (!v) return;
      if (document.fullscreenElement === v) return;   // entering — nothing to do yet
      const home = scrollHomeRef.current;
      if (!home || !home.el.isConnected) return;
      // Two frames: fullscreen teardown relays out, and a single frame lands too early.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        // 되돌리는 것이지 굴리는 것이 아니다. smooth 가 전역이라 그냥 대입하면
        // 전체화면에서 나올 때 화면이 주르륵 미끄러진다.
        (home.el as HTMLElement).scrollTo({ top: home.top, behavior: 'instant' as ScrollBehavior });
        scrollHomeRef.current = null;
      }));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  // Hover-to-play with sound. Leaving the card just pauses — we keep the current
  // playback position so the next hover resumes from where the user was watching.
  const handleMouseEnter = () => {
    // 포스터가 떠 있으면 여기서 영상으로 바꾼다 — 목록을 훑는 동안에는 이미지만 산다.
    if (showPoster) { setWantVideo(true); return; }
    const v = videoRef.current;
    if (!v) return;
    v.muted = false;
    v.play().catch(() => {
      // Browser autoplay policy may block unmuted playback without an explicit click.
      // Fall back to muted playback so the user at least sees motion; they can click
      // the volume control to unmute manually.
      if (videoRef.current) {
        videoRef.current.muted = true;
        videoRef.current.play().catch(() => {});
      }
    });
  };
  const handleMouseLeave = () => {
    videoRef.current?.pause();
  };

  // Use shared blob cache (populated by store on success). Fetch + cache if missing.
  // 4k is the exception: we stream the URL directly instead of downloading the whole
  // file first. Measured on a real 4k clip — blob path 7.6s to first frame vs 1.36s
  // streaming, because the blob route must pull all ~8MB before the <video> gets
  // anything. (moov sits at the end of these files, but Chromium's range requests
  // handle that fine — measured, not assumed.)
  useEffect(() => {
    // ★ 포스터가 떠 있으면 영상을 아예 받지 않는다. 그리기만 막고 이 fetch 를 놔두면
    //   목록이 여전히 카드마다 4.8MB 를 내려받아서, 포스터를 넣은 의미가 없어진다.
    if (showPoster) return;
    if (!mounted || !activeSrc || is4k) return;
    const src = activeSrc;
    const cached = getCachedBlob(src);
    if (cached) {
      const url = URL.createObjectURL(cached);
      blobUrlRef.current = url;
      setBlobSrc(url);
      setLoading(false);
      setFailed(false);
      return () => {
        if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
        setBlobSrc(null);
      };
    }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetch(src)
      .then(r => { if (!r.ok) throw Object.assign(new Error(`status ${r.status}`), { status: r.status }); return r.blob(); })
      .then(b => {
        if (cancelled) return;
        setCachedBlob(src, b); // share with download flow
        const url = URL.createObjectURL(b);
        blobUrlRef.current = url;
        setBlobSrc(url);
        setLoading(false);
      })
      .catch((err: any) => {
        if (cancelled) return;
        // 마스터(체인 2번째)가 404 = NCP 에 보관본이 없다. 네트워크 실패는 상태코드가
        // 없으므로 여기 걸리지 않는다 — 그 차이가 아래 문구와 버튼을 가른다.
        if (src === chain[1] && err?.status === 404) setMasterGone(true);
        // 보관 전이라 /api/media 가 404 인 경우가 대부분이다 — 원본으로 내려가면 된다.
        if (goFallback()) return;
        setLoading(false);
        setFailed(true);
      });
    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setBlobSrc(null);
    };
  }, [activeSrc, mounted, showPoster, retryTick]);

  return (
    <div
      ref={containerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      // Capture phase: the native controls swallow pointerdown, so a bubbling listener
      // would never see the click on the fullscreen button.
      onPointerDownCapture={rememberScroll}
      className={`${className} aspect-video bg-black flex items-center justify-center relative`}
    >
      {/* 목록 썸네일. 마우스를 올리거나 누르면 영상으로 바뀐다. */}
      {showPoster && (
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setPosterState('ok')}
          onError={() => { setPosterState('none'); setWantVideo(true); }}
          className="w-full h-full object-contain"
        />
      )}
      {/* 포스터가 있는지 확인하는 동안에는 아무것도 받지 않는다. 없으면(404) 영상으로 간다. */}
      {posterState === 'checking' && (
        <img src={poster} alt="" className="hidden"
          onLoad={() => setPosterState('ok')}
          onError={() => { setPosterState('none'); setWantVideo(true); }} />
      )}
      {!showPoster && !mounted && <Play size={40} className="text-white/30" />}
      {!showPoster && mounted && loading && !blobSrc && !is4k && (
        <Loader2 size={32} className="text-white/60 animate-spin" />
      )}
      {/* 4k is HEVC — a machine without the platform decoder renders a black frame and
          no error a user can act on. Say so plainly and point at the two things that
          actually work: download it, or install the free codec. The video still exists
          and is still downloadable; only in-app preview is unavailable. */}
      {mounted && is4k && !CAN_PLAY_HEVC ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-4 text-center">
          <p className="text-[13px] text-white/80 leading-snug">
            이 PC에서는 4K(HEVC) 미리보기를 재생할 수 없습니다.
          </p>
          <p className="text-[11px] text-white/50 leading-snug">
            영상은 정상 생성되었습니다 — 다운로드해서 확인하세요.<br />
            (Microsoft Store의 무료 &ldquo;HEVC Video Extensions&rdquo; 설치 시 재생 가능)
          </p>
        </div>
      ) : mounted && failed ? (
        // 목록의 마지막 단까지 죽었다. 죽은 src 를 <video> 에 물려 검은 상자를 남기는
        // 대신, 왜 못 보는지 말해준다.
        // 예전 조건은 !fallbackSrc 였는데 709 이후로 fallbackSrc 가 항상 채워져 있어
        // 이 안내가 영영 뜨지 않았다 — 그 자리가 전부 검은 상자로 나갔다.
        <>
        {/* 포스터가 있으면 뒤에 깔아준다. 검은 상자만 남으면 어느 컷이었는지 알 수가
            없는데, 포스터는 16~34KB 라 띄우는 비용이 사실상 없다. 없으면(404) 조용히
            사라지고 예전처럼 글씨만 남는다 — 보관 전에 만료된 옛 영상이 그 경우다. */}
        {/* ★ 썸네일을 가리지 않는다. 이 화면의 요점은 '무엇이었는지' 를 보여주는
            것인데, 가운데에 글씨를 얹으면 그 요점이 사라진다. 설명은 아래 띠로 내린다.
            띠는 그림 위에 겹치되 아래쪽 한 줄만 차지하고, 그라데이션으로 글씨만 읽히게
            한다 — 박스를 키우면 카드 높이가 흔들려 목록이 출렁인다. */}
        {!failPosterGone && failBg && (
          <img
            src={failBg}
            alt=""
            onLoad={() => setFailPosterOk(true)}
            onError={() => setFailPosterGone(true)}
            className="absolute inset-0 w-full h-full object-contain"
          />
        )}
        {failPosterOk ? (
          <div className="absolute inset-x-0 bottom-0 px-3 pt-6 pb-2 flex items-end gap-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent">
            <span className="text-[11px] text-white/90 leading-snug flex-1 text-left">
              {masterGone
                ? (PERSONAL ? '24시간 링크가 지나 영상은 남아 있지 않아요. 첫 장면 이미지는 받아 둘 수 있어요.' : '원본 영상은 보관 기간이 지나 남아 있지 않습니다. 이 이미지는 받아두실 수 있습니다.')
                : '지금 영상을 불러오지 못했습니다. 보관본은 남아 있습니다.'}
            </span>
            {masterGone ? (
              <button
                onClick={saveFailPoster}
                title="1280x720 이미지로 저장합니다"
                className="shrink-0 text-[11px] text-white/85 hover:text-white bg-white/15 hover:bg-white/25 border border-white/25 rounded-md px-2.5 py-1 transition-colors">
                이미지 다운로드
              </button>
            ) : (
              <button
                onClick={retry}
                className="shrink-0 text-[11px] text-white/85 hover:text-white bg-white/15 hover:bg-white/25 border border-white/25 rounded-md px-2.5 py-1 transition-colors">
                다시 시도
              </button>
            )}
          </div>
        ) : (
          // 보여줄 그림이 없다. 이때는 검은 상자뿐이니 가운데에 설명을 둔다.
          <div className="relative w-full h-full flex flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-[12px] text-white leading-snug">영상을 불러오지 못했습니다</p>
            <p className="text-[11px] text-white/70 leading-snug">
              보관 전에 원본 링크가 만료됐거나, 잠시 연결이 끊겼을 수 있습니다.<br />
              자동 다운로드를 켜두셨다면 다운로드 폴더에 남아 있습니다.
            </p>
            <button
              onClick={retry}
              className="mt-0.5 text-[11px] text-white/70 hover:text-white bg-white/10 hover:bg-white/20 border border-white/20 rounded-md px-2.5 py-1 transition-colors">
              다시 시도
            </button>
          </div>
        )}
        </>
      ) : !showPoster && mounted && (blobSrc || is4k) && (
        <video
          ref={videoRef}
          src={blobSrc || activeSrc}
          // 4k 는 blob 을 거치지 않고 직접 스트리밍하므로, 보관 전 404 는 여기서 잡힌다.
          // 더 내려갈 단이 없으면 failed 를 세운다 — 안 그러면 검은 상자로 남는다.
          onError={() => { if (!goFallback()) setFailed(true); }}
          // 포스터가 없어서 영상을 띄운 경우, 첫 프레임을 떠서 올려둔다. 다음부터는
          // 이 카드도 16~34KB 이미지로 뜬다. 코덱이 없어 디코딩이 안 되면 여기까지
          // 오지 않으므로(onError 로 빠진다) 아무 기록도 남기지 않고, 다음 기회에 다시 한다.
          onLoadedData={(e) => { if (posterOf && posterState === 'none') void capturePoster(e.currentTarget, posterOf); }}
          controls
          // ★ 브라우저가 <video> 에 얹어주는 저장 기능을 전부 끈다.
          //   여기 물린 src 는 재생용 H.264 프록시다(playbackSrcFor). 컨트롤 막대의
          //   다운로드 버튼이나 우클릭 "동영상을 다른 이름으로 저장" 으로 받으면
          //   원본 대신 재인코딩본이 저장된다 — 그걸 원본인 줄 알고 납품하면 사고다.
          //   원본이 나가는 문은 하나뿐이어야 한다: 카드의 다운로드 버튼
          //   (downloadClip → mediaSrcFor → 마스터. 해시까지 원본과 같음을 확인했다).
          //   nodownload 가 막대의 버튼을, onContextMenu 가 우클릭 메뉴를 없앤다 —
          //   우클릭 메뉴는 controlsList 를 항상 따르지는 않아 둘 다 건다.
          controlsList="nodownload"
          onContextMenu={(e) => e.preventDefault()}
          playsInline
          // 4k streams straight from the CDN, so only ask for metadata up-front instead
          // of eagerly buffering ~8MB per card that scrolls near the viewport.
          preload={is4k ? 'metadata' : 'auto'}
          className="w-full h-full object-contain"
        />
      )}
    </div>
  );
}

/* ─── Timer ─── */
function LiveTimer({ startTime, endTime }: { startTime?: number, endTime?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (endTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [endTime]);
  if (!startTime) return null;
  const elapsed = Math.floor(((endTime || now) - startTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  return <span className="font-mono text-[14px] text-indigo-500 font-medium">{mins}:{secs}</span>;
}

/* ─── Helpers ─── */
// 평문 → 작성 칸 HTML. 평문은 글자다 — '<' 가 태그가 되면 안 된다(26.10.801 검토: 받은 영상 속 글이 여기로 들어오면 그 안의
// 스크립트가 돌 수 있었다). 알약에 넣는 값도 따옴표를 막는다.
const escHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const textToHtml = (text: string, assets: any[]) => {
  const regex = /(\[(?:Image|Video|Audio) \d+\])/g;
  const parts = text.split(regex);
  return parts.map(part => {
    if (part.match(regex)) {
      const name = part.slice(1, -1);
      const asset = assets.find(a => a.name === name);
      if (asset) {
        const thumbSrc = (asset.type === 'image_url' || asset.type === 'video_url') ? (asset.thumbnailUrl || (asset.type === 'image_url' ? asset.url : '')) : '';
        const iconHtml = thumbSrc
          ? `<img src="${escHtml(thumbSrc)}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;display:inline-block;vertical-align:middle;margin-right:4px;" />`
          : `<span style="display:inline-block;width:16px;height:16px;background:#f0f0f5;border-radius:2px;vertical-align:middle;margin-right:4px;text-align:center;line-height:16px;font-size:10px;">${asset.type === 'video_url' ? '🎥' : '🎵'}</span>`;
        return `<span contenteditable="false" class="mention-pill" data-name="${escHtml(asset.name)}" data-asset-id="${escHtml(asset.id)}" style="display:inline-flex;align-items:center;background:#eef2ff;color:#4338ca;padding:2px 6px;border-radius:6px;font-size:13px;margin:0 2px;vertical-align:middle;border:1px solid #c7d2fe;">${iconHtml}<span style="font-weight:500;">[${escHtml(asset.name)}]</span></span>&nbsp;`;
      }
    }
    return escHtml(part);
  }).join('');
};

// ─── 에이전트 작업함 도우미 (26.10.302~, 쓰는 곳은 ChatArea 의 '에이전트 작업함') ───
// 확장자 → 형식. 미디어 캐시는 원본을 octet-stream 으로 주므로 File 의 형식은 여기서 정한다. 첨부 검사(attachFiles)는
// 드래그와 똑같이 형식과 확장자를 본다 — 모르는 확장자는 빈 형식이 되어 거기서 '지원하지 않는 파일' 로 걸린다.
const AGENT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm',
  wav: 'audio/wav', mp3: 'audio/mpeg',
};

// 에이전트가 준 프롬프트(평문) → 작성 칸 HTML. 줄마다 <div>, 빈 줄은 <div><br></div> — getPlainText 가 글자 그대로
// 되읽는 모양이다. [Image N] 같은 표시는 붙인 레퍼런스의 알약으로(textToHtml 과 같은 모양, 뒤에 붙는 공백만 뺀다 —
// 보낸 글이 받은 글과 한 글자도 다르지 않게).
// @{이름} 은 엘리먼트(어셋 라이브러리) 멘션 — elementPill 이 알약 HTML 을 주고, 못 찾은 이름은 missing 에 모은다
// (부르는 쪽이 그때 보내지 않는다 — 글자로 나가면 그 인물 없이 만들어지고 값은 똑같이 낸다).
const agentPromptHtml = (text: string, named: any[], elementPill?: (name: string) => string | null, missing?: string[]) =>
  text.replace(/\r\n?/g, '\n').split('\n').map(line => {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inner = line.split(/(\[(?:Image|Video|Audio) \d+\]|@\{[^}\n]{1,80}\})/g).map(part => {
      if (/^\[(?:Image|Video|Audio) \d+\]$/.test(part)) return textToHtml(part, named).replace(/&nbsp;$/, '');
      const el = part.match(/^@\{([^}\n]{1,80})\}$/);
      if (el) {
        const html = elementPill?.(el[1].trim());
        if (html) return html;
        missing?.push(el[1].trim());
      }
      return esc(part);
    }).join('');
    return `<div>${inner || '<br>'}</div>`;
  }).join('');

// 적어 둔 작성 칸 HTML 의 레퍼런스 알약을 지금 레퍼런스 id 에 이름으로 다시 묶는다 — replaceAllAssets 는 새 id 를 준다.
// handleReuse 와 같은 일. 안 묶으면 알약 감시 effect 가 '지워진 레퍼런스' 로 보고 알약을 지운다.
const rebindMentionPills = (html: string, named: { id: string; name: string }[]) => {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  temp.querySelectorAll('.mention-pill').forEach(pill => {
    const match = named.find(a => a.name === pill.getAttribute('data-name'));
    if (match) pill.setAttribute('data-asset-id', match.id);
    else pill.removeAttribute('data-asset-id');
  });
  return temp.innerHTML;
};

// 보낸 에이전트 작업 → 카드 상태를 올릴 것(26.10.2002~ 앱에 하나). 예전에는 칸(ChatArea)마다 들고 있어서, 보낸 칸을 닫으면
// 그 작업이 'sent' 에서 멈췄다. 이제 손대는 칸이 누구 것이든 이어서 올린다(agentReportProgress).
const agentActive = new Map<string, { projectId: string; ids: string[]; last: string; inFlight?: boolean }>();
// '보내는 중' 잠금(26.10.2004 감사) — 칸이 아니라 프로젝트에 붙는다(store sendingProjects). 한 번 보내기에 한 번만 올리고
// 내린다(token): sendRequest 가 busy(true/false) 를 부르고, 부르는 쪽은 끝난 뒤 1.5초에 한 번 더 release 한다 — 어느 길에서
// 내리는 것을 빠뜨려도 잠금이 남지 않게(Omni 는 0.8초 뒤에 내려 돌기가 보이게 한다).
const sendLock = (pid: string) => {
  let held = false;
  const release = () => { if (held) { held = false; useAppStore.getState().endSending(pid); } };
  return { busy: (on: boolean) => { if (on && !held) { held = true; useAppStore.getState().beginSending(pid); } else if (!on) release(); }, release };
};
const sendingNow = (pid: string) => (useAppStore.getState().sendingProjects[pid] || 0) > 0;

// 화면 id 와 '처리 중' 은 창에 하나(26.10.2002 검토). 칸마다 두면, 왼쪽 칸이 요청을 처리하는(업로드) 사이 사용자가 오른쪽 칸을
// 누를 때 왼쪽 칸은 작업함에 들르지 않아(손대는 칸만 들른다) 서버가 60초 뒤 그 요청을 '화면 응답 없음' 실패로 닫았다 → 에이전트가
// 다시 보내면 오른쪽 칸이 바로 보내고 왼쪽도 업로드를 마치고 보내 두 번 과금될 수 있었다. 이제 어느 칸이 손대는 칸이든 같은 id 로
// 들르고, 처리 중이면 상태만 알린다(peek).
const agentScreenId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let agentBusy = false;
// 받아서 아직 '끝 보고'(요청: sent/failed · 명령: done/failed)가 서버에 닿지 않은 id — claim 마다 알린다. 서버는 이 화면이 가져간
// taken 인데 여기 없는 것을 '받다 끊긴 것' 으로 닫는다(claim 응답을 못 받았거나 보고를 잃음 — taken 에 영원히 굳지 않게).
const agentWorking = new Set<string>();

// 작업함 호출엔 시간 제한 — 서버가 답을 안 하면 agentBusy 가 안 풀려 에이전트 줄 전체가 소리 없이 멈췄다.
// (BytePlus 생성 요청에는 두지 않는다 — 끊어도 작업은 만들어질 수 있어, 카드만 '실패' 가 된다.)
const agentPost = (url: string, body: unknown, ms = 15000) => {
  const ac = new AbortController();
  const t = window.setTimeout(() => ac.abort(), ms);
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
    .finally(() => window.clearTimeout(t));
};
const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => new Promise((resolve, reject) => {
  const t = window.setTimeout(() => reject(new Error(`${what} — ${Math.round(ms / 1000)}초 안에 끝나지 않았습니다`)), ms);
  p.then(v => { window.clearTimeout(t); resolve(v); }, e => { window.clearTimeout(t); reject(e); });
});
// 끝 보고는 닿을 때까지 다시 보낸다(2초 → 30초 간격) — 잃으면 서버에서 그 요청 · 명령이 taken 에 굳는다. 닿을 때까지 agentWorking
// 에 남긴다. 404 = 서버가 다시 떠서 그 요청이 없다 — 그만. 기다리지 않는다(부르는 쪽은 void) — 다음 요청을 막지 않게.
const agentReportSure = (kind: 'jobs' | 'commands', id: string, body: Record<string, unknown>): Promise<void> => {
  agentWorking.add(id);
  return new Promise(resolve => {
    let tries = 0;
    const go = () => {
      agentPost(`/api/agent/${kind}/${encodeURIComponent(id)}/report`, body)
        .then(r => { if (!r.ok && r.status !== 404) throw new Error(String(r.status)); agentWorking.delete(id); resolve(); })
        .catch(() => { tries++; window.setTimeout(go, Math.min(30000, 2000 * tries)); });
    };
    go();
  });
};
const agentReport = (id: string, body: Record<string, unknown>) => agentReportSure('jobs', id, body);

// 카드 상태 → 에이전트에게 보여 줄 모양. 카드를 지웠으면 missing.
const agentCards = (projectId: string, ids: string[]) => {
  const msgs = useAppStore.getState().projects.find(p => p.id === projectId)?.messages || [];
  return ids.map(id => {
    const m = msgs.find(x => x.id === id) as any;
    if (!m) return { id, status: 'missing' };
    return {
      id, status: m.status || 'queued',
      ...(m.taskId ? { taskId: m.taskId } : {}),
      ...(m.videoUrl ? { videoUrl: m.videoUrl } : {}),
      ...(m.error ? { error: String(m.error).slice(0, 500) } : {}),
    };
  });
};
// 보낸 요청의 카드 상태를 올린다(바뀐 때만). 전부 끝나면(성공 · 실패 · 지워짐) done. 손대는 칸이 2초마다.
// 보고가 닿은 뒤에만 '올렸음' 으로 치고 지운다 — 예전엔 보내기 전에 지워서, 'done' 을 잃으면 에이전트 쪽이 'sent' 에 굳었다.
const agentReportProgress = () => {
  for (const [jobId, a] of agentActive) {
    if (a.inFlight) continue;
    const cards = agentCards(a.projectId, a.ids);
    const sig = JSON.stringify(cards);
    if (sig === a.last) continue;
    const finished = cards.every(c => c.status === 'succeeded' || c.status === 'failed' || c.status === 'missing');
    a.inFlight = true;
    agentPost(`/api/agent/jobs/${encodeURIComponent(jobId)}/report`, { status: finished ? 'done' : 'sent', messages: cards })
      .then(r => {
        if (r.status === 404) { agentActive.delete(jobId); return; }   // 서버가 다시 떠서 그 요청이 없다
        if (!r.ok) return;                                              // 다음 틱에 다시
        a.last = sig;
        if (finished) agentActive.delete(jobId);
      }, () => { /* 다음 틱에 다시 */ })
      .finally(() => { a.inFlight = false; });
  }
};
// 에이전트가 가리킨 프로젝트 — id 먼저(projects.list 의 id), 없으면 사이드바 이름 그대로. 대상이 애매하면 고르지 않는다:
// 같은 이름이 둘(다른 그룹)이면 후보를 돌려주고, 못 찾으면 실패다. 열린 프로젝트로 대신 가지 않는다(26.10.2002~).
// ★ server.ts 의 작업함(claim)도 같은 규칙으로 대상을 찾는다(코드가 없는 프로젝트의 작업은 내주지 않으려고) — 같이 고칠 것.
const agentResolveProject = (projectId: unknown, name: unknown, what = '보낼 프로젝트') => {
  const st = useAppStore.getState();
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  const n = typeof name === 'string' ? name.trim() : '';
  if (id) {
    const p = st.projects.find(x => x.id === id);
    if (!p) throw new Error(`프로젝트를 찾지 못했습니다(id ${id}) — 지워졌을 수 있습니다. projects.list 로 다시 확인해 주세요.`);
    // 둘 다 적었는데 다르면 보내지 않는다(26.10.2002 검토) — 확인한 뒤 이름이 바뀌었거나 id 를 잘못 짝지은 것이다.
    if (n && n !== id && n !== p.name.trim()) throw new Error(`projectId 의 프로젝트 이름은 "${p.name}" 입니다(요청: "${n}") — 이름이 바뀌었거나 id 가 다른 프로젝트 것입니다. projects.list 로 확인한 뒤 다시 보내 주세요.`);
    return p;
  }
  if (!n) throw new Error(`${what}가 없습니다 — projectId(projects.list 의 id) 또는 project(사이드바 이름 그대로)를 적어 주세요.`);
  const byId = st.projects.find(x => x.id === n);   // project 칸에 id 를 적은 경우(예전 명령은 둘 다 받았다)
  if (byId) return byId;
  const hits = st.projects.filter(x => x.name.trim() === n);
  if (hits.length > 1) {
    const g = (gid?: string) => st.projectGroups.find(x => x.id === gid)?.name;
    throw new Error(`같은 이름의 프로젝트가 ${hits.length}개입니다: "${n}" — projectId 로 정해 보내 주세요.\n`
      + hits.map(h => `  ${h.id}${g(h.groupId) ? ` (그룹 "${g(h.groupId)}")` : ' (최상위)'}`).join('\n'));
  }
  if (!hits.length) throw new Error(`프로젝트를 찾지 못했습니다: "${n}"\n(있는 프로젝트: ${st.projects.slice(0, 40).map(x => x.name).join(', ')}${st.projects.length > 40 ? ' …' : ''})`);
  return hits[0];
};
// 코드를 기다리는 작업 수(프로젝트 id → 수) — 늘어난 때만 토스트(손대는 칸).
let agentWaitingPrev: Record<string, number> = {};

// 에이전트 설명서(src/lib/agent-inbox.ts) — 모듈 상수에서 만들므로 한 번만 만든다(바뀌려면 앱을 다시 켜야 한다).
let agentManualCache: ReturnType<typeof buildAgentManual> | null = null;
const agentManual = () => (agentManualCache ??= buildAgentManual(__APP_VERSION__));


// Settings chips for a message / preview card. Omni shows its task + fixed 720p (its
// `mode` field is a stale Seedance leftover); Seedance shows mode / resolution as before.
/**
 * 마스터 주소 — NCP 보관본. 서버가 로컬 사본을 갖고 있으면 디스크에서 바로 나오고,
 * 없으면 NCP 에서 흘려준다. 아직 보관 전이면 404 다 — 재생은 playbackChain 의 다음
 * 단으로 내려가고, 다운로드는 이 주소만 쓴다(언제나 원본).
 *
 * project/ext 를 쿼리로 함께 보내는 것은 서버가 색인을 잃었을 때(재설치 등)의 복구용이다.
 * 평소에는 서버 색인만으로 충분하다.
 */
export function mediaSrcFor(m: { taskId?: string; videoUrl?: string; usedSettings?: any; videoStorage?: { project?: string; ext?: string; projectId?: string } }): string {
  if (!m.taskId || !m.videoUrl) return m.videoUrl || '';
  const q = new URLSearchParams();
  if (m.videoStorage?.ext) q.set('ext', m.videoStorage.ext);
  if (m.videoStorage?.project) q.set('project', m.videoStorage.project);
  // 26.9.2306~ 영상은 NCP 에서 프로젝트 id 폴더에 있다 — 서버가 id 폴더를 먼저, 그다음 이름 폴더를 본다.
  if (m.videoStorage?.projectId) q.set('projectId', m.videoStorage.projectId);
  // 보관 경로의 최상위 폴더. 모델에서 유도하므로 따로 저장할 필요가 없다.
  q.set('provider', archiveProviderOf(m.usedSettings?.model));
  const s = q.toString();
  return `/api/media/${encodeURIComponent(m.taskId)}${s ? `?${s}` : ''}`;
}

/**
 * NCP 최상위 폴더 이름 = 모델 상징 id. 다운로드 파일 이름의 접두어와 같은 값이다.
 * 삼항으로 두 회사를 가르던 자리 — 세 번째 회사가 들어오면 이런 삼항을 전부 찾아
 * 고쳐야 했고 하나만 놓쳐도 조용히 남의 폴더에 쌓였다. 이제 규칙은 한 곳뿐이다
 * (model-access.ts / BRAND_RULES).
 */
export function archiveProviderOf(model?: string): string {
  return brandOf(model);
}

/**
 * 재생 체인의 첫 단 — H.264 프록시. 결과물이 전부 HEVC 라, 코덱 없는 PC 에서는 4K 는
 * 물론 1080p 도 재생되지 않기 때문이다. 없으면(404) playbackChain 의 다음 단으로 간다.
 * ★ 다운로드는 이 주소를 쓰지 않는다 — 언제나 마스터(mediaSrcFor)를 받는다.
 */
export function playbackSrcFor(m: { taskId?: string; videoUrl?: string }): string {
  if (!m.taskId || !m.videoUrl) return m.videoUrl || '';
  return `/api/media/${encodeURIComponent(m.taskId)}/preview`;
}

/**
 * 재생 소스의 우선순위. VideoPlayer 는 이 목록을 앞에서부터 쓰고, 한 단이 죽으면
 * 다음 단으로 내려간다.
 *
 *   1. 프록시  — H.264. 코덱 없는 PC 에서도 나오는 유일한 단이다. 아직 안 만들었거나
 *                원본이 이미 H.264 라 만들 필요가 없었으면 404 다.
 *   2. 마스터  — NCP 보관 원본(로컬 사본이 있으면 디스크에서 바로). 보관 전이면 404.
 *   3. 원본URL — 생성 API 가 준 주소. 약 24시간이면 죽으므로 그 안쪽만 시도한다.
 *                갓 만든 영상은 여기 바이트가 이미 blobCache 에 있어 즉시 뜬다.
 *
 * ★ 순서를 정하는 곳은 여기 하나뿐이다. 단을 늘리거나 바꿀 때 호출부 네 군데를
 *   따라다니지 않게 하려는 것 — 예전에 그러다 원본 단을 통째로 잃었다.
 */
export function playbackChain(m: {
  taskId?: string; videoUrl?: string; usedSettings?: any; endTime?: number; timestamp?: number;
  videoStorage?: { project?: string; ext?: string };
}): string[] {
  return [
    playbackSrcFor(m),
    mediaSrcFor(m),
    originMaybeAlive(m) ? (m.videoUrl || '') : '',
  ];
}
/** 목록 썸네일 주소. 없으면 서버가 404 를 주고, 카드가 그때 만들어 올린다. */
export function posterSrcFor(m: { taskId?: string; usedSettings?: any; videoStorage?: { project?: string; projectId?: string } }): string {
  if (!m.taskId) return '';
  const q = new URLSearchParams();
  q.set('provider', archiveProviderOf(m.usedSettings?.model));
  if (m.videoStorage?.project) q.set('project', m.videoStorage.project);
  if (m.videoStorage?.projectId) q.set('projectId', m.videoStorage.projectId);
  return `/api/media/${encodeURIComponent(m.taskId)}/poster?${q.toString()}`;
}

// 이번 실행에서 이미 캡처를 시도한 taskId. 실패(4K HEVC 등)를 영구 기록으로 남기지
// 않는 것이 핵심이다 — 코덱을 나중에 깔거나, 코덱이 있는 다른 팀원 PC 가 열면 그때
// 만들어진다. 포스터는 NCP 에 있으므로 한 번 만들어지면 전원이 본다.
const posterTried = new Set<string>();

/**
 * <video> 의 현재 프레임을 떠서 서버로 보낸다. 목록이 4.8MB 짜리 영상을 통째로 받던
 * 자리를 16~34KB 로 바꾸는 것이 목적이다(실측: 13MB 4K → 34KB, 3.9MB 1080p → 16KB).
 * 1280 폭이면 카드(350~400px)의 2배 밀도에도 여유가 있다.
 *
 * 실패는 조용히 넘어간다. 썸네일이 없으면 지금처럼 영상을 띄우면 될 뿐, 잃는 데이터가 없다.
 */
async function capturePoster(video: HTMLVideoElement, m: { taskId?: string; usedSettings?: any; videoStorage?: { project?: string; projectId?: string } }) {
  const id = m.taskId;
  if (!id || posterTried.has(id) || !video.videoWidth) return;
  posterTried.add(id);
  try {
    const w = Math.min(1280, video.videoWidth);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = Math.round(w * video.videoHeight / video.videoWidth);
    c.getContext('2d')!.drawImage(video, 0, 0, c.width, c.height);
    const blob: Blob | null = await new Promise(r => c.toBlob(r, 'image/webp', 0.8));
    if (!blob || blob.size < 256) return;
    const q = new URLSearchParams();
    q.set('provider', archiveProviderOf(m.usedSettings?.model));
    if (m.videoStorage?.project) q.set('project', m.videoStorage.project);
    // 서버는 색인에 본 영상이 있으면 그 옆에, 없으면 id 폴더(없으면 이름 폴더)에 올린다.
    if (m.videoStorage?.projectId) q.set('projectId', m.videoStorage.projectId);
    await fetch(`/api/media/${encodeURIComponent(id)}/poster?${q.toString()}`, {
      method: 'POST', headers: { 'Content-Type': 'image/webp' }, body: blob,
    });
  } catch { /* 캡처 실패(코덱 없음 등)는 다음 기회에 */ }
}

/**
 * 생성 API 가 준 원본 URL 이 아직 살아있을 가능성이 있는가.
 *
 * BytePlus 의 결과 URL 은 약 24시간이면 죽는다. 그보다 오래된 것에 폴백을 걸어봐야
 * 403 을 받고(측정 0.86초) 결국 깨진 플레이어가 남는다 — 갤러리 한 페이지가 24장이니
 * 카드마다 1초씩 헛돈다. 확실히 만료된 것은 시도조차 하지 않고 안내를 띄운다.
 * 여유를 두고 20시간으로 잡는다: 경계 근처의 것은 한 번 시도해 보는 편이 낫다.
 */
export function originMaybeAlive(m: { endTime?: number; timestamp?: number }): boolean {
  const at = m.endTime || m.timestamp || 0;
  return at > 0 && Date.now() - at < 20 * 60 * 60 * 1000;
}

// 초안/본편 칩. 문자열 목록(settingsTagList)은 그대로 두고, 그리는 쪽이 이 두 값만 색을
// 달리 칠한다 — 회색 칩 사이에서 "이건 480p 미리보기" 가 한눈에 보여야 한다.
const DRAFT_TAG = 'Draft';
const FINAL_TAG = '본편';
const tagTone = (tag: string, plain: string) => tag === DRAFT_TAG ? 'bg-amber-100 text-amber-700'
  : tag === FINAL_TAG ? 'bg-indigo-100 text-indigo-600'
  : plain;

// 초안이 본편으로 쓰일 수 있는 남은 시간. 하루 넘게 남았으면 날짜로(그게 가장 덜 헷갈린다),
// 하루 안쪽이면 시간으로 — 그때는 급하다는 것이 보여야 한다.
export function draftLeftLabel(expiresAt: number, now = Date.now()): string {
  const left = expiresAt - now;
  if (left >= 24 * 60 * 60 * 1000) {
    const d = new Date(expiresAt);
    return `${d.getMonth() + 1}/${d.getDate()}까지`;
  }
  return `${Math.max(1, Math.ceil(left / (60 * 60 * 1000)))}시간 남음`;
}

const settingsTagList = (us: any, videoUrl?: string, draftOf?: string): string[] => {
  if (!us) return [];
  // 초안/본편 표시는 모델·해상도 칩 뒤에 붙인다. 앞쪽 칩의 순서는 기존 카드와 같게 둔다.
  const withDraftTag = (tags: string[]) =>
    us.draft ? [...tags, DRAFT_TAG] : draftOf ? [...tags, FINAL_TAG] : tags;
  return withDraftTag(baseSettingsTags(us, videoUrl));
};

const baseSettingsTags = (us: any, videoUrl?: string): string[] => {
  // Two Omni models now ship side by side, so the chip has to tell them apart in ~90px:
  // 'Gemini Omni 1.1 Flash' → 'Omni 1.1 Flash', 'Gemini Omni Flash' → 'Omni Flash'.
  const modelName = MODELS.find((m: any) => m.id === us.model)?.name?.replace('Seedance ', '').replace('Gemini Omni', 'Omni') || '2.0';
  if (modelProvider(us.model) === 'gemini') {
    // Resolve against the snapshot's OWN model — an old card must keep reading as what it
    // actually was, and a task the recorded model never offered is not a truthful chip.
    const t = resolveOmniTask(us.model, us.omniTask);
    if (t === 'edit' || t === 'extend') {
      // Only the RATIO came from the source clip — resolution was sent and honoured, so
      // report it. Extend's duration is what was APPENDED, not the finished length.
      const dur = t === 'edit' ? '원본 길이' : `+${Math.max(3, Math.min(10, us.duration || 5))}s`;
      const r = modelResolutions(us.model).length > 1
        ? (us.resolution === '4k' ? '4K' : us.resolution || '720p')
        : '720p';
      return [modelName, OMNI_TASK_LABELS[t], r, '비율 원본', dur];
    }
    // Only multi-resolution models ever sent the field; the preview was always 720p.
    const res = modelResolutions(us.model).length > 1
      ? (us.resolution === '4k' ? '4K' : us.resolution || '720p')
      : '720p';
    return [modelName, OMNI_TASK_LABELS[t], res, us.ratio, `${Math.max(3, Math.min(10, us.duration || 5))}s`];
  }
  // API value is lowercase '4k'; display it as "4K" to match the Resolution dropdown.
  const res = us.resolution === '4k' ? '4K' : us.resolution;
  const tags = [modelName, us.mode, res, us.ratio, us.duration === -1 ? 'Auto' : `${us.duration}s`];
  // Output format, but ONLY for models where it was a choice — every 2.0 clip has always
  // been mp4, so a chip there is noise on cards that never had a decision behind them.
  // Read off the finished URL first and the stored setting only as a fallback: the URL is
  // what the API actually produced, the setting is what we asked for.
  if (modelOutputFormats(us.model).length > 1) {
    const fromUrl = (videoUrl || '').split('?')[0].match(/\.(mov|mp4)$/i)?.[1];
    const fmt = fromUrl || resolveOutputFormat(us.model, us.output_format);
    if (fmt) tags.push(fmt.toLowerCase());
  }
  return tags;
};

// filename → messageId, for downloads whose save path only arrives with the Electron
// 'download-done' event. MODULE scope, not a component ref: the all-projects gallery can
// start a download for a message in a project ChatArea doesn't have open, and both paths
// must feed the same listener.
export const pendingReveal = new Map<string, string>();

// Date+time stamp pinned to a clip's top-left corner. The card already carries WHAT was
// generated (model / mode / resolution chips); this answers WHEN, which is how people
// actually tell two takes of the same prompt apart.
// pointer-events-none so it never steals the hover that starts playback.
export function ClipStamp({ ms }: { ms: number }) {
  return (
    <div
      title={`생성 시각 ${formatStampFull(ms)}`}
      className="absolute top-2 left-2 z-10 pointer-events-none select-none px-1.5 py-[3px] rounded-md bg-black/55 backdrop-blur-[2px] text-white/90 text-[10px] font-mono tabular-nums leading-none tracking-tight"
    >
      {formatStamp(ms)}
    </div>
  );
}

// Draft ↔ 본편 연결 줄의 작은 썸네일. 포스터가 있으면 그 이미지를 쓰고, 없으면 영상 첫 프레임을
// 한 번 떠서 이미지로 바꾼다 — 작은 칸 하나 때문에 디코더를 계속 붙잡아 두지 않게.
// Draft 는 갤러리에서 기본으로 숨겨져 있어 포스터가 거의 없다(포스터는 갤러리에서 영상을 띄울
// 때 만들어진다). 뜬 이미지는 이번 실행 동안만 taskId 별로 기억한다.
const pairThumbCache = new Map<string, string>();
function PairThumb({ m }: { m: any }) {
  const key = m?.taskId || '';
  const ready = m?.status === 'succeeded' && !!m?.videoUrl;
  const [img, setImg] = useState(() => pairThumbCache.get(key) || '');
  const [stage, setStage] = useState<number>(-1);          // -1 = 포스터, 0.. = 재생 소스 순서
  const [near, setNear] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || near) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  const sources = ready ? playbackChain(m).filter(Boolean) : [];
  const grab = (v: HTMLVideoElement) => {
    try {
      const w = 160, h = Math.max(1, Math.round(w * (v.videoHeight || 9) / (v.videoWidth || 16)));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d')?.drawImage(v, 0, 0, w, h);
      const url = c.toDataURL('image/jpeg', 0.8);
      pairThumbCache.set(key, url);
      setImg(url);
    } catch { /* 다른 출처(원본 URL)라 캔버스로 못 뜨면 영상 첫 프레임을 그대로 보여 준다 */ }
  };
  return (
    <div ref={boxRef} className="w-16 h-9 rounded-md overflow-hidden bg-black/80 shrink-0 flex items-center justify-center">
      {!ready ? <Loader2 size={14} className="animate-spin text-white/70" />
        : img ? <img src={img} alt="" className="w-full h-full object-cover" />
        : !near ? null
        : stage < 0 ? <img src={posterSrcFor(m)} alt="" className="w-full h-full object-cover" onError={() => setStage(0)} />
        : stage < sources.length ? (
          <video key={stage} src={`${sources[stage]}#t=0.1`} muted playsInline preload="auto" className="w-full h-full object-cover"
            onLoadedData={(e) => grab(e.currentTarget)} onError={() => setStage(s => s + 1)} />
        ) : <Video size={14} className="text-white/60" />}
    </div>
  );
}

// Draft ↔ 본편을 잇는 줄. 카드 맨 위에 둔다 — 짝이 어느 카드인지 썸네일과 생성 시각으로 바로
// 보인다. 시각은 짝 카드의 영상 왼쪽 위 스탬프와 같은 형식이라 눈으로 맞춰 볼 수 있다.
// 누르면 그 카드로 가서 테두리를 잠깐 밝힌다. 영상 위에 글을 얹지 않으려고 카드 머리에 둔다.
function PairLink({ toDraft, other, onGo }: { toDraft: boolean; other: any; onGo: () => void }) {
  const running = !toDraft && other.status !== 'succeeded';
  return (
    <button onClick={onGo}
      title={toDraft ? '이 본편을 만든 Draft 로 이동' : '이 Draft 로 만든 본편으로 이동'}
      className={`flex items-center gap-2 w-fit max-w-full rounded-lg border pl-1 pr-2.5 py-1 transition-colors ${toDraft
        ? 'border-amber-200 bg-amber-50/70 hover:bg-amber-100/70'
        : 'border-indigo-200 bg-indigo-50/70 hover:bg-indigo-100/70'}`}>
      <PairThumb m={other} />
      <span className={`text-[12px] font-semibold whitespace-nowrap ${toDraft ? 'text-amber-700' : 'text-indigo-600'}`}>
        {toDraft ? '원본 Draft' : running ? '본편 만드는 중' : '본편'}
      </span>
      <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">{formatStamp(other.timestamp)}</span>
      {toDraft ? <ArrowUp size={13} className="text-amber-500 shrink-0" /> : !running && <ArrowDown size={13} className="text-indigo-500 shrink-0" />}
    </button>
  );
}

// Download a clip and mark its message so the button flips to "다시 다운로드".
// Module-level and owner-resolved-by-message-id (rather than closing over the open
// project) so the all-projects gallery can download a clip from ANY project. That also
// removes a latent bug: the old version always wrote to the currently-open project.
export async function downloadClip(msgId: string, videoUrl: string, taskId: string) {
  try {
    const st = useAppStore.getState();
    const owner = st.projects.find(p => p.messages.some(m => m.id === msgId));
    if (!owner) return;
    // 이름 규칙은 자동 다운로드와 같은 함수를 쓴다 (store.ts / downloadFilenameFor).
    // 규칙이 두 벌이면 반드시 갈라진다 — 실제로 Omni 의 짧은 이름 규칙은 여기에만
    // 있었고 자동 다운로드 쪽에는 규칙 자체가 없었다.
    // 확장자는 이 클립이 실제로 가진 URL 에서 뽑는다(2.5 → .mov). 프로젝트의 현재
    // 모델이 아니라 이 클립을 만든 모델을 쓴다 — 그 사이 바뀌었을 수 있다.
    const msgSettings = owner.messages.find(m => m.id === msgId)?.usedSettings;
    const msgModel = msgSettings?.model || '';
    // 초안이면 이름 끝에 -draft 가 붙는다 — 그 판단에 쓰는 값도 함께 넘긴다.
    const filename = downloadFilenameFor({ videoUrl, taskId, usedSettings: { model: msgModel, draft: msgSettings?.draft } as any });
    // Remember which message this filename belongs to. The Electron download path only
    // learns the save path once 'download-done' fires, long after this call returns.
    pendingReveal.set(filename, msgId);
    // ★ 마스터를 받는다. 예전에는 생성 API 가 준 원본 URL 을 그대로 썼는데, 그 링크는
    //   약 24시간 뒤 죽어서 보관된 영상조차 다운로드가 403 으로 실패했다. 서버가
    //   로컬 사본 → NCP → 원본 순으로 내려가며 언제나 원본 화질을 준다(프록시가 아니다).
    // 보관 힌트(확장자 · 프로젝트)도 넘긴다 — 재생은 넘기는데 다운로드만 안 넘겨서, 이 PC 의 보관 색인이 없으면(재설치 ·
    // AppData 정리) 서버가 .mp4 로 찾다가 2.5(.mov) 영상을 못 찾고 다운로드가 조용히 실패했다(26.10.801 격리 시험에서 발견).
    const msg = owner.messages.find(m => m.id === msgId);
    const masterSrc = mediaSrcFor({ videoUrl, taskId, usedSettings: { model: msgModel } as any, videoStorage: msg?.videoStorage });
    // 받은 영상 끝에 이 영상을 만든 설정을 넣고(26.10.801~, settings-box), 레퍼런스 원본은 30일 정리에서 뺀다 — 나중에 이
    // 파일을 앱에 끌어다 놓으면 작성 칸이 되살아난다.
    if (msg) pinMessageReferences(msg);
    const meta = msg ? await downloadMetaFor(msg) : undefined;
    // 개인판(26.10.2006~)은 보관본이 없다 — 24시간 링크(옴니는 앱 안 파일)로 받는다. 링크가 지났으면 받을 것이 없다고 말한다.
    const src = PERSONAL ? (videoUrl.startsWith('/') || (msg && originMaybeAlive(msg)) ? videoUrl : '') : (masterSrc || videoUrl);
    if (!src) {
      window.dispatchEvent(new CustomEvent('seedance:toast', { detail: { msg: '이 영상은 24시간 링크가 지나 받을 수 없어요 — 남은 것은 첫 장면 이미지예요.', ok: false } }));
      pendingReveal.delete(filename);
      return;
    }
    const savedPath = await downloadViaProxy(src, filename, meta);
    useAppStore.getState().updateMessage(owner.id, msgId, {
      downloadedAt: Date.now(),
      // Blob fast path knows the path immediately; otherwise the done-listener fills it.
      ...(savedPath ? { downloadedPath: savedPath } : {}),
    });
    if (savedPath) pendingReveal.delete(filename);
    // Force the mark to disk now — the 1.5s debounced write would be lost
    // if the app quits (or auto-update restarts) right after the download.
    await flushPersist();
  } catch (e) { console.error('download failed:', e); }
}

// Open the containing folder with the file selected, so the user can see WHICH clip this
// was. The file may be long gone (moved into an edit project, renamed, deleted) — main
// checks existence and reports back so we can say so instead of doing nothing.
// `warn` is injected because the toast lives in ChatArea but the gallery needs this too.
export async function revealClipFile(filePath: string | undefined, warn: (m: string) => void) {
  if (!filePath) { warn('저장 경로를 알 수 없습니다. 다시 다운로드해주세요.'); return; }
  const api = (window as any).electronAPI;
  if (!api?.revealFile) { warn('이 환경에서는 폴더 열기를 지원하지 않습니다.'); return; }
  const r = await api.revealFile(filePath);
  if (r?.ok) return;
  warn(r?.reason === 'missing'
    ? `파일을 찾을 수 없습니다 — 이동·이름변경·삭제된 것 같습니다.\n${filePath}`
    : '폴더를 열지 못했습니다.');
}

const renderMessageContent = (content: string, namedAssets: any[]) => {
  const regex = /(\[(?:Image|Video|Audio) \d+\])/g;
  const parts = content.split(regex);
  return parts.map((part, i) => {
    if (part.match(regex)) {
      const assetName = part.slice(1, -1);
      const asset = namedAssets.find(a => a.name === assetName);
      if (asset) {
        return (
          <span key={i} className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-md px-1.5 py-0.5 mx-0.5 align-middle text-[13px]">
            {asset.type === 'image_url' ? <img src={asset.thumbnailUrl || asset.url} className="w-4 h-4 object-cover rounded-sm" alt="" /> : asset.type === 'video_url' && asset.thumbnailUrl ? <img src={asset.thumbnailUrl} className="w-4 h-4 object-cover rounded-sm" alt="" /> : asset.type === 'video_url' ? <Video size={12} /> : <Music size={12} />}
            <span className="font-medium">[{asset.name}]</span>
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
};

/* Render a saved prompt-HTML snapshot (with mention pills) into React nodes for
   the message card — mirrors the input's pills (panel + element) with their
   image icons. No dangerouslySetInnerHTML: text nodes render as text and any
   unknown element degrades to its textContent, so user-typed/pasted markup can
   never execute. Thumbnails are the frozen ones baked in at send. */
const renderPromptHtml = (html: string, namedAssets: any[]): React.ReactNode[] => {
  const temp = document.createElement('div');
  temp.innerHTML = html;
  const out: React.ReactNode[] = [];
  let key = 0;
  const endsWithNewline = () => out.length > 0 && out[out.length - 1] === '\n';

  // Walk RECURSIVELY so the card mirrors exactly what the API send sees.
  // getPlainText() builds the sent text via innerText, which turns block
  // boundaries (<div>/<p>) AND <br> into "\n". We must match that here — and
  // recurse INTO blocks — otherwise a 2nd+ line (Enter makes <div>, multi-line
  // paste makes <div>) would lose its line break AND flatten its pills to plain
  // text. Newlines are emitted as RAW "\n" (never <br>): the collapsed card uses
  // `truncate` (white-space:nowrap) → squashes to a one-line preview, while the
  // expanded card uses `whitespace-pre-wrap` → real line break. A literal <br>
  // would ignore white-space and force multi-line even when collapsed.
  const walk = (parent: Node) => {
    parent.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        // Literal [Image N]/[Video N]/[Audio N] in text (typed, or pasted before
        // the refs existed) → re-pill via renderMessageContent so the card matches
        // the input — restores the pin display the pre-promptHtml renderer gave.
        if (node.textContent) out.push(<Fragment key={key++}>{renderMessageContent(node.textContent, namedAssets)}</Fragment>);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === 'BR') { out.push('\n'); return; }
      const isPanel = el.classList.contains('mention-pill');
      const isElement = el.classList.contains('element-pill');
      if (isPanel || isElement) {
        const name = el.getAttribute('data-name') || '';
        const thumb = el.querySelector('img')?.getAttribute('src') || '';
        if (isElement) {
          const cat = el.getAttribute('data-category') as AssetCategory;
          const meta = (cat && CATEGORY_META[cat]) || { bg: 'var(--cat-fallback-bg)', text: 'var(--cat-fallback-text)', border: 'var(--cat-fallback-border)', accent: 'var(--cat-fallback-accent)' };
          out.push(
            <span key={key++} className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 mx-0.5 align-middle text-[13px] font-medium" style={{ background: meta.bg, color: meta.text, border: `1px solid ${meta.border}` }}>
              {thumb ? <img src={thumb} className="w-4 h-4 object-cover rounded-sm" alt="" /> : <span className="w-2 h-2 rounded-full inline-block" style={{ background: meta.accent }} />}
              <span>[{name}]</span>
            </span>
          );
        } else {
          // Icon parity with renderMessageContent: image→thumb, video→thumb or
          // Video icon, audio→Music icon. Type comes from the frozen usedAssets
          // (namedAssets) so an audio/video pin still reads as that type, not a
          // bare name, in the card.
          const asset = namedAssets.find((a: any) => a.name === name);
          out.push(
            <span key={key++} className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 border border-indigo-200 rounded-md px-1.5 py-0.5 mx-0.5 align-middle text-[13px]">
              {thumb ? <img src={thumb} className="w-4 h-4 object-cover rounded-sm" alt="" />
                : asset?.type === 'video_url' ? <Video size={12} />
                : asset?.type === 'audio_url' ? <Music size={12} />
                : null}
              <span className="font-medium">[{name}]</span>
            </span>
          );
        }
        return;
      }
      // Block element → starts on its own line (mirror innerText), then recurse
      // so its text + pills render instead of being flattened to textContent.
      if (el.tagName === 'DIV' || el.tagName === 'P') {
        if (out.length > 0 && !endsWithNewline()) out.push('\n');
        walk(el);
        return;
      }
      // Inline wrapper (span/b/i/…) → recurse to catch nested pills & text.
      walk(el);
    });
  };
  walk(temp);
  return out;
};

/* ─── Collapsible prompt: 1-line truncated by default, expand/collapse + copy ─── */
// ─── 받은 영상에서 되살리기 (26.10.801~, src/lib/settings-box.ts) ─────────────────────────
// 받은 영상(끝에 생성 설정이 든 것)을 끌어다 놓으면 뜨는 창. 이 PC 에 그 카드가 있으면 그 카드 그대로(재사용과
// 같다), 없으면(다른 PC · 지운 카드) 파일에 실려 온 설정으로 채운다. 설정이 없는 옛 영상은 파일 이름의 작업 번호 · 영상 안의
// BytePlus 고유번호로 이 PC 카드를 찾고, 그것도 없으면 만든 시각이 가까운 카드를 후보로 보여 주고 고르게 한다.
type LocalMatch = { projectId: string; projectName: string; msg: ChatMessage };
type RestoreTarget = {
  payload: SettingsPayload | null;
  local: LocalMatch | null;
  file?: File;                     // 영상이면 '레퍼런스로 붙이기' 에 쓴다
  candidates?: LocalMatch[];       // 설정도 번호도 없을 때 — 만든 시각이 가까운 이 PC 카드
};
// 불러오기 직전의 작성 칸 · 레퍼런스 · 오른쪽 설정 · 컬렉션 연결 — 불러오기는 초기화부터 하므로 안내의 '되돌리기' 를 위해 둔다.
type ComposerSnapshot = { projectId: string; promptHtml: string; assets: any[]; settings: any; collectionId: string | null };
// 불러온 뒤 작성 칸 위에 남는 안내 — 머리 한 줄 + 앱이 대신 바꾼 것(notes)과 빠졌거나 그때와 다른 것(missing)만. 닫기를 눌러야 닫힌다.
type RestoreReport = {
  how: 'paste' | 'restore';
  source: string;
  sourceTitle: string;             // 마우스를 올리면 — 만든 시각 · 어디서 왔는지 자세히
  notes: string[];                 // 앱이 대신 바꾼 것(컬렉션 연결) — 회색
  missing: string[];               // 빠졌거나 그때와 다른 것 — 주황
  local: LocalMatch | null;        // '그 카드로 가기'
  target: RestoreTarget;           // '프롬프트만' 뒤에 '그때 설정 그대로' 로 다시 불러오기
  snapshot: ComposerSnapshot;      // '되돌리기'
};
type ReportSink = { notes: string[]; missing: string[] };
// 레퍼런스 알약 → '[Image 1]' 같은 글자('프롬프트만': 레퍼런스는 안 붙이고 번호만 남긴다). 어셋 알약은 그대로. 읽기만 하는 문서로 다룬다.
function unpillReferences(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.body.querySelectorAll('.mention-pill').forEach(p => p.replaceWith(doc.createTextNode(`[${p.getAttribute('data-name') || ''}]`)));
  return doc.body.innerHTML;
}

function SettingsRestoreDialog({ target, onPaste, onFill, onGoToCard, onAttach, onClose }: {
  target: RestoreTarget;
  onPaste: (pick: LocalMatch | null) => void;      // 프롬프트만(초기화 → 프롬프트 · 레퍼런스 · 어셋, 모델 · 모드만 그 영상대로)
  onFill: (pick: LocalMatch | null) => void;       // 그때 설정 그대로(초기화 → 작성 칸 · 레퍼런스 · 모델 · 파라미터 · 컬렉션)
  onGoToCard: (pick: LocalMatch) => void;
  onAttach?: () => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState<LocalMatch | null>(target.local);
  const src: any = pick ? pick.msg : target.payload?.message;
  const thumbs = pick ? {} : (target.payload?.thumbs || {});
  const elementAssets = useAppStore(s => s.elementAssets);
  // 레퍼런스 원본이 이 PC 에 있는가(캐시 또는 라이브러리 — 받은 영상의 것은 30일 정리에서 빠져 있다).
  const [have, setHave] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let alive = true;
    const ids = ((src?.usedAssets as any[]) || []).map(a => a?.cacheId).filter(Boolean) as string[];
    (async () => {
      const out: Record<string, boolean> = {};
      for (const id of ids) { try { out[id] = (await fetch(`/api/cache/${id}`, { method: 'HEAD', cache: 'no-store' })).ok; } catch { out[id] = false; } }
      if (alive) setHave(out);
    })();
    return () => { alive = false; };
  }, [src]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const when = (m: any) => m?.endTime || m?.timestamp;
  const source = pick
    ? `이 PC 의 카드 · ${pick.projectName} · ${when(pick.msg) ? formatStampFull(when(pick.msg)) : ''}`
    : target.payload
      ? `${target.payload.project.name || '이름 없는 프로젝트'}${when(src) ? ' · ' + formatStampFull(when(src)) : ''} · 이 PC 에는 이 카드가 없어요(다른 PC 이거나 지운 카드)`
      : '설정이 들어 있지 않은 영상이에요 — 만든 시각이 가까운 이 PC 카드를 골라 주세요';
  const named = getAssetNames(((src?.usedAssets as any[]) || []) as any);
  // 어셋 멘션은 어셋 하나에 그림이 여러 장일 수 있다 — 어셋마다 한 줄.
  const elements = Object.values(((src?.usedElementImages as any[]) || []).reduce((acc: Record<string, any>, e: any) => {
    const k = e?.elementId || e?.name; if (k && !acc[k]) acc[k] = e; return acc;
  }, {})) as any[];
  const roleLabel = (r: string) => r === 'first_frame' ? '시작 프레임' : r === 'last_frame' ? '끝 프레임' : r === 'reference_video' ? '참조 영상' : r === 'reference_audio' ? '참조 오디오' : '참조 이미지';

  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-5 pt-4 pb-3 border-b border-gray-100 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="text-[15px] font-semibold text-gray-900">이 영상을 만든 설정</h3>
            <p className="text-[12px] text-gray-500 mt-0.5">{source}</p>
          </div>
          <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700 rounded-md" title="닫기 (Esc)"><X size={16} /></button>
        </div>
        <div className="px-5 py-4 overflow-y-auto space-y-4">
          {target.candidates && target.candidates.length > 0 && (
            <div className="space-y-1.5">
              {target.candidates.map(c => (
                <button key={c.msg.id} onClick={() => setPick(c)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${pick?.msg.id === c.msg.id ? 'border-indigo-400 bg-indigo-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <div className="text-[11px] text-gray-500">{c.projectName} · {formatStampFull(when(c.msg))}</div>
                  <div className="text-[13px] text-gray-800 truncate">{c.msg.promptText || '(프롬프트 없음)'}</div>
                </button>
              ))}
            </div>
          )}
          {src && (
            <>
              {src.usedSettings && (
                <div className="flex flex-wrap gap-1.5">
                  {settingsTagList(src.usedSettings).map((tag, i) => (
                    <span key={i} className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${tagTone(tag, 'bg-gray-100 text-gray-600')}`}>{tag}</span>
                  ))}
                </div>
              )}
              <div className="text-[13px] text-gray-800 whitespace-pre-wrap break-words max-h-48 overflow-y-auto bg-gray-50 rounded-lg px-3 py-2 border border-gray-100">
                {src.promptText || '(프롬프트 없음)'}
              </div>
              {(named.length > 0 || elements.length > 0) && (
                <div className="space-y-1.5">
                  <div className="text-[12px] font-semibold text-gray-500">레퍼런스</div>
                  {named.map((a: any, i: number) => {
                    const ok = a.cacheId ? have[a.cacheId] : undefined;
                    const img = a.type === 'image_url' ? thumbSrc(a.thumbnailUrl || a.url, thumbs) : '';
                    return (
                      <div key={'a' + i} className="flex items-center gap-2 text-[12px]">
                        {img ? <img src={img} className="w-8 h-8 object-cover rounded border border-gray-200 shrink-0" alt="" />
                          : <div className="w-8 h-8 rounded bg-gray-100 flex items-center justify-center shrink-0">{a.type === 'video_url' ? <Video size={14} className="text-purple-500" /> : <Music size={14} className="text-green-500" />}</div>}
                        <span className="font-medium text-gray-700">[{a.name}]</span>
                        <span className="text-gray-400 truncate">{a.file_name || ''} · {roleLabel(a.role)}</span>
                        <span className={`ml-auto shrink-0 ${ok === false ? 'text-red-500' : ok ? 'text-emerald-600' : 'text-gray-400'}`}>{ok === false ? '이 PC 에 없음' : ok ? '있음' : '확인 중'}</span>
                      </div>
                    );
                  })}
                  {elements.map((e: any, i: number) => {
                    const ok = elementAssets.some(x => x.id === e.elementId || mentionKey(x.name) === mentionKey(e.name || ''));
                    const img = thumbSrc(e.url, thumbs);
                    return (
                      <div key={'e' + i} className="flex items-center gap-2 text-[12px]">
                        {img ? <img src={img} className="w-8 h-8 object-cover rounded border border-gray-200 shrink-0" alt="" /> : <div className="w-8 h-8 rounded bg-gray-100 shrink-0" />}
                        <span className="font-medium text-gray-700">@{e.name}</span>
                        <span className="text-gray-400">어셋 라이브러리</span>
                        <span className={`ml-auto shrink-0 ${ok ? 'text-emerald-600' : 'text-red-500'}`}>{ok ? '있음' : '이 PC 에 없음'}</span>
                      </div>
                    );
                  })}
                </div>
              )}
              {src.apiPrompt && (
                <details className="text-[12px] text-gray-500">
                  <summary className="cursor-pointer select-none">실제로 보낸 문장</summary>
                  <div className="mt-1 whitespace-pre-wrap break-words bg-gray-50 rounded-lg px-3 py-2 border border-gray-100 max-h-40 overflow-y-auto">{src.apiPrompt}</div>
                </details>
              )}
            </>
          )}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center gap-2 justify-end flex-wrap">
          {onAttach && <button onClick={onAttach} className="px-3 py-1.5 text-[13px] font-medium text-gray-600 hover:text-indigo-600 bg-gray-50 hover:bg-indigo-50 border border-gray-200 rounded-lg">레퍼런스로 붙이기</button>}
          {pick && <button onClick={() => onGoToCard(pick)} className="px-3 py-1.5 text-[13px] font-medium text-gray-600 hover:text-indigo-600 bg-gray-50 hover:bg-indigo-50 border border-gray-200 rounded-lg">그 카드로 가기</button>}
          {src && <button onClick={() => onFill(pick)} title="초기화하고 작성 칸 · 레퍼런스 · 어셋 컬렉션 · 모델 · 파라미터까지 이 영상을 만든 그대로" className="px-3 py-1.5 text-[13px] font-medium text-violet-600 bg-violet-50 hover:bg-violet-100 border border-violet-200 rounded-lg">그때 설정 그대로</button>}
          {src && <button onClick={() => onPaste(pick)} title="초기화하고 프롬프트만 불러와요. 어셋 언급은 함께, 레퍼런스는 빼고(모델 · 모드는 그 영상대로)" className="px-3 py-1.5 text-[13px] font-semibold text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg">프롬프트만</button>}
        </div>
      </div>
    </div>
  );
}

function CollapsiblePrompt({ promptText, promptHtml, namedAssets }: { promptText: string; promptHtml?: string; namedAssets: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(promptText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API can fail on insecure contexts — silently noop, UI just won't flash check
    }
  };

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded(v => !v);
  };

  return (
    <div className="flex items-start gap-2 min-w-0 w-full">
      <div
        className={
          'flex-1 min-w-0 text-[14px] text-gray-800 font-medium leading-relaxed ' +
          // Expanded: cap height + scroll so a very long prompt doesn't blow the
          // card up to thousands of px; collapsed stays a 1-line truncated preview.
          (expanded ? 'whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto pr-1' : 'truncate')
        }
      >
        {promptHtml ? renderPromptHtml(promptHtml, namedAssets) : renderMessageContent(promptText, namedAssets)}
      </div>
      <div className="flex items-center gap-0.5 shrink-0 -mt-0.5">
        <button
          onClick={toggleExpand}
          className="p-1 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-colors"
          title={expanded ? '접기' : '펼치기'}
          aria-label={expanded ? '프롬프트 접기' : '프롬프트 펼치기'}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button
          onClick={handleCopy}
          className="p-1 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded transition-colors"
          title={copied ? '복사됨!' : '프롬프트 복사'}
          aria-label="프롬프트 복사"
        >
          {copied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

/* ─── 채팅 카드 한 장 (26.10.2001~ 작업창 함수에서 떼어 냄) ─── */
// memo — 작업창이 다시 그려져도(칸 전환 · 다른 프로젝트의 폴링 · 입력 · 다운로드 진행) 바뀐 카드만 다시 그린다. 예전엔
// 카드가 작업창 함수 안에 그대로 있어 무엇이 바뀌든 카드 전부를 다시 만들었다 — 665장 프로젝트에서 칸을 누를 때마다
// 0.3~0.7초 멈춤(실측 2026-10-20, 작업창 나누기 데모). 화면 함수는 ref(actions)로 받는다 — 작업창이 그릴 때마다 새
// 함수가 되어도 카드 props 는 그대로라 memo 가 산다. 카드가 보는 데이터는 props 로만: 이 카드의 메시지 · 짝(초안/본편) ·
// 어셋 미리보기 지도 · 재생성 잠금. 작업창 안의 값을 직접 보게 고치면 memo 가 낡은 값을 그린다.
export type CardActions = {
  scrollToMessage: (id: string) => void;
  handleReuse: (m: any) => unknown;
  handleRegenerate: (m: any) => unknown;
  toggleStar: (id: string, next: boolean) => void;
  handleVideoDownload: (id: string, url: string, taskId: string) => unknown;
  revealDownloaded: (p?: string) => void;
  makeFinalFromDraft: (taskId: string, m: any) => unknown;
};
const MessageCard = memo(function MessageCard({ msg, projectId, divider, dividerCount, draftOther, finalOther, elementImageUrlById, isGenerating, actions }: {
  msg: any; projectId: string; divider: boolean; dividerCount: number; draftOther?: any; finalOther?: any;
  elementImageUrlById: Map<string, { preview: string; original: string }>; isGenerating: boolean; actions: { current: CardActions };
}) {
  const isDraft = !!msg.usedSettings?.draft;
  return (
    <>
    {divider && (
      <div className="flex items-center gap-3 select-none pointer-events-none">
        <div className="flex-1 h-px bg-indigo-300/70 dark:bg-indigo-400/40" />
        <span className="text-[11px] font-semibold text-indigo-500 whitespace-nowrap">
          여기부터 새로 생성됨{dividerCount > 0 ? ` · ${dividerCount}개` : ''}
        </span>
        <div className="flex-1 h-px bg-indigo-300/70 dark:bg-indigo-400/40" />
      </div>
    )}
    {/* 화면 밖 카드는 레이아웃 · 그리기를 건너뛴다(content-visibility, 26.10.2001~ — 전체 갤러리 · 어셋 라이브러리와 같은
        방법). 실측 2026-10-20(665장, 운영 빌드): 스크롤 20번에 50ms 넘는 멈춤 52번(최대 181ms) → 2~5번(최대 76ms). 크기는
        한 번 그려진 뒤엔 그 값을 기억하고(auto), 처음 보는 카드만 700px 로 어림한다 — 메시지로 가기 · 보던 자리 되돌리기는
        앵커(메시지 id)로 붙들어서 어림이 실제 높이로 바뀌어도 자리를 지킨다. ★ 이 상자는 그리기를 가두므로(contain:paint)
        안에 fixed 로 뜨는 것을 두지 마라 — 미리보기(HoverZoom)처럼 body 로 내보낼 것. */}
    <div id={`msg-${msg.id}`} className="flex justify-center animate-fade-in-up"
      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 700px', overflowClipMargin: '16px' } as any}>
      <div className="w-full max-w-3xl bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-sm border border-gray-200/80 overflow-hidden hover:shadow-md transition-shadow duration-300">
        {/* Card Header */}
        <div className="p-4 border-b border-gray-100 bg-gradient-to-r from-gray-50/80 to-white dark:to-[#1c1c1e]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 flex flex-col gap-3">
              {/* Draft ↔ 본편 짝. 본편은 맨 아래에 붙으므로, 어느 Draft 에서 나왔는지(또는 이
                  Draft 로 무엇을 만들었는지)를 카드 맨 위에서 썸네일로 보여 준다. */}
              {draftOther && (
                <PairLink toDraft other={draftOther} onGo={() => actions.current.scrollToMessage(draftOther.id)} />
              )}
              {isDraft && msg.taskId && finalOther && (
                <PairLink toDraft={false} other={finalOther} onGo={() => actions.current.scrollToMessage(finalOther.id)} />
              )}
              {(msg.usedAssets?.length > 0 || (msg.usedElementImages as any)?.length > 0) && (
                <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
                  {(msg.usedAssets || []).map((asset: any, i: number) => (
                    <div key={asset.id || i}
                      title={String(asset.type).startsWith('image') ? `${asset.file_name || asset.name || '이미지'} · 우클릭: 이미지 복사` : undefined}
                      onContextMenu={(e) => {
                        if (!String(asset.type).startsWith('image')) return; // 영상/오디오는 기본 동작 유지
                        e.preventDefault();
                        // 원본(미디어캐시) → 디스크 원본 재캐시 → (없으면) 썸네일
                        copyImageToClipboard([
                          { src: asset.cacheId && `/api/cache/${asset.cacheId}`, original: true },
                          { fromPath: asset.originalPath, expect: asset.cacheId, original: true },
                          { src: asset.url }, { src: asset.thumbnailUrl },
                        ], asset.file_name || asset.name || '이미지');
                      }}
                      className="w-11 h-11 rounded-lg overflow-hidden border border-gray-200 shadow-sm bg-white dark:bg-[#1c1c1e] relative group shrink-0">
                      {asset.type.startsWith('video') ? (
                        asset.thumbnailUrl
                          ? <HoverZoom className="block w-full h-full" src={asset.thumbnailUrl} videoSrc={asset.cacheId ? `/api/cache/${asset.cacheId}` : undefined}><img src={asset.thumbnailUrl} alt="" className="w-full h-full object-cover cursor-zoom-in" /></HoverZoom>
                          : asset.cacheId
                            ? <HoverZoom className="block w-full h-full" src="" videoSrc={`/api/cache/${asset.cacheId}`}><div className="w-full h-full flex items-center justify-center bg-purple-50 text-purple-400 cursor-zoom-in"><Video size={14} /></div></HoverZoom>
                            : <div className="w-full h-full flex items-center justify-center bg-purple-50 text-purple-400"><Video size={14} /></div>
                      ) : asset.type.startsWith('audio') ? (
                        <div className="w-full h-full flex items-center justify-center bg-indigo-50 text-indigo-400"><Music size={14} /></div>
                      ) : (
                        <HoverZoom className="block w-full h-full" src={asset.url} fullSrc={asset.cacheId ? `/api/cache/${asset.cacheId}` : undefined}><img src={asset.url} alt="" className="w-full h-full object-cover cursor-zoom-in" /></HoverZoom>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[7px] text-center py-0.5 opacity-0 group-hover:opacity-100 transition-opacity">{asset.role?.replace('_', ' ')}</div>
                    </div>
                  ))}
                  {((msg.usedElementImages as any) || []).map((ei: any) => {
                    const meta = CATEGORY_META[ei.category as AssetCategory] || { border: 'var(--cat-fallback-border)' };
                    const full = elementImageUrlById.get(`${ei.elementId}__${ei.imageId}`);
                    return (
                      <div key={ei.id} title={`${ei.name} · 우클릭: 이미지 복사`}
                        onContextMenu={(e) => { e.preventDefault(); copyImageToClipboard([
                          { src: full?.original, original: true }, { src: ei.libId && `/api/library/${ei.libId}`, original: true },
                          { src: ei.cacheId && `/api/cache/${ei.cacheId}`, original: true },
                          { src: ei.url },
                        ], ei.name || '이미지'); }}
                        className="w-11 h-11 rounded-lg overflow-hidden shadow-sm bg-white dark:bg-[#1c1c1e] relative group shrink-0" style={{ border: `2px solid ${meta.border}` }}>
                        <HoverZoom className="block w-full h-full" src={ei.url} fullSrc={full?.preview && full.preview !== ei.url ? full.preview : undefined}><img src={ei.url} alt="" className="w-full h-full object-cover cursor-zoom-in" /></HoverZoom>
                        <div className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[7px] text-center py-0.5 opacity-0 group-hover:opacity-100 transition-opacity truncate px-0.5">{ei.name}</div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="flex-1 min-w-0">
                {msg.promptText
                  ? <CollapsiblePrompt promptText={msg.promptText} promptHtml={msg.promptHtml} namedAssets={getAssetNames((msg.usedAssets as any) || [])} />
                  : <div className="text-[14px] text-gray-400 italic">프롬프트 없음</div>}
                {msg.usedSettings && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {settingsTagList(msg.usedSettings, msg.videoUrl, msg.draftOf).map((tag, i) => (
                      <span key={i} className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${tagTone(tag, 'bg-gray-100 text-gray-500')}`}>{tag}</span>
                    ))}
                  </div>
                )}
                {msg.taskId && (
                  <button
                    onClick={() => { navigator.clipboard.writeText(msg.taskId!); }}
                    className="mt-2 text-[10px] font-mono text-indigo-500/70 bg-indigo-50/50 hover:bg-indigo-100/60 rounded-md px-2 py-0.5 w-fit transition-colors cursor-pointer text-left break-all"
                    title="클릭하여 복사"
                  >
                    Task: {msg.taskId}
                  </button>
                )}
              </div>
            </div>
            <div className="flex items-center gap-0.5 shrink-0">
              <button onClick={() => { void actions.current.handleReuse(msg); }} className="p-1.5 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors" title="프롬프트 재사용"><RefreshCw size={15} /></button>
              {(msg.status === 'succeeded' || msg.status === 'failed') && (
                <button onClick={() => { void actions.current.handleRegenerate(msg); }} disabled={isGenerating} className="p-1.5 text-gray-300 hover:text-indigo-500 hover:bg-indigo-50 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed" title={msg.draftOf && msg.status === 'failed' ? '본편 다시 시도 (같은 Draft에서)' : '재생성 (같은 설정·래퍼런스로 한 편 다시 생성)'}><Sparkles size={15} /></button>
              )}
              <button onClick={() => useAppStore.getState().deleteMessage(projectId, msg.id)} className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors" title="삭제"><Trash2 size={15} /></button>
            </div>
          </div>
        </div>
        {/* Card Body */}
        <div className="p-4">
          {(msg.status === 'running' || msg.status === 'queued') ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 text-sm text-indigo-600 bg-indigo-50 px-3 py-2 rounded-lg">
                <div className="flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {msg.status === 'queued' ? '대기열에서 대기 중...' : '영상 생성 중...'}
                </div>
                {msg.taskId && (
                  <button
                    onClick={() => useAppStore.getState().cancelTask(projectId, msg.id, msg.taskId!)}
                    className="text-[12px] font-medium text-red-500 hover:text-red-700 hover:bg-red-50 px-2 py-1 rounded-md transition-colors"
                  >
                    취소
                  </button>
                )}
              </div>
              <div className="w-full aspect-video bg-gradient-to-br from-gray-100 to-gray-50 animate-pulse rounded-xl flex flex-col items-center justify-center border border-gray-200/50">
                <Loader2 size={28} className="animate-spin text-indigo-400 mb-2" />
                <LiveTimer startTime={msg.startTime} endTime={msg.endTime} />
              </div>
            </div>
          ) : msg.status === 'failed' ? (
            <div className="flex items-start gap-2.5 text-sm text-red-600 bg-red-50 px-4 py-3 rounded-xl border border-red-100">
              <AlertCircle size={16} className="shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">생성 실패</p>
                <p className="text-red-500 mt-0.5 text-[13px]">{translateError(msg.error || '')}</p>
                {msg.error && msg.error !== translateError(msg.error) && <p className="text-red-400 mt-1 text-[11px] font-mono">{msg.error}</p>}
              </div>
            </div>
          ) : msg.status === 'succeeded' && (msg.videoUrl || msg.imageUrl) ? (
            <div className="space-y-3">
              {msg.videoUrl && (
                <div className="relative">
                  <VideoPlayer sources={playbackChain(msg)} failPoster={posterSrcFor(msg)} className="rounded-xl overflow-hidden border border-gray-200/80 bg-black" is4k={msg.usedSettings?.resolution === '4k'} />
                  <ClipStamp ms={msg.timestamp} />
                </div>
              )}
              {msg.imageUrl && (
                <div className="rounded-xl overflow-hidden border border-gray-200/80 bg-black relative">
                  <img src={msg.imageUrl} alt="Last Frame" className="w-full max-h-[400px] object-contain" />
                  {!msg.videoUrl && <ClipStamp ms={msg.timestamp} />}
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  {(msg.videoUrl || msg.imageUrl) && (
                    <button onClick={() => actions.current.toggleStar(msg.id, !msg.starred)}
                      title={msg.starred ? '채택 해제' : '컷 채택'}
                      className={`flex items-center justify-center w-9 h-9 rounded-lg border transition-all shrink-0 ${msg.starred
                        ? 'text-amber-500 bg-amber-50 border-amber-200 hover:bg-amber-100'
                        : 'text-gray-400 hover:text-amber-500 bg-gray-50 hover:bg-amber-50 border-gray-200 hover:border-amber-200'}`}>
                      <Star size={15} className={msg.starred ? 'fill-amber-400' : ''} />
                    </button>
                  )}
                  {msg.videoUrl && (
                    <button onClick={() => { void actions.current.handleVideoDownload(msg.id, msg.videoUrl!, msg.taskId || 'unknown'); }}
                      className={`flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-lg border transition-all whitespace-nowrap shrink-0 ${msg.downloadedAt
                        ? 'text-emerald-600 hover:text-emerald-700 bg-emerald-50/70 hover:bg-emerald-50 border-emerald-200'
                        : 'text-gray-500 hover:text-indigo-600 bg-gray-50 hover:bg-indigo-50 border-gray-200 hover:border-indigo-200'}`}>
                      {msg.downloadedAt ? <RefreshCw size={14} /> : <Download size={14} />} {msg.downloadedAt ? '다시 다운로드' : '영상 다운로드'}
                    </button>
                  )}
                  {msg.downloadedPath && (
                    <button onClick={() => actions.current.revealDownloaded(msg.downloadedPath)} title={msg.downloadedPath}
                      className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-indigo-600 px-3 py-1.5 bg-gray-50 hover:bg-indigo-50 rounded-lg border border-gray-200 hover:border-indigo-200 transition-all whitespace-nowrap shrink-0">
                      <FolderOpen size={14} /> 폴더에서 보기
                    </button>
                  )}
                  {msg.imageUrl && (
                    <button onClick={() => downloadViaProxy(msg.imageUrl!, buildDownloadFilename(msg.taskId || 'unknown', '.png'))}
                      className="flex items-center gap-1.5 text-[13px] font-medium text-gray-500 hover:text-indigo-600 px-3 py-1.5 bg-gray-50 hover:bg-indigo-50 rounded-lg border border-gray-200 hover:border-indigo-200 transition-all whitespace-nowrap shrink-0">
                      <Download size={14} /> 이미지
                    </button>
                  )}
                  {/* Draft → 본편 만들기 버튼. 이미 만든 본편으로 가는 길(과 본편에서 Draft 로
                      돌아가는 길)은 카드 맨 위의 짝 줄(PairLink)이 맡는다. */}
                  {isDraft && msg.taskId && (() => {
                    // 본편이 이미 있으면(만드는 중 포함) 여기엔 아무것도 없다 — 카드 맨 위의
                    // 짝 줄(PairLink)이 그 본편을 썸네일로 보여 주고 데려간다.
                    if (finalOther) return null;
                    const exp = draftExpiresAt(msg);
                    if (Date.now() > exp) return (
                      <span title="Draft는 생성 후 7일까지만 본편으로 만들 수 있습니다" className="text-[12px] text-gray-400 whitespace-nowrap shrink-0 px-1">Draft 만료 · 본편 불가</span>
                    );
                    return (
                      <button onClick={() => { void actions.current.makeFinalFromDraft(msg.taskId!, msg); }}
                        title={`구도·길이·비율은 이 Draft 그대로 두고 1080p 로 다시 그립니다.\n이 Draft는 ${formatStampFull(exp)} 까지 본편으로 만들 수 있습니다.`}
                        className="flex items-center gap-1.5 text-[13px] font-medium px-3 py-1.5 rounded-lg border border-indigo-500 transition-all whitespace-nowrap shrink-0 text-white bg-indigo-500 hover:bg-indigo-600 active:scale-95">
                        <Sparkles size={14} /> 1080p 본편 만들기
                        <span className="text-[11px] font-normal text-white/75">{draftLeftLabel(exp)}</span>
                      </button>
                    );
                  })()}
                </div>
                {/* Just the duration. The start/finish timestamps used to sit here
                    too, but the clip already carries its stamp in the top-left
                    corner — repeating it two lines below is noise, not detail. */}
                <div className="text-[11px] text-gray-400 whitespace-nowrap shrink-0">소요 시간: <LiveTimer startTime={msg.startTime} endTime={msg.endTime} /></div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
    </>
  );
});

/* ─── Main Component ─── */
// 작업창 한 칸(26.10.2001~ 나누기 — Workspace 가 칸마다 하나씩 띄운다). 자기 칸의 프로젝트(projectId)만 그린다.
//   slot    0번 칸은 늘 있다 — 받은 영상 다운로드 표시는 0번 칸 몫이다(두 칸이 같이 받으면 두 번 뜬다).
//   active  지금 손대는 칸. 앱 전체에 하나뿐이어야 하는 일 — 에이전트 작업 받기 · 마우스 뒤로/앞으로 · 다른 곳에서 보낸
//           토스트 — 은 이 칸만 한다. 나누지 않았으면 늘 true(예전 그대로).
// ★ 아래 코드의 `currentProjectId` 는 '이 칸의 프로젝트' 다(앱 전체의 지금 프로젝트가 아니다 — 그건 손대는 칸의 것).
//   async 흐름에서 "아직 그 프로젝트를 보고 있나" 를 물을 때는 스토어가 아니라 paneProjectRef 를 본다.
export function ChatArea({ projectId, slot = 0, split = false, active = true }: {
  projectId: string; slot?: 0 | 1; split?: boolean; active?: boolean;
}) {
  const { projects, addMessage, updateMessage, addAsset, removeAsset, elementAssets, projectCollectionId, assetCollections, setMentionedElementImages, billingProjectKey } = useAppStore();
  const currentProjectId: string | null = projectId;
  const paneProjectRef = useRef<string | null>(projectId);
  paneProjectRef.current = projectId;
  const activeRef = useRef(active);
  activeRef.current = active;
  const rootRef = useRef<HTMLDivElement>(null);
  // 카드(MessageCard)가 부르는 화면 함수 — 렌더마다 바꿔 끼운다(아래 Render 바로 위). 카드에는 이 ref 하나만 넘어간다.
  const cardActions = useRef<CardActions>(null as unknown as CardActions);
  const project = projects.find((p) => p.id === currentProjectId);
  // 프로젝트 코드(과금) — 앱 전체에 하나(공동 코드, 26.10.2004~). 두 칸이 같은 코드다.
  // Block sends (reactive mirror for the button's disabled state) whenever no
  // project is picked — strict: no project ⇒ no generate. handleSend re-checks via
  // getState() so Enter & 재생성 are gated too; this is just the visual disable.
  const needsBillingSelection = !billingProjectKey;
  const isOmni = !!project && modelProvider(project.settings.model) === 'gemini'; // Gemini Omni surface
  // 지금 보내면 초안(480p)으로 나가는가. 보내는 쪽 판정(applyTaskConstraints)과 같은 조건이다.
  const sendAsDraft = !!project && !isOmni && draftEffective(project.settings.model, project.settings.draft);
  // Task is always explicit; coerce empty/legacy/other-model values to text_to_video.
  // Resolved against the project's model so 1.1's Extend can't drive the preview's UI.
  const omniTask = project ? resolveOmniTask(project.settings.model, project.settings.omniTask) : '';
  // Per live Omni doc: frames belong ONLY to image_to_video (1 image = the start/first frame).
  // reference_to_video takes *reference* images (not frames); text_to_video/edit take none.
  const omniFramesOn = isOmni && omniTask === 'image_to_video';
  // End frame is Omni-UNOFFICIAL (no last-frame/interpolation in the API). Offered on
  // image_to_video by user opt-in; at send it routes through reference_to_video + a
  // FIRST/LAST prompt (best-effort). A warning is shown next to the slot.
  const omniEndFrameOn = isOmni && omniTask === 'image_to_video';
  const [hasText, setHasText] = useState(false);
  // '보내는 중' — 이 칸의 프로젝트가 보내는 중인가(어느 칸에서 보냈든 · 칸을 닫았다 열어도). 26.10.2004~ 프로젝트에 붙는다.
  const isGenerating = useAppStore(s => (s.sendingProjects[projectId] || 0) > 0);
  // 이 칸이 아직 떠 있나 — 내려간 칸의 토스트는 안 보인다(경고를 손대는 칸으로 넘긴다, warnFor).
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  const [isDragging, setIsDragging] = useState(false);
  const [dragVideo, setDragVideo] = useState(false);                       // 끄는 것에 영상이 있다 → 막이 셋으로
  const [dropZone, setDropZone] = useState<'prompt' | 'restore' | 'attach' | null>(null);
  const [headerSearch, setHeaderSearch] = useState('');
  // 갤러리의 프롬프트 검색(26.10.203~). 채팅 검색과 따로 둔다 — 갤러리에서 '찾기' 로 채팅에 가면 그 대화의
  // 앞뒤가 보여야 하고, 갤러리로 돌아오면 검색해 둔 결과가 그대로 있어야 한다.
  const [gallerySearch, setGallerySearch] = useState('');
  const [showGallery, setShowGallery] = useState(false);
  // 갤러리 "채택만" 필터. 세션 한정(저장 안 함) — 필터 상태까지 영속화하면 다음에 열었을 때
  // 영상이 사라진 것처럼 보인다.
  const [starredOnly, setStarredOnly] = useState(false);
  const [withDrafts, setWithDrafts] = useState(false); // 갤러리에 초안까지 보일지 (기본: 본편만)
  const [previewItem, setPreviewItem] = useState<any>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const dragCounter = useRef(0);
  const [mentionState, setMentionState] = useState<{ active: boolean, query: string }>({ active: false, query: '' });
  const mentionIndexRef = useRef(0);
  const contentEditableRef = useRef<HTMLDivElement>(null);
  // Scroll container WRAPPING the contentEditable. The editable must not own the
  // scrollbar: with our custom ::-webkit-scrollbar styling Chromium paints the
  // element's hover cursor over the scrollbar too, so an editable-owned scrollbar
  // showed the text I-beam instead of the arrow. A plain wrapper owns the scroll
  // (arrow over scrollbar), the editable inside keeps the I-beam over text.
  const promptScrollRef = useRef<HTMLDivElement>(null);
  // Validation warnings show as a NON-BLOCKING in-app toast, not window.alert(). A native
  // alert() de-activates the Electron renderer window — which drops the prompt caret and
  // wedges the Korean IME until you alt-tab back (the exact bug users hit). A toast never
  // touches focus, so the caret stays and typing keeps working right after a warning.
  const [toast, setToast] = useState<{ msg: string; ok?: boolean } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = (msg: string, ok = false) => {
    setToast({ msg, ok });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), ok ? 2200 : 5000);
  };
  // 에이전트 작업(아래 '에이전트 작업함')을 보내는 동안 뜬 경고를 모아, 그 작업의 실패 이유로 돌려준다.
  // 화면 토스트는 평소처럼 뜬다 — 사용자도 왜 안 나갔는지 본다.
  const agentWarnRef = useRef<string[] | null>(null);
  const warn = (msg: string) => { agentWarnRef.current?.push(msg); showToast(msg, false); };
  // 그 프로젝트 일의 경고 — 이 칸이 아직 그 프로젝트를 보여 주면 이 칸에, 아니면(칸을 닫았거나 다른 프로젝트를 열었으면)
  // 손대는 칸에 '[프로젝트]' 를 붙여 띄운다. 예전엔 내려간 칸의 토스트로 가서 사라져, 보내다 멈춘 것을 아무도 못 봤다(26.10.2004 감사).
  const warnFor = (pid: string) => (msg: string) => {
    if (aliveRef.current && paneProjectRef.current === pid) { warn(msg); return; }
    agentWarnRef.current?.push(msg);
    const name = useAppStore.getState().projects.find(p => p.id === pid)?.name;
    window.dispatchEvent(new CustomEvent('seedance:toast', { detail: { msg: name ? `[${name}] ${msg}` : msg, ok: false } }));
  };
  // 그 프로젝트의 작성 칸 글을 바꾼다 — 이 칸에 떠 있으면 바로, 아니면 그 프로젝트를 띄운 칸이 받는다(seedance:draft-replaced).
  // 예전엔 작성 중 글만 고쳐서, 그 사이 다른 칸이 그 프로젝트를 띄웠으면 그 칸 화면엔 옛 글이 남아 다음 타자가 덮었다.
  const putPromptHtml = (pid: string, html: string) => {
    if (aliveRef.current && paneProjectRef.current === pid && contentEditableRef.current) {
      contentEditableRef.current.innerHTML = html;
      setHasText(!!contentEditableRef.current.innerText.trim());
      syncMentionCount();
    } else {
      window.dispatchEvent(new CustomEvent('seedance:draft-replaced', { detail: { projectId: pid, html } }));
    }
    useAppStore.getState().updateDraftPrompt(pid, html);
  };
  useEffect(() => {
    const onReplaced = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      const ed = contentEditableRef.current;
      if (!ed || d.projectId !== paneProjectRef.current || typeof d.html !== 'string') return;
      ed.innerHTML = d.html;
      setHasText(!!ed.innerText.trim());
      syncMentionCount();
    };
    window.addEventListener('seedance:draft-replaced', onReplaced);
    return () => window.removeEventListener('seedance:draft-replaced', onReplaced);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  // 받은 영상에서 되살리기(26.10.801~). 작성 칸 쪽 두 칸 — '프롬프트만' · '그때 설정 그대로' — 에 놓으면 바로 채우고, 무엇을
  // 되살렸고 무엇이 빠졌는지 작성 칸 위에 남긴다(restoreReport — 닫기를 눌러야 닫힌다). 설정이 없는 옛 영상은 창(restoreTarget).
  const [restoreTarget, setRestoreTarget] = useState<RestoreTarget | null>(null);
  const [restoreReport, setRestoreReport] = useState<RestoreReport | null>(null);
  // 다른 채팅의 작성 칸 이야기다 — 받은 영상 후보 창도 닫는다(26.10.2004 감사: 열린 채 이 칸의 프로젝트가 바뀌면 고르는 순간 새 프로젝트를 덮었다).
  useEffect(() => { setRestoreReport(null); setRestoreTarget(null); }, [currentProjectId]);
  const composerBoxRef = useRef<HTMLDivElement>(null);
  // first/last 모드에서 붙여넣기가 두 슬롯을 번갈아 교체하도록 다음 대상 추적.
  // 슬롯 id를 함께 저장해서, 슬롯이 다른 경로(피커·삭제 후 재추가·프로젝트
  // 전환)로 바뀌었으면 사이클을 버리고 무조건 first부터 다시 시작한다.
  const pasteCycleRef = useRef<{ firstId: string; lastId: string; next: 'first_frame' | 'last_frame' } | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 프로젝트를 열면 언제나 맨 아래(최신)다. 마지막 위치를 기억하지 않는다 —
  // 기억하게 해봤더니(1503) 전환 도중 브라우저가 쏘는 scroll 이벤트가 아직 자라지
  // 않은 높이로 기억을 덮어써서, 다른 프로젝트의 중간 위치가 따라붙는 것처럼 보였다.
  // 그리고 애초에 원하는 동작이 아니었다: 프로젝트를 열면 새로 만든 것이 보여야 한다.
  // '새로 생성된 것이 어디부터인가' 는 아래의 구분선이 답한다.
  const [newFrom, setNewFrom] = useState(0);
  const previousProjectIdRef = useRef<string | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [promptHeight, setPromptHeight] = useState(160);
  const [downloads, setDownloads] = useState<Record<string, { received: number; total: number; state: string }>>({});
  const [downloadsCollapsed, setDownloadsCollapsed] = useState(false);

  // Sum images of the distinct elements currently @mentioned in the prompt.
  // Defined up here (before the effects/guard that use it) so it's never in its
  // temporal dead zone. Uses elementAssets (not the post-guard elementById memo).
  const mentionedElementStats = () => {
    const ids = new Set<string>();
    let count = 0;
    contentEditableRef.current?.querySelectorAll('.element-pill').forEach(p => {
      const id = p.getAttribute('data-element-id');
      if (id && !ids.has(id)) { ids.add(id); const el = elementAssets.find(e => e.id === id); if (el) count += el.images.length; }
    });
    return { count, ids };
  };
  // Mirror the mentioned-element image count into the store (only when it changes)
  // so SettingsPanel's "이미지 N/9" reflects elements used in the prompt, not just
  // panel assets — i.e. the shared budget shows up there too.
  // ★ 값은 앱에 하나라 손대는 칸만 쓴다(26.10.2004 감사 — 두 칸이 서로 덮어 설정 패널의 '이미지 N/M' · 추가 잠금이 다른 칸
  //   기준이 됐다). 손대는 칸이 되면 다시 센다(아래 effect).
  const syncMentionCount = () => {
    if (!activeRef.current) return;
    const n = mentionedElementStats().count;
    if (useAppStore.getState().mentionedElementImages !== n) setMentionedElementImages(n);
  };
  useEffect(() => { if (active) syncMentionCount(); }, [active]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Listen to download events from Electron main process
  // 0번 칸만 듣는다(나누기 26.10.2001~) — 두 칸이 같이 들으면 진행 표시가 두 번 뜬다. 0번 칸은 나누고 닫아도 내려가지
  // 않으므로(Workspace) 여기 붙인 리스너가 한 벌로 남는다.
  useEffect(() => {
    if (slot !== 0) return;
    const api = (window as any).electronAPI;
    if (api?.onDownloadStarted) {
      api.onDownloadStarted(({ filename }: { filename: string }) => {
        setDownloads(d => ({ ...d, [filename]: { received: 0, total: 0, state: 'progressing' } }));
      });
      api.onDownloadProgress(({ filename, received, total, state }: any) => {
        setDownloads(d => ({ ...d, [filename]: { received, total, state } }));
      });
      api.onDownloadDone(({ filename, state, path }: any) => {
        // Main sends the save path here — this is the only point the Electron download
        // path can report it. Record it on the originating message so "폴더에서 보기"
        // survives restarts.
        if (state === 'completed' && path) {
          const msgId = pendingReveal.get(filename);
          if (msgId) {
            pendingReveal.delete(filename);
            const st = useAppStore.getState();
            const owner = st.projects.find(p => p.messages.some(m => m.id === msgId));
            if (owner) st.updateMessage(owner.id, msgId, { downloadedPath: path });
          }
        }
        setDownloads(d => {
          const next = { ...d };
          if (state === 'completed') {
            setTimeout(() => setDownloads(curr => { const c = { ...curr }; delete c[filename]; return c; }), 3000);
          }
          next[filename] = { ...(next[filename] || { received: 0, total: 0 }), state };
          return next;
        });
      });
    }

    // Instant downloads served from in-memory blob cache (no Electron will-download fires)
    const onInstant = (e: Event) => {
      const { filename, size } = (e as CustomEvent).detail;
      setDownloads(d => ({ ...d, [filename]: { received: size, total: size, state: 'completed' } }));
      setTimeout(() => setDownloads(curr => { const c = { ...curr }; delete c[filename]; return c; }), 2000);
    };
    window.addEventListener('seedance:download-instant', onInstant);
    return () => window.removeEventListener('seedance:download-instant', onInstant);
  }, []);

  // Toast requests from non-component code (utils.copyImageToClipboard) and from panels
  // that have no toast UI of their own. One owner for the toast, many senders.
  useEffect(() => {
    const onToast = (e: Event) => {
      if (!activeRef.current) return;   // 나눠 보는 중이면 손대는 칸만 띄운다
      const d = (e as CustomEvent).detail || {};
      showToast(d.msg || '', d.ok === true);
    };
    window.addEventListener('seedance:toast', onToast);
    return () => window.removeEventListener('seedance:toast', onToast);
  }, []);

  // A cancel the API refused (task already running → 409). store.cancelTask leaves the
  // message polling in that case, so the user needs to be told the work is still going
  // and will still be billed — silently doing nothing would look like a dead button.
  useEffect(() => {
    // 손대는 칸만 — 취소는 카드를 눌러야 하니 그 칸이 손대는 칸이고, 에이전트 card.cancel 도 손대는 칸에서 돈다(agentWarnRef).
    const onCancelFailed = (e: Event) => { if (activeRef.current) warn((e as CustomEvent).detail?.message || '취소하지 못했습니다.'); };
    window.addEventListener('seedance:cancel-failed', onCancelFailed);
    return () => window.removeEventListener('seedance:cancel-failed', onCancelFailed);
  }, []);

  // Save draft for previous project, load draft for new project
  useEffect(() => {
    const prevId = previousProjectIdRef.current;
    if (prevId && prevId !== currentProjectId && contentEditableRef.current) {
      // Flush any pending debounced save then commit current HTML to previous project
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
      useAppStore.getState().updateDraftPrompt(prevId, contentEditableRef.current.innerHTML);
    }
    if (contentEditableRef.current) {
      const newProject = useAppStore.getState().projects.find(p => p.id === currentProjectId);
      const draft = newProject?.draftPrompt || '';
      contentEditableRef.current.innerHTML = draft;
      setHasText(!!contentEditableRef.current.innerText.trim());
      syncMentionCount();
    }
    previousProjectIdRef.current = currentProjectId;
    setHeaderSearch('');
    setShowGallery(false);
    setPreviewItem(null);
    // '여기부터 새로 생성됨' 구분선의 기준 시각.
    //
    // App.tsx 가 프로젝트를 열자마자 lastSeenAt 을 지금 시각으로 밀어버리므로, 그전에
    // 집어둬야 한다. 자식의 effect 가 부모보다 먼저 돌기 때문에 여기서 읽으면 아직
    // 옛 값이다 — 이 순서에 기대고 있다는 것을 알고 있어야 한다.
    if (currentProjectId) {
      const p = useAppStore.getState().projects.find(x => x.id === currentProjectId);
      setNewFrom(p?.lastSeenAt || 0);
    }
  }, [currentProjectId]);

  // 작성 칸이 내려갔다 다시 그려질 때 초안을 지킨다(26.10.303~). 갤러리는 채팅 화면을 통째로 바꾸므로 작성 칸도
  // 내려갔다가 새로 그려지는데, 초안을 편집기에 다시 넣는 곳이 위의 프로젝트 전환 effect 뿐이라 빈 칸으로 돌아왔고,
  // 이어 치면 그 빈 칸이 초안을 덮었다. 게다가 초안 저장은 0.5초 디바운스라, 치자마자 갤러리를 열면 마지막 글자가
  // 저장되지 않았다(타이머가 돌 때 편집기가 이미 없다).
  //   내려갈 때: 떼어진 노드도 내용은 그대로 들고 있다 — 그걸 지금 초안으로 저장한다(그 편집기가 들고 있던 프로젝트에).
  //   다시 그려질 때: 지금 프로젝트의 초안을 넣는다 — 갤러리에서 '찾기' 로 다른 프로젝트에 가도 그 프로젝트 것이 들어간다.
  // 처음 그려질 때는 프로젝트 전환 effect 가 맡는다. 렌더마다 돌지만 같은 노드면 바로 끝난다.
  const lastEditorRef = useRef<HTMLDivElement | null>(null);
  const editorParkedRef = useRef(false);
  useLayoutEffect(() => {
    const el = contentEditableRef.current;
    const prev = lastEditorRef.current;
    if (el === prev) return;
    lastEditorRef.current = el;
    if (!el) {
      if (!prev) return;
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
      // previousProjectIdRef = 이 편집기가 들고 있던 프로젝트(프로젝트 전환 effect 가 바꾸기 전 값).
      const owner = previousProjectIdRef.current;
      if (owner) useAppStore.getState().updateDraftPrompt(owner, prev.innerHTML);
      editorParkedRef.current = true;
      return;
    }
    if (!editorParkedRef.current) return;
    editorParkedRef.current = false;
    el.innerHTML = useAppStore.getState().projects.find(p => p.id === currentProjectId)?.draftPrompt || '';
    setHasText(!!el.innerText.trim());
    syncMentionCount();
  });

  // Persist draft on window close (cache before IndexedDB debounce window)
  useEffect(() => {
    const handler = () => {
      if (currentProjectId && contentEditableRef.current) {
        useAppStore.getState().updateDraftPrompt(currentProjectId, contentEditableRef.current.innerHTML);
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [currentProjectId]);

  // 작성 칸의 글을 지금 바로 초안으로(나누기 26.10.2001~). 칸을 닫을 때 남는 칸이 닫히는 칸의 프로젝트를 이어받을 수
  // 있어서(store closePane) 그 전에 부른다 — 0.5초 디바운스를 기다리면 이어받는 칸이 옛 초안을 읽는다. 칸이 내려갈
  // 때(언마운트)도 한다: 디바운스 타이머는 편집기가 사라진 뒤에 돌아 마지막 글자를 잃는다.
  // ★ 레이아웃 effect 의 정리 함수다 — 내려갈 때 DOM ref 가 풀리기 전에 돈다(일반 effect 정리 때는 이미 null).
  const flushDraftNow = () => {
    const el = contentEditableRef.current || lastEditorRef.current;
    const pid = previousProjectIdRef.current;
    if (!el || !pid) return;
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
    useAppStore.getState().updateDraftPrompt(pid, el.innerHTML);
  };
  const flushDraftRef = useRef(flushDraftNow);
  flushDraftRef.current = flushDraftNow;
  useLayoutEffect(() => {
    const onFlush = () => flushDraftRef.current();
    window.addEventListener('seedance:flush-drafts', onFlush);
    return () => {
      window.removeEventListener('seedance:flush-drafts', onFlush);
      flushDraftRef.current();
    };
  }, []);

  // Listen for SettingsPanel reset → also clear prompt
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.projectId !== currentProjectId) return;
      if (contentEditableRef.current) contentEditableRef.current.innerHTML = '';
      setHasText(false);
      syncMentionCount();
      if (currentProjectId) useAppStore.getState().updateDraftPrompt(currentProjectId, '');
    };
    window.addEventListener('seedance:reset', handler as EventListener);
    return () => window.removeEventListener('seedance:reset', handler as EventListener);
  }, [currentProjectId]);

  // Track mention pills by asset UUID — remove deleted, renumber shifted, and
  // refresh embedded thumbnails when an image asset is replaced (replaceAsset
  // keeps the id stable but swaps url/thumbnailUrl).
  useEffect(() => {
    if (!contentEditableRef.current || !project) return;
    const named = getAssetNames(project.assets);
    let changed = false;
    contentEditableRef.current.querySelectorAll('.mention-pill').forEach(pill => {
      const assetId = pill.getAttribute('data-asset-id');
      if (assetId) {
        const asset = named.find(a => a.id === assetId);
        if (!asset) {
          // Asset was deleted → remove the pill
          pill.remove(); changed = true;
          return;
        }
        if (asset.name !== pill.getAttribute('data-name')) {
          // Asset was renumbered (e.g. Image 3 → Image 2) → update pill text
          pill.setAttribute('data-name', asset.name);
          const textSpan = pill.querySelector('span[style*="font-weight"]');
          if (textSpan) textSpan.textContent = `[${asset.name}]`;
          changed = true;
        }
        if (asset.type === 'image_url' || asset.type === 'video_url') {
          // Refresh thumbnail src so a replaced image/video shows the new
          // bytes immediately in any pill that references it. Video pills
          // only have an <img> when a thumbnail was successfully captured;
          // otherwise they show the 🎥 emoji span and we skip.
          const img = pill.querySelector('img') as HTMLImageElement | null;
          const newSrc = (asset as any).thumbnailUrl || (asset.type === 'image_url' ? asset.url : '');
          if (img && newSrc && img.getAttribute('src') !== newSrc) {
            img.setAttribute('src', newSrc);
            changed = true;
          }
        }
      } else {
        // No asset ID (legacy pill) — fallback to name matching
        const name = pill.getAttribute('data-name');
        if (name && !named.some(a => a.name === name)) { pill.remove(); changed = true; }
      }
    });
    if (changed) setHasText(!!contentEditableRef.current.innerText.trim());
  }, [project?.assets]);

  // Lookup across ALL collections — a pill stays valid even if the user later
  // switches the bound collection; it only dies when the element is deleted.
  // MUST be declared above the effect that lists it as a dependency: this hook
  // runs before the `if (!project) return null` guard, so referencing it any
  // later would hit its temporal dead zone during render (blank-screen crash).
  const elementById = useMemo(() => new Map(elementAssets.map(e => [e.id, e] as const)), [elementAssets]);
  // O(1) full-res URL lookup by "${elementId}__${imageId}" (== usedElementImages[].id) so
  // message/preview cards don't linear-scan elementAssets.find().images.find() per image
  // per render (which re-ran on every store write, worst when many elements are in use).
  // 26.9.3001~ 둘로 나뉜다: 크게 보기는 JPG 미리보기(화면용), 복사는 원본 그대로.
  const elementImageUrlById = useMemo(() => {
    const m = new Map<string, { preview: string; original: string }>();
    for (const e of elementAssets) for (const im of e.images) m.set(`${e.id}__${im.id}`, { preview: libraryPreviewSrc(im), original: libraryOriginalSrc(im) });
    return m;
  }, [elementAssets]);

  // Element-pill counterpart — tracks library mentions (.element-pill) by their
  // data-element-id. Separate from the panel-asset effect above (which only
  // touches .mention-pill) so the two mention systems never interfere. Removes
  // pills whose element was deleted, refreshes name + thumbnail on edit.
  useEffect(() => {
    if (!contentEditableRef.current) return;
    let changed = false;
    contentEditableRef.current.querySelectorAll('.element-pill').forEach(pill => {
      const id = pill.getAttribute('data-element-id');
      const el = id ? elementById.get(id) : null;
      if (!el) { pill.remove(); changed = true; return; }
      if (el.name !== pill.getAttribute('data-name')) {
        pill.setAttribute('data-name', el.name);
        const textSpan = pill.querySelector('span[data-el-text]');
        if (textSpan) textSpan.textContent = `[${el.name}]`;
        changed = true;
      }
      const img = pill.querySelector('img') as HTMLImageElement | null;
      const newSrc = el.images[0]?.thumbnailUrl || el.images[0]?.url || '';
      if (img && newSrc && img.getAttribute('src') !== newSrc) { img.setAttribute('src', newSrc); changed = true; }
    });
    if (changed) setHasText(!!contentEditableRef.current.innerText.trim());
    syncMentionCount();
  }, [elementById]);

  // ─── 뒤로/앞으로(MB4/MB5)로 돌아왔을 때 '보던 자리' (26.9.3002~) ────────────────
  // 프로젝트마다 보던 자리를 기억한다: 화면 맨 위에 걸친 메시지와, 그 메시지가 화면 위에서 얼마나
  // 떨어져 있었는지. 픽셀(scrollTop)만 기억하면 카드의 포스터·영상이 늦게 로드되며 높이가 바뀔 때
  // 엉뚱한 곳으로 간다. 바닥에 있었으면 '바닥' 으로 기억한다(그 사이 새 컷이 생겼으면 그것까지 보이게).
  // 클릭으로 옮길 때는 쓰지 않는다 — 그때는 예전처럼 맨 아래다.
  type ScrollMemo = { atBottom: boolean; anchorId?: string; offset: number; top: number };
  const scrollMemoRef = useRef(new Map<string, ScrollMemo>());
  const shownProjectIdRef = useRef<string | null>(null);   // 지금 목록에 그려진 프로젝트
  const memoRafRef = useRef(0);
  const rememberScroll = useCallback(() => {
    if (memoRafRef.current) return;                        // 한 프레임에 한 번만
    memoRafRef.current = requestAnimationFrame(() => {
      memoRafRef.current = 0;
      const el = messagesScrollRef.current, pid = shownProjectIdRef.current;
      if (!el || !pid) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 40) {
        scrollMemoRef.current.set(pid, { atBottom: true, offset: 0, top: el.scrollTop });
        return;
      }
      const top = el.getBoundingClientRect().top;
      let anchorId: string | undefined, offset = 0;
      for (const node of el.querySelectorAll<HTMLElement>('[id^="msg-"]')) {
        const r = node.getBoundingClientRect();
        if (r.bottom > top + 1) { anchorId = node.id.slice(4); offset = r.top - top; break; }
      }
      scrollMemoRef.current.set(pid, { atBottom: false, anchorId, offset, top: el.scrollTop });
    });
  }, []);

  const handleMessagesScroll = useCallback(() => {
    if (messagesScrollRef.current) {
      const el = messagesScrollRef.current;
      setShowScrollTop(el.scrollTop > 300);
      // Show "scroll to bottom" when not near the bottom
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollBottom(distFromBottom > 300);
    }
    rememberScroll();
  }, [rememberScroll]);

  // 잠깐 동안 바닥에 붙여둔다. 한 번만 맞추면 모자라다 — 카드의 포스터와 영상이
  // 뒤늦게 로드되며 높이가 계속 자라서, 그 순간 맞춘 위치가 곧 중간이 된다.
  // 사용자가 휠을 굴리거나 손가락을 대면 즉시 손을 뗀다. 따라가며 싸우면 안 된다.
  const pinReleaseRef = useRef<(() => void) | null>(null);
  // 바닥으로 '순간이동' 시킨다.
  //
  // ★ behavior:'instant' 가 이 함수의 핵심이다. index.css 가 `* { scroll-behavior:
  //   smooth }` 를 모든 요소에 걸어놔서, 평범한 `el.scrollTop = x` 는 값을 넣는 게
  //   아니라 애니메이션을 시작한다. 그래서 1505 는 매 프레임 애니메이션을 새로
  //   시작시키며 영영 도착하지 못했고, 화면에는 끝없이 미끄러지는 것으로 보였다.
  //   Sidebar 의 자동 스크롤도 같은 자리에서 한 번 당한 적이 있다(거기 주석 참고).
  const jumpToBottom = (el: HTMLDivElement) => {
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
  };

  // 잠깐 동안 바닥에 붙여둔다 — 카드가 뒤늦게 로드되며 높이가 자랄 수 있어서다.
  // 순간이동이라 붙어 있는 동안에도 눈에 보이는 움직임이 없다.
  // 사용자가 휠을 굴리거나 손가락을 대면 즉시 손을 뗀다. 따라가며 싸우면 안 된다.
  const pinToBottom = useCallback((ms = 700) => {
    const el = messagesScrollRef.current;
    if (!el) return;
    // ★ 앞서 돌던 고정을 먼저 끈다. 프로젝트를 빠르게 오가면 고정이 여러 개 겹쳐
    //   돌고, 사용자가 스크롤을 시작해도 남은 것들이 계속 끌어내린다.
    pinReleaseRef.current?.();
    let stop = false;
    const release = () => { stop = true; };
    const done = () => {
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
    };
    // 휠·터치 말고 버튼(맨 위로 / 특정 컷으로)으로도 풀 수 있어야 한다.
    pinReleaseRef.current = () => { stop = true; done(); };
    el.addEventListener('wheel', release, { once: true, passive: true });
    el.addEventListener('touchstart', release, { once: true, passive: true });
    const t0 = Date.now();
    const step = () => {
      const cur = messagesScrollRef.current;
      if (stop || !cur) { done(); return; }
      jumpToBottom(cur);
      if (Date.now() - t0 < ms) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  }, []);

  // 기억해 둔 자리로 되돌린다. 카드가 뒤늦게 로드되며 높이가 바뀌어도 잠깐 그 자리를 붙든다 —
  // pinToBottom 과 같은 방식이고, 사용자가 휠을 굴리거나 손가락을 대면 즉시 놓는다.
  const restoreScroll = useCallback((memo: ScrollMemo, ms = 700) => {
    const el = messagesScrollRef.current;
    if (!el) return;
    pinReleaseRef.current?.();
    let stop = false;
    const release = () => { stop = true; };
    const done = () => {
      el.removeEventListener('wheel', release);
      el.removeEventListener('touchstart', release);
    };
    pinReleaseRef.current = () => { stop = true; done(); };
    el.addEventListener('wheel', release, { once: true, passive: true });
    el.addEventListener('touchstart', release, { once: true, passive: true });
    const apply = () => {
      const cur = messagesScrollRef.current;
      if (!cur) return;
      const node = memo.anchorId ? document.getElementById(`msg-${memo.anchorId}`) : null;
      if (node && cur.contains(node)) {
        const delta = (node.getBoundingClientRect().top - cur.getBoundingClientRect().top) - memo.offset;
        if (Math.abs(delta) > 0.5) cur.scrollTo({ top: cur.scrollTop + delta, behavior: 'instant' as ScrollBehavior });
      } else {
        // 그 메시지가 그새 지워졌거나 검색으로 가려졌으면 픽셀 위치로라도.
        cur.scrollTo({ top: memo.top, behavior: 'instant' as ScrollBehavior });
      }
    };
    apply();
    const t0 = Date.now();
    const step = () => {
      if (stop || !messagesScrollRef.current) { done(); return; }
      apply();
      if (Date.now() - t0 < ms) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  }, []);

  // 특정 메시지로 가서 잠깐 그 자리를 붙든다(26.10.203~). 갤러리의 '찾기' · 상세의 '프롬프트 찾기' ·
  // 전체 갤러리의 '찾기'(다른 프로젝트면 consumeFindRequest 로 들어온다)가 같이 쓴다. 위쪽 카드의
  // 포스터·영상이 늦게 로드되며 높이가 자라도 그 메시지가 제자리에 있게, MB4/MB5 의 '보던 자리' 와 같은
  // 방법(restoreScroll)으로 0.9초 붙든다 — 휠·터치면 즉시 놓는다. 갤러리에서 돌아오는 중이거나 채팅
  // 검색이 그 메시지를 가리고 있으면(검색을 푼다) 메시지가 그려질 때까지 몇 프레임 기다린다.
  const headerSearchRef = useRef('');
  headerSearchRef.current = headerSearch;
  const revealMessage = useCallback((messageId: string) => {
    pinReleaseRef.current?.();
    setShowGallery(false);
    setPreviewItem(null);
    const q = headerSearchRef.current.trim().toLowerCase();
    if (q) {
      const st = useAppStore.getState();
      const m = st.projects.find(p => p.id === paneProjectRef.current)?.messages.find(x => x.id === messageId);
      if (m && !messageMatchesQuery(m, q)) setHeaderSearch('');
    }
    const t0 = Date.now();
    const attempt = () => {
      const node = document.getElementById(`msg-${messageId}`);
      const cur = messagesScrollRef.current;
      if (!node || !cur || !cur.contains(node)) {
        if (Date.now() - t0 < 3000) requestAnimationFrame(attempt);
        return;
      }
      restoreScroll({ atBottom: false, anchorId: messageId, offset: 16, top: cur.scrollTop }, 900);
      // 도착한 카드의 테두리를 잠깐 밝힌다. 같은 프롬프트의 Draft 가 여러 장 붙어 있으면 스크롤만으로는
      // 어느 카드로 왔는지 알 수 없다. 줄 전체가 아니라 카드(첫 자식)에 건다.
      const card = node.firstElementChild as HTMLElement | null;
      if (card) {
        card.classList.add('ring-2', 'ring-indigo-400');
        window.setTimeout(() => card.classList.remove('ring-2', 'ring-indigo-400'), 1800);
      }
    };
    attempt();
  }, [restoreScroll]);

  // 지금 보고 있는 프로젝트 안에서의 전체 갤러리 '찾기'(store.ts requestFindMessage).
  useEffect(() => {
    const onFind = (e: Event) => {
      const d = (e as CustomEvent).detail || {};
      // 나눠 보는 중이면 그 프로젝트가 떠 있는 칸이 받는다(store requestFindMessage 가 projectId 를 싣는다).
      if (typeof d.projectId === 'string' ? d.projectId !== paneProjectRef.current : !activeRef.current) return;
      if (typeof d.messageId === 'string') revealMessage(d.messageId);
    };
    window.addEventListener('seedance:find-message', onFind);
    return () => window.removeEventListener('seedance:find-message', onFind);
  }, [revealMessage]);

  // 그려지기 전에 먼저 바닥으로 보낸다. useEffect 는 그린 뒤에 돌기 때문에, 거기서
  // 옮기면 '위에 있다가 아래로 내려가는' 한 프레임이 실제로 보인다. useLayoutEffect
  // 는 페인트 전이라 처음부터 맨 아래로 그려진다 — 켜면 이미 맨 아래인 상태가 된다.
  // ★ 예외 둘: 뒤로/앞으로(MB4/MB5)로 온 것이면 보던 자리로, 전체 갤러리의 '찾기'로 온 것이면
  //   그 메시지로 간다 — 맨 아래 고정을 걸지 않는다(걸면 도착한 자리를 바닥으로 끌어내린다).
  useLayoutEffect(() => {
    const el = messagesScrollRef.current;
    shownProjectIdRef.current = currentProjectId;
    const viaHistory = consumeHistoryNav(currentProjectId);
    const findId = consumeFindRequest(currentProjectId);
    if (el && findId) { revealMessage(findId); return; }
    const memo = viaHistory && currentProjectId ? scrollMemoRef.current.get(currentProjectId) : undefined;
    if (el && memo && !memo.atBottom) { restoreScroll(memo); return; }
    if (el) jumpToBottom(el);
    pinToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProjectId]);

  // ─── 마우스 뒤로(MB4)/앞으로(MB5) — 마지막 두 프로젝트 사이 와리가리 (26.9.3002~) ───
  // 같은 동작을 Alt+←/→ 로도 한다(옆 버튼 없는 마우스·노트북, 그리고 시험용). 마우스 드라이버에
  // 따라(로지텍 소프트웨어 등) 옆 버튼이 마우스 이벤트가 아니라 Windows '앱 명령'
  // (browser-backward)으로 오기도 해서 그것도 받는다(main.cjs → preload). 한 번 누른 게 두 경로로
  // 두 번 와도 괜찮다 — 뒤로 끝에서 또 뒤로는 아무 일도 없다. 규칙은 store.ts navigateProjectHistory.
  useEffect(() => {
    // 손대는 칸만 옮긴다 — 두 칸이 같이 받으면 한 번 누른 것이 두 번 간다(나누기 26.10.2001~).
    const go = (dir: -1 | 1) => { if (activeRef.current) navigateProjectHistory(dir); };
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();                  // 페이지 자체의 뒤로가기 같은 기본 동작은 막는다
      if (e.type === 'mouseup') go(e.button === 3 ? -1 : 1);
    };
    const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.repeat) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      // 맥의 Option+←/→ 는 단어 단위 커서 이동이다 — 글을 쓰는 중에는 건드리지 않는다.
      const t = e.target as HTMLElement | null;
      if (isMac && t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      go(e.key === 'ArrowLeft' ? -1 : 1);
    };
    window.addEventListener('mousedown', onMouse, true);
    window.addEventListener('mouseup', onMouse, true);
    window.addEventListener('auxclick', onMouse, true);
    window.addEventListener('keydown', onKey, true);
    const off = (window as any).electronAPI?.onAppCommand?.((cmd: string) => {
      if (cmd === 'browser-backward') go(-1);
      else if (cmd === 'browser-forward') go(1);
    });
    return () => {
      window.removeEventListener('mousedown', onMouse, true);
      window.removeEventListener('mouseup', onMouse, true);
      window.removeEventListener('auxclick', onMouse, true);
      window.removeEventListener('keydown', onKey, true);
      if (typeof off === 'function') off();
    };
  }, []);

  const scrollToTop = () => { pinReleaseRef.current?.(); messagesScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); };
  const scrollToBottom = () => messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });

  const enterGallery = () => {
    setShowGallery(true);
  };
  // 갤러리에서 채팅으로 돌아오기(26.10.204~). 채팅 목록은 갤러리와 자리를 바꾸며 통째로 다시 그려지므로
  // 처음엔 맨 위(scrollTop 0)다. 예전에는 그린 뒤 한 프레임 + 50ms 뒤에 맨 아래로 굴렸는데, index.css 의
  // 전역 `scroll-behavior: smooth` 때문에 'auto' 가 곧 smooth 라 맨 위에서 주르륵 미끄러져 내려가는 게
  // 보였다. 이제 그리기 전(아래 useLayoutEffect)에 보던 자리로 순간이동한다 — 맨 아래였으면 맨 아래.
  // '찾기' 로 돌아올 때는 revealMessage 가 자리를 정하므로 여기를 타지 않는다.
  const backFromGalleryRef = useRef(false);
  const exitGallery = () => {
    backFromGalleryRef.current = true;
    setShowGallery(false);
  };
  useLayoutEffect(() => {
    if (showGallery || !backFromGalleryRef.current) return;
    backFromGalleryRef.current = false;
    const el = messagesScrollRef.current;
    if (!el) return;
    const memo = currentProjectId ? scrollMemoRef.current.get(currentProjectId) : undefined;
    if (memo && !memo.atBottom) { restoreScroll(memo); return; }
    jumpToBottom(el);
    pinToBottom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showGallery]);
  // Find a specific message and scroll to it — 갤러리 '찾기' · 상세의 '프롬프트 찾기'. 실제 일은 revealMessage.
  const scrollToMessage = (messageId: string) => revealMessage(messageId);

  // ── 에이전트 작업함 (26.10.302~) — 훅이라 아래 `if (!project) return null` 보다 위에 둔다 ──
  // 2초마다 server.ts 작업함을 들여다본다(폴링은 setInterval 하나 — HANDOFF §7 API 4). 실제 처리(agentTick)는
  // handleSend 아래에 있고, 렌더마다 새 함수로 바꿔 끼운다 — 그래야 지금 화면의 상태(isGenerating 등)를 본다.
  // 화면 id(agentScreenId) · 처리 중(agentBusy) · 받은 id(agentWorking)는 창에 하나(모듈) — 칸마다 두지 않는다(위 주석).
  const restoreBusyRef = useRef(false); // 받은 영상을 작성 칸에 불러오는 중(26.10.801~ runRestore — 둘이 섞이지 않게)
  const agentTickRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    const t = window.setInterval(() => { void agentTickRef.current(); }, 2000);
    return () => window.clearInterval(t);
  }, []);
  // 설명서 올리기 — 서버가 가진 버전이 이 화면의 것과 다르면(앱을 막 켰거나 서버만 다시 떴을 때) 올린다.
  // 서버는 이걸 에이전트에게 그대로 내주고, 작업함 응답마다 버전을 붙인다(src/lib/agent-inbox.ts).
  const agentSyncManual = (serverVersion: unknown) => {
    const m = agentManual();
    if (serverVersion === m.version) return;
    void fetch('/api/agent/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) }).catch(() => {});
  };
  // 열린 프로젝트가 없을 때(아래 가드에서 멈춤)도 '화면은 켜져 있음' 과 설명서는 알린다 — 가드 뒤에서 진짜 처리로 바꿔 끼운다.
  agentTickRef.current = async () => {
    if (!activeRef.current) return;   // 에이전트에게 '화면' 은 하나 — 손대는 칸만 알린다(나누기 26.10.2001~)
    agentReportProgress();
    try {
      const r = await fetch('/api/agent/jobs/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ screen: agentScreenId, peek: true, project: null, billing: null, composer: false, manual: agentManual().version, working: [...agentWorking] }),
      });
      if (r.ok) agentSyncManual((await r.json())?.manualVersion);
    } catch { /* 다음 틱에 */ }
  };

  if (!project) return null;

  const namedAssets = useMemo(() => getAssetNames(project.assets), [project.assets]);
  const mentionableAssets = useMemo(() => namedAssets.filter(a => a.role !== 'first_frame' && a.role !== 'last_frame'), [namedAssets]);

  // Element library: the @ menu surfaces the bound collection's assets, but only
  // in modes that actually take reference images (others can't carry them).
  const boundCollectionId = currentProjectId ? projectCollectionId[currentProjectId] : undefined;
  const boundCollectionName = boundCollectionId ? assetCollections.find(c => c.id === boundCollectionId)?.name : undefined;
  // For Omni, element @mentions are image references → enable on reference_to_video (they
  // become <IMAGE_REF_N>). Never key this off the stale Seedance `mode` when on Omni.
  const elementMentionEnabled = isOmni
    ? omniTask === 'reference_to_video'
    : (project.settings.mode === 'multimodal_reference' || project.settings.mode === 'edit_video'
      || (project.settings.mode === 'extend_video' && modeRefCaps(project.settings.model, 'extend_video').image > 0));
  const collectionElements = useMemo(
    () => (elementMentionEnabled && boundCollectionId ? elementAssets.filter(a => a.collectionId === boundCollectionId) : []),
    [elementAssets, boundCollectionId, elementMentionEnabled]
  );

  // Unified @ menu = panel reference assets + bound-collection elements, each
  // tagged with `kind` so insertMention and the dropdown can branch.
  const filteredMentionAssets = useMemo(() => {
    const q = mentionState.query.toLowerCase();
    const assetItems = mentionableAssets
      .filter(a => a.name.toLowerCase().includes(q))
      .map(a => ({ kind: 'asset' as const, ...a }));
    const elementItems = collectionElements
      .filter(e => e.name.toLowerCase().includes(q))
      .map(e => ({ kind: 'element' as const, id: e.id, name: e.name, category: e.category, thumbnailUrl: e.images[0]?.thumbnailUrl || e.images[0]?.url || '' }));
    return [...assetItems, ...elementItems];
  }, [mentionableAssets, collectionElements, mentionState.query]);

  // 프롬프트 글자와 태스크 ID(받은 파일 이름째 붙여 넣어도) — src/lib/search-match.ts
  const displayMessages = useMemo(() => headerSearch.trim()
    ? project.messages.filter(m => messageMatchesQuery(m, headerSearch.trim().toLowerCase()))
    : project.messages, [project.messages, headerSearch]);

  // '여기부터 새로 생성됨' 구분선이 들어갈 자리.
  //
  // 왼쪽 목록은 몇 개가 새로 생겼는지 알려주지만, 막상 들어오면 그 몇 개가 어디서부터인지
  // 알 수가 없다. 기준(newFrom)은 이 프로젝트를 열기 직전의 lastSeenAt 이고, 한 번 열면
  // App.tsx 가 그 값을 밀어버리므로 다음에 들어올 때는 자연히 사라진다 — 따로 지우는
  // 코드가 없다.
  //
  // newFrom 이 0 이면(한 번도 본 적 없는 프로젝트) 전부가 '새 것' 이라 맨 위에 선이 걸린다.
  // 그건 알려주는 게 없으므로 그리지 않는다. 검색 중일 때도 목록이 걸러진 상태라 선의
  // 의미가 없어 건너뛴다.
  const newDividerIdx = useMemo(() => {
    if (!newFrom || headerSearch.trim()) return -1;
    const i = displayMessages.findIndex(m => (m.endTime || m.timestamp || 0) > newFrom);
    return i > 0 ? i : -1;
  }, [displayMessages, newFrom, headerSearch]);
  const newDividerCount = useMemo(() => newDividerIdx < 0 ? 0
    : displayMessages.slice(newDividerIdx).filter(m => m.status === 'succeeded').length,
    [displayMessages, newDividerIdx]);

  // 초안 ↔ 본편 연결. 초안 카드는 자기 본편을, 본편 카드는 자기 초안을 여기서 찾는다.
  // 한 초안에 본편이 여럿이면(실패 뒤 재시도) 실패하지 않은 것 중 가장 나중 것을 쓴다.
  const { finalOfDraft, draftByTaskId } = useMemo(() => {
    const finalOfDraft = new Map<string, any>();
    const draftByTaskId = new Map<string, any>();
    for (const m of project.messages) {
      if (m.usedSettings?.draft && m.taskId) draftByTaskId.set(m.taskId, m);
      if (m.draftOf && m.status !== 'failed') finalOfDraft.set(m.draftOf, m);
    }
    return { finalOfDraft, draftByTaskId };
  }, [project.messages]);

  // 갤러리는 기본이 '본편만' 이다. 초안은 고르기 위한 480p 미리보기라 대부분 버려지는데,
  // 그대로 섞으면 편집 때 쓸 컷을 찾는 화면이 미리보기로 덮인다. 초안이 하나라도 있으면
  // '초안 포함' 버튼이 나타난다.
  const isDraftClip = (m: any) => !!m.usedSettings?.draft;
  const galleryClips = useMemo(() => project.messages.filter(m => m.status === 'succeeded' && m.videoUrl), [project.messages]);
  const gq = gallerySearch.trim().toLowerCase();
  const matchesGallerySearch = (m: any) => !gq || messageMatchesQuery(m, gq);
  // 버튼을 보일지는 검색과 상관없이 정한다 — 검색어를 치는 동안 버튼이 사라졌다 나타나면 안 된다.
  const hasDraftClips = useMemo(() => galleryClips.some(isDraftClip), [galleryClips]);
  const hasStarredClips = useMemo(() => galleryClips.some(m => m.starred), [galleryClips]);
  const draftClipCount = useMemo(
    () => galleryClips.filter(m => isDraftClip(m) && matchesGallerySearch(m)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [galleryClips, gq]);
  // 태스크 ID 로 찾은 카드는 초안이어도 보인다 — 그 영상 하나를 찾는 검색이라 'Draft 포함' 을 켜라고 할 일이 아니다.
  const galleryVideos = useMemo(() => galleryClips
    .filter(m => withDrafts || !isDraftClip(m) || taskIdMatches(m.taskId, gq))
    .filter(m => !starredOnly || m.starred)
    .filter(matchesGallerySearch)
    .sort((a, b) => b.timestamp - a.timestamp),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [galleryClips, starredOnly, withDrafts, gq]);
  // 채택 숫자도 지금 보이는 범위(초안 포함 여부 · 검색)에 맞춘다 — 누르면 나오는 개수와 같아야 한다.
  const starredCount = useMemo(
    () => galleryClips.filter(m => m.starred && (withDrafts || !isDraftClip(m) || taskIdMatches(m.taskId, gq)) && matchesGallerySearch(m)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [galleryClips, withDrafts, gq]);

  // Gallery paging — see the note on the grid. Reset whenever the visible set changes
  // (opening it, switching project, toggling 채택만) so we never open mid-list.
  const GALLERY_PAGE = 24;
  const [gallShown, setGallShown] = useState(GALLERY_PAGE);
  const gallSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { setGallShown(GALLERY_PAGE); }, [showGallery, project.id, starredOnly, withDrafts, gq]);
  useEffect(() => {
    if (!showGallery || galleryVideos.length <= gallShown) return;
    const el = gallSentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) setGallShown(n => n + GALLERY_PAGE);
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
    // ★ gallShown 을 의존성에 넣으면 안 된다. 넣으면 한 페이지 늘 때마다 옵저버를 새로
    //   만드는데, 새 IntersectionObserver 는 생성 즉시 현재 교차 상태를 콜백으로 보낸다.
    //   센티널이 아직 400px 안에 있으면 그 자리에서 또 +24 → 의존성 변경 → 또 새 옵저버
    //   → 또 즉시 발화. 센티널이 마진 밖으로 밀려날 때까지 폭주하고, 그 사이 카드 수백
    //   개가 한꺼번에 마운트되면서 "N개 더 불러오는 중"이 멈춘 것처럼 보인다.
    //   전체 갤러리(GlobalGallery)는 애초에 shown 을 의존성에 두지 않아 멀쩡했다 —
    //   두 갤러리가 갈린 지점이 정확히 여기다.
  }, [showGallery, galleryVideos.length]);

  const revealDownloaded = (filePath?: string) => revealClipFile(filePath, warn);

  // 컷 채택 토글. downloadedAt과 같은 경로(updateMessage)라 별도 배선이 없다.
  const toggleStar = (msgId: string, next: boolean) => {
    useAppStore.getState().updateMessage(project.id, msgId, { starred: next });
  };

  const handleVideoDownload = downloadClip;
  // previewItem is a useState snapshot — read downloadedAt live from the store
  const previewDownloaded = previewItem ? project.messages.find(m => m.id === previewItem.id)?.downloadedAt : undefined;
  const previewDownloadedPath = previewItem ? project.messages.find(m => m.id === previewItem.id)?.downloadedPath : undefined;

  /* ─── Drag & Drop ─── */
  // 영상을 끌어오면(26.10.801~) 막이 둘로 나뉜다 — 작성 칸 자리 '프롬프트 불러오기' · 나머지 '레퍼런스로 첨부'.
  // 끄는 동안에는 파일 내용을 못 읽고 형식(type)만 보인다 — 그 영상에 설정이 있는지는 놓은 뒤에 안다.
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current += 1;
    if (e.dataTransfer.items?.length) {
      setIsDragging(true);
      setDragVideo([...e.dataTransfer.items].some(it => it.kind === 'file' && /^video\//.test(it.type)));
    }
  };
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); dragCounter.current -= 1; if (dragCounter.current === 0) { setIsDragging(false); setDropZone(null); } };

  // 파일 붙이기 — 이 칸 프로젝트의 레퍼런스 칸에. 검사는 attachFilesTo(src/lib/send-request.ts) 한 곳이다 — 에이전트는
  // 같은 함수로 메모리에 붙인다(사용자의 레퍼런스 칸을 건드리지 않게). 붙이지 못한 파일과 이유를 돌려준다.
  const attachFiles = (allFiles: File[], src?: (f: File) => { path?: string; cacheId?: string } | undefined) =>
    attachFilesTo(projectAssetSink(project.id), allFiles, src);

  // ─── 받은 영상에서 되살리기 (26.10.801~) ───
  const findLocalByTask = (taskId?: string): LocalMatch | null => {
    if (!taskId) return null;
    for (const p of useAppStore.getState().projects) {
      const m = p.messages.find(x => x.taskId === taskId && x.status === 'succeeded');
      if (m) return { projectId: p.id, projectName: p.name, msg: m };
    }
    return null;
  };
  // 끌어다 놓은 파일이 '설정이 있는 영상 · 이 PC 카드를 찾을 수 있는 옛 영상' 인가.
  const inspectDroppedFile = async (file: File): Promise<RestoreTarget | null> => {
    const isVideo = /^video\//.test(file.type) || /\.(mp4|mov|m4v)$/i.test(file.name);
    if (!isVideo) return null;
    const payload = await readSettingsFromFile(file).catch(() => null);
    if (payload) return { payload, local: findLocalByTask(payload.taskId), file };
    // 설정이 없는 영상(이 기능 전에 받은 것): 파일 이름의 작업 번호 → 영상 안 BytePlus 고유번호(앱이 받을 때 적어 둔다).
    const clues = await readVideoClues(file);
    let local = findLocalByTask(clues.taskId);
    if (!local && clues.c2paId) {
      const r = await fetch(`/api/media/by-c2pa/${clues.c2paId}`).then(x => (x.ok ? x.json() : null)).catch(() => null);
      local = findLocalByTask(r?.taskId);
    }
    if (local) return { payload: null, local, file };
    if (!clues.madeAt) return null;
    // 마지막으로 만든 시각(증명서)이 가까운 카드 — 같이 돌린 영상은 몇 초 차이로 끝나서 하나로 정하지 않고 고르게 한다
    // (실측: 시각만으로는 405개 중 25개만 하나로 좁혀졌다).
    const near: (LocalMatch & { d: number })[] = [];
    for (const p of useAppStore.getState().projects) for (const m of p.messages) {
      if (m.status !== 'succeeded' || !m.endTime) continue;
      const d = Math.abs(m.endTime - clues.madeAt);
      if (d <= 10 * 60 * 1000) near.push({ projectId: p.id, projectName: p.name, msg: m, d });
    }
    near.sort((a, b) => a.d - b.d);
    return near.length ? { payload: null, local: null, file, candidates: near.slice(0, 4) } : null;
  };
  // 안내의 머리 — 어디서 불러왔나(짧게. 만든 시각 · 자세한 설명은 마우스를 올리면).
  const reportSource = (t: RestoreTarget, pick: LocalMatch | null): { source: string; sourceTitle: string } => {
    const when = (m: any) => m?.endTime || m?.timestamp;
    const at = (m: any) => (when(m) ? ` · ${formatStampFull(when(m))}` : '');
    if (pick) return { source: `${pick.projectName} 카드`, sourceTitle: `이 PC 의 카드 · ${pick.projectName}${at(pick.msg)}` };
    const m = t.payload?.message;
    const name = t.payload?.project.name || '이름 없는 프로젝트';
    return { source: `영상 속 설정 · ${name}`, sourceTitle: `이 PC 에 그 카드가 없어 영상에 든 설정으로 불러왔어요 · ${name}${at(m)}` };
  };
  // 불러오기 전의 작성 칸 · 레퍼런스 · 오른쪽 설정 · 컬렉션 연결 — 안내의 '되돌리기' 가 되돌린다(잘못 놓아도 쓰던 글이 안 사라지게).
  const takeSnapshot = (pid: string): ComposerSnapshot => {
    const st = useAppStore.getState();
    const p = st.projects.find(x => x.id === pid);
    return { projectId: pid, promptHtml: contentEditableRef.current?.innerHTML || '', assets: p?.assets || [], settings: { ...(p?.settings || {}) }, collectionId: st.projectCollectionId[pid] || null };
  };
  // 오른쪽 패널의 '초기화' 와 같다 — 설정을 기본값으로(keep 만 남기고), 레퍼런스를 비우고, 작성 칸을 비운다. 받은 영상을 불러올 때는
  // 언제나 여기서 시작한다(사용자 2026-10-08: 쓰던 글 · 레퍼런스 · 설정이 남은 채 섞이면 안 된다).
  const resetComposer = (pid: string, keep: Record<string, any>) => {
    const st = useAppStore.getState();
    st.updateProjectSettings(pid, { ...defaultSettings, ...keep });
    st.replaceAllAssets(pid, []);
    window.dispatchEvent(new CustomEvent('seedance:reset', { detail: { projectId: pid } }));
  };
  // 받은 영상의 메시지 — 이 PC 카드면 그 카드, 아니면 파일 속 설정(미리보기를 먼저 라이브러리에 넣는다).
  // ★ 파일에서 온 글은 늘 HTML 로 만들어 거른다 — promptHtml 이 없으면 평문을 글자 그대로(태그가 되지 않게) 짓는다. 평문을 그대로
  //   넘기면 handleReuse 가 작성 칸에 HTML 로 넣는다(26.10.801 검토: 조작한 파일의 스크립트가 거기서 돌 수 있었다).
  const sourceMessage = async (t: RestoreTarget, pick: LocalMatch | null): Promise<any | null> => {
    if (pick) return pick.msg;
    if (!t.payload) return null;
    await storePayloadThumbs(t.payload.thumbs);   // 칩 · 레퍼런스 미리보기 — 이름이 곧 내용이라 같은 주소로 살아난다
    const m = t.payload.message;
    return { ...m, promptHtml: sanitizePromptHtml(m.promptHtml || plainTextToHtml(m.promptText || '')) };
  };
  // 그때 이 채팅에 연결돼 있던 어셋 컬렉션과 이 PC 의 그 컬렉션(다른 PC 에서 온 것은 id 가 달라 같은 이름으로).
  const findUsedCollection = (msg: any, fromFile: boolean) => {
    const want: { id: string; name: string } | undefined = fromFile ? msg.usedCollection : usedCollectionOf(msg);
    if (!want) return { want: undefined, found: undefined };
    const st = useAppStore.getState();
    const found = st.assetCollections.find(x => x.id === want.id) || (fromFile ? st.assetCollections.find(x => x.name === want.name) : undefined);
    return { want, found };
  };
  // 아는 모델인가 — 없어진 모델은 이어받는 모델로, 모르는 모델 id(파일에서 온 것)는 쓰지 않고 지금 모델 그대로.
  const knownModel = (raw: unknown, fallback: string): { model: string; unknown?: string } => {
    if (typeof raw !== 'string' || !raw) return { model: fallback };
    const m = resolveModelId(raw);
    return MODELS.some(x => x.id === m) ? { model: m } : { model: fallback, unknown: raw };
  };
  // 지금 프로젝트 코드(공동 코드)로 그 모델을 쓸 수 있는가(코드는 사람이 고른다 — 안 골랐으면 보낼 때 묻는다).
  const checkModelAllowed = (pid: string, sink: ReportSink) => {
    const st = useAppStore.getState();
    const model = st.projects.find(p => p.id === pid)?.settings.model;
    const bill = projectBilling(st, pid);
    if (model && bill && !isModelAllowed(model, { billingProjectKey: bill.key, billingProjects: st.billingProjects })) {
      sink.missing.push(`프로젝트 코드 '${bill.project}' 에 ${MODELS.find(m => m.id === model)?.name || model} 권한 없음`);
    }
  };
  // '그때 설정 그대로' — 초기화한 뒤 작성 칸 · 레퍼런스 · 어셋(그때 연결한 컬렉션까지) · 모델 · 파라미터를 그 영상을 만든 그대로.
  const restoreAll = async (pid: string, msg: any, fromFile: boolean, sink: ReportSink, before: ComposerSnapshot) => {
    const { want, found } = findUsedCollection(msg, fromFile);
    if (want && !found) sink.missing.push(`어셋 컬렉션 '${want.name}' 없음(지워졌거나 다른 PC 것)`);
    if (found) {
      const st = useAppStore.getState();
      const prev = st.assetCollections.find(x => x.id === st.projectCollectionId[pid]);
      if (prev?.id !== found.id) {
        st.setProjectCollection(pid, found.id);
        sink.notes.push(`어셋 컬렉션을 '${found.name}' 로 연결했어요${prev ? ` (전: ${prev.name})` : ''}`);
      }
    }
    const km = knownModel(msg.usedSettings?.model, before.settings.model);
    if (km.unknown) sink.missing.push(`모르는 모델(${km.unknown}) — 지금 모델로 두었어요`);
    resetComposer(pid, { model: km.model });
    await handleReuse(km.unknown ? { ...msg, usedSettings: { ...msg.usedSettings, model: km.model } } : msg,
      { fromFile, report: sink, collectionId: found?.id });
  };
  // '프롬프트만' — 초기화한 뒤 그 영상의 프롬프트만. 어셋 언급은 이 PC 라이브러리 어셋에 묶어 함께 오고, 레퍼런스는 붙이지 않는다 —
  // 알약은 '[Image 1]' 같은 글자로 남아 새로 붙이는 레퍼런스의 순서를 가리킨다(BytePlus 는 [Image N] 을 패널 순서로 읽는다).
  // 사용자: "프롬프트만 가져오기 했는데 래퍼런스도 다 오는데 … 설정 그대로도 같은 내용 아님?" — 레퍼런스까지는 '그때 설정 그대로'.
  // 모델 · 모드만 그 영상대로(어셋 언급은 레퍼런스 → 영상 · 영상 편집에서만 쓰인다), 나머지 설정은 그 조합의 기본값. 컬렉션 연결은 그대로.
  const restorePromptOnly = async (pid: string, msg: any, fromFile: boolean, sink: ReportSink, before: ComposerSnapshot) => {
    const us = msg.usedSettings || {};
    const km = knownModel(us.model, before.settings.model);
    if (km.unknown) sink.missing.push(`모르는 모델(${km.unknown}) — 지금 모델로 두었어요`);
    const mode = (us.mode || defaultSettings.mode) as GenerationMode;
    const keep: Record<string, any> = { model: km.model, mode, ...settingsDefaultsFor(km.model, mode) };
    if (us.omniTask) keep.omniTask = us.omniTask;
    resetComposer(pid, keep);
    const refCount = Array.isArray(msg.usedAssets) ? msg.usedAssets.length : 0;
    await handleReuse({ ...msg, promptHtml: msg.promptHtml ? unpillReferences(msg.promptHtml) : undefined, usedAssets: [], usedSettings: undefined },
      { fromFile, report: sink, collectionId: findUsedCollection(msg, fromFile).found?.id });
    if (refCount) sink.notes.push(`레퍼런스 ${refCount}개는 빼고 불러왔어요`);
  };
  // 두 칸의 공통 틀(26.10.801 검토): 하나가 끝날 때까지 다음 것을 받지 않고(두 초기화가 섞이지 않게), 시작한 채팅을 고정하고
  // (기다리는 사이 다른 채팅으로 옮기면 거기에 섞이지 않게 — 초기화 전이면 멈추고, 뒤면 원래 채팅에 넣어 둔다), 도중에 실패하면
  // 불러오기 전으로 되돌린다(초기화만 되고 끝나면 쓰던 글을 잃는다).
  // (restoreBusyRef 는 위 에이전트 작업함 훅 옆에 있다 — 훅은 'if (!project) return' 보다 앞이어야 한다.)
  // 26.10.2002~ 에이전트는 작성 칸을 빌리지 않는다 — 에이전트가 보내는 중이어도 불러오기를 막지 않는다.
  const runRestore = async (how: 'paste' | 'restore', t: RestoreTarget, pick: LocalMatch | null, snapshot?: ComposerSnapshot) => {
    if (restoreBusyRef.current) { warn('앞의 영상을 불러오는 중이에요 — 끝난 뒤에 다시 놓아 주세요'); return; }
    restoreBusyRef.current = true;
    setRestoreTarget(null);
    const pid = project.id;
    const here = () => paneProjectRef.current === pid;   // 이 칸이 아직 그 채팅인가(나눠 보는 중엔 다른 칸에 손대도 그대로다)
    let before: ComposerSnapshot | null = null;
    try {
      if (showGallery) { exitGallery(); await new Promise(r => setTimeout(r, 80)); }   // 작성 칸이 다시 그려진 뒤에 채운다
      const msg = await sourceMessage(t, pick);
      if (!msg) return;
      if (!here()) { warn('다른 채팅으로 옮겨서 불러오기를 멈췄어요'); return; }
      before = snapshot || takeSnapshot(pid);
      const sink: ReportSink = { notes: [], missing: [] };
      if (how === 'restore') await restoreAll(pid, msg, !pick, sink, before);
      else await restorePromptOnly(pid, msg, !pick, sink, before);
      checkModelAllowed(pid, sink);
      if (!here()) { showToast('다른 채팅으로 옮겨서, 불러온 내용은 원래 채팅에 넣어 뒀어요', true); return; }
      setRestoreReport({ how, ...reportSource(t, pick), notes: sink.notes, missing: sink.missing, local: pick, target: t, snapshot: before });
    } catch (e: any) {
      console.warn('[Restore] 불러오기 실패:', e);
      if (before) undoRestore(before, true);
      warn(`영상을 불러오다 멈췄어요 — 불러오기 전으로 돌려놨어요.\n${e?.message || e}`);
    } finally {
      restoreBusyRef.current = false;
    }
  };
  const applyRestore = (t: RestoreTarget, pick: LocalMatch | null, snapshot?: ComposerSnapshot) => runRestore('restore', t, pick, snapshot);
  const pasteFrom = (t: RestoreTarget, pick: LocalMatch | null, snapshot?: ComposerSnapshot) => runRestore('paste', t, pick, snapshot);
  // 안내의 '되돌리기' — 불러오기 직전의 작성 칸 · 레퍼런스 · 오른쪽 설정 · 컬렉션 연결로. 레퍼런스는 다시 찾지 않고 그대로 넣고
  // (주소만 있는 레퍼런스도 되돌아온다), 알약은 이름으로 다시 묶는다.
  const undoRestore = (snap: ComposerSnapshot, quiet = false) => {
    setRestoreReport(null);
    const st = useAppStore.getState();
    const pid = snap.projectId;
    st.setProjectCollection(pid, snap.collectionId);
    const now = st.projects.find(p => p.id === pid)?.settings || {};
    const restore: Record<string, unknown> = { ...snap.settings };
    for (const k of Object.keys(now)) if (!(k in snap.settings)) restore[k] = undefined;   // 새로 생긴 키는 비운다 — 합치기라서
    st.updateProjectSettings(pid, restore as Partial<GenerationSettings>);
    st.replaceAllAssets(pid, snap.assets.map(({ id: _id, ...rest }: any) => rest));
    const html = rebindMentionPills(snap.promptHtml, getAssetNames(useAppStore.getState().projects.find(p => p.id === pid)?.assets || []));
    putPromptHtml(pid, html);
    if (!quiet) showToast('불러오기 전으로 되돌렸어요', true);
  };
  // 이름으로 어셋 찾기 — 그때 컬렉션 · 지금 이 채팅 컬렉션의 것을 먼저(같은 이름이 여러 컬렉션에 있을 수 있다).
  const findElementByName = (nm: string, prefer: (string | undefined)[]) => {
    const lib = useAppStore.getState().elementAssets;
    const key = mentionKey(nm);
    for (const cid of prefer) if (cid) { const e = lib.find(x => x.collectionId === cid && mentionKey(x.name) === key); if (e) return e; }
    return lib.find(x => mentionKey(x.name) === key) || null;
  };
  // 그 어셋의 그림이 그때와 같은가 — 내용 해시 앞 12자로 비교한다(이름이 곧 내용이라 다른 PC 것도 비교된다). 확장자는 보지 않는다 —
  // 26.7~26.9 카드는 cacheId 에 원래 확장자(.jpeg · .JPG)를, 지금 어셋은 libId 에 알아낸 확장자(.jpg)를 적어서 같은 그림이 달라 보였다.
  const elementImagesChanged = (msg: any, el: { id: string; name: string; images: any[] }, oldId: string | null, oldName: string): boolean => {
    const key = (x: any) => String(x?.libId || x?.cacheId || '').slice(0, 12);
    const then = ((msg.usedElementImages as any[]) || [])
      .filter(x => x && (x.elementId === oldId || mentionKey(x.name || '') === mentionKey(oldName)))
      .map(key).filter(Boolean);
    if (!then.length) return false;
    const now = el.images.map(key).filter(Boolean);
    return then.length !== now.length || then.some((x: string) => !now.includes(x));
  };
  // 작성 칸 쪽 두 칸('프롬프트만' · '그때 설정 그대로')에 놓은 영상.
  const loadPromptFromFile = async (file: File, how: 'paste' | 'restore') => {
    if (restoreBusyRef.current) { warn('앞의 영상을 불러오는 중이에요 — 끝난 뒤에 다시 놓아 주세요'); return; }
    const t = await inspectDroppedFile(file).catch(() => null);
    if (!t) {
      warn('이 영상에는 불러올 설정이 없어요.\n이 앱에서 받은 영상이 아니거나, 카톡처럼 다시 압축되면서 정보가 지워진 영상이에요.');
      return;
    }
    if (!t.payload && !t.local) { setRestoreTarget(t); return; }   // 시각이 가까운 후보 — 창에서 골라 붙인다
    await (how === 'restore' ? applyRestore(t, t.local) : pasteFrom(t, t.local));
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); dragCounter.current = 0; setIsDragging(false); setDropZone(null);
    const allFiles = Array.from(e.dataTransfer.files) as File[];
    if (allFiles.length === 0) return;
    // 영상을 끌어오면 막이 셋으로 나뉜다(아래 isDragging 막) — 작성 칸 쪽 '프롬프트만' · '그때 설정 그대로', 나머지 '레퍼런스로 첨부'.
    const zone = (e.target as HTMLElement)?.closest?.('[data-drop-zone]')?.getAttribute('data-drop-zone');
    const isVideo = (f: File) => /^video\//.test(f.type) || /\.(mp4|mov|m4v)$/i.test(f.name);

    (async () => {
      const toAttach: File[] = [];
      let loaded = false;
      for (const f of allFiles) {
        // 작성 칸 쪽 두 칸 — 첫 영상 하나만 불러온다.
        if (!loaded && (zone === 'prompt' || zone === 'restore') && isVideo(f)) {
          loaded = true; await loadPromptFromFile(f, zone === 'restore' ? 'restore' : 'paste'); continue;
        }
        toAttach.push(f);
      }
      if (toAttach.length === 0) return;
      // 모델 · 모드는 지금 것으로 읽는다 — 위에서 영상을 불러왔으면 그 영상대로 바뀌어 있다(26.10.801 검토).
      const now = useAppStore.getState().projects.find(p => p.id === project.id)?.settings || project.settings;
      // Seedance-only guard: for Omni the stale `mode` is irrelevant (Omni routes by omniTask
      // in attachFiles). After 초기화 mode resets to 'text_to_video', which would otherwise
      // wrongly block an Omni Edit/Reference drop with a "Text to Video" message.
      if (modelProvider(now.model) !== 'gemini' && now.mode === 'text_to_video') {
        warn('Text to Video 모드에서는 래퍼런스 파일을 사용하지 않습니다.');
        return;
      }
      const rejected = await attachFiles(toAttach);
      if (rejected.length > 0) warn(`일부 파일이 추가되지 않았습니다:\n\n${rejected.join('\n')}`);
    })();
  };

  /* ─── Input handlers ─── */
  const highlightMentionItem = useCallback(() => {
    // 이 칸의 목록만 — 나눠 보는 중 다른 칸에도 @ 목록이 떠 있으면 번호가 섞인다.
    (rootRef.current || document).querySelectorAll('.mention-item').forEach((item, i) => {
      if (i === mentionIndexRef.current) {
        item.classList.add('bg-indigo-50', 'text-indigo-700');
        item.classList.remove('text-gray-700');
        // Keep the keyboard-selected item visible — the list scrolls (max-h-48),
        // so navigating to the 4th+ item must bring it into the scroll viewport.
        (item as HTMLElement).scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('bg-indigo-50', 'text-indigo-700');
        item.classList.add('text-gray-700');
      }
    });
  }, []);

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    setHasText(!!e.currentTarget.innerText.trim());
    syncMentionCount();
    const sel = window.getSelection();
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0);
      if (range.startContainer.nodeType === Node.TEXT_NODE) {
        // `[^\s@]*` (not `\w*`) so the query captures Korean/Unicode asset names —
        // `\w` is ASCII-only, which broke "@김…" filtering entirely. Closes on
        // whitespace so a stray "@" in prose doesn't keep the menu open forever.
        const match = range.startContainer.textContent?.slice(0, range.startOffset).match(/@([^\s@]*)$/);
        if (match) { mentionIndexRef.current = 0; setMentionState({ active: true, query: match[1] }); }
        else setMentionState(s => s.active ? { ...s, active: false } : s);
      } else { setMentionState(s => s.active ? { ...s, active: false } : s); }
    }

    // Auto-scroll caret into view. contentEditable does NOT do this natively
    // (unlike <textarea>/<input>), so long prompts or paste-in-long-text hide
    // the cursor below the visible area and users can't see what they're typing.
    // Run in rAF so layout is finalized before measuring.
    requestAnimationFrame(() => {
      const container = promptScrollRef.current; // the wrapper scrolls, not the editable
      const s = window.getSelection();
      if (!container || !s?.rangeCount) return;
      const r = s.getRangeAt(0).cloneRange();
      r.collapse(true);
      let rect = r.getBoundingClientRect();
      // Collapsed range at an element boundary can return a zero-rect; insert
      // a zero-width marker to get a real position, then immediately remove it.
      if (rect.top === 0 && rect.bottom === 0 && rect.left === 0) {
        const marker = document.createElement('span');
        marker.textContent = '\u200B';
        try {
          r.insertNode(marker);
          rect = marker.getBoundingClientRect();
        } finally {
          marker.remove();
        }
      }
      if (rect.bottom === 0 && rect.top === 0) return;
      const cRect = container.getBoundingClientRect();
      const pad = 8;
      if (rect.bottom > cRect.bottom - pad) {
        container.scrollTop += rect.bottom - cRect.bottom + pad * 2;
      } else if (rect.top < cRect.top + pad) {
        container.scrollTop -= cRect.top - rect.top + pad * 2;
      }
    });

    // Debounced draft save
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      if (contentEditableRef.current && currentProjectId) {
        useAppStore.getState().updateDraftPrompt(currentProjectId, contentEditableRef.current.innerHTML);
      }
    }, 500);
  };

  // Build a mention pill element — shared by click-to-mention and paste-to-mention.
  const buildMentionPill = (item: any): HTMLSpanElement => {
    const pill = document.createElement('span');
    pill.contentEditable = 'false';
    if (item.kind === 'element') {
      const meta = CATEGORY_META[item.category as AssetCategory];
      pill.className = 'element-pill';
      pill.dataset.name = item.name;
      pill.dataset.elementId = item.id;
      pill.dataset.category = item.category;
      pill.style.cssText = `display:inline-flex;align-items:center;background:${meta.bg};color:${meta.text};padding:2px 6px;border-radius:6px;font-size:13px;margin:0 2px;vertical-align:middle;border:1px solid ${meta.border};`;
      const iconHtml = item.thumbnailUrl
        ? `<img src="${item.thumbnailUrl}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;margin-right:4px;" />`
        : `<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${meta.accent};margin-right:5px;"></span>`;
      pill.innerHTML = `${iconHtml}<span data-el-text style="font-weight:500;">[${item.name}]</span>`;
    } else {
      pill.className = 'mention-pill'; pill.dataset.name = item.name; pill.dataset.assetId = item.id;
      pill.style.cssText = 'display:inline-flex;align-items:center;background:#eef2ff;color:#4338ca;padding:2px 6px;border-radius:6px;font-size:13px;margin:0 2px;vertical-align:middle;border:1px solid #c7d2fe;';
      const thumbSrc = (item.type === 'image_url' || item.type === 'video_url') ? (item.thumbnailUrl || (item.type === 'image_url' ? item.url : '')) : '';
      const iconHtml = thumbSrc
        ? `<img src="${thumbSrc}" style="width:16px;height:16px;object-fit:cover;border-radius:2px;margin-right:4px;" />`
        : `<span style="width:16px;height:16px;background:#f0f0f5;border-radius:2px;margin-right:4px;text-align:center;line-height:16px;font-size:10px;display:inline-block;">${item.type === 'video_url' ? '🎥' : '🎵'}</span>`;
      pill.innerHTML = `${iconHtml}<span style="font-weight:500;">[${item.name}]</span>`;
    }
    return pill;
  };

  // ─── Paste-to-mention ───
  // Parse pasted text, turning `@name` / `[name]` refs that match a panel asset
  // (Image N / Video N / Audio N) or a bound-collection element into pills. Refs
  // that don't match anything stay as literal text (e.g. "@image2" with no Image 2
  // stays "@image2"). Element conversions respect the shared 9-image budget. Never
  // throws on weird input — stray '@'/'[' just pass through.
  const resolveMentionTokens = (text: string): Array<{ type: 'text'; text: string } | { type: 'pill'; item: any }> => {
    const norm = mentionKey;   // 엘리먼트 생성 쪽(ElementLibrary)과 같은 규칙을 써야 한다
    const panelCands = getAssetNames(project.assets)
      .filter(a => a.role !== 'first_frame' && a.role !== 'last_frame')
      .map(a => ({ kind: 'asset' as const, norm: norm(a.name), imgs: 0, item: { kind: 'asset', ...a } }));
    const elemCands = (elementMentionEnabled ? collectionElements : [])
      .map(e => ({ kind: 'element' as const, norm: norm(e.name), imgs: e.images.length, item: { kind: 'element', id: e.id, name: e.name, category: e.category, thumbnailUrl: e.images[0]?.thumbnailUrl || e.images[0]?.url || '' } }));
    // elements first (user-named, specific), then panel; longest normalized name first
    const cands = [...elemCands, ...panelCands].filter(c => c.norm).sort((a, b) => b.norm.length - a.norm.length);

    const usedEl = new Set<string>();
    mentionedElementStats().ids.forEach(id => usedEl.add(id));
    let usedImgs = project.assets.filter(a => a.type === 'image_url').length
      + [...usedEl].reduce((n, id) => n + (elementAssets.find(e => e.id === id)?.images.length || 0), 0);
    const canConvert = (c: { kind: string; imgs: number; item: any }) => {
      if (c.kind !== 'element') return true;          // panel mention adds no images (already attached)
      if (usedEl.has(c.item.id)) return true;          // already counted (dedup)
      if (usedImgs + c.imgs > modelImageMax(project.settings.model)) return false;  // exceeds shared cap → leave as text
      usedEl.add(c.item.id); usedImgs += c.imgs;
      return true;
    };

    // Space-flexible, case-insensitive match of candNorm against text from `pos`.
    // Returns the end index, or -1. Rejects if the next char would extend the ref
    // (so "@image1" never partial-matches inside "@image12").
    const matchAt = (pos: number, candNorm: string) => {
      let ti = pos, ci = 0;
      while (ci < candNorm.length) {
        while (ti < text.length && /\s/.test(text[ti])) ti++;
        if (ti >= text.length || text[ti].toLowerCase() !== candNorm[ci]) return -1;
        ti++; ci++;
      }
      if (ti < text.length && /[a-z0-9]/i.test(text[ti])) return -1;
      return ti;
    };

    const nodes: Array<{ type: 'text'; text: string } | { type: 'pill'; item: any }> = [];
    let buf = '';
    const flush = () => { if (buf) { nodes.push({ type: 'text', text: buf }); buf = ''; } };
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '@') {
        let hit: { c: any; end: number } | null = null;
        for (const c of cands) { const end = matchAt(i + 1, c.norm); if (end !== -1) { hit = { c, end }; break; } }
        if (hit && canConvert(hit.c)) { flush(); nodes.push({ type: 'pill', item: hit.c.item }); i = hit.end; continue; }
      } else if (ch === '[') {
        const close = text.indexOf(']', i + 1);
        if (close !== -1 && close - i <= 60) {
          const c = cands.find(x => x.norm === norm(text.slice(i + 1, close)));
          if (c && canConvert(c)) { flush(); nodes.push({ type: 'pill', item: c.item }); i = close + 1; continue; }
        }
      }
      buf += ch; i++;
    }
    flush();
    return nodes;
  };

  // Insert resolved nodes (text + pills) at the caret, replacing any selection.
  // Newlines become <br> so multi-line pasted prompts keep their line breaks.
  const insertNodesAtCaret = (nodes: Array<{ type: 'text'; text: string } | { type: 'pill'; item: any }>) => {
    const ce = contentEditableRef.current;
    if (!ce) return;
    ce.focus();
    const sel = window.getSelection(); if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = document.createDocumentFragment();
    nodes.forEach((n, i) => {
      if (n.type === 'text') {
        n.text.split('\n').forEach((part, idx) => {
          if (idx > 0) frag.appendChild(document.createElement('br'));
          if (part) frag.appendChild(document.createTextNode(part));
        });
      } else {
        frag.appendChild(buildMentionPill(n.item));
        // Only inject a caret-target space when no real text follows (pill is last,
        // or two pills are adjacent). When text follows it already carries the
        // user's original spacing — adding one here would double it or split a
        // Korean particle ("@남자가" → "남자 가").
        const next = nodes[i + 1];
        if (next && next.type !== 'pill') return;
        frag.appendChild(document.createTextNode(' '));
      }
    });
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) { range.setStartAfter(last); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
    setMentionState(s => ({ ...s, active: false }));
    setHasText(!!ce.innerText.trim());
    syncMentionCount();
    if (currentProjectId) useAppStore.getState().updateDraftPrompt(currentProjectId, ce.innerHTML);
  };

  const insertMention = (item: any) => {
    if (!contentEditableRef.current) return;
    // Shared image budget: element images draw from the SAME 9-image cap as the
    // panel's reference images. Block the mention proactively if it would push the
    // combined count past 9 — so it's caught here, not as a surprise at send.
    if (item.kind === 'element') {
      const panelImgs = project.assets.filter(a => a.type === 'image_url').length;
      const { count, ids } = mentionedElementStats();
      const adding = ids.has(item.id) ? 0 : (elementById.get(item.id)?.images.length || 0);
      if (panelImgs + count + adding > modelImageMax(project.settings.model)) {
        warn(`이미지 합산 9장을 넘습니다.\n패널 ${panelImgs}장 + 어셋 ${count}장${adding ? ` + ‘${item.name}’ ${adding}장` : ''} = ${panelImgs + count + adding}장.\n(어셋 이미지는 래퍼런스 패널과 9장을 나눠 씁니다)\n패널 이미지나 다른 어셋 멘션을 줄여주세요.`);
        setMentionState(s => ({ ...s, active: false }));
        return;
      }
    }
    contentEditableRef.current.focus();
    const sel = window.getSelection(); if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const mentionStart = (range.startContainer.textContent || '').lastIndexOf('@', range.startOffset);
      if (mentionStart !== -1) { range.setStart(range.startContainer, mentionStart); range.deleteContents(); }
    }
    const pill = buildMentionPill(item);
    const space = document.createTextNode('\u00A0');
    range.insertNode(space); range.insertNode(pill);
    range.setStartAfter(space); range.collapse(true);
    sel.removeAllRanges(); sel.addRange(range);
    setMentionState(s => ({ ...s, active: false })); setHasText(true);
    syncMentionCount();
  };

  // 우클릭 원본 복사 로직은 lib/utils.ts 의 copyImageToClipboard 로 이동(패널과 공유).

  // Copy/cut OUT of the prompt box: put ONLY clean plain text on the clipboard. The
  // editor stores each line as a <div>, and apps that render <div> as a spaced
  // paragraph turned that into an extra blank line per line when pasted (a 3300-char
  // prompt landed as ~3800). Dropping the text/html flavor makes what you paste
  // identical to what you see — any target app, any mix of ko/ja/zh/en.
  const writePlainClipboard = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    const holder = document.createElement('div');
    holder.appendChild(sel.getRangeAt(0).cloneContents());
    e.clipboardData.setData('text/plain', getPlainText(holder.innerHTML));
    e.preventDefault(); // suppresses the default text/html flavor
    return true;
  };
  const handlePromptCopy = (e: React.ClipboardEvent<HTMLDivElement>) => { writePlainClipboard(e); };
  const handlePromptCut = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // preventDefault cancels the native delete too, so remove the selection ourselves.
    // execCommand keeps the undo stack intact and still fires the input handler.
    if (writePlainClipboard(e)) document.execCommand('delete');
  };

  // Clipboard image paste into the prompt box. Default contentEditable
  // behavior inlines the image into the prompt HTML (disaster) — intercept and
  // route to the asset list per mode instead. Text paste falls through.
  const handlePromptPaste = async (e: React.ClipboardEvent<HTMLDivElement>) => {
    const imageFiles = Array.from(e.clipboardData?.items || [])
      .filter(it => it.kind === 'file' && it.type.startsWith('image/'))
      .map(it => it.getAsFile())
      .filter((f): f is File => !!f);
    if (imageFiles.length === 0) {
      // Text paste: auto-convert @name / [name] refs to pills. Only intercept when
      // at least one ref actually matches — otherwise let the default paste run so
      // plain / multi-line text stays untouched.
      const pasted = e.clipboardData?.getData('text/plain') || '';
      if (pasted && /[@[]/.test(pasted)) {
        const nodes = resolveMentionTokens(pasted);
        if (nodes.some(n => n.type === 'pill')) { e.preventDefault(); insertNodesAtCaret(nodes); }
      }
      return; // plain text without matching refs → default paste
    }
    e.preventDefault(); // 이미지가 프롬프트 HTML에 박히는 것 차단

    // ── Gemini Omni: route pasted images by the selected Video task (NOT the stale Seedance
    // `mode`, which resets to text_to_video on 초기화 and would wrongly block the paste). ──
    if (isOmni) {
      const fresh = useAppStore.getState().projects.find(p => p.id === project.id)?.settings;
      const task = resolveOmniTask(fresh?.model, fresh?.omniTask);
      if (task === 'text_to_video') { warn('Text to Video는 이미지를 사용하지 않습니다.'); return; }
      if (task === 'edit') { warn('Edit Video는 편집할 소스 영상만 씁니다 (이미지 X).'); return; }
      if (task === 'extend') { warn('Extend Video는 이어붙일 원본 영상만 씁니다 (이미지 X).'); return; }
      for (const raw of imageFiles) {
        const ext = (raw.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
        const file = new File([raw], `clipboard-${stamp}-${Math.random().toString(36).slice(2, 5)}.${ext}`, { type: raw.type });
        const sizeErr = validateImageFile(file);
        if (sizeErr) { warn(sizeErr); continue; }
        const assets = useAppStore.getState().projects.find(p => p.id === project.id)?.assets || [];
        let role: any = 'reference_image';
        if (task === 'image_to_video') {
          if (!assets.some(a => a.role === 'first_frame')) role = 'first_frame';
          else if (!assets.some(a => a.role === 'last_frame')) role = 'last_frame';
          else { warn('Image to Video는 시작·끝 프레임 2장까지입니다.'); continue; }
        } else {
          const imgCapPaste = modelImageMax(fresh?.model || project.settings.model);
          if (assets.filter(a => a.type === 'image_url').length >= imgCapPaste) {
            warn(`이미지 한도 ${imgCapPaste}장 초과`); continue;
          }
        }
        try {
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          addAsset(project.id, { type: 'image_url', url: '', role, file_name: file.name, cacheId, thumbnailUrl });
        } catch (err: any) { warn(`이미지 처리 실패: ${err.message || ''}`); }
      }
      return;
    }

    const mode = project.settings.mode;
    if (mode === 'text_to_video') { warn('Text to Video 모드에서는 이미지를 첨부할 수 없습니다.'); return; }
    if (mode === 'extend_video' && modeRefCaps(project.settings.model, mode).image === 0) { warn('이 모델의 Extend Video 모드에서는 이미지를 첨부할 수 없습니다.\n(비디오만 사용하는 모드입니다)'); return; }

    for (const raw of imageFiles) {
      // 클립보드 이미지는 전부 image.png라는 이름으로 들어옴 → 구분 가능한 이름 부여
      const ext = (raw.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
      const file = new File([raw], `clipboard-${stamp}-${Math.random().toString(36).slice(2, 5)}.${ext}`, { type: raw.type });

      const sizeErr = validateImageFile(file);
      if (sizeErr) { warn(sizeErr); continue; }
      const dimErr = await validateImageDimensions(file);
      if (dimErr) { warn(dimErr); continue; }

      // 비동기 검증 사이에 상태가 변했을 수 있으니 매번 fresh 조회
      const assets = useAppStore.getState().projects.find(p => p.id === project.id)?.assets || [];

      try {
        if (mode === 'image_to_video_first') {
          // 슬롯 1개 — 있으면 교체 (id 보존 → 멘션 핀 유지), 없으면 추가
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          const existing = assets.find(a => a.role === 'first_frame');
          if (existing) {
            useAppStore.getState().replaceAsset(project.id, existing.id, { url: '', file_name: file.name, cacheId, thumbnailUrl });
          } else {
            addAsset(project.id, { type: 'image_url', url: '', role: 'first_frame', file_name: file.name, cacheId, thumbnailUrl });
          }
        } else if (mode === 'image_to_video_first_last') {
          // 빈 슬롯부터 채우고(first → last), 둘 다 차면 first → last → first …
          // 순서로 번갈아 교체. 교체 사이클은 항상 first부터 시작한다.
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          const first = assets.find(a => a.role === 'first_frame');
          const last = assets.find(a => a.role === 'last_frame');
          if (!first) {
            addAsset(project.id, { type: 'image_url', url: '', role: 'first_frame', file_name: file.name, cacheId, thumbnailUrl });
            pasteCycleRef.current = null; // 슬롯 구성 변경 → 사이클 리셋
          } else if (!last) {
            addAsset(project.id, { type: 'image_url', url: '', role: 'last_frame', file_name: file.name, cacheId, thumbnailUrl });
            pasteCycleRef.current = null;
          } else {
            const cycle = pasteCycleRef.current;
            // 마지막 붙여넣기 이후 슬롯이 바뀌었으면(피커로 채움, 재추가 등)
            // 이어가지 않고 first부터 새로 시작
            const stale = !cycle || cycle.firstId !== first.id || cycle.lastId !== last.id;
            const targetRole = stale ? 'first_frame' : cycle.next;
            const target = targetRole === 'first_frame' ? first : last;
            useAppStore.getState().replaceAsset(project.id, target.id, { url: '', file_name: file.name, cacheId, thumbnailUrl });
            pasteCycleRef.current = { firstId: first.id, lastId: last.id, next: targetRole === 'first_frame' ? 'last_frame' : 'first_frame' };
          }
        } else {
          // multimodal_reference / edit_video / (2.5) extend_video — 레퍼런스 이미지는 모델 · 모드별 상한, 초과 시 기존 유지
          const imgCount = assets.filter(a => a.type === 'image_url').length;
          const pasteCap = mode === 'extend_video' ? modeRefCaps(project.settings.model, mode).image : modelImageMax(project.settings.model);
          if (imgCount >= pasteCap) {
            warn(`이미지는 최대 ${pasteCap}장까지만 첨부할 수 있습니다.\n기존 이미지는 그대로 유지됩니다.`);
            break;
          }
          const thumbnailUrl = await createThumbnail(file);
          const cacheId = await cacheFile(file);
          addAsset(project.id, { type: 'image_url', url: '', role: 'reference_image', file_name: file.name, cacheId, thumbnailUrl });
        }
      } catch (err: any) {
        warn(`클립보드 이미지 처리 실패: ${err?.message || ''}`);
      }
    }
  };

  const processFrameFile = async (file: File, role: AssetRole) => {
    if (!file.type.startsWith('image/')) { warn('이미지 파일만 업로드할 수 있습니다.'); return; }
    const sizeErr = validateImageFile(file);
    if (sizeErr) { warn(sizeErr); return; }
    try {
      const dimErr = await validateImageDimensions(file);
      if (dimErr) { warn(dimErr); return; }
      const thumbnailUrl = await createThumbnail(file);
      const originalPath = getFilePath(file);
      // Attach → media-cache only (R2 upload deferred to send time)
      const cacheId = await cacheFile(file);
      addAsset(project.id, { type: 'image_url', url: '', role, file_name: file.name, cacheId, thumbnailUrl, ...(originalPath ? { originalPath } : {}) });
    } catch (e) { warn(`이미지 캐싱 실패: ${file.name}`); }
  };
  const handleFrameUpload = (e: React.ChangeEvent<HTMLInputElement>, role: AssetRole) => { const f = e.target.files?.[0]; if (f) processFrameFile(f, role); e.target.value = ''; };
  const handleFrameDrop = (e: React.DragEvent<HTMLInputElement>, role: AssetRole) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); dragCounter.current = 0; const f = e.dataTransfer.files?.[0]; if (f) processFrameFile(f, role); };

  const handlePromptResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = promptHeight;
    const onMove = (ev: MouseEvent) => {
      const next = startH + (startY - ev.clientY); // drag up → grow
      const clamped = Math.max(44, Math.min(window.innerHeight * 0.7, next));
      setPromptHeight(clamped);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (mentionState.active && filteredMentionAssets.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndexRef.current = (mentionIndexRef.current + 1) % filteredMentionAssets.length; highlightMentionItem(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndexRef.current = (mentionIndexRef.current - 1 + filteredMentionAssets.length) % filteredMentionAssets.length; highlightMentionItem(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insertMention(filteredMentionAssets[mentionIndexRef.current]); return; }
      if (e.key === 'Escape') { setMentionState(s => ({ ...s, active: false })); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  // 카드의 설정 · 레퍼런스 · 프롬프트를 '되살린 값' 으로 만든다 — 어디에도 쓰지 않는다(26.10.2002~ handleReuse 에서 떼어 냄).
  // 화면의 재사용 · 재생성 · 받은 영상 불러오기는 handleReuse 가 이 값을 작성 칸에 넣고, 에이전트의 card.regenerate 는 작성 칸을
  // 건드리지 않고 이 값 그대로 sendRequest 로 보낸다. pid: 되살릴 프로젝트(지금 해상도 · 연결된 컬렉션을 거기서 읽는다).
  // 레퍼런스의 새 id 는 여기서 주고 알약도 그 id 로 묶는다 — handleReuse 는 준 id 를 지키는 replaceAllAssets 로 넣는다.
  // opts.fromFile(26.10.801~): 끌어다 놓은 받은 영상에서 온 메시지 — 다른 PC 것일 수 있다. 어셋 멘션을 id 대신
  // 이름으로도 찾고(그때 컬렉션 opts.collectionId 의 것을 먼저), 이 PC 에 없는 어셋은 지우지 않고 '@이름' 글자로 남긴다.
  // opts.report: 받은 영상에서 불러올 때 — 결과를 토스트 대신 작성 칸 위 안내에 모은다.
  type Reused = { settings?: Partial<GenerationSettings>; assets?: Asset[]; html?: string; assetsOk: boolean };
  const prepareReuse = async (msg: any, pid: string, opts: { fromFile?: boolean; report?: ReportSink; collectionId?: string; warn: (m: string) => void }): Promise<Reused> => {
    const out: Reused = { assetsOk: true };
    const report = opts.report;
    const warn = opts.warn;
    const say = (m: string) => { if (report) report.missing.push(m); else warn(m); };
    // Returns false if any reference asset could not be restored (already alerted).
    // 재사용 ignores the return; 재생성 uses it to abort before sending.
    let assetsOk = true;
    // 카드의 레퍼런스 이름(Image 2 …) → 되살린 레퍼런스. 하나라도 못 되살리면 뒤 번호가 당겨진다(Image 3 이 Image 2 가 된다).
    // 그래서 알약을 이름이 아니라 이 표로 묶는다 — 예전에는 이름으로 묶어서 [Image 2] 알약이 원래의 Image 3 을 가리켰고
    // 빠진 것도 모른 채 다른 그림으로 보냈다(26.10.801 고침). 못 되살린 레퍼런스의 알약은 '[빠진 레퍼런스: 이름]' 글자가 된다.
    const pillMap = new Map<string, { ok: true; index: number } | { ok: false; label: string }>();
    // Past messages keep the model they were generated on, and one of those (the 2.5 demo)
    // no longer exists. Reusing such a card would restore a dead id into the live settings
    // and the send would 400 — map it forward here, the same way hydration does for the
    // project's own settings.
    if (msg.usedSettings) {
      const targetModel = msg.usedSettings.model ? resolveModelId(msg.usedSettings.model) : undefined;
      // 초안 카드의 480p 는 사용자가 고른 값이 아니라 초안이 강제한 값이다. 그대로 되살리면
      // 나중에 초안을 껐을 때 해상도가 480p 로 남는다 — "끄면 쓰던 해상도로 돌아온다" 가
      // 깨진다. 그래서 초안 카드는 해상도만 빼고 되살린다(초안 모드 자체는 켜진다).
      // 지금 해상도가 그 모델에 없는 값이면(2.0 의 4K → 2.5) 모델 기본값으로 둔다.
      let restore: any = msg.usedSettings;
      if (msg.usedSettings.draft) {
        const { resolution: _forced, ...rest } = msg.usedSettings;
        const cur = useAppStore.getState().projects.find(p => p.id === pid)?.settings.resolution;
        const m: string = targetModel || msg.usedSettings.model || '';
        restore = { ...rest, resolution: cur && modelResolutions(m).includes(cur) ? cur : (MODELS.find(x => x.id === m)?.defaults?.resolution || '720p') };
      }
      out.settings = {
        ...restore,
        ...(targetModel ? { model: targetModel } : {}),
        // Draft 는 그 카드가 실제로 어땠는지를 true/false 로 못 박는다. 2.5 는 Draft 가 기본이라,
        // 값을 비워 두면 Draft 이전에 1080p 로 만든 카드를 재생성해도 480p Draft 가 나간다.
        draft: !!msg.usedSettings.draft,
      };
      if (report && targetModel && msg.usedSettings.model && targetModel !== msg.usedSettings.model) {
        report.missing.push(`그때 모델은 없어져서 ${MODELS.find(m => m.id === targetModel)?.name || targetModel} 로 바꿨어요`);
      }
    }
    if (msg.usedAssets) {
      // Build the full restored list FIRST, then commit in one atomic store call.
      // Old approach (clearAssets + N×addAsset across awaits) could interleave
      // with re-renders or any double-invocation pattern and produce duplicates.
      const restored: any[] = [];
      const failures: string[] = [];
      const failedNames: string[] = [];   // 안내(report)에는 이름만
      const oldNamed = getAssetNames(msg.usedAssets);
      for (const [i, a] of (msg.usedAssets as any[]).entries()) {
        const label = a.file_name || a.type.replace('_url', '');
        const oldName = oldNamed[i]?.name;
        const before = restored.length;
        // strip snapshot id — replaceAllAssets assigns fresh ones
        const { id, ...rest } = a;
        let recovered = false;

        // Reuse must NOT trigger R2 upload — that's send-time territory. Only
        // verify the asset is reachable (cache hit, or disk re-cache via
        // originalPath) so the next send finds it. Keep url cleared so the
        // send loop unconditionally re-uploads to R2 with a fresh per-task key.
        if (a.cacheId) {
          // Confirm cache is still present; cheap HEAD via cache fetch (404 → fall through)
          try {
            const probe = await fetch(`/api/cache/${a.cacheId}`, { method: 'GET' });
            if (probe.ok) {
              probe.body?.cancel?.(); // don't hold the bytes in memory
              restored.push({ ...rest, url: '' });
              recovered = true;
            }
          } catch { /* fall through to originalPath */ }
        }
        if (!recovered && a.originalPath) {
          try {
            // Disk fallback: re-cache the file (NOT R2) so the next send hits cache.
            // 첨부 때의 cacheId 를 함께 보내 '그 파일이 맞는지' 확인한다. 같은 이름으로
            // 수정본을 덮어썼다면 서버가 거절한다 — 이 카드를 만든 버전이 아니므로 대신
            // 넣지 않고 빠뜨린 채 알린다(재생성은 여기서 멈춘다).
            const cacheId = await cacheFromPath(a.originalPath, a.cacheId);
            restored.push({ ...rest, url: '', cacheId });
            recovered = true;
          } catch (err: any) {
            if (err instanceof SourceChangedError) {
              failures.push(`${label} — 이 카드를 만든 뒤 같은 이름으로 수정됨 (그때 버전은 캐시가 지워져 되살릴 수 없음)`);
            } else {
              const m = (err?.message || '').replace(/^Error:\s*/, '');
              failures.push(`${label}${m ? ' — ' + m : ''}`);
            }
          }
        }

        if (!recovered && !a.originalPath && !a.cacheId) {
          failures.push(`${label}: 캐시 없음 + 원본 경로 정보 없음 (구버전에서 첨부됨)`);
        } else if (!recovered && a.originalPath) {
          // catch above already pushed the failure
        } else if (!recovered) {
          failures.push(opts?.fromFile ? `${label}: 이 PC 에 원본이 없음` : `${label}: 복원 실패`);
        }
        if (oldName) pillMap.set(oldName, recovered ? { ok: true, index: before } : { ok: false, label });
        if (!recovered) failedNames.push(label);
      }
      out.assets = restored.map(x => ({ ...x, id: crypto.randomUUID() }));
      if (failures.length > 0) {
        assetsOk = false;
        say(report ? `레퍼런스 원본 없음: ${failedNames.join(', ')}`
          : `일부 래퍼런스 복원 실패:\n\n${failures.join('\n')}\n\n파일을 다시 첨부해주세요.`);
      }
    }
    if (msg.promptHtml || msg.promptText) {
      // 화면 밖(box)에서 짓고 마지막에 넣는다 — 위의 기다림(캐시 확인 · 원본 다시 읽기) 사이에 사용자가 다른 채팅으로 옮겼으면 그 채팅
      // 작성 칸이 아니라 이 채팅의 작성 중 글(draftPrompt)로 들어가야 한다(26.10.801 검토).
      const box = document.createElement('div');
      // Prefer the exact innerHTML snapshot — it carries element-library mention
      // pills too, which resolve to bare names in promptText and can't be rebuilt
      // from it. Fall back to text→pill reconstruction for pre-promptHtml messages
      // (those still lose element mentions — unavoidable, the data isn't there).
      box.innerHTML = msg.promptHtml
        ? msg.promptHtml
        : textToHtml(msg.promptText, getAssetNames(msg.usedAssets || []));
      // Panel pills: re-bind data-asset-id — replaceAllAssets just gave the restored assets
      // fresh ids, so the snapshot's ids are stale. 되살린 순서(pillMap)로 묶고, 번호가 당겨졌으면 알약 글자도 지금 이름으로.
      const freshAssets = getAssetNames(out.assets || useAppStore.getState().projects.find(p => p.id === pid)?.assets || []);
      box.querySelectorAll('.mention-pill').forEach(pill => {
        const name = pill.getAttribute('data-name') || '';
        const hit = pillMap.get(name);
        if (hit && hit.ok === false) { pill.replaceWith(document.createTextNode(`[빠진 레퍼런스: ${hit.label}]`)); return; }
        const match = hit && hit.ok === true ? freshAssets[hit.index] : freshAssets.find(a => a.name === name);
        if (!match) { pill.removeAttribute('data-asset-id'); return; }
        pill.setAttribute('data-asset-id', match.id);
        if (match.name !== name) {
          pill.setAttribute('data-name', match.name);
          const label = [...pill.querySelectorAll('span')].reverse().find(s => /^\[.*\]$/.test(s.textContent || ''));
          if (label) label.textContent = `[${match.name}]`;
        }
      });
      // Element pills: validate against the live (global) library. Drop pills whose
      // element was deleted; refresh name + thumbnail for the rest so a renamed or
      // re-imaged asset shows current state and the next send merges its images.
      // 파일에서 온 설정(다른 PC 일 수 있다)은 id 가 이 PC 와 다르다 — 같은 이름(멘션 규칙 mentionKey)의 어셋으로 묶고,
      // 없으면 지우지 않고 '@이름' 글자로 남긴다.
      const droppedElements: string[] = [];
      const missingByName: string[] = [];
      const changedEls: string[] = [];
      const elNames = new Set<string>();
      box.querySelectorAll('.element-pill').forEach(pill => {
        const id = pill.getAttribute('data-element-id');
        const nm = pill.getAttribute('data-name') || '';
        elNames.add(mentionKey(nm));
        const lib = useAppStore.getState().elementAssets;
        let el = id ? lib.find(e => e.id === id) : null;
        // 받은 영상에서 불러올 때(파일 · 안내)는 '그때 그대로' 를 최대한 — 같은 이름의 어셋으로도 묶고, 없으면 지우지 않고 '@이름' 글자로.
        const keep = !!(opts?.fromFile || report);
        const once = (list: string[]) => { if (!list.some(x => mentionKey(x) === mentionKey(nm))) list.push(nm || '(이름 없음)'); };
        if (!el && keep && nm) el = findElementByName(nm, [opts?.collectionId, useAppStore.getState().projectCollectionId[pid]]);
        if (!el && keep) { once(missingByName); pill.replaceWith(document.createTextNode(`@${nm}`)); return; }
        if (!el) { once(droppedElements); pill.remove(); return; }
        if (report && elementImagesChanged(msg, el, id, nm) && !changedEls.includes(el.name)) changedEls.push(el.name);
        pill.setAttribute('data-element-id', el.id);
        pill.setAttribute('data-name', el.name);
        const textSpan = pill.querySelector('span[data-el-text]');
        if (textSpan) textSpan.textContent = `[${el.name}]`;
        const img = pill.querySelector('img') as HTMLImageElement | null;
        const newSrc = el.images[0]?.thumbnailUrl || el.images[0]?.url || '';
        if (img && newSrc) img.setAttribute('src', newSrc);
      });
      // A mentioned element that was deleted from the library can't be merged →
      // the regenerated video would silently lose that subject. Flag it (assetsOk
      // = false aborts 재생성) and tell the user, mirroring the panel-asset case.
      if (droppedElements.length > 0) {
        assetsOk = false;
        warn(`멘션한 어셋이 삭제되어 빠졌습니다:\n\n${droppedElements.join(', ')}\n\n어셋 라이브러리에서 복구하거나, 프롬프트에서 해당 멘션을 지운 뒤 다시 시도해주세요.`);
      }
      if (missingByName.length > 0) {
        assetsOk = false;
        say(report ? `라이브러리에 없는 어셋: ${missingByName.map(n => '@' + n).join(', ')}`
          : `이 PC 어셋 라이브러리에 없는 어셋이라 이름만 글자로 남겼어요:\n\n${missingByName.join(', ')}\n\n어셋을 넣은 뒤 @로 다시 멘션해 주세요.`);
      }
      if (changedEls.length) say(`그때와 그림이 다른 어셋(지금 그림으로 보내요): ${changedEls.map(n => '@' + n).join(', ')}`);
      out.html = box.innerHTML;
    }
    out.assetsOk = assetsOk;
    return out;
  };

  // 되살린 값을 그 프로젝트의 작성 칸 · 설정 · 레퍼런스에 넣는다.
  const applyReuse = (pid: string, r: Reused) => {
    if (r.settings) useAppStore.getState().updateProjectSettings(pid, r.settings);
    if (r.assets) useAppStore.getState().replaceAllAssets(pid, r.assets);   // 알약이 묶인 그 id 그대로
    if (r.html !== undefined) putPromptHtml(pid, r.html);
  };
  // 카드의 설정을 이 칸의 작성 칸 · 설정 · 레퍼런스에 넣는다(재사용 · 받은 영상 불러오기).
  // Returns false if any reference asset could not be restored (already alerted).
  const handleReuse = async (msg: any, opts?: { fromFile?: boolean; report?: ReportSink; collectionId?: string }): Promise<boolean> => {
    const pid = project.id;
    const r = await prepareReuse(msg, pid, { ...opts, warn: warnFor(pid) });
    applyReuse(pid, r);
    if (showGallery) exitGallery();
    setPreviewItem(null);
    return r.assetsOk;
  };

  /* ─── Send ─── */
  // 이 칸의 작성 칸 · 설정 · 레퍼런스로 보낸다. 실제 일은 sendRequest(src/lib/send-request.ts) — 에이전트 작업함도 같은 함수다.
  // Read the project FRESH from the store rather than the render closure: 재생성
  // calls handleReuse() (which mutates settings + assets) and then handleSend()
  // in the SAME tick, before React re-renders — so the closure's `project` would
  // be stale and we'd send the OLD setup. getState() guarantees the just-restored
  // setup is what gets sent. For a normal send this is identical to the closure.
  // 만든 카드 id 를 돌려준다. 멈춘 경우는 undefined.
  // '보내는 중' 은 스토어에서 바로 묻는다(렌더 값이 아니라) — 같은 틱의 두 번째 Enter · 다른 칸에서 같은 프로젝트를 보내는 것도 막는다.
  const handleSend = async (): Promise<string[] | undefined> => {
    const editor = contentEditableRef.current;
    if (!editor) return;
    const project = useAppStore.getState().projects.find(p => p.id === currentProjectId);
    if (!project || sendingNow(project.id)) return;
    const pid = project.id;
    const lock = sendLock(pid);
    try {
      return await sendRequest(
        { projectId: pid, promptHtml: editor.innerHTML, settings: project.settings, assets: project.assets, writeBack4k: true },
        { warn: warnFor(pid), busy: lock.busy, sent: () => { if (paneProjectRef.current === pid) setTimeout(() => scrollToBottom(), 150); } },
      );
    } finally { window.setTimeout(lock.release, 1500); }
  };

  /* ─── 에이전트 작업함: 받아서 보내기 (26.10.302~ · 26.10.2002~ 화면을 바꾸지 않고 지정한 프로젝트로) ─── */
  // 같은 PC 의 에이전트(freewill 커넥터의 send-to-seedance)가 server.ts 작업함에 넣은 요청을, 사람이 전송 버튼을
  // 누르는 것과 같은 함수(attachFilesTo → sendRequest, src/lib/send-request.ts)로 보낸다. 생성 중 카드 · 권한 검사 ·
  // 트래커 보고 · NCP 보관 · 폴링이 전부 평소대로다.
  // 26.10.2002~ 작성 칸을 빌리지 않는다. 요청이 가리킨 프로젝트(projectId 또는 정확한 이름)의 설정 위에 요청의 설정을
  // 메모리에서 얹고, 레퍼런스도 메모리에 붙여 바로 보낸다 — 사용자의 열린 프로젝트 · 작성 칸 · 설정 · 레퍼런스 칸이 그대로고,
  // 입력 중 · 생성 중 · 갤러리 화면이어도 받는다. 카드는 그 프로젝트에 생기고(사이드바 스피너 · 완료 배지), 토스트로 알린다.
  // 지키는 것:
  //   · 대상이 애매하면 보내지 않는다 — 같은 이름이 둘이면 후보를, 못 찾으면 이유를 돌려준다(agentResolveProject).
  //   · 과금은 앱의 프로젝트 코드(공동 코드, 26.10.2004~)다. 코드가 없으면 서버가 작업을 내주지 않고 기다리게 한다(사람이 고를
  //     때까지, 10분). 요청에 적힌 코드(billing)와 다르면 보내지 않는다 — 과금은 사람이 정한다. 가져갈 때 본 코드를 sendRequest 가
  //     요청을 띄우기 직전에 다시 비교한다(그 사이 사람이 바꾸거나 60초 확인이 비우면 보내지 않음).
  //   · 레퍼런스를 하나라도 못 붙이면 보내지 않는다 — 빠진 채로 나가면 다른 영상이 되고 값은 똑같이 낸다.
  //   · 진행은 카드(스토어 메시지)에서 읽어 올린다. /api/byteplus/tasks/:id 를 따로 부르지 않는다(server.ts 주석).
  const agentFail = (job: any, error: string, projectName?: string) => {
    showToast(`${projectName ? `[${projectName}] ` : ''}에이전트 요청을 보내지 않았어요 — ${error.split('\n')[0]}`, false);
    void agentReport(job.id, { status: 'failed', error, ...(projectName ? { project: projectName } : {}) });
  };

  // 경로의 파일을 화면으로 가져온다. 서버가 디스크에서 읽어 미디어 캐시에 넣고(cache-from-path — 재사용이 쓰는 그 길),
  // 화면은 그 바이트로 File 을 만든다. 캐시 id 는 내용 md5 라 attachFilesTo 가 다시 올리지 않고 그대로 쓴다.
  const agentFileFromPath = async (p: string): Promise<{ file: File; cacheId: string }> => {
    const cacheId = await withTimeout(cacheFromPath(p), 180000, '파일 읽기');
    const res = await withTimeout(fetch(`/api/cache/${cacheId}`), 180000, '캐시 읽기');
    if (!res.ok) throw new Error(`캐시를 읽지 못했습니다 (${res.status})`);
    const name = p.split(/[\\/]/).pop() || 'file';
    const ext = (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
    return { file: new File([await res.blob()], name, { type: AGENT_MIME[ext] || '' }), cacheId };
  };

  // 프롬프트의 @{이름} → 그 프로젝트에 연결된 컬렉션의 엘리먼트 알약(화면에서 @ 멘션한 것과 같은 모양).
  // 보낼 때 앱이 그 엘리먼트 이미지를 레퍼런스로 붙이고 [Image N] 으로 바꾼다(sendRequest 의 엘리먼트 멘션).
  const agentElementPill = (pid: string) => {
    const st = useAppStore.getState();
    const cid = st.projectCollectionId[pid];
    const els = cid ? st.elementAssets.filter(e => e.collectionId === cid) : [];
    return (name: string) => {
      const e = els.find(x => mentionKey(x.name) === mentionKey(name));
      if (!e) return null;
      return buildMentionPill({ kind: 'element', id: e.id, name: e.name, category: e.category,
        thumbnailUrl: e.images[0]?.thumbnailUrl || e.images[0]?.url || '' }).outerHTML;
    };
  };

  // 서버 작업함에서 프로젝트 코드를 기다리는 작업 수(대상 프로젝트별) — 설정 패널이 알리고, 늘어나면 토스트로 한 번.
  const agentNoteWaiting = (w: unknown) => {
    if (w === undefined) return;   // 명령만 준 답(서버가 명령을 먼저 준다)에는 없다 — 지난 값을 그대로 둔다
    const m: Record<string, number> = {};
    if (w && typeof w === 'object') for (const [k, v] of Object.entries(w as Record<string, unknown>)) if (typeof v === 'number' && v > 0) m[k] = v;
    useAppStore.getState().setAgentWaitingBilling(m);
    const grew = Object.keys(m).filter(k => m[k] > (agentWaitingPrev[k] || 0));
    agentWaitingPrev = m;
    if (!grew.length) return;
    const st = useAppStore.getState();
    const names = grew.map(k => st.projects.find(p => p.id === k)?.name || '(알 수 없는 프로젝트)');
    showToast(`[${names.join(', ')}] 에이전트 요청이 프로젝트 코드를 기다려요 — 설정 패널 맨 위 "프로젝트 코드" 를 골라 주세요`, false);
  };

  const agentProcess = async (job: any) => {
    let target: ReturnType<typeof agentResolveProject>;
    try { target = agentResolveProject(job.projectId, job.project); }
    catch (e: any) { return agentFail(job, e?.message || String(e)); }
    const fail = (error: string) => agentFail(job, error, target.name);
    // 과금 — 앱의 프로젝트 코드(공동 코드). 코드가 없으면 서버가 작업을 내주지 않는다(claim) — 여기 온 건 그 사이 코드가 비워진 경우다.
    const bill = projectBilling(useAppStore.getState(), target.id);
    if (!bill) return fail('시댄스의 프로젝트 코드가 골라져 있지 않습니다 — 사람에게 앱 설정 패널 맨 위 "프로젝트 코드" 를 골라 달라고 한 뒤 다시 보내 주세요.');
    if (job.billing && job.billing !== bill.project.trim()) {
      return fail(`시댄스의 프로젝트 코드는 "${bill.project}" 입니다(요청: "${job.billing}"). 과금은 사람이 정합니다 — 이 코드로 보낼지, 앱에서 코드를 바꿀지 사람에게 확인한 뒤 다시 보내 주세요.`);
    }
    const plan = agentSettings(target.settings, job.settings && typeof job.settings === 'object' ? job.settings : {});
    if (!plan.next) return fail(plan.error || '설정을 읽지 못했습니다');
    const next = plan.next;
    const omni = modelProvider(next.model) === 'gemini';
    // 첫·끝 프레임은 role 로 순서를 정한다. 나머지는 받은 순서 그대로 — 프롬프트의 [Image N] 번호가 이 순서다.
    const rank = (r?: string) => (r === 'first_frame' ? 0 : r === 'last_frame' ? 1 : 2);
    const refs = (Array.isArray(job.refs) ? job.refs : [])
      .map((r: any, i: number) => ({ path: String(r?.path || ''), role: typeof r?.role === 'string' ? r.role : undefined, i }))
      .sort((a: any, b: any) => rank(a.role) - rank(b.role) || a.i - b.i);
    if (refs.length && !omni && next.mode === 'text_to_video') return fail('Text to Video 모드에서는 래퍼런스 파일을 사용하지 않습니다.');

    // 레퍼런스는 메모리에 붙인다(attachFilesTo 의 검사 그대로) — 그 프로젝트의 레퍼런스 칸에는 아무것도 생기지 않는다.
    const sink = memoryAssetSink(next);
    try {
      const files: File[] = [];
      const given = new Map<File, { path: string; cacheId: string }>();
      for (const r of refs) {
        try {
          const got = await agentFileFromPath(r.path);
          files.push(got.file);
          given.set(got.file, { path: r.path, cacheId: got.cacheId });
        } catch (e: any) { throw new Error(`레퍼런스를 읽지 못했습니다: ${r.path}\n${e?.message || e}`); }
      }
      const rejected = await attachFilesTo(sink, files, f => given.get(f));
      if (rejected.length) throw new Error(`레퍼런스를 붙이지 못했습니다:\n${rejected.join('\n')}`);
    } catch (e: any) { return fail(e?.message || String(e)); }
    const missing: string[] = [];
    const html = agentPromptHtml(String(job.prompt || ''), getAssetNames(sink.list), agentElementPill(target.id), missing);
    if (missing.length) {
      const st2 = useAppStore.getState();
      const bound = st2.assetCollections.find(c => c.id === st2.projectCollectionId[target.id])?.name;
      return fail(`엘리먼트를 찾지 못했습니다: ${missing.join(', ')}\n(이 프로젝트에 연결된 컬렉션: ${bound ? `"${bound}"` : '없음'} — collections.list · collection.bind)`);
    }
    const warnings: string[] = [];
    let ids: string[] | undefined;
    try {
      ids = await sendRequest(
        { projectId: target.id, promptHtml: html, settings: next, assets: sink.list, expectBillingKey: bill.key },
        { warn: m => { warnings.push(m); } },
      );
    } catch (e: any) { return fail(e?.message || String(e)); }
    if (!ids?.length) return fail(warnings.join('\n') || '앱이 보내지 않았습니다.');
    agentActive.set(job.id, { projectId: target.id, ids, last: '' });
    showToast(`[${target.name}] 에이전트 요청을 보냈어요 — 카드 ${ids.length}개${job.name ? ` (${job.name})` : ''}`, true);
    void agentReport(job.id, { status: 'sent', project: target.name, projectId: target.id, messages: agentCards(target.id, ids), ...(warnings.length ? { warnings } : {}) });
  };

  /* ─── 에이전트 명령 (26.10.305~) ─── */
  // 설명서의 AGENT_COMMANDS(src/lib/agent-inbox.ts)와 짝 — 이름이 같아야 한다. 앱 버튼이 부르는 것과 같은 스토어 함수 ·
  // 화면 함수로 실행한다. 지우기와 과금 프로젝트 고르기는 없다(사용자 결정 2026-10-03 — 사람이 앱에서).
  const agentCmdReport = (id: string, body: Record<string, unknown>) => { void agentReportSure('commands', id, body); };

  const agentFindCollection = (ref: unknown) => {
    const st = useAppStore.getState();
    const s = String(ref ?? '').trim();
    if (!s) throw new Error('collection 이 비었습니다');
    const c = st.assetCollections.find(x => x.id === s) || st.assetCollections.find(x => mentionKey(x.name) === mentionKey(s));
    if (!c) throw new Error(`컬렉션을 찾지 못했습니다: ${s}\n(있는 컬렉션: ${st.assetCollections.map(x => x.name).join(', ') || '없음'})`);
    return c;
  };
  const agentFindCard = (ref: unknown) => {
    const s = String(ref ?? '');
    for (const p of useAppStore.getState().projects) {
      const m = p.messages.find(x => x.id === s);
      if (m) return { project: p, card: m as any };
    }
    throw new Error(`카드를 찾지 못했습니다: ${s} (cards.list 의 id)`);
  };
  const agentCardView = (m: any, projectName?: string) => {
    const us = m.usedSettings || {};
    return {
      id: m.id, status: m.status || 'queued', created: m.timestamp,
      ...(projectName ? { project: projectName } : {}),
      prompt: String(m.promptText || '').slice(0, 600),
      settings: m.usedSettings ? { model: us.model, mode: us.mode, ...(modelProvider(us.model || '') === 'gemini' ? { omniTask: us.omniTask } : {}),
        ratio: us.ratio, duration: us.duration, resolution: us.resolution, draft: !!us.draft } : null,
      draft: !!us.draft, ...(m.draftOf ? { finalOf: m.draftOf } : {}),
      starred: !!m.starred,
      ...(m.taskId ? { taskId: m.taskId } : {}),
      ...(m.videoUrl ? { videoUrl: m.videoUrl } : {}),
      ...(m.downloadedPath ? { downloadedPath: m.downloadedPath } : {}),
      ...(m.error ? { error: String(m.error).slice(0, 500) } : {}),
    };
  };
  // 경로의 이미지들 → 엘리먼트 이미지(화면 등록과 같은 검사 · 썸네일 · 원본 보관, fileToElementImage).
  const agentElementImages = async (paths: unknown) => {
    const list = Array.isArray(paths) ? paths.map(String) : [];
    const out = [];
    for (const p of list) {
      const { file } = await agentFileFromPath(p);
      try { out.push(await fileToElementImage(file)); }
      catch (e: any) { throw new Error(`${p}: ${e?.message || e}`); }
    }
    return out;
  };

  const agentCommands: Record<string, (a: any) => Promise<unknown>> = {
    'projects.list': async () => {
      const st = useAppStore.getState();
      const groupName = (gid?: string) => st.projectGroups.find(g => g.id === gid)?.name ?? null;
      const collName = (cid?: string) => st.assetCollections.find(c => c.id === cid)?.name ?? null;
      const shown = new Set(visibleProjectIds(st));
      return {
        current: st.projects.find(p => p.id === st.currentProjectId)?.name ?? null,
        features: AGENT_FEATURES,
        projects: st.projects.map(p => {
          // 그 프로젝트로 보낼 때의 코드 · 권한(26.10.2004~ 공동 코드라 모두 같다 — 커넥터가 프로젝트마다 읽는 모양은 그대로 둔다).
          const b = projectBilling(st, p.id);
          const bo = billingOf(st, p.id);
          return {
            id: p.id, name: p.name, group: groupName(p.groupId),
            cards: p.messages.filter(m => m.role !== 'user').length,
            collection: collName(st.projectCollectionId[p.id]), current: p.id === st.currentProjectId, shown: shown.has(p.id),
            billing: b ? { name: b.project, id: b.id || null } : null,
            ...(b ? { allowedModels: MODELS.filter(m => isModelAllowed(m.id, bo)).map(m => m.id), fourK: isFourKAllowed(bo) } : {}),
          };
        }),
      };
    },
    'project.open': async (a) => {
      const p = agentResolveProject(a.projectId, a.project, '열 프로젝트');
      useAppStore.getState().setCurrentProjectId(p.id);
      return { project: p.name };
    },
    'project.create': async (a) => {
      const name = String(a.name || '').trim();
      if (!name) throw new Error('name 이 비었습니다');
      const st = useAppStore.getState();
      let gid: string | undefined;
      if (a.group) {
        const g = st.projectGroups.find(x => x.id === a.group || mentionKey(x.name) === mentionKey(String(a.group)));
        if (!g) throw new Error(`그룹을 찾지 못했습니다: ${a.group}\n(있는 그룹: ${st.projectGroups.map(x => x.name).join(', ') || '없음'})`);
        gid = g.id;
      }
      // open:false(26.10.2002~) — 만들기만 하고 열지 않는다(화면 · 접힌 그룹 그대로). 안 주면 예전처럼 연다.
      const open = a.open !== false;
      const madeId = st.createProject(gid, { open });
      const made = useAppStore.getState().projects.find(p => p.id === madeId);
      if (!made) throw new Error('프로젝트를 만들지 못했습니다');
      useAppStore.getState().renameProject(made.id, name);
      const final = useAppStore.getState().projects.find(p => p.id === made.id);
      return { id: made.id, name: final?.name ?? name, opened: open };
    },
    'billing.list': async (a) => {
      const st = useAppStore.getState();
      // 프로젝트 코드(공동 코드) — project · projectId 를 주면 그 이름을 같이 돌려준다(코드는 프로젝트와 상관없이 같다).
      const of = a.project || a.projectId ? agentResolveProject(a.projectId, a.project) : st.projects.find(p => p.id === st.currentProjectId);
      const sel = projectBilling(st, of?.id ?? null);
      // 크레딧 대시보드의 숫자(영상 수 · 토큰)는 트래커가 준다 — 앱 서버가 이미 받아 오는 목록을 그대로 읽는다.
      let usage: any[] = [];
      try {
        const r = await fetch('/api/projects');
        const j = await r.json();
        if (j?.ok && Array.isArray(j.projects)) usage = j.projects;
      } catch { /* 숫자만 빠진다 */ }
      return {
        project: of?.name ?? null,
        selected: sel?.project ?? null,
        projects: st.billingProjects.map(b => {
          const u = usage.find(x => (b.id && String(x.id || x.project_id || '') === b.id) || x.project === b.project) || {};
          return { name: b.project, status: b.status, videos: u.videoCount ?? null, tokens: u.tokens ?? null,
            allow25: !!b.allow25, allow4k: !!b.allow4k, selected: !!sel && sel.key === b.key };
        }),
        note: '프로젝트 코드(과금)는 앱 전체에 하나고, 고르는 건 사람이 앱 설정 패널 맨 위 "프로젝트 코드" 에서 한다',
      };
    },
    'collections.list': async () => {
      const st = useAppStore.getState();
      return st.assetCollections.map(c => ({
        id: c.id, name: c.name,
        boundTo: st.projects.filter(p => st.projectCollectionId[p.id] === c.id).map(p => p.name),
        elements: st.elementAssets.filter(e => e.collectionId === c.id)
          .map(e => ({ id: e.id, name: e.name, category: e.category, description: e.description, images: e.images.length })),
      }));
    },
    'collection.create': async (a) => {
      const name = String(a.name || '').trim();
      if (!name) throw new Error('name 이 비었습니다');
      const st = useAppStore.getState();
      const have = st.assetCollections.find(c => mentionKey(c.name) === mentionKey(name));
      if (have) return { id: have.id, name: have.name, existed: true };
      const id = st.createCollection(name);
      return { id, name, existed: false };
    },
    'collection.bind': async (a) => {
      const c = agentFindCollection(a.collection);
      const p = agentResolveProject(a.projectId, a.project, '연결할 프로젝트');
      useAppStore.getState().setProjectCollection(p.id, c.id);
      return { project: p.name, collection: c.name };
    },
    'elements.add': async (a) => {
      const c = agentFindCollection(a.collection);
      const items: any[] = Array.isArray(a.items) ? a.items : [];
      if (!items.length) throw new Error('items 가 비었습니다');
      const added: unknown[] = [], skipped: unknown[] = [], failed: unknown[] = [];
      for (const it of items) {
        const name = String(it?.name || '').trim();
        const category = String(it?.category || 'character');
        if (!name) { failed.push({ name: '(이름 없음)', error: 'name 이 없습니다' }); continue; }
        if (!(category in CATEGORY_META)) { failed.push({ name, error: `category 는 ${Object.keys(CATEGORY_META).join(' / ')}` }); continue; }
        // 컬렉션 안에서 이름은 하나 — 멘션이 이름으로 찾기 때문이다(ElementLibrary 의 등록 규칙과 같다).
        const same = useAppStore.getState().elementAssets.find(e => e.collectionId === c.id && mentionKey(e.name) === mentionKey(name));
        if (same) { skipped.push({ name, id: same.id, reason: '같은 이름이 이미 있음 — 고치려면 element.update' }); continue; }
        const paths = Array.isArray(it?.images) ? it.images : [];
        if (!paths.length) { failed.push({ name, error: 'images 가 비었습니다' }); continue; }
        if (paths.length > MAX_ELEMENT_IMAGES) { failed.push({ name, error: `이미지는 ${MAX_ELEMENT_IMAGES}장까지` }); continue; }
        try {
          const images = await agentElementImages(paths);
          useAppStore.getState().addElementAsset({ collectionId: c.id, category: category as AssetCategory, name, description: String(it?.description || ''), images });
          const made = useAppStore.getState().elementAssets.find(e => e.collectionId === c.id && mentionKey(e.name) === mentionKey(name));
          added.push({ name, id: made?.id, images: images.length });
        } catch (e: any) { failed.push({ name, error: e?.message || String(e) }); }
      }
      return { collection: c.name, added, skipped, failed };
    },
    'element.update': async (a) => {
      const c = agentFindCollection(a.collection);
      const st = useAppStore.getState();
      const key = String(a.name || '');
      const e = st.elementAssets.find(x => x.collectionId === c.id && (x.id === key || mentionKey(x.name) === mentionKey(key)));
      if (!e) throw new Error(`엘리먼트를 찾지 못했습니다: ${key} (컬렉션 "${c.name}")`);
      const upd: Record<string, unknown> = {};
      if (a.newName) {
        const nn = String(a.newName).trim();
        const clash = st.elementAssets.find(x => x.collectionId === c.id && x.id !== e.id && mentionKey(x.name) === mentionKey(nn));
        if (clash) throw new Error(`컬렉션에 같은 이름이 있습니다: ${nn}`);
        upd.name = nn;
      }
      if (a.category) {
        if (!(String(a.category) in CATEGORY_META)) throw new Error(`category 는 ${Object.keys(CATEGORY_META).join(' / ')}`);
        upd.category = a.category;
      }
      if (a.description !== undefined) upd.description = String(a.description);
      if (a.replaceImages) upd.images = await agentElementImages(a.replaceImages);
      else if (a.addImages) {
        const more = await agentElementImages(a.addImages);
        if (e.images.length + more.length > MAX_ELEMENT_IMAGES) throw new Error(`이미지는 ${MAX_ELEMENT_IMAGES}장까지 — 지금 ${e.images.length}장`);
        upd.images = [...e.images, ...more];
      }
      if (!Object.keys(upd).length) throw new Error('바꿀 것이 없습니다 (newName · category · description · addImages · replaceImages)');
      if (Array.isArray(upd.images) && !upd.images.length) throw new Error('이미지가 하나도 없게 바꿀 수는 없습니다');
      useAppStore.getState().updateElementAsset(e.id, upd as any);
      const now = useAppStore.getState().elementAssets.find(x => x.id === e.id);
      return { id: e.id, name: now?.name, category: now?.category, images: now?.images.length };
    },
    'cards.list': async (a) => {
      const p = agentResolveProject(a.projectId, a.project, '카드를 볼 프로젝트');
      const limit = Math.max(1, Math.min(100, Number(a.limit) || 20));
      let cards = p.messages.filter(m => m.role !== 'user').slice().reverse() as any[];
      if (a.status) cards = cards.filter(m => (m.status || 'queued') === a.status);
      if (a.starred === true) cards = cards.filter(m => m.starred);
      return { project: p.name, total: cards.length, cards: cards.slice(0, limit).map(m => agentCardView(m)) };
    },
    'card.get': async (a) => {
      const { project: p, card: m } = agentFindCard(a.id);
      return agentCardView(m, p.name);
    },
    'card.star': async (a) => {
      const { project: p, card: m } = agentFindCard(a.id);
      useAppStore.getState().updateMessage(p.id, m.id, { starred: a.on !== false });
      return { id: m.id, starred: a.on !== false };
    },
    'card.download': async (a) => {
      const { project: p, card: m } = agentFindCard(a.id);
      if (m.status !== 'succeeded' || !m.videoUrl) throw new Error('아직 영상이 없는 카드입니다(완성된 카드만 받을 수 있음)');
      // 저장 경로는 다운로드가 끝나야 안다(Electron 'download-done'). 이번 저장의 경로를 받으려고 옛 경로를 비운다.
      useAppStore.getState().updateMessage(p.id, m.id, { downloadedPath: undefined });
      await downloadClip(m.id, m.videoUrl, m.taskId || '');
      const until = Date.now() + 180000;
      for (;;) {
        const cur = useAppStore.getState().projects.find(x => x.id === p.id)?.messages.find(x => x.id === m.id) as any;
        if (cur?.downloadedPath) return { id: m.id, path: cur.downloadedPath };
        if (Date.now() > until) return { id: m.id, path: null, note: '다운로드는 시작했지만 저장 경로를 아직 모릅니다 — 큰 파일이면 앱 아래쪽 진행 막대를 보세요' };
        await new Promise(r => setTimeout(r, 500));
      }
    },
    'card.final': async (a) => {
      const { project: p, card: m } = agentFindCard(a.id);
      if (!m.usedSettings?.draft || m.status !== 'succeeded' || !m.taskId) throw new Error('완성된 초안(Draft) 카드만 본편을 만들 수 있습니다');
      const warnings: string[] = [];
      agentWarnRef.current = warnings;
      try {
        const id = await makeFinalFromDraft(m.taskId, m);
        if (!id) throw new Error(warnings.join('\n') || '본편을 만들지 않았습니다');
        return { card: id, project: p.name };
      } finally { agentWarnRef.current = null; }
    },
    'card.regenerate': async (a) => {
      const { project: p, card: m } = agentFindCard(a.id);
      // 초안에서 만든 본편이 실패했으면 같은 초안에서 다시(카드의 재생성 버튼 handleRegenerate 와 같은 규칙).
      if (m.draftOf && m.status === 'failed') {
        const warnings: string[] = [];
        agentWarnRef.current = warnings;
        try {
          const id = await makeFinalFromDraft(m.draftOf, m);
          if (!id) throw new Error(warnings.join('\n') || '본편을 다시 만들지 않았습니다');
          return { cards: [id], project: p.name };
        } finally { agentWarnRef.current = null; }
      }
      // 26.10.2002~ 카드의 재생성 버튼과 같은 값(prepareReuse)을 메모리에서 만들어 같은 함수(sendRequest)로 그 프로젝트에
      // 보낸다 — 작성 칸 · 설정 · 레퍼런스 칸을 건드리지 않고, 그 프로젝트를 열지 않아도 된다.
      const notes: string[] = [];
      const r = await prepareReuse(m, p.id, { warn: x => { notes.push(x); } });
      if (!r.assetsOk) throw new Error(notes.join('\n') || '레퍼런스를 되살리지 못해 다시 만들지 않았습니다');
      if (r.html === undefined) throw new Error('카드에 프롬프트가 없어 다시 만들 수 없습니다');
      const now = useAppStore.getState().projects.find(x => x.id === p.id);
      if (!now) throw new Error('프로젝트가 사라졌습니다');
      const warnings = [...notes];
      const ids = await sendRequest(
        { projectId: p.id, promptHtml: r.html, settings: { ...now.settings, ...r.settings, output_count: 1 }, assets: r.assets ?? now.assets },   // 늘 한 편(화면 재생성과 같다)
        { warn: x => { warnings.push(x); } },
      );
      if (!ids?.length) throw new Error(warnings.join('\n') || '다시 만들지 않았습니다');
      showToast(`[${p.name}] 에이전트가 카드를 다시 만들었어요 — 카드 ${ids.length}개`, true);
      return { cards: ids, project: p.name, ...(warnings.length ? { warnings } : {}) };
    },
    'card.cancel': async (a) => {
      const { project: p, card: m } = agentFindCard(a.id);
      if (!m.taskId || m.status !== 'queued') throw new Error(`대기 중(queued)인 카드만 취소할 수 있습니다 — 지금 ${m.status || 'queued'}`);
      const warnings: string[] = [];
      agentWarnRef.current = warnings;
      try {
        await useAppStore.getState().cancelTask(p.id, m.id, m.taskId);
        await new Promise(r => setTimeout(r, 300));   // 거절 알림(seedance:cancel-failed)이 경고로 들어올 틈
        const cur = useAppStore.getState().projects.find(x => x.id === p.id)?.messages.find(x => x.id === m.id);
        if (warnings.length || cur?.status === 'queued' || cur?.status === 'running') {
          throw new Error(warnings.join('\n') || '앱이 취소하지 못했습니다(이미 돌기 시작했으면 과금됩니다)');
        }
        return { id: m.id, status: cur?.status ?? 'deleted' };
      } finally { agentWarnRef.current = null; }
    },
  };

  const agentRunCommand = async (cmd: { id: string; command: string; args?: any }) => {
    const fn = agentCommands[cmd.command];
    if (!fn) {
      agentCmdReport(cmd.id, { status: 'failed', error: `모르는 명령입니다: ${cmd.command}\n(있는 명령: ${AGENT_COMMANDS.map(c => c.name).join(', ')})` });
      return;
    }
    try {
      const result = await fn(cmd.args && typeof cmd.args === 'object' ? cmd.args : {});
      agentCmdReport(cmd.id, { status: 'done', result: result ?? null });
    } catch (e: any) {
      agentCmdReport(cmd.id, { status: 'failed', error: e?.message || String(e) });
    }
  };

  const agentTick = async () => {
    // ★ 손대는 칸만 한다(나누기 26.10.2001~) — 에이전트에게 '화면' 은 하나다.
    if (!activeRef.current) return;
    // 1) 보낸 요청의 카드 상태를 올린다(앱에 하나 — 보낸 칸을 닫았어도).
    agentReportProgress();
    // 2) 새 요청 · 명령. 26.10.2002~ 작성 칸을 빌리지 않으므로 입력 중 · 생성 중 · 갤러리 화면이어도 받는다.
    //    다른 요청을 보내는 중(busy)이면 상태만 알린다(peek).
    const st = useAppStore.getState();
    const proj = st.projects.find(p => p.id === st.currentProjectId);
    const busy = agentBusy;
    // 코드 목록(시트)을 아직 못 받았으면 대상 판단을 하지 않는다 — 다 '코드 없음' 으로 보여 잘못 기다리게 했다(26.10.2002 검토).
    const billingReady = st.billingProjects.length > 0;
    const peek = busy;
    const takeCommands = !busy;
    if (!busy) agentBusy = true;   // 응답을 기다리는 사이 다음 틱(어느 칸이든)이 또 가져가지 않게
    let job: any = null;
    let commands: any[] = [];
    try {
      const res = await fetch('/api/agent/jobs/claim', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),   // 26.10.2002~ 서버가 답을 안 하면 busy 가 안 풀려 줄 전체가 멈췄다
        body: JSON.stringify({
          // composer · generating 은 옛 커넥터가 '왜 아직 안 받나' 를 알리는 데 쓴다 — 26.10.2002~ 작성 칸 · 사용자 생성과
          // 상관없이 받으므로 composer 는 늘 true, generating 은 '다른 에이전트 요청을 보내는 중' 이다.
          screen: agentScreenId, peek, takeCommands, composer: true,
          project: proj?.name ?? null,
          billing: projectBilling(st, st.currentProjectId)?.project ?? null,
          generating: busy,
          manual: agentManual().version,
          // 지금 과금 프로젝트로 쓸 수 있는 것 — 에이전트가 권한 없는 모델을 고르지 않게(설명서는 '무엇이 있나', 이건 '지금 되나').
          allowedModels: MODELS.filter(m => isModelAllowed(m.id, billingOf(st, st.currentProjectId))).map(m => m.id),
          fourK: isFourKAllowed(billingOf(st, st.currentProjectId)),
          // 26.10.2002~ 프로젝트마다 코드가 있는지 — 서버가 '대상 프로젝트에 코드가 없는 작업' 을 내주지 않고 기다리게 한다.
          // 처리 중(peek)에도 보낸다 — 기다림 표시가 늦지 않게. 코드 목록이 아직이면 보내지 않고 billingReady:false.
          billingReady,
          ...(billingReady ? { projects: st.projects.map(p => ({ id: p.id, name: p.name, billing: projectBilling(st, p.id)?.project ?? null })) } : {}),
          working: [...agentWorking],
        }),
      });
      if (res.ok) {
        const data = await res.json();
        job = data?.job || null;
        commands = Array.isArray(data?.commands) ? data.commands : [];
        // 받은 순간 '처리 중' 으로 — 다음 claim 부터 서버가 이 id 를 받은 것으로 안다(끝 보고가 닿으면 빠진다).
        if (job?.id) agentWorking.add(job.id);
        for (const c of commands) if (c?.id) agentWorking.add(c.id);
        agentSyncManual(data?.manualVersion);
        agentNoteWaiting(data?.waitingBilling);
      }
    } catch { /* 서버가 잠깐 없으면 다음 틱에 */ }
    if (busy) return;
    try {
      // 서버는 명령이 있으면 명령만 준다(그 틱엔 생성 요청을 안 줌) — project.open 같은 명령 뒤의 생성은 화면이
      // 새로 그려진 다음 틱에 받아야 지금 프로젝트를 제대로 본다.
      for (const c of commands) await agentRunCommand(c);
      if (job) {
        try { await agentProcess(job); }
        catch (e: any) { void agentReport(job.id, { status: 'failed', error: e?.message || String(e) }); }
      }
    } finally { agentBusy = false; }
  };
  agentTickRef.current = agentTick;

  /* ─── 초안 → 1080p 본편 ─── */
  // handleSend 를 타지 않는다. 본편 요청에 초안에서 물려받는 값(프롬프트·레퍼런스·길이·비율·
  // 시드·오디오·작업 종류)을 다시 실으면 값이 같아도 즉시 400 이다 — 실측(generate_audio).
  // handleSend 는 바로 그것들을 싣는 게 일이라, 거기에 예외를 끼우면 둘이 얽힌다. 여기서는
  // 초안 id 하나와 '다시 정할 수 있는' 값만 보낸다.
  // 새 카드는 맨 아래에 붙는다. 초안 바로 밑에 끼우면 '여기부터 새로 생성됨' 구분선과 갤러리
  // 정렬(생성 시각)이 어긋난다. 대신 초안 카드의 '본편 보기' 가 그 자리로 데려간다.
  // base: 새 카드에 옮겨 적을 프롬프트·설정·레퍼런스를 가진 메시지 — 초안 카드 자신이거나,
  // 실패한 본편을 다시 시도할 때는 그 본편 카드.
  // 만든 본편 카드 id 를 돌려준다(에이전트 명령 card.final · card.regenerate 가 따라간다). 멈췄으면 undefined.
  const makeFinalFromDraft = async (draftTaskId: string, base: any): Promise<string | undefined> => {
    const st = useAppStore.getState();
    const owner = st.projects.find(p => p.messages.some(m => m.id === base.id));
    if (!owner || !draftTaskId) return;
    // 같은 초안으로 이미 만드는 중이거나 다 만들었으면 또 보내지 않는다 (더블클릭 등).
    // 실패한 본편만 있으면 다시 만들 수 있다. 스토어를 새로 읽으므로 같은 틱의 두 번째
    // 클릭도 첫 클릭이 붙인 카드를 본다.
    if (owner.messages.some(m => m.draftOf === draftTaskId && m.status !== 'failed')) {
      warn('이 Draft로 만든 본편이 이미 있습니다.\n(Draft 카드의 "본편 보기" 로 이동할 수 있습니다.)');
      return;
    }
    const draftMsg = owner.messages.find(m => m.taskId === draftTaskId);
    if (draftMsg && Date.now() > draftExpiresAt(draftMsg)) {
      warn('Draft는 생성 후 7일까지만 본편으로 만들 수 있습니다.\n같은 설정으로 다시 뽑으려면 Draft 카드의 재생성(✦)을 누르세요.');
      return;
    }
    const us = base.usedSettings || {};
    const model = resolveModelId(us.model || '');
    if (!modelSupportsDraft(model)) { warn('이 모델은 Draft → 본편을 지원하지 않습니다.'); return; }
    // 과금 프로젝트는 Draft 가 나간 곳을 따른다 — 같은 컷의 연장이다. 그 사이 드롭다운에서
    // 다른 프로젝트를 골라 두었어도 본편만 엉뚱한 프로젝트에 찍히지 않게.
    // ★ 이름이 아니라 key 로 찾는다. Draft 를 만든 뒤 프로젝트 이름이 바뀌어도(POS) 같은 프로젝트를
    //   찾고, 보낼 때는 '지금 이름' 을 쓴다. 이름으로 찾던 때는 이름이 바뀌는 순간 "권한 없음" 으로
    //   영구히 막혔다. key 가 없는 Draft(26.9.2306 이전)는 이름으로 찾는다. Draft 에 프로젝트 기록이
    //   아예 없으면 앱의 프로젝트 코드(공동 코드)를 쓴다.
    const vs = base.videoStorage || {};
    const origin = billingProjectOfDraft(st.billingProjects, vs);
    const hasOrigin = origin.hasOrigin;
    const bill = hasOrigin ? origin.bill : projectBilling(st, owner.id);
    if (!bill) {
      // '권한 없음' 이 아니라 실제 이유를 말한다 — 목록(진행 중인 프로젝트)에 없는 것이다.
      warn(hasOrigin
        ? `이 Draft 의 프로젝트(${vs.project || '알 수 없음'})가 종료되었거나 목록에 없어 본편을 만들 수 없습니다.`
        : '프로젝트 코드를 먼저 골라 주세요.\n(설정 패널 맨 위 "프로젝트 코드")');
      return;
    }
    if (!isModelAllowed(model, { billingProjectKey: bill.key, billingProjects: st.billingProjects })) {
      warn(`프로젝트 코드 "${bill.project}" 는 ${MODELS.find(m => m.id === model)?.name || '이 모델'} 권한이 없습니다.`);
      return;
    }

    // 카드에는 '실제로 나오는 것' 을 적는다. 비율·길이·오디오는 초안 그대로라 초안의 기록을
    // 그대로 쓰고, 해상도만 1080p 로, 초안 표시는 끈다.
    const usedSettings = { ...us, model, resolution: DRAFT_FINAL_RESOLUTION, draft: false };
    const id = crypto.randomUUID();
    // apiPrompt 도 초안 것 — 본편 요청은 초안 태스크만 가리키고, 모델이 본 글은 초안 때 보낸 그 글이다.
    addMessage(owner.id, { id, role: 'system', content: '본편 생성 시작... (Draft → 1080p)', status: 'queued',
      promptText: base.promptText, promptHtml: base.promptHtml, apiPrompt: base.apiPrompt, usedSettings,
      usedAssets: base.usedAssets, usedElementImages: base.usedElementImages, usedCollection: usedCollectionOf(base),
      videoStorage: { project: bill.project, projectId: bill.id, projectKey: bill.key }, draftOf: draftTaskId } as any);

    // 다시 정할 수 있는 값은 빠뜨리면 '초안 때 값' 이 아니라 모델 기본값이 된다(문서).
    // 그래서 형식과 마지막 프레임은 초안 때 값을 다시 실어 보낸다.
    const payload: any = {
      model,
      content: [{ type: 'draft_task', draft_task: { id: draftTaskId } }],
      resolution: DRAFT_FINAL_RESOLUTION,
      watermark: false,
      // app-only — server.ts 가 둘 다 떼어내 과금 프로젝트로 쓴다 (handleSend 와 같다)
      project: bill.project, project_id: bill.id,
    };
    const outFmt = resolveOutputFormat(model, us.output_format);
    if (outFmt) payload.output_format = outFmt;
    if (us.return_last_frame) payload.return_last_frame = true;

    try {
      const res = await fetch('/api/byteplus/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { throw new Error(`서버 응답 오류 (${res.status})`); }
      if (!res.ok || (data.code !== undefined && data.code !== 0)) throw new Error(data.error?.message || data.msg || data.error || JSON.stringify(data));
      const taskId = data.id || data.data?.task_id;
      if (!taskId) throw new Error('Task ID를 받지 못했습니다.');
      updateMessage(owner.id, id, { content: `Task 생성 완료. ID: ${taskId}`, taskId, status: 'running', startTime: Date.now() });
      useAppStore.getState().pollTask(owner.id, id, taskId);
      showToast('1080p 본편을 만들기 시작했습니다 — 맨 아래에 추가됩니다.', true);
    } catch (error: any) {
      updateMessage(owner.id, id, { content: '본편 생성 실패', status: 'failed', error: error.message, endTime: Date.now() });
    }
    return id;
  };

  /* ─── Regenerate: restore this card's exact setup, then re-run the SAME send ─── */
  // Reuses the proven handleReuse + handleSend paths verbatim → the payload,
  // [Image N] numbering, R2 re-upload and validation are byte-for-byte a normal
  // send, so it can't diverge/tangle. Aborts (no send) when handleReuse reports a
  // reference it couldn't restore — the user sees "파일을 다시 첨부" instead of a
  // broken request. regenLockRef stops a double-click from firing two runs in the
  // window before handleSend flips isGenerating.
  // ★ 26.10.2004 감사: 예전엔 handleReuse 뒤에 handleSend 로 '작성 칸' 을 다시 읽어 보냈다. 되살리는(캐시 확인 · 원본 다시 읽기)
  //   몇 초 사이에 이 칸의 프로젝트가 바뀌면(사이드바 · 뒤로가기 · 칸 닫기 · 에이전트 project.open) 작성 칸에는 다른 프로젝트의 글이
  //   있어, 그 글이 원래 프로젝트의 설정 · 레퍼런스로 과금됐다. 이제 되살린 값(prepareReuse)을 작성 칸에 넣어 보여 주되, 보낼
  //   때는 그 값 그대로 sendRequest 에 넘긴다(에이전트 card.regenerate 와 같은 길) — 작성 칸을 다시 읽지 않는다. 되살리는 동안부터
  //   그 프로젝트를 잠근다(다시 누르거나 보내지 않게).
  const regenLockRef = useRef(false);
  const handleRegenerate = async (msg: any) => {
    const pid = project.id;
    if (sendingNow(pid) || regenLockRef.current) return;
    // 초안에서 만든 본편이 실패했으면 다시 시도도 같은 초안에서 한다. handleSend 로 보내면
    // 초안과 상관없는 새 1080p 영상이 나와서, 골라 둔 구도를 잃는다.
    // (성공한 본편의 재생성은 다른 카드와 같다 — 같은 설정으로 새 1080p 한 편.)
    if (msg.draftOf && msg.status === 'failed') { await makeFinalFromDraft(msg.draftOf, msg); return; }
    regenLockRef.current = true;
    const lock = sendLock(pid);
    lock.busy(true);
    try {
      const r = await prepareReuse(msg, pid, { warn: warnFor(pid) });
      // 재생성은 늘 한 편(사용자 결정 2026-10-21) — 그 카드 묶음의 개수(×1~3)는 되살리지 않는다(예전엔 ×3 묶음의 한 장을 다시 만들면
      // 3편이 과금됐다). 작성 칸의 개수는 사용자가 고른 그대로 둔다.
      if (r.settings) { const { output_count: _n, ...rest } = r.settings; r.settings = rest; }
      applyReuse(pid, r);
      if (paneProjectRef.current === pid) { if (showGallery) exitGallery(); setPreviewItem(null); }
      if (!r.assetsOk) return;
      const now = useAppStore.getState().projects.find(p => p.id === pid);
      if (!now) return;
      // 카드에 프롬프트가 없으면(아주 옛 카드) 그 프로젝트의 지금 글 — 이 칸에 떠 있으면 작성 칸, 아니면 작성 중 글.
      const html = r.html ?? (paneProjectRef.current === pid && contentEditableRef.current ? contentEditableRef.current.innerHTML : now.draftPrompt || '');
      await sendRequest(
        { projectId: pid, promptHtml: html, settings: { ...now.settings, output_count: 1 }, assets: now.assets, writeBack4k: true },
        { warn: warnFor(pid), busy: lock.busy, sent: () => { if (paneProjectRef.current === pid) setTimeout(() => scrollToBottom(), 150); } },
      );
    } finally {
      regenLockRef.current = false;
      window.setTimeout(lock.release, 1500);
    }
  };

  /* ─── Render ─── */
  cardActions.current = { scrollToMessage, handleReuse, handleRegenerate, toggleStar, handleVideoDownload, revealDownloaded, makeFinalFromDraft };
  const downloadEntries = Object.entries(downloads);
  const activeCount = downloadEntries.filter(([, i]) => i.state !== 'completed' && i.state !== 'interrupted' && i.state !== 'cancelled').length;
  const dismissDownload = (filename: string) => setDownloads(d => { const n = { ...d }; delete n[filename]; return n; });
  const dismissAllDownloads = () => setDownloads({});
  return (
    <div ref={rootRef} className="flex-1 flex flex-col bg-[#fafafa] dark:bg-[#242426] h-full relative min-w-0" onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      {/* 받은 영상에서 되살리기 (26.10.801~) */}
      {restoreTarget && (
        <SettingsRestoreDialog
          target={restoreTarget}
          onClose={() => setRestoreTarget(null)}
          onPaste={(pick) => { void pasteFrom(restoreTarget, pick); }}
          onFill={(pick) => { void applyRestore(restoreTarget, pick); }}
          onGoToCard={(pick) => { setRestoreTarget(null); if (showGallery) exitGallery(); requestFindMessage(pick.projectId, pick.msg.id); }}
          onAttach={restoreTarget.file ? () => {
            const f = restoreTarget.file!;
            setRestoreTarget(null);
            if (!isOmni && project.settings.mode === 'text_to_video') { warn('Text to Video 모드에서는 래퍼런스 파일을 사용하지 않습니다.'); return; }
            void attachFiles([f]).then(rej => { if (rej.length) warn(`일부 파일이 추가되지 않았습니다:\n\n${rej.join('\n')}`); });
          } : undefined}
        />
      )}
      {/* Non-blocking validation toast — replaces alert() so the prompt caret/IME stay intact */}
      <AnimatePresence>
        {toast && (
          <motion.div
            key="toast"
            initial={{ opacity: 0, y: -12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.98 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            // 나눠 보는 중이면 그 칸 위에 — 어느 칸의 이야기인지 보이게. 한 칸이면 예전처럼 창 가운데.
            className={`${split ? 'absolute top-16' : 'fixed top-4'} left-1/2 -translate-x-1/2 z-[70] w-[min(92%,28rem)]`}
          >
            <div className={`flex items-start gap-2.5 border rounded-xl shadow-lg px-3.5 py-2.5 ${toast.ok ? 'bg-emerald-50 border-emerald-300 text-emerald-900' : 'bg-amber-50 border-amber-300 text-amber-900'}`}>
              {toast.ok
                ? <Check size={16} className="text-emerald-500 shrink-0 mt-0.5" />
                : <AlertCircle size={16} className="text-amber-500 shrink-0 mt-0.5" />}
              <p className="text-[13px] leading-snug whitespace-pre-line flex-1">{toast.msg}</p>
              <button onClick={() => setToast(null)} className={`shrink-0 -mt-0.5 ${toast.ok ? 'text-emerald-400 hover:text-emerald-700' : 'text-amber-400 hover:text-amber-700'}`}><X size={15} /></button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Download progress — collapsed pill or expanded list */}
      <AnimatePresence>
      {downloadEntries.length > 0 && (
        downloadsCollapsed ? (
          <motion.button
            key="dl-pill"
            initial={{ opacity: 0, scale: 0.85, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.85, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            onClick={() => setDownloadsCollapsed(false)}
            className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 bg-white dark:bg-[#1c1c1e] border border-gray-200 shadow-lg rounded-full px-3 py-1.5 hover:border-indigo-300 transition-colors"
          >
            {activeCount > 0 ? <Loader2 size={12} className="text-indigo-500 animate-spin" /> : <Download size={12} className="text-green-500" />}
            <span className="text-[11px] text-gray-700 font-medium">{activeCount > 0 ? `다운로드 ${activeCount}` : '완료'}</span>
          </motion.button>
        ) : (
          <motion.div
            key="dl-list"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="fixed bottom-4 right-4 z-[60] flex flex-col gap-1.5 max-w-xs"
          >
            <div className="flex items-center justify-end gap-1">
              <button onClick={() => setDownloadsCollapsed(true)} className="text-[10px] text-gray-500 hover:text-indigo-600 px-2 py-0.5 bg-white dark:bg-[#1c1c1e] border border-gray-200 rounded-full shadow" title="최소화">접기</button>
              <button onClick={dismissAllDownloads} className="text-[10px] text-gray-500 hover:text-red-500 px-2 py-0.5 bg-white dark:bg-[#1c1c1e] border border-gray-200 rounded-full shadow" title="전체 닫기">전체 닫기</button>
            </div>
            <AnimatePresence mode="popLayout">
              {downloadEntries.map(([filename, info]) => {
                const pct = info.total > 0 ? Math.round((info.received / info.total) * 100) : 0;
                const mb = (info.received / 1024 / 1024).toFixed(1);
                const totalMb = info.total > 0 ? (info.total / 1024 / 1024).toFixed(1) : '?';
                const isDone = info.state === 'completed';
                const isFailed = info.state === 'interrupted' || info.state === 'cancelled';
                return (
                  <motion.div
                    key={filename}
                    layout
                    initial={{ opacity: 0, x: 30, scale: 0.95 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 30, scale: 0.95, transition: { duration: 0.25 } }}
                    transition={{ duration: 0.2, ease: 'easeOut' }}
                    className={`bg-white dark:bg-[#1c1c1e] rounded-lg shadow border ${isFailed ? 'border-red-200' : isDone ? 'border-green-200' : 'border-indigo-200'} px-2.5 py-1.5`}
                  >
                    <div className="flex items-center gap-1.5">
                      {isFailed ? <AlertCircle size={11} className="text-red-500 shrink-0" />
                        : isDone ? <Download size={11} className="text-green-500 shrink-0" />
                        : <Loader2 size={11} className="text-indigo-500 shrink-0 animate-spin" />}
                      <span className="text-[10px] text-gray-700 truncate flex-1" title={filename}>{filename}</span>
                      <button onClick={() => dismissDownload(filename)} className="text-gray-300 hover:text-gray-600 shrink-0" title="닫기"><X size={10} /></button>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[9px] text-gray-500">
                      <span className="font-mono">{isDone ? '완료' : isFailed ? '실패' : `${mb}/${totalMb}MB`}</span>
                      {!isDone && !isFailed && (
                        <div className="flex-1 h-0.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-indigo-500 transition-all duration-200" style={{ width: `${pct}%` }} />
                        </div>
                      )}
                      {!isDone && !isFailed && info.total > 0 && <span className="font-mono">{pct}%</span>}
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        )
      )}
      </AnimatePresence>

      {/* Drag overlay */}
      {isDragging && !dragVideo && (
        <div className="absolute inset-0 z-50 bg-indigo-50/90 flex flex-col items-center justify-center border-4 border-dashed border-indigo-400 m-4 rounded-2xl animate-fade-in">
          <UploadCloud size={64} className="text-indigo-500 mb-4" />
          <h2 className="text-2xl font-bold text-indigo-700">파일을 여기에 놓으세요</h2>
          <p className="text-indigo-500 mt-2">이미지 / 비디오 / 오디오 래퍼런스로 추가됩니다</p>
        </div>
      )}
      {/* 영상을 끌어오면 막이 셋으로(26.10.801~): 작성 칸 쪽은 '프롬프트만' · '그때 설정 그대로', 나머지는 '레퍼런스로 첨부'.
          어디에 놓았는지는 handleDrop 이 data-drop-zone 으로 안다. */}
      {isDragging && dragVideo && (
        <div className="absolute inset-0 z-50 m-4 flex flex-col gap-3 animate-fade-in">
          <div data-drop-zone="attach" onDragOver={() => dropZone !== 'attach' && setDropZone('attach')}
            className={`flex-1 min-h-0 rounded-2xl border-4 border-dashed flex flex-col items-center justify-center transition-colors ${dropZone === 'attach' ? 'border-indigo-500 bg-indigo-100/95' : 'border-indigo-300 bg-indigo-50/90'}`}>
            <UploadCloud size={48} className="text-indigo-500 mb-3 pointer-events-none" />
            <h2 className="text-xl font-bold text-indigo-700 pointer-events-none">레퍼런스로 첨부</h2>
            <p className="text-indigo-500 mt-1 text-sm pointer-events-none">영상을 참조 영상으로 붙여요</p>
          </div>
          <div className="shrink-0 flex gap-3" style={{ height: Math.max(170, (composerBoxRef.current?.offsetHeight || 0) + 40) }}>
            <div data-drop-zone="prompt" onDragOver={() => dropZone !== 'prompt' && setDropZone('prompt')}
              className={`flex-1 min-w-0 rounded-2xl border-4 border-dashed flex flex-col items-center justify-center transition-colors ${dropZone === 'prompt' ? 'border-emerald-500 bg-emerald-100/95' : 'border-emerald-300 bg-emerald-50/90'}`}>
              <Sparkles size={36} className="text-emerald-600 mb-2 pointer-events-none" />
              <h2 className="text-lg font-bold text-emerald-700 pointer-events-none">프롬프트만</h2>
              <p className="text-emerald-600 mt-1 text-[13px] text-center px-4 pointer-events-none">초기화하고 프롬프트만 — 어셋 언급은 함께, 레퍼런스는 빼고(모델 · 모드는 그 영상대로)</p>
            </div>
            <div data-drop-zone="restore" onDragOver={() => dropZone !== 'restore' && setDropZone('restore')}
              className={`flex-1 min-w-0 rounded-2xl border-4 border-dashed flex flex-col items-center justify-center transition-colors ${dropZone === 'restore' ? 'border-violet-500 bg-violet-100/95' : 'border-violet-300 bg-violet-50/90'}`}>
              <RefreshCw size={36} className="text-violet-600 mb-2 pointer-events-none" />
              <h2 className="text-lg font-bold text-violet-700 pointer-events-none">그때 설정 그대로</h2>
              <p className="text-violet-600 mt-1 text-[13px] text-center px-4 pointer-events-none">초기화하고 프롬프트 · 레퍼런스 · 어셋 컬렉션 · 모델 · 파라미터까지 그 영상대로</p>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className={`h-14 border-b border-gray-200/80 bg-white/90 dark:bg-[#1c1c1e]/90 backdrop-blur-xl flex items-center justify-between gap-2 shrink-0 z-10 sticky top-0 ${split ? 'px-4' : 'px-6'}`}>
        {showGallery ? (
          <button onClick={exitGallery} className="flex items-center gap-2 text-[15px] font-medium text-gray-500 hover:text-indigo-600 transition-colors whitespace-nowrap">
            ← 채팅으로 돌아가기
          </button>
        ) : (
          <h1 className={`min-w-0 font-semibold tracking-tight truncate ${split ? 'text-[17px]' : 'text-[20px]'} ${split && !active ? 'text-gray-500 dark:text-gray-500' : 'text-[#1d1d1f] dark:text-gray-900'}`} title={project.name}>{project.name}</h1>
        )}
        <div className="flex items-center gap-2 shrink-0">
          {/* 갤러리의 채택만 · Draft 포함은 머리에 둔다(26.10.203~). 목록 맨 위에 두었더니 스크롤하면
              같이 올라가 버려, 채택만 보면서 내려가다 끄려면 다시 맨 위까지 가야 했다. */}
          {showGallery && (hasStarredClips || starredOnly) && (
            <button onClick={() => setStarredOnly(v => !v)} title="채택한 컷만 보기"
              className={`flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors whitespace-nowrap ${starredOnly
                ? 'text-amber-700 bg-amber-50 border-amber-300'
                : 'text-gray-500 bg-white dark:bg-[#1c1c1e] border-gray-200 hover:border-amber-300 hover:text-amber-600'}`}>
              <Star size={13} className={starredOnly ? 'fill-amber-400 text-amber-500' : ''} />
              채택만 <span className="font-mono opacity-70">{starredCount}</span>
            </button>
          )}
          {showGallery && (hasDraftClips || withDrafts) && (
            <button onClick={() => setWithDrafts(v => !v)}
              title="Draft(480p 미리보기)는 기본으로 숨겨 둡니다"
              className={`flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-lg border transition-colors whitespace-nowrap ${withDrafts
                ? 'text-amber-700 bg-amber-50 border-amber-300'
                : 'text-gray-500 bg-white dark:bg-[#1c1c1e] border-gray-200 hover:border-amber-300 hover:text-amber-600'}`}>
              {withDrafts ? <Check size={13} /> : <Eye size={13} />}
              Draft 포함 <span className="font-mono opacity-70">{draftClipCount}</span>
            </button>
          )}
          {/* 프롬프트 검색 — 채팅에서는 메시지를, 갤러리에서는 컷을 거른다(검색어는 따로 기억한다). */}
          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input type="text" value={showGallery ? gallerySearch : headerSearch}
              onChange={(e) => (showGallery ? setGallerySearch : setHeaderSearch)(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') (showGallery ? setGallerySearch : setHeaderSearch)(''); }}
              placeholder={split ? '검색...' : '프롬프트 · 태스크 ID 검색...'}
              title="프롬프트 · 태스크 ID 검색"
              className={`${split ? 'w-32' : 'w-44'} pl-8 pr-7 py-1.5 bg-gray-50 border border-gray-200 focus:border-indigo-400 focus:bg-white dark:focus:bg-[#1c1c1e] rounded-lg text-[13px] outline-none transition-all`} />
            {(showGallery ? gallerySearch : headerSearch) && (
              <button onClick={() => (showGallery ? setGallerySearch : setHeaderSearch)('')} title="검색 지우기 (Esc)"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-700">
                <X size={13} />
              </button>
            )}
          </div>
          <button onClick={showGallery ? exitGallery : enterGallery} className={`p-2 rounded-lg transition-all ${showGallery ? 'bg-indigo-500 text-white shadow-md' : 'text-gray-400 hover:bg-gray-100 hover:text-indigo-600'}`} title="갤러리">
            <LayoutGrid size={18} />
          </button>
          {/* 나눠 보는 중(26.10.2001~) — 두 칸 자리 바꾸기 · 이 칸 닫기. 닫으면 남은 칸이 넓게 펴진다. */}
          {split && (
            <div className="flex items-center gap-0.5 pl-1.5 ml-0.5 border-l border-gray-200 dark:border-white/10">
              <button onClick={() => useAppStore.getState().swapPanes()} title="두 칸 자리 바꾸기"
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-indigo-600 transition-colors">
                <ArrowLeftRight size={16} />
              </button>
              <button onClick={() => useAppStore.getState().closePane(slot)} title="이 칸 닫기 (프로젝트는 그대로 남아요)"
                className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-red-500 transition-colors">
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Preview Modal */}
      {previewItem && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in" onClick={() => setPreviewItem(null)}>
          <div className="bg-white dark:bg-[#1c1c1e] rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
            <div className="aspect-video bg-black rounded-t-2xl overflow-hidden">
              <VideoPlayer sources={playbackChain(previewItem)} failPoster={posterSrcFor(previewItem)} className="w-full h-full" eager is4k={previewItem.usedSettings?.resolution === '4k'} />
            </div>
            <div className="p-6 space-y-4">
              <div>
                <p className="text-[11px] font-semibold text-indigo-500 uppercase tracking-wider">{project.name}</p>
                <p className="text-[15px] text-gray-800 mt-1 leading-relaxed whitespace-pre-wrap">{previewItem.promptText || '프롬프트 없음'}</p>
              </div>
              {(previewItem.usedAssets?.length > 0 || (previewItem.usedElementImages as any)?.length > 0) && (
                <div>
                  <p className="text-[12px] font-semibold text-gray-500 mb-2">래퍼런스</p>
                  <div className="flex gap-2 flex-wrap">
                    {(previewItem.usedAssets || []).map((a: any, i: number) => (
                      <div key={i}
                        title={a.type === 'image_url' ? `${a.file_name || '이미지'} · 우클릭: 이미지 복사` : undefined}
                        onContextMenu={(e) => {
                          if (a.type !== 'image_url') return;
                          e.preventDefault();
                          copyImageToClipboard([
                            { src: a.cacheId && `/api/cache/${a.cacheId}`, original: true },
                            { fromPath: a.originalPath, expect: a.cacheId, original: true },
                            { src: a.url }, { src: a.thumbnailUrl },
                          ], a.file_name || '이미지');
                        }}
                        className="w-16 h-16 rounded-lg overflow-hidden border border-gray-200 bg-gray-50">
                        {a.type === 'image_url' ? (
                          <HoverZoom className="block w-full h-full" src={a.url} fullSrc={a.cacheId ? `/api/cache/${a.cacheId}` : undefined}>
                            <img src={a.url} className="w-full h-full object-cover cursor-zoom-in" />
                          </HoverZoom>
                        ) : a.type === 'video_url' && a.thumbnailUrl ? (
                          // thumbnail is a square crop → pass the clip so the zoom keeps aspect
                          <HoverZoom className="block w-full h-full" src={a.thumbnailUrl} videoSrc={a.cacheId ? `/api/cache/${a.cacheId}` : undefined}>
                            <img src={a.thumbnailUrl} className="w-full h-full object-cover cursor-zoom-in" />
                          </HoverZoom>
                        ) : a.type === 'video_url' && a.cacheId ? (
                          <HoverZoom className="block w-full h-full" src="" videoSrc={`/api/cache/${a.cacheId}`}>
                            <div className="w-full h-full flex items-center justify-center text-gray-400 cursor-zoom-in"><Video size={20} /></div>
                          </HoverZoom>
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-gray-400">{a.type === 'audio_url' ? <Music size={20} /> : <Video size={20} />}</div>
                        )}
                      </div>
                    ))}
                    {((previewItem.usedElementImages as any) || []).map((ei: any) => {
                      const meta = CATEGORY_META[ei.category as AssetCategory] || { border: 'var(--cat-fallback-border)' };
                      const full = elementImageUrlById.get(`${ei.elementId}__${ei.imageId}`);
                      return (
                        <div key={ei.id} title={`${ei.name} · 우클릭: 이미지 복사`}
                          onContextMenu={(e) => { e.preventDefault(); copyImageToClipboard([
                                      { src: full?.original, original: true }, { src: ei.libId && `/api/library/${ei.libId}`, original: true },
                                      { src: ei.cacheId && `/api/cache/${ei.cacheId}`, original: true },
                                      { src: ei.url },
                                    ], ei.name || '이미지'); }}
                          className="w-16 h-16 rounded-lg overflow-hidden bg-gray-50" style={{ border: `2px solid ${meta.border}` }}>
                          <HoverZoom className="block w-full h-full" src={ei.url} fullSrc={full?.preview && full.preview !== ei.url ? full.preview : undefined}><img src={ei.url} className="w-full h-full object-cover cursor-zoom-in" /></HoverZoom>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {previewItem.usedSettings && (
                <div className="flex flex-wrap gap-2">
                  {settingsTagList(previewItem.usedSettings, previewItem.videoUrl, previewItem.draftOf).map((tag, i) => (
                    <span key={i} className={`px-2.5 py-1 rounded-full text-[11px] font-medium ${tagTone(tag, 'bg-gray-100 text-gray-600')}`}>{tag}</span>
                  ))}
                </div>
              )}
              {/* 상세는 좁은 카드가 아니므로 초 단위까지 그대로 보여준다 */}
              <div className="text-[11px] text-gray-500 tabular-nums">
                생성 {formatStampFull(previewItem.timestamp)}
                {previewItem.endTime && <> · 완료 {formatStampFull(previewItem.endTime)}</>}
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-gray-100">
                <button onClick={() => { if (previewItem.videoUrl && previewItem.taskId) handleVideoDownload(previewItem.id, previewItem.videoUrl, previewItem.taskId); }}
                  className={`flex items-center gap-1.5 px-4 py-2 text-white text-[13px] font-medium rounded-lg transition-colors ${previewDownloaded ? 'bg-emerald-500 hover:bg-emerald-600' : 'bg-indigo-500 hover:bg-indigo-600'}`}>
                  {previewDownloaded ? <RefreshCw size={14} /> : <Download size={14} />} {previewDownloaded ? '다시 다운로드' : '다운로드'}
                </button>
                {previewDownloadedPath && (
                  <button onClick={() => revealDownloaded(previewDownloadedPath)} title={previewDownloadedPath}
                    className="flex items-center gap-1.5 px-4 py-2 bg-gray-100 text-gray-700 text-[13px] font-medium rounded-lg hover:bg-gray-200 transition-colors">
                    <FolderOpen size={14} /> 폴더에서 보기
                  </button>
                )}
                <button onClick={() => scrollToMessage(previewItem.id)}
                  className="flex items-center gap-1.5 px-4 py-2 bg-gray-100 text-gray-700 text-[13px] font-medium rounded-lg hover:bg-gray-200 transition-colors">
                  <Search size={14} /> 프롬프트 찾기
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 갤러리 ⇄ 채팅 전환.
          ★ 예전엔 AnimatePresence mode="wait" 로 0.15초 크로스페이드를 했는데, 메시지가 많은
          프로젝트에서 갤러리가 영영 안 뜨는 문제가 있었다. mode="wait" 는 나가는 쪽의 exit 이
          끝나야 들어오는 쪽을 마운트하는데, 채팅 서브트리(카드 48개 · DOM 15,000개)의 exit 이
          완료 신호를 못 내고 멈추었다 — 화면에는 opacity 0 인 채팅만 남고 갤러리는
          DOM 에 아예 들어오지 않는다(15초 관찰, 복구 안 됨).
          0.15초짜리 장식 때문에 기능이 멈추는 거래라 애니메이션을 뜼고 그냥 즉시 교체한다. */}
      {showGallery ? (
        <div className="flex-1 overflow-y-auto p-6 bg-[#f5f5f7] dark:bg-[#242426]">
          {gq && galleryVideos.length > 0 && (
            <p className="text-[12px] text-gray-500 mb-3">‘{gallerySearch.trim()}’ 검색 결과 <span className="font-mono">{galleryVideos.length}</span>개</p>
          )}
          {galleryVideos.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 animate-fade-in">
              {gq ? <Search size={48} className="text-gray-300" /> : <LayoutGrid size={48} className="text-gray-300" />}
              <p className="text-lg">{gq ? '검색 결과가 없습니다.'
                : starredOnly ? '채택한 컷이 없습니다.'
                : !withDrafts && draftClipCount > 0 ? `본편이 아직 없습니다 · Draft ${draftClipCount}개` : '아직 생성된 영상이 없습니다.'}</p>
              {gq && (
                <button onClick={() => setGallerySearch('')} className="text-[13px] text-indigo-500 hover:text-indigo-600 font-medium">검색 지우기</button>
              )}
              {!gq && starredOnly && (
                <button onClick={() => setStarredOnly(false)} className="text-[13px] text-indigo-500 hover:text-indigo-600 font-medium">전체 보기</button>
              )}
              {!gq && !starredOnly && !withDrafts && draftClipCount > 0 && (
                <button onClick={() => setWithDrafts(true)} className="text-[13px] text-indigo-500 hover:text-indigo-600 font-medium">Draft 보기</button>
              )}
            </div>
          ) : (
            <>
            <div className="grid grid-cols-2 xl:grid-cols-3 gap-4">
              {galleryVideos.slice(0, gallShown).map((item, idx) => (
                <div key={item.id}
                  // Same two perf levers as the all-projects gallery: only a page of cards
                  // is mounted at a time (mounting hundreds of IntersectionObservers in one
                  // frame is the open-hitch), and the browser skips painting off-screen ones.
                  style={{ contentVisibility: 'auto', containIntrinsicSize: '260px' } as any}
                  className="bg-white dark:bg-[#1c1c1e] rounded-xl shadow-sm border border-gray-200/80 overflow-hidden hover:shadow-md hover:border-gray-300 transition-all duration-200" >
                  <div className="aspect-video bg-black relative group">
                    <VideoPlayer sources={playbackChain(item)} poster={posterSrcFor(item)} posterOf={item} className="w-full h-full" is4k={item.usedSettings?.resolution === '4k'} />
                    <ClipStamp ms={item.timestamp} />
                    {/* 채택된 컷은 항상 보이고, 아닌 것은 hover 시에만 — 그리드가 조용해진다 */}
                    <button onClick={(e) => { e.stopPropagation(); toggleStar(item.id, !item.starred); }}
                      title={item.starred ? '채택 해제' : '컷 채택'}
                      className={`absolute top-2 right-2 z-10 p-1.5 rounded-full backdrop-blur-sm transition-all ${item.starred
                        ? 'bg-black/45 text-amber-400 opacity-100'
                        : 'bg-black/45 text-white/70 hover:text-amber-400 opacity-0 group-hover:opacity-100'}`}>
                      <Star size={15} className={item.starred ? 'fill-amber-400' : ''} />
                    </button>
                  </div>
                  <div className="p-3 space-y-2">
                    {/* 초안 표시는 영상 위가 아니라 글 줄에 둔다 — 썸네일 위에는 글을 얹지 않는다 */}
                    <p className="text-[11px] font-semibold text-indigo-500 flex items-center gap-1.5">
                      <span className="truncate">{project.name}</span>
                      {isDraftClip(item) && <span className="shrink-0 px-1.5 py-px rounded-full bg-amber-100 text-amber-700 text-[10px] font-medium">Draft 480p</span>}
                    </p>
                    <p className="text-[13px] text-gray-700 line-clamp-2 leading-snug h-[2.5em]">{item.promptText || '프롬프트 없음'}</p>
                    <div className="flex items-center gap-1 pt-1 flex-wrap">
                      <button onClick={() => { if (item.videoUrl && item.taskId) handleVideoDownload(item.id, item.videoUrl, item.taskId); }}
                        className={`flex items-center gap-1 text-[11px] font-medium px-1.5 py-1 rounded-md transition-colors whitespace-nowrap shrink-0 ${item.downloadedAt
                          ? 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50'
                          : 'text-gray-500 hover:text-indigo-600 hover:bg-indigo-50'}`}>
                        {item.downloadedAt ? <RefreshCw size={12} /> : <Download size={12} />} {item.downloadedAt ? '다시 다운로드' : '다운로드'}
                      </button>
                      {item.downloadedPath && (
                        <button onClick={() => revealDownloaded(item.downloadedPath)} title={item.downloadedPath}
                          className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors whitespace-nowrap shrink-0">
                          <FolderOpen size={12} /> 폴더
                        </button>
                      )}
                      <button onClick={() => setPreviewItem(item)}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors whitespace-nowrap shrink-0">
                        <Eye size={12} /> 상세
                      </button>
                      <button onClick={() => scrollToMessage(item.id)}
                        className="flex items-center gap-1 text-[11px] font-medium text-gray-500 hover:text-indigo-600 px-1.5 py-1 rounded-md hover:bg-indigo-50 transition-colors whitespace-nowrap shrink-0">
                        <Search size={12} /> 찾기
                      </button>
                      <span title={`생성 시각 ${formatStampFull(item.timestamp)}`}
                        className="text-[10px] text-gray-400 ml-auto whitespace-nowrap shrink-0 tabular-nums">{formatStamp(item.timestamp)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {galleryVideos.length > gallShown && (
              <div ref={gallSentinelRef} className="py-6 flex items-center justify-center gap-2 text-[12px] text-gray-400">
                아래로 스크롤하면 {galleryVideos.length - gallShown}개 더
              </div>
            )}
            </>
          )}
        </div>
      ) : (
        // Wrapper reproduces what the bare fragment used to contribute to the parent flex
        // column: the messages pane stays the flexible child, the composer stays pinned.
        // min-h-0 is load-bearing — without it the overflow-y-auto child refuses to shrink.
        <div className="flex-1 flex flex-col min-h-0">
          {/* Messages */}
          <div ref={messagesScrollRef} onScroll={handleMessagesScroll} className="flex-1 overflow-y-auto p-6 space-y-5 bg-[#f5f5f7] dark:bg-[#242426]">
            {displayMessages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-3 animate-fade-in">
                {headerSearch ? <><Search size={44} className="text-gray-300" /><p className="text-lg">검색 결과가 없습니다.</p></> : <><Play size={44} className="text-gray-300" /><p className="text-lg">프롬프트를 입력하여 영상을 생성하세요.</p></>}
              </div>
            ) : (
              displayMessages.map((msg, idx) => (
                <MessageCard key={msg.id} msg={msg} projectId={project.id}
                  divider={idx === newDividerIdx} dividerCount={idx === newDividerIdx ? newDividerCount : 0}
                  draftOther={msg.draftOf ? draftByTaskId.get(msg.draftOf) : undefined}
                  finalOther={isDraftClip(msg) && msg.taskId ? finalOfDraft.get(msg.taskId) : undefined}
                  elementImageUrlById={elementImageUrlById}
                  isGenerating={isGenerating && (msg.status === 'succeeded' || msg.status === 'failed')}
                  actions={cardActions} />
              ))
            )}
            <div ref={messagesEndRef} />

            {showScrollBottom ? (
              <button onClick={scrollToBottom} className="sticky bottom-4 float-right mr-2 flex items-center gap-1.5 px-3 py-2 bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-sm border border-gray-200 rounded-full shadow-lg text-[12px] font-medium text-gray-500 hover:text-indigo-600 hover:border-indigo-300 transition-all z-20">
                <ArrowDown size={14} /> 맨 아래로
              </button>
            ) : showScrollTop ? (
              <button onClick={scrollToTop} className="sticky bottom-4 float-right mr-2 flex items-center gap-1.5 px-3 py-2 bg-white/95 dark:bg-[#1c1c1e]/95 backdrop-blur-sm border border-gray-200 rounded-full shadow-lg text-[12px] font-medium text-gray-500 hover:text-indigo-600 hover:border-indigo-300 transition-all z-20">
                <ArrowUp size={14} /> 맨 위로
              </button>
            ) : null}
          </div>

          {/* Input */}
          <div className="p-4 bg-white dark:bg-[#1c1c1e] border-t border-gray-200/80 shrink-0 relative">
            {/* Resize grabber — sits above the prompt box */}
            <div className="max-w-4xl mx-auto flex justify-center mb-1.5">
              <div
                onMouseDown={handlePromptResize}
                title="드래그해서 크기 조절"
                className="h-1.5 w-14 rounded-full bg-gray-300 hover:bg-indigo-400 active:bg-indigo-500 cursor-ns-resize transition-colors"
              />
            </div>

            {/* ★ Anchored to the PROMPT BOX, not to this bar.
                The bar is full width; the prompt box inside it is max-w-4xl mx-auto, i.e.
                centred. `left-4` on an absolute child therefore measured from the bar's
                edge, so the menu stayed pinned to the far left while the box it belongs to
                drifted to the middle — visible on any window wider than ~896px + sidebar,
                and not related to reopening the pane or clearing the prompt.
                Re-using the same max-w-4xl mx-auto wrapper keeps the two aligned by
                construction, so changing the prompt width can't desync them again. */}
            {mentionState.active && filteredMentionAssets.length > 0 && (
            <div className="absolute bottom-full inset-x-0 px-4 mb-2 z-50 pointer-events-none">
              <div className="max-w-4xl mx-auto flex">
              <div className="pointer-events-auto bg-white dark:bg-[#1c1c1e] border border-gray-200 rounded-xl shadow-xl overflow-hidden min-w-[250px] animate-slide-up">
                {(() => {
                  const panelImgs = project.assets.filter(a => a.type === 'image_url').length;
                  const elemImgs = elementMentionEnabled ? mentionedElementStats().count : 0;
                  const used = panelImgs + elemImgs;
                  const imgCap = modelImageMax(project.settings.model);
                  return (
                    <div className="px-3 py-2 bg-gray-50 border-b border-gray-100">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-gray-500">에셋 선택</span>
                        {elementMentionEnabled && <span className={`font-semibold tabular-nums ${used > imgCap ? 'text-red-500' : used === imgCap ? 'text-amber-600' : 'text-gray-400'}`} title={`래퍼런스 패널 이미지 + 멘션한 어셋 이미지 합산 (최대 ${imgCap}장)`}>이미지 {used}/{imgCap}</span>}
                      </div>
                      {boundCollectionName && <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-600 mt-1 truncate" title="현재 채팅에 사용 중인 어셋 컬렉션"><FolderOpen size={10} className="shrink-0" /> {boundCollectionName}{elementMentionEnabled ? ` · 패널 ${panelImgs} + 어셋 ${elemImgs}` : ''}</div>}
                    </div>
                  );
                })()}
                <div className="max-h-48 overflow-y-auto">
                  {filteredMentionAssets.map((item, idx) => (
                    <button key={(item.kind === 'element' ? 'el-' : 'as-') + item.id} onClick={() => insertMention(item)}
                      className={`mention-item w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-indigo-50 transition-none ${idx === mentionIndexRef.current ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'}`}>
                      {item.kind === 'element' ? (
                        item.thumbnailUrl
                          ? <img src={item.thumbnailUrl} className="w-6 h-6 object-cover rounded shrink-0 border border-gray-200" alt="" />
                          : <div className="w-6 h-6 flex items-center justify-center rounded shrink-0" style={{ background: CATEGORY_META[item.category].bg }}><span className="w-2 h-2 rounded-full" style={{ background: CATEGORY_META[item.category].accent }} /></div>
                      ) : (
                        item.type === 'image_url' && (item.thumbnailUrl || item.url) ? <img src={item.thumbnailUrl || item.url} className="w-6 h-6 object-cover rounded shrink-0 border border-gray-200" alt="" /> : item.type === 'image_url' ? <div className="w-6 h-6 bg-blue-50 flex items-center justify-center rounded shrink-0"><ImageIcon size={14} className="text-blue-500" /></div> : item.type === 'video_url' ? <div className="w-6 h-6 bg-purple-50 flex items-center justify-center rounded shrink-0"><Video size={14} className="text-purple-500" /></div> : <div className="w-6 h-6 bg-green-50 flex items-center justify-center rounded shrink-0"><Music size={14} className="text-green-500" /></div>
                      )}
                      <span className="font-medium">[{item.name}]</span>
                      <span className="text-xs ml-auto" style={item.kind === 'element' ? { color: CATEGORY_META[item.category].text } : { color: '#9ca3af' }}>{item.kind === 'element' ? CATEGORY_META[item.category].name : (item as any).role}</span>
                    </button>
                  ))}
                </div>
              </div>
              </div>
            </div>
            )}

            {/* 받은 영상을 불러온 결과 — 닫기를 눌러야 닫힌다(무엇이 빠졌는지 보고 손볼 때까지 남아 있게). */}
            {restoreReport && (
              <div data-restore-report className="max-w-4xl mx-auto mb-2 text-[13px] bg-white dark:bg-[#1c1c1e] border border-gray-200 rounded-xl px-3 py-1.5 shadow-sm">
                {/* 한 줄: 무엇을 했는지 · 어디서 — 버튼. 빠졌거나 다른 것이 있을 때만 그 아래 짧은 줄로. */}
                <div className="flex items-center gap-2 min-w-0">
                  {restoreReport.missing.length > 0
                    ? <AlertCircle size={14} className="shrink-0 text-amber-500" />
                    : <Check size={14} className="shrink-0 text-emerald-500" />}
                  <span className="shrink-0 font-semibold text-gray-800 dark:text-gray-100">{restoreReport.how === 'restore' ? '그때 설정 그대로 불러왔어요' : '프롬프트를 불러왔어요'}</span>
                  <span className="min-w-0 truncate text-gray-400" title={restoreReport.sourceTitle}>{restoreReport.source}</span>
                  <div className="ml-auto flex items-center gap-3 shrink-0 text-[12px]">
                    {restoreReport.how === 'paste' && (
                      <button onClick={() => { const r = restoreReport; void applyRestore(r.target, r.local, r.snapshot); }}
                        title="모델 · 파라미터 · 어셋 컬렉션까지 이 영상을 만든 그대로 다시 불러와요"
                        className="font-semibold text-violet-600 hover:underline">그때 설정 그대로</button>
                    )}
                    <button onClick={() => { void undoRestore(restoreReport.snapshot); }}
                      title="불러오기 직전의 작성 칸 · 레퍼런스 · 오른쪽 설정으로 되돌려요"
                      className="text-gray-500 hover:text-gray-800 hover:underline">되돌리기</button>
                    {restoreReport.local && (
                      <button onClick={() => { const l = restoreReport.local!; setRestoreReport(null); if (showGallery) exitGallery(); requestFindMessage(l.projectId, l.msg.id); }}
                        className="text-gray-500 hover:text-gray-800 hover:underline">카드로 가기</button>
                    )}
                    <button onClick={() => setRestoreReport(null)} className="text-gray-400 hover:text-gray-700" title="닫기"><X size={14} /></button>
                  </div>
                </div>
                {(restoreReport.missing.length > 0 || restoreReport.notes.length > 0) && (
                  <ul className="mt-0.5 mb-0.5 pl-[22px] space-y-0.5 text-[12px]">
                    {restoreReport.missing.map((m, i) => <li key={'m' + i} className="text-amber-700 dark:text-amber-400 break-words">{m}</li>)}
                    {restoreReport.notes.map((m, i) => <li key={'n' + i} className="text-gray-500 break-words">{m}</li>)}
                  </ul>
                )}
              </div>
            )}
            <div ref={composerBoxRef} className="max-w-4xl mx-auto relative flex flex-col gap-2 bg-gray-50 border-2 border-gray-200 rounded-2xl p-2 focus-within:border-indigo-400 focus-within:bg-white dark:focus-within:bg-[#1c1c1e] transition-all duration-200">
              <AnimatePresence>
              {(omniFramesOn || (!isOmni && (project.settings.mode === 'image_to_video_first' || project.settings.mode === 'image_to_video_first_last'))) && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: 'easeInOut' }} className="overflow-hidden">
                <div className="flex gap-3 px-2 pt-2 pb-1">
                  {/* Start Frame */}
                  <div className="relative w-20 h-20 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center overflow-hidden group hover:border-indigo-400 transition-colors bg-white dark:bg-[#1c1c1e]">
                    {project.assets.find(a => a.role === 'first_frame') ? (
                      <>
                        <img src={(project.assets.find(a => a.role === 'first_frame') as any)?.thumbnailUrl || project.assets.find(a => a.role === 'first_frame')?.url} className="w-full h-full object-cover" />
                        <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <button onClick={() => removeAsset(project.id, project.assets.find(a => a.role === 'first_frame')!.id)} className="text-white bg-red-500 p-1 rounded-full hover:bg-red-600"><X size={12} /></button>
                        </div>
                        <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] text-center py-0.5">시작</div>
                      </>
                    ) : (
                      <>
                        <input type="file" accept="image/*" onChange={(e) => handleFrameUpload(e, 'first_frame')} onDrop={(e) => handleFrameDrop(e, 'first_frame')} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }} className="absolute inset-0 opacity-0 cursor-pointer" />
                        <ImageIcon className="text-gray-400 mb-0.5" size={16} />
                        <span className="text-[9px] text-gray-400 text-center px-1">시작 프레임</span>
                      </>
                    )}
                  </div>
                  {/* End Frame */}
                  {(omniEndFrameOn || (!isOmni && project.settings.mode === 'image_to_video_first_last')) && (
                    <div className="relative w-20 h-20 border-2 border-dashed border-gray-300 rounded-xl flex flex-col items-center justify-center overflow-hidden group hover:border-indigo-400 transition-colors bg-white dark:bg-[#1c1c1e]">
                      {project.assets.find(a => a.role === 'last_frame') ? (
                        <>
                          <img src={(project.assets.find(a => a.role === 'last_frame') as any)?.thumbnailUrl || project.assets.find(a => a.role === 'last_frame')?.url} className="w-full h-full object-cover" />
                          <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                            <button onClick={() => removeAsset(project.id, project.assets.find(a => a.role === 'last_frame')!.id)} className="text-white bg-red-500 p-1 rounded-full hover:bg-red-600"><X size={12} /></button>
                          </div>
                          <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[9px] text-center py-0.5">끝</div>
                        </>
                      ) : (
                        <>
                          <input type="file" accept="image/*" onChange={(e) => handleFrameUpload(e, 'last_frame')} onDrop={(e) => handleFrameDrop(e, 'last_frame')} onDragOver={e => { e.preventDefault(); e.stopPropagation(); }} onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }} className="absolute inset-0 opacity-0 cursor-pointer" />
                          <ImageIcon className="text-gray-400 mb-0.5" size={16} />
                          <span className="text-[9px] text-gray-400 text-center px-1">끝 프레임</span>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {isOmni && (
                  modelHasFirstLastFrame(project.settings.model)
                    ? <p className="px-2 pb-1 text-[10px] text-gray-400 leading-snug">시작·끝 프레임을 모두 넣으면 두 프레임 사이를 이어주는 영상이 만들어져요.</p>
                    : <p className="px-2 pb-1 text-[10px] text-amber-600 leading-snug">⚠ 이 모델에서 끝 프레임은 <b>비공식</b> 기능 — 참조 방식으로 유도하며 정확한 보간은 보장되지 않아요. Omni 1.1로 바꾸면 공식 기능으로 동작합니다.</p>
                )}
                </motion.div>
              )}
              </AnimatePresence>
              <div className="flex items-end gap-2 w-full">
                <div ref={promptScrollRef} style={{ maxHeight: `min(${promptHeight}px, 70vh)` }} className="w-full overflow-y-auto">
                  <div ref={contentEditableRef} contentEditable onInput={handleInput} onKeyDown={handleKeyDown} onPaste={handlePromptPaste} onCopy={handlePromptCopy} onCut={handlePromptCut}
                    style={{ minHeight: 44 }}
                    className="w-full bg-transparent border-none focus:ring-0 resize-none py-2 px-3 text-[16px] text-[#1d1d1f] dark:text-gray-900 outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-gray-400"
                    data-placeholder="영상을 설명해주세요... (@로 에셋 멘션)" />
                </div>
                {/* 초안 모드면 버튼에 '초안' 을 붙인다. 설정 패널을 접어 두고 쓰는 사람도 지금 보내는
                    것이 480p 초안인지 전송 직전에 알 수 있어야 한다. */}
                <button onClick={handleSend} disabled={!hasText || isGenerating || needsBillingSelection}
                  title={needsBillingSelection ? '프로젝트를 먼저 선택하세요' : sendAsDraft ? 'Draft (480p) — 마음에 들면 카드에서 1080p 본편을 만듭니다' : '전송'}
                  className={`shrink-0 flex items-center gap-1.5 bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed text-white p-2.5 rounded-xl transition-all duration-200 mb-0.5 mr-0.5 active:scale-95 ${sendAsDraft ? 'px-3' : ''}`}>
                  {isGenerating ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                  {sendAsDraft && <span className="text-[13px] font-semibold leading-none">Draft</span>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
