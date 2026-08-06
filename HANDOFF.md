# Freewill Seedance 2.0 — 인수인계

> 최종 정리: **2026-08-03** / 배포 버전 **26.8.305**
> 이 문서 하나로 인수받을 수 있게 쓴다. 시간순 기록이 아니라 **주제별**이다.
> 여기 적힌 숫자는 전부 실측이다. 확인 못 한 것은 "미확인"이라고 명시한다.
>
> **곁 문서**: [`CREDIT.md`](CREDIT.md) — 크레딧(토큰) 계산 기준. 토큰 공식·해상도 상수·
> **task ID만으로 입력영상 유무를 판별해 요율을 고르는 법**·트래커 로깅 개선점. (2026-08-03 실측)

---

## 0. 5분 요약

BytePlus Seedance + Gemini Omni Flash 로 영상을 만드는 사내 도구.

| | |
|---|---|
| **윈도우** | Electron 패키지 EXE. NSIS 설치, 자동 업데이트(GitHub Releases) |
| **맥** | EXE 없음. **소스에서 로컬 웹앱**으로 실행 (`start.command` → `npm run dev` → `localhost:3000`) |
| 저장소 | https://github.com/productionkhu-tech/freewill-seedance (**Public**) |
| 데이터 | IndexedDB + `~/Documents/Freewill Seedance Backup/` 파일 미러 |

**공개 저장소다.** 키·토큰·2.5 데모 엔드포인트 ID 를 코드나 문서에 절대 넣지 마라.
(2026-05-18 GitHub secret scanning 에 막힌 적 있음. 그 뒤로 평문 금지가 정책.)

---

## 1. 구조

```
프론트 (React 19 + Vite + Zustand + Tailwind + motion)
    ↕ localhost:3000        ── modelProvider() 로 두 갈래 ──
서버 (Express, server.ts)
    ├ [시댄스] BytePlus async task+poll · Cloudflare R2(에셋) · BytePlus CDN(영상)
    └ [옴니]   Google Interactions API(동기) · Google Files API · media-cache/
윈도우만: Electron main(electron/main.cjs) ← preload
```

**서버는 두 플랫폼 모두에서 돈다.** 윈도우는 Electron 메인 프로세스가 `server.cjs` 를
`require` 하고, 맥은 `tsx server.ts` 로 직접 띄운다. 개발 모드에서는 서버가 Vite 를
미들웨어로 물어서 **한 포트(3000)** 로 앱과 API 를 같이 서빙한다.

| 파일 | 역할 |
|---|---|
| `server.ts` | Express. BytePlus/R2 중계, 옴니 프록시, media-cache, 백업 라우트, 트래커 POST |
| `src/store.ts` | Zustand + IndexedDB. `MODELS`/`modelProvider`, 그룹 트리, 이름 규칙, persist·백업 |
| `src/components/ChatArea.tsx` | 메인 UI(대형). 전송 두 갈래, 프롬프트 에디터, 갤러리, 다운로드 |
| `src/components/Sidebar.tsx` | 프로젝트/그룹 목록, 드래그, 아이콘 피커, 전체 갤러리 진입 |
| `src/components/GlobalGallery.tsx` | 전 프로젝트 클립 그리드 + 파셋 필터 |
| `src/components/SettingsPanel.tsx` | 모델·모드·해상도·듀레이션·에셋 |
| `electron/main.cjs` | 윈도우 전용. 서버 기동, 다운로드, 트레이, 자동 업데이트, 백업 IPC |
| `scripts/build.cjs` | Vite 빌드 + esbuild 로 `server.ts` → `dist-server/server.cjs` |

---

## 2. 배포와 업데이트 ★ 여기가 제일 잘 깨진다

### 2-1. 절대 바꾸면 안 되는 네 가지

| 값 | 어디 | 바꾸면 |
|---|---|---|
| `appId: com.freewill.seedance` | electron-builder.yml | NSIS 업그레이드 GUID 가 바뀐다 → **제자리 업그레이드 불가**, 프로그램 목록에 두 개 |
| `executableName: Freewill Seedance 2.0` | electron-builder.yml | exe 이름이 바뀌면 **작업표시줄 고정이 전부 깨진다**(NSIS 가 추적 못 함, 실측 확인) |
| `name: freewill-seedance` | package.json | `app.getName()` 이 이것이다 → userData 경로가 바뀌어 **프로젝트 전부 사라짐** |
| `artifactName` | electron-builder.yml | GitHub 자산 이름. 공백·비ASCII 가 들어가면 업데이터 다운로드가 깨진다 |

`productName`(표시 이름)은 바꿔도 된다. **위 넷과 독립**이라 그러라고 분리해 둔 것이다.

### 2-2. 버전 체계 — 앞자리 0 금지

```
26.M.DDPP     예) 26.8.305 = 2026-08-03 패치05
```

- **leading zero 절대 금지.** `26.8.0301` 은 invalid semver → electron-updater 가 런타임에
  파싱하다 **패키지 exe 가 부팅 즉시 크래시**한다. dev 에서는 안 잡힌다(업데이터는 패키지
  앱에서만 동작). 실제로 한 번 죽였다.
- 하이픈 금지(프리릴리스로 인식 → 업데이트 감지 실패).
- 다음 버전은 항상 이전보다 커야 한다. 달이 넘어가면 `26.7.3126` → `26.8.201` 처럼 간다.
- **버전은 두 곳**: `package.json` 과 `src/App.tsx` 하단 표시 텍스트.

### 2-3. 배포 절차

```bash
# 1) 버전 2곳 수정  2) 커밋  3) push
git push
# 4) 빌드 → 패키징 → GitHub Release 업로드
export GH_TOKEN="<사용자에게 받기 — 문서에 적지 말 것>"
SEEDANCE_API_KEY=test node scripts/build.cjs
npx electron-builder --win --publish always
```

