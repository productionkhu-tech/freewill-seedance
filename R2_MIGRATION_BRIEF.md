# 시댄스 앱 R2 마이그레이션 브리핑

레퍼런스 파일 호스팅을 **tmpfiles → Cloudflare R2** 로 교체한다. tmpfiles의 간헐적 503으로 작업이 실패하는 문제를 해소하면서, 모달별 처리를 정리한다.

> **검증 완료(2026-05-14):** R2 안정성(500회 GET 무실패, 평균 142ms), BytePlus의 R2 presigned URL fetch(`succeeded` 완주), succeeded/failed 감지 → R2 삭제 → 실제 객체 소멸(HeadObject 404) — 전부 실제 앱 흐름 미러링으로 e2e 검증 끝.

---

## 0. 사용자 설정 (이게 전부)

각 사용자 머신에서 **`F:\api key\R2.bat` 한 번 실행**만 하면 됩니다. R2 환경변수 4개가 영구 등록됨:

| 환경변수 | 용도 |
|---|---|
| `R2_ENDPOINT` | R2 S3 엔드포인트 |
| `R2_ACCESS_KEY_ID` | S3 Access Key |
| `R2_SECRET_ACCESS_KEY` | S3 Secret |
| `R2_BUCKET` | 버킷 이름 (`seedance2-260514`) |

기존 `SEEDANCE_API_KEY` 와 동일한 방식. **앱 코드에 키 하드코딩 절대 금지** — `process.env.R2_*` 로만 읽음. 미설정 시 서버는 `SEEDANCE_API_KEY` 처럼 즉시 종료한다.

---

## 1. 모달별 처리 (이 변경의 핵심)

| 모달 | 현재 | 변경 후 | 클라이언트 변경 | 서버 변경 |
|---|---|---|---|---|
| **이미지** | base64 data URL | base64 data URL (그대로) | 없음 | 없음 |
| **오디오** | tmpfiles 공개 URL | **base64 data URL** (이미지와 동일) | 있음 | 핸들러에서 제외 |
| **비디오** | tmpfiles 공개 URL | **R2 presigned URL** | 없음 | `uploadToTmpFiles` → `uploadToR2` |

> **R2 가 처리하는 건 비디오 단 하나.** 오디오는 base64로 인라인 = R2 안 거침 = 매핑/삭제 코드 단순화.

---

## 2. 서버 변경 (`server.ts`)

### 2-A. 비디오 업로드 백엔드 교체

`uploadToTmpFiles()` 를 **삭제**하고 `uploadToR2()` 로 대체. 시그니처는 동일하게 유지 (URL 문자열 반환) → 호출처 3곳 자동 반영.

```ts
async function uploadToR2(fileBuffer: Buffer, filename: string): Promise<string> {
  // 1. PutObject — key 는 unique-per-upload (예: `${cacheId}-${Date.now()}.mp4`)
  // 2. getSignedUrl(GetObjectCommand, { expiresIn: 43200 }) ← 12시간
  // 3. presigned URL 반환
}
```

**호출처 3곳 (모두 비디오 전용으로):**
- `POST /api/upload-public`
- `POST /api/reupload/:cacheId`
- `POST /api/reupload-from-path`

**옵션 — `@aws-sdk/*` 사용:**
```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```
`region: "auto"` 필수 (R2 규칙). dynamic import 불필요 — 런타임 상시 필요.

### 2-B. 오디오는 더 이상 서버 업로드 안 함

위 3개 핸들러는 비디오 전용이 됨. MIME 체크 추가하거나 그냥 호출이 안 옴 (클라이언트가 오디오를 base64로 처리하므로). 기존 `/api/cache` 는 오디오 재사용에 그대로 사용.

### 2-C. 비디오 R2 key 매핑

`POST /api/byteplus/tasks` 핸들러에 추가:

```ts
// 기존 reportedTasks Set 옆에:
const taskToR2Keys = new Map<string, string[]>();

// POST /api/byteplus/tasks 안에서, 응답으로 task id 받은 직후:
const keys: string[] = [];
for (const item of req.body.content || []) {
  if (item.type === 'video_url') {
    const url = item.video_url?.url;
    if (url && isR2Url(url)) keys.push(extractR2Key(url));
  }
}
if (keys.length) taskToR2Keys.set(data.id, keys);

// isR2Url: R2_ENDPOINT 의 hostname 과 strict 매칭만 true
// extractR2Key: URL pathname 에서 '/{bucket}/' 다음 부분
```

> **반드시 `string[]` 배열** — `extend_video` 모드는 비디오 3개까지. 단일 string으로 만들면 나머지 leak.

### 2-D. 종료 시 R2 삭제

**`GET /api/byteplus/tasks/:id`** 핸들러의 기존 크레딧 트래커 fire-and-forget **바로 옆에**:

```ts
if (data?.status === 'succeeded' || data?.status === 'failed' || data?.status === 'expired') {
  const keys = taskToR2Keys.get(req.params.id);
  if (keys) {
    taskToR2Keys.delete(req.params.id);
    for (const key of keys) {
      r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
        .catch(err => console.warn(`[R2] delete failed for ${key}:`, err.message));
    }
  }
}
```

