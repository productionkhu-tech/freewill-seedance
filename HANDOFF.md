# Freewill Seedance 2.0 — 세션 인수인계 (2026-05-15 기준)

이 문서는 **이전 에이전트가 한 작업 + 우리 사이에 굳어진 규칙 + 발견한 함정**을 다음 에이전트가 30분 안에 흡수할 수 있게 정리한 핸드오프 노트.

핵심 기술 참조는 같은 폴더의 SKILL 파일 (`.claude/skills/freewill-seedance/freewill-seedance_SKILL.md`)이 자동 로드됨. 이 HANDOFF.md는 그 위에 얹는 **세션 컨텍스트 + 사용자 톤 + 불변 규칙**.

---

## 0. 가장 먼저 알아야 할 것

| 항목 | 값 |
|------|------|
| 프로젝트 위치 | `C:\Users\user\Desktop\기획 파일\TA\앱개발\시댄스 api\26.04.15\` |
| GitHub | https://github.com/productionkhu-tech/freewill-seedance (Public) |
| 현재 버전 | **v26.5.1301** (2026-05-13 배포) |
| 사용자 | 김현우 / Studio Freewillusion TA |
| 사용자 환경 | Windows + git-bash, PowerShell. Python 3, Node 22+ |
| 작업 디렉토리 | 코드는 절대 경로 사용. `cd` 거의 안 함 |

---

## 1. 최근 변경 이력 (요약, 신순)

| 버전 | 날짜 | 핵심 변경 |
|------|------|----------|
| **26.5.1301** | 05-13 | **originalPath fallback** — `webUtils.getPathForFile` 캐처 + `/api/reupload-from-path` 엔드포인트. media-cache 미스 시 원본 파일 디스크 재읽기. 새 GH_TOKEN으로 첫 배포 |
| 26.5.408 | 05-04 | **media-cache → userData 이전** — auto-update 시 resources/ wipe 문제 해결 |
| 26.5.407 | 05-04 | **handleReuse atomic** — `replaceAllAssets` 신설. clearAssets+N×addAsset 패턴이 2× 중복 유발하던 거 차단 |
| 26.5.406 | 05-04 | **과거 메시지 스냅샷 완전 격리** — thumbAssets에서 비디오 url 보존, 사이드 썸네일은 `<img>`, fallback 제거 |
| 26.5.405 | 05-04 | **CRITICAL: 과거 메시지 멘션을 snapshot으로** — 옛날엔 live namedAssets 참조해서 replace 시 과거 메시지 다 같이 변형됨 |
| 26.5.404 | 05-04 | 비디오 첫 프레임 썸네일 + 글로벌 drag-drop replace |
| 26.5.403 | 05-04 | edit_video 비디오 교체 (`replaceAsset` 신설, id 보존) |
| 26.5.402 | 05-04 | 멀티 파일 피커 (multiple=true) |
| 26.5.401 | 05-04 | **크레딧 트래커 통합** — 영상 성공 시 GAS POST. 팀명은 SEEDANCE_API_KEY SHA-256 해시로 자동 |
| 26.4.2404 | 04-24 | 호버 재생 시 currentTime 보존 (rewind 안 함) |
| 26.4.2403 | 04-24 | 호버 시 재생 + 소리 ON 기본 |
| 26.4.2402 | 04-24 | 리사이즈 핸들 maxHeight 의미로 (default 160) |
| 26.4.2401 | 04-24 | 긴 프롬프트 커서 자동 스크롤 (contentEditable 한계 우회) |
| 26.4.2203 | 04-21 | **Files API 롤백** — 비디오도 tmpfiles로 복귀 |
| 26.4.2202 | 04-21 | Files API fallback (실패) |
| 26.4.2201 | 04-21 | Files API 시도 (실패) |
| 26.4.2101 | 04-21 | **4 critical fixes**: pollTask hang(8s timeout), bad response caching, 5s 다운 짤림(5min), tmpfiles 무한 대기(60s) |

---

## 2. 폐기된 시도 (다시 시도 금지)

### ❌ BytePlus Files API
v26.4.2201/2202에서 비디오만 BytePlus `/api/v3/files`로 보내려 함. 실패. 2203에서 롤백.

2026-05-13 재조사 결과 **근본적으로 불가능**:
- Files API는 **Responses API**용 (영상 *이해*, 모델 `seed-1-6-...`)
- Seedance 생성 API (`/contents/generations/tasks`, 모델 `dreamina-seedance-2-0-...`)는 **`file_id` 필드 자체를 받지 않음**
- 공식 튜토리얼(`ModelArk_Seedance 2.0 series tutorial.md`)이 명시: `image_url.url` / `video_url.url` / `audio_url.url` — 공개 URL만
- 공식 권장 대안: BytePlus TOS object storage (유료)

→ tmpfiles는 처음부터 올바른 선택이었음. 502 자주 뜨면 BytePlus TOS로 이전이 정공법.

### ❌ 워터마크 위조 / 실사 사람 필터 우회
BytePlus가 Seedream T2I 결과물의 invisible watermark로 실사 사람 감지 통과시킴. 키 없이 위조 불가능(SHA-256급 암호 서명). 시도 금지 (가이드라인 외 + 법적 리스크).

### ❌ 이미지 base64 inline 전환
한 번 검토함. 9개 30MB 이미지 = 360MB base64 → 64MB BytePlus 한도 초과. + IndexedDB 비대화. tmpfiles 유지가 정답.

---

## 3. 불변 규칙 (어기면 사용자 보고된 버그가 다시 살아남)

### 데이터 무결성
- **이미지/비디오/오디오 압축·리사이즈·재인코딩 금지**. 원본 바이트 그대로 전송
- **썸네일은 별도 필드** (`thumbnailUrl`, base64). 원본 `url` 절대 덮어쓰지 말 것 (v26.5.406 교훈)

### 과거 메시지 렌더링
- **`msg.usedAssets` 스냅샷만** 사용. `project.assets` / `namedAssets` (live) 절대 X
- `renderMessageContent(promptText, getAssetNames(msg.usedAssets || []))` 패턴
- thumbAssets 빌드 시 **이미지 url만** thumbnail로 교체, 비디오 url은 보존
- 사이드 비디오 썸네일은 `<img src={thumbnailUrl}>` (양상 `<video>` element 금지)

### 멘션 시스템
- pill에 `data-asset-id` (UUID) 박기
- 에셋 교체는 **반드시 `replaceAsset(id, updates)`** — id 보존 → 멘션 안 끊김
- 에셋 일괄 교체는 **`replaceAllAssets(projectId, assets)`** — atomic 단일 set() (race 차단)

### 캐시 계층
- **media-cache는 `app.getPath('userData')/media-cache`** — `MEDIA_CACHE_DIR` env로 server.ts에 주입
- 절대로 `process.cwd()` / `process.resourcesPath` 기준 X (auto-update wipe됨)
- 30일 자동 정리 (서버 시작 시)
- **원본 경로(`originalPath`) fallback**: media-cache 미스 시 디스크에서 재읽기

### 폴링
- `setInterval(10s)` 만 (setTimeout 체인 금지)
- `_pollingSet` 으로 중복 차단
- 8초 AbortController timeout (응답 hang 방지)
- HTTP 5xx 시 status 안 바꿈 (다음 cycle 재시도)
- `finally` 블록에서 항상 set 비움

### 버전 / 배포
- 버전 형식: **26.M.XXYY** (M=월, XX=일, YY=패치)
- **하이픈 금지** (semver 프리릴리스로 인식 → auto-update 깨짐)
- **leading zero 금지** — 일자 1~9는 한자리로 (예: 5월 4일 = `26.5.4XX`, 5월 13일 = `26.5.13XX`)
- 모든 fix → bump + commit + push + electron-builder publish (한 번에)
- 빌드 후 **키 노출 grep 검증** 필수
- 버전 갱신 2곳: `package.json` + `src/App.tsx`

### API 키 보안
- `SEEDANCE_API_KEY` 환경변수 only, 코드 하드코딩 절대 X
- 팀명은 **SHA-256 해시 매핑** (server.ts `TEAM_KEY_HASHES`) — 원본 키 EXE에 안 들어감
- `GH_TOKEN` inline export (배포 시점에만)

---

## 4. 운영 절차

### 배포 명령어 (한 번에)
```bash
cd "C:/Users/user/Desktop/기획 파일/TA/앱개발/시댄스 api/26.04.15"
# 1) package.json + src/App.tsx 버전 동시 변경
# 2) git add 변경파일 → commit → push
# 3) 빌드 + 키 검증 + publish
export GH_TOKEN="<사용자가 보관하는 토큰 — 평문 기록 금지>"
SEEDANCE_API_KEY=test node scripts/build.cjs
grep -c "ccc0f342\|ef3aaa5c\|3b9715e5\|1654a923\|429c43a3\|32a18b43\|f1148313\|83f240c3\|e18a3821\|6b26237c\|2de035f8\|9e081469\|9a7cd59c" dist-server/server.cjs  # 0이어야 함
npx electron-builder --win --publish always
```

### 키 매핑 (server.ts에 SHA-256으로 박힘)
| 팀명 | API 키 첫 8자 |
|------|--------------|
| 1팀 | ccc0f342 |
| 2팀 | ef3aaa5c |
| 3팀 | 3b9715e5 |
| 4팀 | 1654a923 |
| 5팀 | 429c43a3 |
| 6팀 | 32a18b43 |
| 7팀 | f1148313 |
| 8팀 | 83f240c3 |
| 9팀 | e18a3821 |
| 10팀 | 6b26237c |
| AFX팀 | 2de035f8 |
| 2D팀 | 9e081469 |
| Special팀 | 9a7cd59c |

원본 매핑: `C:\Users\user\Desktop\기획 파일\TA\앱개발\시댄스 api\api key\key.xlsx`

### 외부 의존
- 트래커 GAS: `https://script.google.com/macros/s/AKfycbyC53V4K-CHJnP86qIbBP0WmXZ4cDD9D3CFVmd8otL4ZThzpQ7RKhnCeIXgDu4y7CFrnQ/exec`
- 대시보드 = 위와 동일 URL (GET하면 HTML)
- tmpfiles.org (이미지/비디오/오디오 모두 여기)
- BytePlus `ark.ap-southeast.bytepluses.com/api/v3`