**`npx electron-builder` 를 파이프/체이닝에 물리지 마라.** 실행이 통째로 누락된다(에러도 안
남는다). 단독 실행하고 릴리스 존재를 API 로 검증할 것.

### 2-4. 배포 후 검증 (이 5개는 매번)

```
1. 릴리스가 draft:false 이고 자산 3개(exe / .blockmap / latest.yml) 전부 uploaded
2. latest.yml 의 version 이 올린 버전
3. 자산 URL 이 HTTP 200 (실제 다운로드 가능)
4. latest.yml 의 sha512 == 로컬 exe 의 sha512
5. semver 비교: 직전 배포본보다 큰가
```

### 2-5. 남의 PC 에서 업그레이드될 때 — 확인된 것

26.7.3002 → 26.8.304 를 실제 무인 설치(`/S`)로 검증:
레지스트리 항목 **1개**(중복 설치 아님) · 구 exe 제거 · 바로가기 재타겟 · userData 무변화 ·
프로젝트 18 / 메시지 503 / 엘리먼트 41개 그대로.

구버전 상태(그룹 기능 이전, `projectGroups` 키 자체가 없음)로도 시뮬:
프로젝트·메시지 보존, `projectGroups` 가 `[]` 로 채워짐, 그 위에서 그룹 생성·갤러리·아이콘 정상.

### 2-6. ★ 맥은 이 경로를 전혀 안 탄다

맥에는 패키지 앱이 없다. **자동 업데이트도 없다.** `git pull && npm install` 이 업데이트다.
dmg 제작·서명·공증은 macOS 에서만 가능해서 윈도우 PC 에서는 만들 수 없다.

---

## 3. 플랫폼 차이 — 윈도우만 보고 판단하지 마라

| | 윈도우 (EXE) | 맥 (소스 웹앱) |
|---|---|---|
| 실행 | 설치된 exe | `./start.command` → `npm run dev` |
| 키 | 시스템 환경변수 (팀 `.bat`) | 프로젝트 폴더 `.env` (dotenv) |
| 업데이트 | 자동 | `git pull && npm install` |
| 다운로드 위치 | 지정 폴더 | 브라우저 기본 다운로드 폴더 |
| 트레이 / 폴더선택 / 캐시정리 | 있음 | 없음(버튼은 안내만) |
| 백업 | Electron IPC | **로컬 서버 HTTP** (26.8.305~) |

### 두 달간 안 드러난 사고

`package.json` 의 **`scripts` 5개와 `devDependencies` 11개가 통째로 삭제**된 채 커밋돼 있었다
(v26.7.3102, PowerShell 이 파일을 깨뜨린 부수피해). 맥은 `npm run dev` 가 유일한 실행 경로라
`Missing script: dev` 로 아무것도 못 했고, scripts 만 고쳐도 `devDependencies` 안의 **`tsx`**
가 안 깔려서 여전히 실패했다.

**이 PC 에서 안 보였던 이유**: `node_modules` 에 예전 설치분이 남아 있어 선언이 사라져도
계속 동작했다.

> **규칙: 빌드/실행 관련을 건드렸으면 깨끗한 clone 에서 한 번 돌려볼 것.**
> 로컬 `node_modules` 는 선언이 맞는지 증명해주지 않는다.

### `window.electronAPI` 를 `if` 로 감싸고 끝내지 마라

```js
if (!api?.backupSave) return;   // 브라우저에서는 이 기능이 통째로 사라진다
```

백업 미러가 정확히 이래서 **맥에서 한 번도 돌지 않았다**. 지금은 `getBackupApi()` 가
IPC/HTTP 를 골라준다. Electron 전용 기능을 새로 붙일 때는 같은 방식으로 갈라라.

---

## 4. 데이터와 백업

### 4-1. 어디에 뭐가 있나

| 대상 | 위치 |
|---|---|
| 작업 기록(프로젝트·메시지·그룹) | IndexedDB `seedance-app-storage` |
| 엘리먼트 라이브러리 | IndexedDB `seedance-elements-manifest` + `…-chunk-N` |
| 재난복구 백업 | `~/Documents/Freewill Seedance Backup/` (양 플랫폼 **같은 폴더·같은 파일명**) |
| 레퍼런스 원본 | userData/`media-cache/` |

백업 미러는 **5분 디바운스**, IndexedDB 는 **1.5초 디바운스**. IDB 가 비어 있으면 다음 실행
때 백업 파일에서 **자동 복원**된다(빈 프로필에서 실측: 18 프로젝트 / 503 메시지 /
엘리먼트 청크 19개 전부 복귀).

### 4-2. 절대 제거하면 안 되는 안전장치

1. **`_elementsHydrated` 게이트** — 라이브러리 로드 전에 백업을 쓰면 라이브러리 없는 백업으로
   좋은 백업을 덮어쓴다. 안전망이 안전망을 죽인다.
2. **엘리먼트는 전용 IDB 키 + 청크** — 메인 blob 에 두면 저장할 때마다 수백 MB 를 재직렬화한다
   (분리 전 403,000,000자 → 18,001,701자).
3. **큰 `JSON.stringify` 는 전부 try/catch** — V8 은 단일 문자열 512MB 에서 `RangeError` 를
   **동기로** 던진다. `setTimeout` 안에서 던지면 `.catch()` 로 잡을 수 없고, 저장만 조용히
   멈춘 채 앱은 멀쩡해 보인다. 백업이 이래서 일주일간 죽어 있었다.