**`DELETE /api/byteplus/tasks/:id`** 핸들러 (사용자 취소 경로):

BytePlus 취소 호출 후 위와 동일하게 `taskToR2Keys` 조회 → 삭제 + Map 엔트리 제거.

> 모든 종료 경로(`succeeded`/`failed`/`expired`/`cancelled`) 에서 삭제되어야 함. 놓치면 1일 lifecycle rule이 backstop이지만, 과금 절대 없이 가려면 즉시 삭제가 정답.

---

## 3. 클라이언트 변경

### 3-A. 오디오 첨부 — 이미지와 완전히 동일하게

기존 비디오·오디오 공통 업로드 흐름(`/api/upload-public` 호출 → 받은 URL 사용)에서, **오디오만** 이미지 패턴으로 분기:

- 첨부 시: `readFileAsDataUrl(audioFile)` → base64 data URL → `cacheFile(audioFile)` 로 media-cache 저장 (cacheId 받음)
- API payload: `audio_url.url` 에 base64 data URL 그대로
- 재사용(handleReuse) 시: `readCacheAsDataUrl(cacheId)` 로 캐시에서 복원 → base64 data URL

> 유틸 함수(`readFileAsDataUrl`, `cacheFile`, `readCacheAsDataUrl`)는 이미지가 이미 쓰는 것 그대로 재사용.

### 3-B. **비디오는 제출 시점마다 재업로드** (중요)

같은 첨부로 큐를 여러 번 보낼 때 충돌 방지를 위해, **submit 직전에 모든 비디오 자산을 R2 에 재업로드**해서 task 별로 unique R2 key 를 갖게 한다.

```ts
// submit 핸들러 안에서 (BytePlus task 생성 호출 전):
for (const asset of currentAssets.filter(a => a.type === 'video_url')) {
  const res = await fetch(`/api/reupload/${asset.cacheId}`, { method: 'POST' });
  const { url } = await res.json();
  asset.url = url; // task 별로 새 R2 URL/key
}
// 그 다음 POST /api/byteplus/tasks
```

- 비용 무시할 수준: cache 에서 R2 로 PutObject 1회, R2 egress 무료
- cache miss 시 `/api/reupload-from-path` 폴백 (현행)
- handleReuse 도 자동으로 이 흐름 타게 됨 — 옛 R2 URL 이 죽었어도 cache/originalPath 에서 fresh 업로드

> **이거 빼면**: 같은 비디오 첨부로 task A·B 두 번 보낼 때 R2 key 가 공유돼서, A 가 먼저 succeeded → R2 삭제 → B 의 BytePlus fetch 404 → B 실패.

### 3-C. **메시지 리스트의 비디오 미리보기는 cache URL 로**

`msg.usedAssets[i].url` 은 R2 URL 이고 task 완료 시 삭제됨. 과거 메시지를 다시 보려고 `<video src={url}>` 하면 404.

→ **비디오 표시는 R2 URL 말고 `/api/cache/${cacheId}` 로**:

```tsx
// 메시지 리스트의 비디오 미리보기
<video src={`/api/cache/${asset.cacheId}`} ... />
```

- 서버에 `/api/cache/:cacheId` 엔드포인트 이미 존재 (`server.ts:276`)
- media-cache 가 30일 유지하므로 그 동안 정상 재생
- R2 URL 은 **BytePlus 에 보낼 때만** 쓰는 ephemeral URL 로 명확히 분리
- 이미지 썸네일(`thumbnailUrl`)·오디오는 기존 그대로

> 비디오 자산 표시 코드 두 분기 가능 — cacheId 있으면 cache URL, 없으면 (혹시 모를 케이스) url 폴백.

---

## 4. 절대 하지 말 것

- ❌ BytePlus Files API(`/files`, File ID) 사용 — 영상 *이해*용이지 *생성*과 무관. 시댄스 2.0은 `content` 배열에 URL 직접 전달.
- ❌ `uploadToBytePlusFiles` dormant 헬퍼 호출 — 삭제하거나 무시.
- ❌ 이미지 base64 경로 변경 — 현행 그대로.
- ❌ 오디오를 R2로 보내기 — base64 분리가 이 변경의 핵심.
- ❌ tmpfiles fallback 코드 남기기 — `uploadToTmpFiles` 함수 완전 제거.
- ❌ R2 key 를 content-hash(cacheId) 그대로 사용 — 함정 #1 참고.
- ❌ `require` 사용 — ESM 모드, `import` 만.
- ❌ R2 자격증명 하드코딩 — 환경변수만.

---

## 5. 회귀 방지 — 7가지 함정

### 1. R2 key 는 unique-per-upload (가장 중요)

`media-cache` 의 cacheId(MD5 해시)를 그대로 R2 key 로 쓰면 **같은 비디오가 여러 task 에 reuse 될 때 충돌**:

```
task1: 비디오V 첨부 → R2 key = hash(V) = abc123
task2: 같은 V 를 handleReuse → 같은 key abc123
task1 succeeded → abc123 삭제
task2 의 BytePlus fetch 가 아직 → 실패
```

