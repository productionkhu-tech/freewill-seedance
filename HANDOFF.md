# Freewill Seedance 2.0 — 인수인계

> 최종 정리: **2026-08-03** / 배포 버전 **26.8.305**
> 이 문서 하나로 인수받을 수 있게 쓴다. 시간순 기록이 아니라 **주제별**이다.
> 여기 적힌 숫자는 전부 실측이다. 확인 못 한 것은 "미확인"이라고 명시한다.

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

## 5. 기능 지도

- **프로젝트 그룹 / 하위그룹** — 딱 1단계. `groupTree()` 가 **읽을 때** 판정한다:
  "부모가 존재하고 그 부모가 스스로 최상위일 때만 하위그룹". dangling·3단·순환이 전부
  최상위로 떨어진다. **존재하는 건 반드시 도달 가능해야 한다.**
- **이름 중복** — 윈도우 폴더 원리. **컨테이너(한 화면에 같이 그려지는 목록) 하나에 이름 하나**,
  폴더와 프로젝트가 한 이름공간. 다른 폴더면 같은 이름 OK, **옮겨서 만나는 순간** `(1)`.
- **드래그** — HTML5 DnD 가 아니라 **포인터 이벤트**. 네이티브 DnD 는 OS 드래그 루프가 휠을
  가져가서 페이지에 `wheel` 이 **0건** 온다(실측: dragover 333 / wheel 0 → 교체 후 49).
  커서에 붙는 미리보기, 가장자리 자동 스크롤, 폴더에 떨구면 폴더가 빛남, 무의미한 드롭은 표시 안 함.
- **전체 갤러리** — 그룹/프로젝트/모델/해상도/비율/길이/기간/채택 필터. 개수는 **파셋**
  (자기 자신을 뺀 나머지 필터 적용). **그룹·프로젝트는 `일치 / 전체`** 두 숫자 — 장소의 크기는
  속성 필터로 변하지 않는다.
- **프로젝트 아이콘** — 이모지 9카테고리 + PNG 업로드(5MB / 48px 이상 / 64px 정사각 저장).
- 사이드바 완료 배지 · 클립 생성일시 · 다운로드 폴더 열기 · 프롬프트 바로가기 · 컷 채택(★).

---

## 6. 불변 규칙 (어기면 사용자 보고 버그가 되살아난다)

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

**작업 방식**

13. **소스 편집에 PowerShell 금지.** `Get-Content -Raw` 가 CP949 로 읽어 한글을 깨뜨리고
    `Set-Content -Encoding utf8` 이 BOM 을 붙여 빌드를 죽인다. 이 세션에서만 3번 당했다.
14. **입력 버그는 합성 이벤트로 재현되지 않는다.** `dispatchEvent` 는 "핸들러가 호출되면
    동작한다" 만 증명한다. CDP `Input.dispatchMouseEvent` 나 실제 마우스를 쓸 것.
15. **파괴적 스크립트는 격리 프로파일(`--user-data-dir`)에만.** 실제 프로필을 건드리기 전에
    백업을 딴 폴더로 복사할 것 — 백업 미러는 5분 디바운스라 "아직 안 덮였겠지" 가 안 통한다.
    (2026-08-03 실제 사고. 안전 사본 하나로 겨우 복구.)

---

## 7. 폐기된 시도 (다시 하지 말 것)

- `Readable.fromWeb(body).pipe(res)` 다운로드 프록시 → **71KB/s 병목**.
- `arrayBuffer()` 전체 버퍼링 → 속도는 나오지만 첫 바이트가 늦어 **진행 게이지가 안 뜨고 큰
  영상이 실패**한다. 현재는 web-stream 리더 수동 펌핑.
- CDN 호스트 `ark-content-generation-…` pre-warm → 호스트가 틀렸다. 실제는 `ark-acg-…`.
- 드래그 `dragleave` 로 표시 지우기 → Chromium 에서 `relatedTarget` 이 대부분 null 이라
  자식 넘을 때마다 지워진다. 스냅샷 + 컨테이너 단일 핸들러가 정답.
- 갤러리 오버레이 exit 애니메이션 제거 → **오진이었다.** 검증에 쓴 Browser pane 이
  `document.hidden` 이라 rAF 가 0프레임이었을 뿐. 애니메이션 검증은 **보이는 창 + CDP** 로.

---

## 8. 알려진 한계 / 미해결

| | |
|---|---|
| **맥 패키지 앱(dmg)** | 없음. 만들려면 macOS 필요(서명·공증 포함). 지금은 소스 실행이 유일 |
| **맥 전체화면** | `<video controls>` 의 브라우저 기본 버튼이라 앱 코드가 없다. 안 된다는 보고가 있으나 **브라우저 미특정**. Safari 라면 blob URL 비디오 재생 의심 — `VideoPlayer` 는 fetch 실패만 폴백하고 **재생 실패 폴백이 없다** |
| 상태 512MB 한계 | 7.7년 뒤. 그때는 청크화 필요 |
| 지워진 media-cache 68개 | 복구 불가. 원본 경로가 살아 있는 17개만 복사 시 자동 재캐싱 |
| 타입 에러 160개 | 기준선. 대부분 `ChatArea.tsx` 의 `React` 네임스페이스 / `File` 타입. 기능 무관하지만 **새 작업 후 160을 넘기지 말 것** |
| `os.homedir()` vs `app.getPath('documents')` | Documents 가 OneDrive 로 리디렉션된 PC 에서 갈릴 수 있다. 현재 윈도우는 HTTP 백업 라우트를 안 부르므로 무영향 |

---

## 9. 작업 절차

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

## 10. 더 깊은 기록

이 저장소에 없는 상세 기록이 개발 PC 로컬에 있다(`.claude/` 는 gitignore — 키가 들어갈 수
있어서다). 사고 경위·이분탐색 로그·실측 표 원본이 필요하면 그쪽을 봐야 한다.

- `.claude/HANDOFF.md` — 시간순 상세본 (§1~§19)
- `.claude/skills/freewill-seedance/SKILL.md` — 에이전트 자동로드 요약본