4. **매니페스트를 마지막에 쓴다** — 그 전까지 절반 쓰인 상태는 "없는 것" 으로 취급된다.
5. **축소 가드**(26.8.306~) — 백업 파일에는 **쓰는 놈이 둘**이다. 패키지 앱(IPC,
   `electron/main.cjs`)과 브라우저(HTTP, `server.ts`). 브라우저는 자기 IndexedDB 를
   갖고 있어서, 빈 프로필이 정당한 작성자로서 전체 기록을 신규설치 상태로 덮는다.
   기존보다 **절반 이하로 줄어드는 쓰기**는 이전 파일을 `*.AUTOPREV-<시각>.json` 으로
   남기고 진행한다(최근 3개 보관). **거부가 아니라 보관**인 이유: 오래된 프로젝트 삭제는
   정당한 축소이고, §4-3 토스트가 사용자에게 권하는 바로 그 행동이다.
   **가드는 두 파일에 각각 있다** — IPC 는 `server.ts` 를 타지 않는다. 한쪽만 고치면
   반쪽만 막힌다.

### 4-3. 규모 한계 (실측)

저장 1회 = 메인스레드에서 전체 상태 `JSON.stringify` 1회.

| 메시지 | 상태 크기 | stringify |
|---:|---:|---:|
| 503 (현재) | 19MB | 40ms |
| 5,030 | 194MB | 373ms — 눈에 띄게 멈춤 |
| **13,581** | — | **RangeError = 저장 실패** |

메시지당 **39.5KB**, 그중 **프롬프트가 76%**(썸네일 아님). 현재 속도로 512MB 까지 약 7.7년.
그 시점의 해법은 상태 청크화 또는 메시지 별도 스토어. 지금은 실패 시 토스트로 알린다.

### 4-4. media-cache 는 30일 TTL 이다 (한 번 사고)

서버 시작 시 mtime 30일 초과 파일을 지운다. **메시지를 보는 것으로는 media-cache 를 읽지
않아서**(카드는 메시지에 박힌 80px 썸네일을 쓴다) "마지막 사용" 이 엉뚱한 걸 재고 있었다.

실측(수정 전): 파일 199개 중 **162개가 무참조**, 기록이 참조하는 105개 중 **68개는 이미 삭제**.
쓰레기는 붙들고 기록을 버렸다.
→ `POST /api/cache/keep` 으로 실행마다 참조 id 전체의 시계를 리셋한다. **이미 지워진 건 못 살린다.**

---

## 5. API 규칙 — 생성 요청을 만들 때

### 5-1. BytePlus (시댄스)

- 호스트 `https://ark.ap-southeast.bytepluses.com/api/v3`
  (`ap-southeast` = `ap-southeast-1`. 같은 싱가포르 서버)
- 생성 `POST /contents/generations/tasks` · 조회 `GET …/{id}` · 취소 `DELETE …/{id}`
- **CDN(생성된 영상)은 `ark-acg-…`** — 예전에 `ark-content-generation-…` 으로 착각해
  pre-warm 하다 효과 0 이었다.

**모드별 payload**

| 모드 | role 필드 | 필수 에셋 |
|---|---|---|
| `text_to_video` | 없음 | 없음 |
| `image_to_video_first` | **없음** (PDF 스펙) | 시작 프레임 1 |
| `image_to_video_first_last` | `first_frame` / `last_frame` | 시작+끝 |
| `multimodal_reference` | `reference_image/video/audio` | 이미지 0-9 · 비디오 0-3 · 오디오 0-3 |
| `edit_video` | `reference_image/video/audio` | 비디오 1 필수 |
| `extend_video` | `reference_video` | 비디오 1-3 |

**에셋 제한** (2026-06-12 공식 문서 대조 완료)

| 타입 | 개당 | 길이 | 해상도/비율 |
|---|---|---|---|
| 이미지 | 30MB | — | 각 변 300~6000px, 비율 0.4~2.5 |
| 비디오 | 50MB | 개당 2~15초, **합산 ≤15.2초** | 480/720/1080p, fps 24~60 |
| 오디오 | 15MB | 개당 2~15초, **합산 ≤15초** | — |

- 전부 R2 presigned URL 로 전달한다(base64 아님).
- **오디오 단독 불가** — 이미지나 비디오가 최소 1개 있어야 한다.
- HEIC/HEIF 는 API 는 받지만 앱이 거부한다(Chromium 이 디코드 못 해 썸네일·검증이 깨진다).