---

## 5. 사용자 톤 / 소통 가이드 (중요)

### 짧은 동의 = 진행 OK
- "ㅇㅇ", "오케이", "ㄱㄱ", "배포해", "맞음" → 바로 작업
- 매번 "정말 진행할까요?" 묻지 말 것

### 명시적 분석 요청
- "체크해바", "테스트해바", "조사해", "분석해", "배포하지 말고" → **분석만 하고 작업 X**
- "지금 바꾸지 말고" → 코드 수정 보류

### 우선순위
- **새 기능보다 기존 버그 수정이 우선**
- **사용자가 직접 보는 결과물** (영상, 다운로드, 프리뷰) 깨지는 거 1순위
- 코드 품질 / 리팩터는 그 다음

### 의심 키워드 매핑
- "영상", "다운로드", "프리뷰" → blobCache 시스템 의심
- "멘션", "@", "Image 1" → 멘션 pill 시스템
- "재사용", "프롬프트 로드", "불러오기" → handleReuse + 스냅샷
- "캐시", "정리", "삭제" → CACHE_DIR / blobCache 구분
- "백지", "안 뜸" → 서버 시작 실패 (env var 미설정 가능성)
- "504", "502" → 외부 서비스 (GitHub / tmpfiles) 일시 장애

### 보고 / 답변 스타일
- **결론 먼저, 근거 나중**
- 표 / 카테고리 / 우선순위로 구조화
- **정직하게 한계 인정** (모르면 모른다, 추측이면 추측이라 명시)
- 사용자가 권장하지 않은 작업은 임의로 안 함
- 같은 경고 반복 금지 (예: 키 노출 경고는 같은 세션에서 한 번만)