→ R2 key 는 `${cacheId}-${Date.now()}.${ext}` 같은 unique 형식. 로컬 media-cache 는 hash 그대로 (중복 방지).

### 2. Map 값은 반드시 `string[]`

`extend_video` 는 비디오 3개까지. 단일 string 으로 만들면 나머지 leak.

### 3. R2 URL 식별은 strict hostname 매칭

`isR2Url(url)` 은 `new URL(url).hostname === new URL(R2_ENDPOINT).hostname` 같이 정확 매칭. 다음은 건드리지 말 것:
- `asset://...` (디지털 캐릭터/실인물 자산)
- 업그레이드 시점 잔존 tmpfiles URL
- base64 data URL
- BytePlus TOS URL (`*.volces.com` — extend/edit 에서 본인 생성영상 reuse)

### 4. 호출처 3곳 모두 교체

`/api/upload-public`, `/api/reupload/:cacheId`, `/api/reupload-from-path` — 하나 빠뜨리면 handleReuse 나 cache-miss 에서 503 재발.

### 5. 환경변수 미설정 시 즉시 종료

`SEEDANCE_API_KEY` 패턴 그대로:
```ts
if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID
    || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
  console.error('[ERROR] R2_* 환경변수가 설정되지 않았습니다. F:\\api key\\R2.bat 을 실행하세요.');
  process.exit(1);
}
```

### 6. 빌드 번들 검증

`@aws-sdk/*` 추가 후:
- `dist-server/server.cjs` 정상 기동 (`node dist-server/server.cjs`)
- 사이즈 증가는 정상
- vite 처럼 dynamic import 불필요 (상시 사용)
- 빌드 산출물에 R2 secret 미포함 확인: `grep "956fb30e" dist-server/server.cjs` 결과 없어야 함

### 7. base64 오디오 request body 한도

`POST /api/byteplus/tasks` 의 request body 64MB 한도. 단일 오디오는 ~수MB라 여유 충분. "9장 이미지 + 3개 큰 오디오" 극단 케이스에서만 의식.

---

## 6. 검증 체크리스트

각 모드 실제 생성 1건씩 → `succeeded` 도달 + R2 객체 삭제 확인:

- [ ] `text_to_video` — 변경 없음, 그대로 동작
- [ ] `image_to_video_first` — 이미지 base64, 변경 없음
- [ ] `image_to_video_first_last` — 이미지 base64, 변경 없음
- [ ] `multimodal_reference` (오디오만) — 오디오 base64 payload, BytePlus fetch 정상
- [ ] `multimodal_reference` (비디오만) — R2 업로드 + presigned URL fetch + succeeded 시 R2 삭제
- [ ] `multimodal_reference` (이미지 + 비디오 + 오디오 혼합) — 세 모달 동시
- [ ] `edit_video` — 비디오 R2 + 이미지 base64 + 오디오 base64
- [ ] `extend_video` (비디오 3개) — R2 key 3개 매핑·삭제
- [ ] handleReuse (비디오) — 같은 cacheId 에서 새 R2 key 로 재업로드 (unique)
- [ ] handleReuse (오디오) — 캐시에서 base64 복원
- [ ] **같은 비디오 첨부로 큐 연속 2번** (시나리오 B) — task A·B 둘 다 succeeded 도달 (3-B 의 재업로드 동작 검증)
- [ ] **과거 메시지 비디오 재생** (시나리오 C) — task 완료 후에도 메시지 리스트에서 영상 정상 재생 (3-C 의 cache URL 사용 검증)
- [ ] 취소 (Cancel) — `DELETE` 핸들러에서 R2 삭제
- [ ] 실패 (failed/expired) — succeeded 와 동일하게 삭제
- [ ] 빌드 후 `node dist-server/server.cjs` 정상 기동
- [ ] `grep` 으로 빌드 산출물에 R2 secret 미포함 확인

---

## 7. 인프라 현황 (참고)

이미 다 셋업됨, 에이전트는 따로 작업할 거 없음:

- **R2 버킷**: `seedance2-260514` (Cloudflare R2)
- **Endpoint**: `https://545d611ede4df5505cb90242ce97be78.r2.cloudflarestorage.com`
- **Lifecycle Rule**: "Delete uploaded objects after 1 day" — 코드 삭제 누락 시 안전망
- **자격증명 .bat**: `F:\api key\R2.bat` (각 머신에서 1회 실행)
- **무료 티어 한도**: 10GB 저장, egress 무제한 무료. 위 lifecycle + 즉시삭제 조합으로 사실상 100MB 수준만 유지 → 한도 도달 불가능.

---

## 정리

| | |
|---|---|
| 사용자 작업 | 머신마다 `R2.bat` 1회 실행 → 끝 |
| 에이전트 작업 | 위 1~3 구현 + 4 금지사항 준수 + 5 함정 회피 + 6 체크리스트 통과 |
| 검증된 위험 | 없음 — 안정성·fetch·삭제 모두 e2e 검증 완료 |
| 과금 위험 | 사실상 없음 — lifecycle + 즉시삭제 조합으로 무료 한도 미도달 |