**출력**: 해상도 480p/720p/1080p/**4k** · 비율 adaptive~9:16 · duration **4~15 또는 -1(Auto)** ·
개수 1~3. **URL 은 24시간**, task 기록은 7일.

> ### ★ 프롬프트 본문의 소수 duration 명령 = internal error
> `Set the actual generation duration to 4.5 seconds.` 같은 **소수 duration 지시**가 본문에
> 있으면 BytePlus 해석기가 터진다. task 는 접수되고(cgt-…) 생성 중 failed.
> 25회 이분탐색으로 확정 — **그 한 문장만 빼면 15,000자 프롬프트도 통과**한다.
> duration 은 앱 설정으로. 본문에 쓸 거면 **정수만**.

### 5-2. 4K (2.0 플래그십 전용 + 프로젝트별 권한)

리터럴은 소문자 **`4k`**. 결과물 3840×2160 HEVC 10-bit + AAC. **토큰 196,000/초**
(5초 ≈ 98만 = 1080p 의 3.97배). duration·모드 제약 없음.

**해상도 매트릭스는 실측이다. PDF 를 믿지 마라.**

| 모델 | 480p | 720p | 1080p | 4k |
|---|:-:|:-:|:-:|:-:|
| 2.0 플래그십 | ✅ | ✅ | ✅ | **✅** |
| 2.0 fast | ✅ | ✅ | ✅(앱은 차단) | ❌ |
| 2.0 mini | ✅ | ✅ | ❌ | ✅(정책상 차단) |

권한 흐름: 시트 `Project_Status` **F열** → GAS `allow4k` → 앱 60초 폴링 → 드롭다운 노출 + 전송 클램프.

**4대 금기**
1. 하이드레이션 클램프는 `modelResolutions`(구조적)로. `allowedResolutions`(정책)로 바꾸면
   `billingProject` 가 세션 전용이라 **재시작마다 4k 설정이 날아간다**.
2. `App.tsx` 목록 비교자에 **`allow4k` 포함** — 빼면 권한만 바뀐 변경이 "무변경" 으로 판정돼
   기능이 영영 반영 안 된다.
3. 권한 감시자는 `updateProjectSettings` 를 호출하지 않는다(작성 중 방해 금지). 하향은
   **전송 시점에만**.
4. HEVC 감지는 **Main10** 으로: `canPlayType('video/mp4; codecs="hvc1.2.4.L150.B0"')`.
   8-bit 로 재면 못 트는 PC 도 "지원" 으로 나온다.

> **★ 무과금 API 프로브** — BytePlus 는 task 생성 **전에** 파라미터를 `resolution → duration
> → ratio` 순으로 검증한다. 일부러 틀린 `ratio:"99:1"` 을 안전핀으로 끼우면 task 가 절대
> 생성되지 않아 **과금 0**. 해상도 매트릭스 전체를 1원도 안 쓰고 확정했다.
> (주의: 모르는 파라미터는 조용히 무시되므로 "존재 여부" 판단에는 못 쓴다.)

### 5-3. Seedance 2.5 Demo — 정식 모델이 아니다

BytePlus 가 준 **데모 엔드포인트**. 약관이 **엔드포인트 공유 금지 / production·batch 금지 /
언제든 회수 가능**을 명시. 할당 2 concurrent / 8 RPM. **공식 문서에 2.5 는 존재하지 않는다** —
아래가 유일한 기록이고 전부 실측이다.

| | 2.0 | 2.5 Demo |
|---|---|---|
| 해상도 | 480/720/1080/4k | **480p/720p만** |
| Duration | 4~15초 | **4~30초** |
| 이미지/비디오/오디오 | 9/3/3 | **30/10/10** |
| 레퍼런스 비디오 개별·합산 | 15.2초 | **둘 다 30.2초** |

- **"네이티브 4K" 는 거짓**(1080p·2k·4k 전부 거부). **"50 에셋" 은 사실.**
- 비디오 10개는 사실상 도달 불가 — 합산 30.2초가 먼저 걸린다.
- `first_frame` 계열은 **`ratio=adaptive` 필수**.
- **프롬프트로 태스크를 재분류한다**(2.0 엔 없다). "원본 영상 그대로 사용" 류면 mode 와
  무관하게 편집 작업으로 판정돼 `ratio=adaptive` + `duration=-1` 을 강제한다. 앱이 예측
  불가(서버의 의미 해석)라 한글 안내로만 대응한다.

**★ 절대 금지 5가지**
1. 기존 모델에 능력 필드를 채우지 마라 — 폴백이 무의미해지고 오염이 시작된다.
2. `MODELS` 에서 2.5 를 빼지 마라 — 하이드레이션이 저장된 2.5 프로젝트를 2.0 으로 되돌린다.
   **노출만** 필터링할 것.
3. **엔드포인트 ID 를 클라이언트에 두지 마라** — 약관 위반 + 이 저장소는 Public.
   서버가 논리 id `seedance-2-5-demo` 를 치환한다.
4. 조회/취소 키를 서버 Map 으로 기억하지 마라 — 재시작 시 틀린 키로 영영 폴링.
5. 에셋 한도를 숫자 grep 으로 찾지 마라 — 한도는 **모델 × 모드** 두 축이다.

데모는 트래커 POST 를 스킵한다(별도 계약). 사용량은 데모 키로 BytePlus task 목록을 조회하면
그대로 감사된다.

### 5-4. Gemini Omni Flash (제2 provider)

`modelProvider(model)` 이 **유일한 갈림길**이다. `MODELS` 에 `provider:'gemini'` 가 붙은
항목만 옴니, 나머지는 byteplus.

- 엔드포인트 `POST https://generativelanguage.googleapis.com/v1beta/interactions`,
  헤더 `x-goog-api-key`. 서버 프록시 `/api/gemini/generate`.
- **동기 호출** — 한 번의 fetch 가 40~90초를 잡고 완성 URL 을 반환한다(시댄스는 비동기 폴링).
- 출력 **720p 고정**, duration 3~10초.
- 태스크 4종: `text_to_video` / `image_to_video` / `reference_to_video` / `edit`.
- 서버가 강제하는 플래그: `background=false`, `stream=false`, `store=true`(`delivery:"uri"` 의
  필수 조건). `edit` 은 duration/aspect 를 **스트립**한다(API 가 거부).
- 파일은 R2 가 아니라 **Google Files API** 로 간다(`_uploadCacheId` → 서버가 업로드 후 uri 치환).

**철칙: 옴니 코드는 시댄스 `settings.mode` 를 절대 조건으로 보지 않는다. `settings.omniTask` 만 본다.**
(mode 누수가 옴니 초기 버그의 주범이었다.)

문법이 안 섞이는 원리: 멘션은 **중립 pill**(`data-asset-id` 만)로 저장하고, **전송 순간에만**
`getPlainText()` 가 시댄스 `[Image 1]`(1-based) / 옴니 `<IMAGE_REF_0>`(0-based)로 변환한다.
저장 단계에 문법이 없으니 오염 자체가 불가능하다.
**옴니 참조영상은 위치 태그가 없다** — 프롬프트에서 "the reference video clip" 이라고
**말로** 지칭해야 반영된다(실측).

---

## 6. 기능 지도

- **프로젝트 그룹 / 하위그룹** — 딱 1단계. `groupTree()` 가 **읽을 때** 판정한다:
  "부모가 존재하고 그 부모가 스스로 최상위일 때만 하위그룹". dangling·3단·순환이 전부
  최상위로 떨어진다. **존재하는 건 반드시 도달 가능해야 한다.**
- **이름 중복** — 윈도우 폴더 원리. **컨테이너(한 화면에 같이 그려지는 목록) 하나에 이름 하나**,
  폴더와 프로젝트가 한 이름공간. 다른 폴더면 같은 이름 OK, **옮겨서 만나는 순간** `(1)`.
- **자동 번호(`Project N` / `그룹 N`)는 "개수+1" 이 아니라 "그 컨테이너에서 비어 있는 가장 작은
  번호"** (26.8.601~, `nextNumberedName`). 개수로 세면 셋 다 틀린다 — 실측 2026-08-06:
  `Project 21` 을 다른 이름으로 바꿔도 21이 안 비고 22가 나오고, `Project 5` 를 지우면
  개수가 줄어 21을 노렸다가 이미 있는 21과 부딪쳐 **`Project 21 (1)`** 이 되고, 21개 중 20개가
  폴더 안이면 최상위엔 1개뿐인데 22가 나온다(번호는 전역 개수, 중복 검사는 컨테이너별이라
  **스코프가 갈려 있었다**). 번호와 중복 검사가 **같은 목록**을 봐야 한다.
- **드래그** — HTML5 DnD 가 아니라 **포인터 이벤트**. 네이티브 DnD 는 OS 드래그 루프가 휠을
  가져가서 페이지에 `wheel` 이 **0건** 온다(실측: dragover 333 / wheel 0 → 교체 후 49).
  커서에 붙는 미리보기, 가장자리 자동 스크롤, 폴더에 떨구면 폴더가 빛남, 무의미한 드롭은 표시 안 함.
- **전체 갤러리** — 그룹/프로젝트/모델/해상도/비율/길이/기간/채택 필터. 개수는 **파셋**
  (자기 자신을 뺀 나머지 필터 적용). **그룹·프로젝트는 `일치 / 전체`** 두 숫자 — 장소의 크기는
  속성 필터로 변하지 않는다.
- **프로젝트 아이콘** — 이모지 9카테고리 + PNG 업로드(5MB / 48px 이상 / 64px 정사각 저장).
- 사이드바 완료 배지 · 클립 생성일시 · 다운로드 폴더 열기 · 프롬프트 바로가기 · 컷 채택(★).

---

## 7. 불변 규칙 (어기면 사용자 보고 버그가 되살아난다)

**API / 생성**
1. `return_last_frame` 과 `generate_audio` **동시 사용 금지**.
2. duration 은 정수 4~15 또는 -1. **프롬프트 본문에 소수 duration 명령**(`set … to 4.5 seconds`)을
   쓰면 BytePlus 가 internal error 로 죽는다(25회 이분탐색으로 확정).
3. 이미지 압축·리사이즈 금지. 원본 그대로.
4. polling 은 `setInterval` 하나. `setTimeout` 체인 금지(끊기면 복구 불가).
5. `cancelTask` 는 `res.ok` 일 때만 취소 처리. BytePlus 는 queued 만 삭제 허용 —
   409 를 무시하면 폴링이 끊겨 **과금은 되고 시트엔 없고 영상도 버려진다**.
6. 옴니 코드에서 시댄스 `settings.mode` 를 조건으로 쓰지 마라. `settings.omniTask` 만 본다.

**UI / 렌더**

7. `alert()`/`confirm()` 금지 — 윈도우 비활성화로 프롬프트 caret·한글 IME 가 깨진다.
8. **dragstart 시점에 리스트 높이를 바꾸지 마라.** 스냅샷을 동기로 찍기 때문에 그 아래 전부가
   어긋난다(실측 65px = 1.7행 → "드롭이 안 먹는다").
9. **팝업 위치를 상수로 추정하지 마라.** 실측 보정(`useClampToViewport`)을 쓸 것. 측정은
   `offsetWidth/Height` 로 — `getBoundingClientRect()` 는 등장 애니메이션의 **변형된** 박스를 준다.
10. 전역 `scroll-behavior: smooth` 때문에 **`el.scrollTop = x` 는 애니메이션을 시작하고 옛 값을
    돌려준다.** 프레임 단위 스크롤은 `scrollTo({behavior:'instant'})`, 끝 판정은 경계값으로.
11. persist 를 `createJSONStorage` 로 되돌리지 마라 — 매 `set()` 마다 동기 stringify 로 프레임이 멈춘다.
12. 슬라이더 같은 연속 입력을 스토어에 직결하지 마라. 로컬 draft + 릴리스 시 1회 커밋.

**R2 / 에셋** (마이그레이션 때 피 본 것들)

13. **R2 key 는 업로드마다 유일**해야 한다. 재사용하면 동시 task 가 서로의 객체를 지운다.
14. task→R2키 매핑은 반드시 `string[]` — `extend_video` 는 비디오를 3개까지 싣는다.
15. R2 URL 식별은 **strict hostname 매칭**으로. 문자열 포함 검사는 오탐한다.
16. `output_count ≥ 2` 는 **같은 R2 URL 을 N개 task 가 공유**한다. 참조 카운트가 0 이 될 때만
    삭제할 것 — 먼저 끝난 task 가 지우면 나머지가 fetch 에 실패한다.
17. **비디오는 제출 시점마다 재업로드**한다(presigned 24h 만료). 이미지와 다르다.

**작업 방식**

18. **소스 편집에 PowerShell 금지.** `Get-Content -Raw` 가 CP949 로 읽어 한글을 깨뜨리고
    `Set-Content -Encoding utf8` 이 BOM 을 붙여 빌드를 죽인다. 이 세션에서만 3번 당했다.
19. **입력 버그는 합성 이벤트로 재현되지 않는다.** `dispatchEvent` 는 "핸들러가 호출되면
    동작한다" 만 증명한다. CDP `Input.dispatchMouseEvent` 나 실제 마우스를 쓸 것.
20. **파괴적 스크립트는 격리 프로파일(`--user-data-dir`)에만.** 실제 프로필을 건드리기 전에
    백업을 딴 폴더로 복사할 것 — 백업 미러는 5분 디바운스라 "아직 안 덮였겠지" 가 안 통한다.
    (2026-08-03 실제 사고. 안전 사본 하나로 겨우 복구.)

**트래커(GAS)** (26.8.501~)

21. **`billingProjects`(목록)는 저장하고 `billingProject`(선택)는 저장하지 마라.** 이 갈림이
    전부다. 목록을 안 저장하면 재시작 때마다 빈 목록으로 시작해 살아 있는 GAS 호출 하나에
    전부를 건다 — 그게 "10분간 프로젝트가 안 뜬다" 의 정체였다. 반대로 선택까지 저장하면
    §5-2 금기 1 이 깨진다(`isFourKAllowed` 가 선택이 비어야 false 를 주는 덕에 부팅 시
    저장된 4k 설정이 안 날아간다).
22. **트래커 호출에는 타임아웃과 재진입 가드를 반드시 둔다.** 둘 다 없던 시절, 콜드 `/exec`
    한 번이 127초를 잡는 동안 60초 인터벌이 계속 새 요청을 쐈다(실측 2026-08-05: 13초에
    doGet 21건). GAS 는 사용자당 동시 실행 30개 제한이 있어 여기서 요청이 거부되기 시작한다.
    현재 서버 25초 · 클라 30초 · 실패 시 3→8→20→40초 백오프.
    참고: **GAS 실행 로그의 "기간" 은 스크립트 실행 시간만 센다.** 컨테이너 부팅·리다이렉트·
    대기열은 안 세고, 404 로 죽은 요청은 로그에 아예 안 남는다. doGet 이 1~2초로 찍혀 있어도
    호출자 입장에서 2분이 걸릴 수 있다 — 두 숫자는 모순이 아니다.
23. **빈 목록은 세 가지 상태다.** "아직 모름 / 못 가져옴 / 진짜 비었음". 서버는 `ok:false` 로
    이미 구분해 준다. 뭉뚱그리면 트래커가 죽은 걸 사용자에게 "PM에게 문의하세요" 로 알리게
    되고, PM 은 시트에 15개가 멀쩡히 있으니 할 말이 없다.

---

## 8. 폐기된 시도 (다시 하지 말 것)

- `Readable.fromWeb(body).pipe(res)` 다운로드 프록시 → **71KB/s 병목**.
- `arrayBuffer()` 전체 버퍼링 → 속도는 나오지만 첫 바이트가 늦어 **진행 게이지가 안 뜨고 큰
  영상이 실패**한다. 현재는 web-stream 리더 수동 펌핑.
- CDN 호스트 `ark-content-generation-…` pre-warm → 호스트가 틀렸다. 실제는 `ark-acg-…`.
- 드래그 `dragleave` 로 표시 지우기 → Chromium 에서 `relatedTarget` 이 대부분 null 이라
  자식 넘을 때마다 지워진다. 스냅샷 + 컨테이너 단일 핸들러가 정답.
- 갤러리 오버레이 exit 애니메이션 제거 → **오진이었다.** 검증에 쓴 Browser pane 이
  `document.hidden` 이라 rAF 가 0프레임이었을 뿐. 애니메이션 검증은 **보이는 창 + CDP** 로.

---

## 9. 알려진 한계 / 미해결

| | |
|---|---|
| **맥 패키지 앱(dmg)** | 없음. 만들려면 macOS 필요(서명·공증 포함). 지금은 소스 실행이 유일 |
| **맥 전체화면** | `<video controls>` 의 브라우저 기본 버튼이라 앱 코드가 없다. 안 된다는 보고가 있으나 **브라우저 미특정**. Safari 라면 blob URL 비디오 재생 의심 — `VideoPlayer` 는 fetch 실패만 폴백하고 **재생 실패 폴백이 없다** |
| 상태 512MB 한계 | 7.7년 뒤. 그때는 청크화 필요 |
| 지워진 media-cache 68개 | 복구 불가. 원본 경로가 살아 있는 17개만 복사 시 자동 재캐싱 |
| 타입 에러 160개 | 기준선. 대부분 `ChatArea.tsx` 의 `React` 네임스페이스 / `File` 타입. 기능 무관하지만 **새 작업 후 160을 넘기지 말 것** |
| `os.homedir()` vs `app.getPath('documents')` | Documents 가 OneDrive 로 리디렉션된 PC 에서 **갈린다**. 26.8.305 부터 브라우저가 HTTP 백업 라우트를 부르므로 **"윈도우는 무영향" 이 더 이상 사실이 아니다** — 같은 PC 에서 EXE 와 브라우저가 서로 다른 폴더에 백업할 수 있다. 미해결 |

---

## 10. 작업 절차

### 검증 도구

- **격리 실행**: `앱.exe --user-data-dir=<임시> --remote-debugging-port=9222 --disable-backgrounding-occluded-windows`
- **CDP 평가**: WebSocket 으로 `Runtime.evaluate` (실제 보이는 창에서 측정)
- **실제 입력**: `Input.dispatchMouseEvent` (clickCount 지정 — 더블클릭·드래그 임계값이 진짜와 같다)
- **불변식 시뮬레이션**: 시나리오를 순서대로 실행하며 매 단계 뒤 persist 디바운스를 기다렸다
  IDB 를 다시 읽고 검사 — 3단 중첩 없음 / 그룹 렌더 위치 유일 / `currentProjectId` 유효 /
  컨테이너별 이름 유일 / 프로젝트 유실 없음 / **현재 프로젝트가 실제로 보임**

### 체크리스트

```
[ ] 타입 에러 160 유지 (npx tsc --noEmit)
[ ] node scripts/build.cjs 통과
[ ] 번들에 키 없음 (grep 으로 확인)
[ ] 버전 2곳(package.json / src/App.tsx) 일치, leading zero 없음
[ ] 실제 데이터로 설치 후 기동 — 프로젝트 수 / 메시지 수 확인
[ ] 배포했으면 §2-4 다섯 가지
[ ] 빌드·실행 관련을 건드렸으면 깨끗한 clone 에서 npm install && npm run dev
```

### 사용자와 일하는 법

- 한국어로. 짧고 사실 위주로. **측정한 것과 추측한 것을 반드시 구분**해서 말한다.
- 틀렸으면 곧바로 인정하고 무엇을 잘못 쟀는지 말한다. 이 사용자는 그걸 신뢰의 근거로 본다.
- "체크해봐" / "배포하지 마" 라고 하면 분석만. "ㅇㅇ" / "ㄱㄱ" 는 진행 동의.
- 새 기능보다 **기존 버그 수정이 우선**.

---

## 11. ★ 저장소 밖 — 시스템 전체 지도

**이 저장소는 시스템의 일부다.** 앱 코드만 읽고 인수받았다고 생각하면 안 된다. 아래가
끊기면 앱은 멀쩡해 보이면서 기능만 죽는다.

### 11-1. 외부 서비스 6곳

| 서비스 | 무엇에 | 끊기면 | 자격증명 |
|---|---|---|---|
| **BytePlus ModelArk** | 시댄스 영상 생성 | 생성 전부 불가 | `SEEDANCE_API_KEY` (팀별 13개) |
| **Cloudflare R2** | 레퍼런스 에셋 호스팅 (presigned URL 로 BytePlus 에 전달) | **서버가 부팅을 거부** | `R2_*` 4개 |
| **Google Apps Script** | 크레딧 트래커 (사용량 기록 + 프로젝트 목록 + 4K 권한) | 프로젝트 목록이 빈다 → 생성 게이트에 막힘 | 없음(웹앱 공개 `/exec`) |
| **Google AI Studio** | Gemini Omni Flash | 옴니만 불가 (시댄스 정상) | `NANOBANANA_STUDIO_KEY` |
| **GitHub Releases** | 윈도우 자동 업데이트 | 업데이트만 불가 | 배포 시 `GH_TOKEN` |
| **BytePlus 2.5 데모** | Seedance 2.5 (별도 계약) | 모델 목록에서 사라짐 | `SEEDANCE_25_DEMO_*` 2개 |

그 외 `fonts.googleapis.com` — `src/index.css` 가 Inter 를 외부에서 받는다. 오프라인이면
글꼴만 대체된다(기능 무관).

### 11-2. 저장소 **밖**에 있는 소스

```
..\26.05.04 시댄스 크레딧 관리\
  ├── dashboard_Code.gs        1,178줄   ← 트래커 본체 (시트 집계 · /exec 웹앱)
  ├── dashboard_byteplus.gs      456줄   ← BytePlus 잔액/사용량 조회
  └── dashboard_Code_TEST.gs     152줄   ← 테스트용

F:\시댄스\                                ← 키 배포 (윈도우 전용, setx)
  ├── 1T.bat … 10T.bat, AFX/AIP/TA/Special.bat   팀별 SEEDANCE_API_KEY 13개
  ├── R2.bat                               R2 자격증명 4개
  ├── 2.5 demo.bat                         2.5 데모 키 2개
  ├── install.bat                          사내 배포용 설치 스크립트
  └── FreewillSeedanceSetup.exe            배포본 사본
```

**GAS 가 저장소 밖에 있다.** 앱 코드와 같이 버전 관리되지 않으므로, 트래커를 고칠 때
앱과 GAS 의 계약(`/api/projects` 응답 형태, POST 필드)이 조용히 어긋날 수 있다.

> **대조하는 법** (2026-08-05 확인) — 로컬 서비스 계정 JSON 으로 Apps Script API 를 부르면
> **배포된 소스를 그대로 받아서 로컬 `.gs` 와 기계적으로 비교할 수 있다.** 키 파일은
> `앱개발\GPT_나노바나나api 추적\config\` 아래(계정 `nanobanana-tracker-bq@…`), JWT(RS256)를
> `oauth2.googleapis.com/token` 으로 교환하는 방식이라 라이브러리도 필요 없다.
> `projects.getContent`(HEAD 와 `?versionNumber=N` 둘 다) · `deployments.list` · Sheets 읽기가
> 열린다. **실행 로그는 안 열린다** — `v1/processes` 는 서비스 계정 본인 실행만 세어 0건,
> `projects/{id}/processes` 는 404, Cloud Logging 은 403. 실행 시간은 사람이 편집기 ⏱ 실행
> 탭을 봐야 한다. API 키(`AIza…`)로는 아무것도 안 된다(구글이 명시적으로 거부).
>
> 2026-08-05 대조 결과: HEAD == 배포 v29(2026-08-04 19:23) == 로컬 `dashboard_Code.gs`,
> 1,242줄, 함수 차이 0. **현재 드리프트 없음.**

저장소 **안**에도 GAS 가 하나 있다: `scripts/r2_hourly_cleanup.gs` (317줄) — R2 에서 1시간
지난 객체를 지우는 시간 트리거. S3 V4 서명을 인라인 구현해서 라이브러리 설치가 필요 없다.

### 11-3. 구글 시트 — 열 순서가 코드다

`Project_Status` 탭: `A연도 B프로젝트명 C현황 D영상수 E토큰 F:4K허용`

- **모든 조회가 B열(프로젝트명) 기준**이다 → 행 정렬·이동·중간 삽입은 안전.
- **열은 고정 인덱스**(`getRange(2,1,lr-1,6)` → `rows[i][5]` = F). **4K 열을 옮기거나 A~F
  사이에 열을 끼우면 조용히 오작동**한다(4K 는 fail-closed 라 전부 꺼진다).
- 뭔가 덧붙이려면 **G열부터**.
- **프로젝트명 변경 금지** — 식별 키라서 누적 토큰이 두 줄로 쪼개진다.

`usage_log` 탭은 2만 행이 넘고 30분마다 전량 재집계되므로 얇게 유지한다(해상도 등 미기록).

### 11-4. GAS 재배포 — 여기서 제일 잘 깨진다

**저장만으로는 `/exec` 에 반영되지 않는다.**
→ 배포 관리 → **기존 배포 편집 → 새 버전**.

⚠️ **"새 배포"를 누르면 URL 이 바뀐다.** 그러면 앱의 `TRACKER_URL`, 대시보드 링크, PM 프로그램이
전부 한꺼번에 깨진다. 반드시 **기존 배포 편집**.

### 11-5. 팀 식별 방식

앱은 `SEEDANCE_API_KEY` 를 SHA-256 해싱해서 `server.ts` 에 박힌 13개 팀 해시맵과 대조해
팀 이름을 정한다. **키 원문이 아니라 해시를 박는 이유**: EXE 한 대가 다른 팀 키를 전부
노출시키지 않기 위해서다. 팀이 늘면 해시를 추가해야 하고, 그때까지는 `UNKNOWN` 으로 기록된다.

부팅 로그에 `[Tracker] Resolved team: ○○팀` 이 찍힌다. **`UNKNOWN` 이면 키가 팀 키가 아니다.**

### 11-6. 데이터가 도는 경로

```
프롬프트 → (에셋 있으면) R2 업로드 → presigned URL
        → BytePlus task 생성 → 10초 폴링
        → succeeded: 영상 URL(24h) + 토큰 사용량
             ├→ blobCache 사전 페치 (다운로드 가속)
             └→ GAS 트래커 POST → 시트 usage_log
        → 성공/실패 확정 시 R2 객체 삭제 (+ 1시간 lifecycle 백스톱)
```

**24시간짜리 URL 두 개**를 기억할 것: BytePlus 영상 URL 과 R2 presigned URL. 지난 영상을
다시 쓰려면 `media-cache` 나 `originalPath` 에서 재업로드해야 한다(§4-4).

---

## 12. 부록 — 맥에서 처음 돌리기

사용자용 상세본은 `맥_실행_가이드.md`. 요약하면:

```bash
git clone https://github.com/productionkhu-tech/freewill-seedance.git
cd freewill-seedance
nano .env          # 아래 5줄(필수) + 3줄(선택)
npm install
./start.command    # 또는 npm run dev
```

`.env` **필수 5** — 없으면 서버가 부팅을 거부한다:
`SEEDANCE_API_KEY` · `R2_ENDPOINT` · `R2_ACCESS_KEY_ID` · `R2_SECRET_ACCESS_KEY` · `R2_BUCKET`

`.env` **선택 3** — 없으면 해당 기능만 막힌다:
`NANOBANANA_STUDIO_KEY`(옴니) · `SEEDANCE_25_DEMO_KEY` · `SEEDANCE_25_DEMO_ENDPOINT`

값은 윈도우 PC PowerShell 에서 뽑는다:

```powershell
foreach ($n in 'SEEDANCE_API_KEY','R2_ENDPOINT','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','NANOBANANA_STUDIO_KEY','SEEDANCE_25_DEMO_KEY','SEEDANCE_25_DEMO_ENDPOINT') { "$n=$([Environment]::GetEnvironmentVariable($n,'User'))" }
```

부팅 로그에 `[Tracker] Resolved team: ○○팀` 과 `http://localhost:3000` 이 뜨면 정상.
`.env` 를 고치면 **서버를 껐다 켜야 한다**(시작 시 1회만 읽는다).
404 가 나면 3000 포트를 다른 프로그램이 쓰는 것(`lsof -i :3000`).

---

## 13. 문서 정책

**이 파일 하나가 전부다.** 앱을 인수받는 사람은 여기만 읽으면 된다.

| 파일 | 성격 |
|---|---|
| **`HANDOFF.md`** (이 파일) | 유일한 인수인계 문서. 바뀐 게 있으면 **여기를 고친다** |
| [`CREDIT.md`](CREDIT.md) | **과금·크레딧만** 다루는 곁 문서. 토큰 공식·요율 구조·조회 API·팀별 정산·트래커 포착률 |
| `맥_실행_가이드.md` | 맥 **사용자**용 실행 안내(개발자용 아님) |
| `.claude/skills/freewill-seedance/SKILL.md` | 에이전트 자동로드용 **포인터** — 이 파일을 읽으라고만 한다 |

`CREDIT.md` 를 따로 둔 이유: 과금은 **BytePlus 청구 체계에 종속**돼 있어 앱 코드와 다른 속도로
바뀌고(요율 개편·모델 추가), 읽는 사람도 다르다(정산 담당). 그 대신 **숫자는 저장소 밖**에 둔다 —
이 저장소는 Public 이라 실제 단가·금액은 `..\26.05.04 시댄스 크레딧 관리\단가표_대외비.md` 에 있다.

문서를 늘리지 마라. 별도 브리핑·마이그레이션 노트를 만들면 6주 뒤 서로 어긋난 채 남는다
(실제로 그랬다 — 2026-08-03 에 md 7개를 이 한 개로 합쳤다).

로컬에만 있던 시간순 상세본(`.claude/HANDOFF.md`, 1,894줄)은 **이 문서로 대체됐다.**
사고 경위 원본이 필요할 때만 참고하고, 새 내용은 거기 쓰지 마라.