---

## 6. 알려진 한계 / 미해결

### 한계
1. **v26.5.1301 이전 첨부분은 originalPath 없음** → 캐시 wipe 시 복구 불가, 재첨부 필요
2. **tmpfiles 502 가끔 발생** — fire-and-forget 재시도로 견딤. 빈도 심해지면 BytePlus TOS 이전 고려
3. **GitHub release 공개 다운로드 프록시 가끔 504** — install.bat은 API 경로로 우회하게 강화됨 (2026-05-15)
4. **6팀 사용자 백지 보고** (2026-05-04) — 진단 미완료. DevTools 콘솔 로그 받으면 추적 가능

### 의도적으로 안 한 것
- 이미지 base64 inline (IndexedDB 비대화 우려)
- BytePlus Files API (생성 엔드포인트 호환 안 함)
- 1080p UI 활성화 (계정 미지원)
- 워터마크 위조 (불가능 + 가이드라인 외)

---

## 7. 사용자가 보유한 토큰 / 키 (현재 유효)

- **GH_TOKEN**: 사용자 로컬 환경 또는 비밀 저장소에 보관 (이 문서에는 평문 기록 금지 — 2026-05-18 GitHub secret scanning 차단 사건 이후 정책)
  - 가장 최근 발급분 2026-05-13 (만료 없음). 사용자에게 직접 요청해서 받기
  - 권한 과다 (admin:* 등). 보안 강화 원하면 `public_repo` 만으로 재발급 권장
- **SEEDANCE_API_KEY**: 사용자 PC에 setx로 팀별 다르게 설정 (.bat 파일 13개)

---

## 8. 다음 에이전트의 첫 행동

사용자가 "시댄스" / "Seedance" / "BytePlus" / "영상 생성" 키워드로 말걸면:

1. **SKILL 자동 로드 확인** (description 매칭으로 자동)
2. **이 HANDOFF.md 한 번 읽기** (`Read C:\Users\user\Desktop\기획 파일\TA\앱개발\시댄스 api\26.04.15\HANDOFF.md`)
3. 사용자 요청 분석 → 수정 / 분석 모드 판단
4. 수정이면 위 4번 (운영 절차) 배포 매뉴얼 따름
5. 분석이면 결과만 보고

### 작업 시 항상 체크
- TodoWrite로 진행 추적 (3단계 이상이면)
- 빌드 검증 (`SEEDANCE_API_KEY=test node scripts/build.cjs`)
- 키 노출 grep
- 버전 번호 한자리 일 확인 (leading zero 금지)
- 커밋 메시지에 "왜" 명시

---

**마지막 업데이트**: 2026-05-15, 이전 에이전트의 마지막 작업.
**다음 갱신 시점**: 새 버전 배포 / 새 규칙 발견 / 폐기 결정 시.
