// Model facts that BOTH the client and server.ts need to agree on.
//
// Deliberately free of React / zustand / any UI import: server.ts bundles this file, and
// pulling the store in would drag the whole frontend into the server bundle.
//
// Why it exists: these ids used to be hand-synced across the two sides with a comment
// ("must match MODELS[] in src/store.ts"). That is fine for a label and not fine for a
// permission — a grant that drifts is a grant that silently stops working.

/**
 * Model ids that no longer exist → what they become.
 *
 * `seedance-2-5-demo` was the BytePlus demo endpoint (its own key, its own contract, never
 * billed to a project). The demo ended 2026-08-14 and the model is gone from the app.
 *
 * It cannot simply be deleted, because projects and past messages still hold that id.
 * Hydration turns an unknown model into the app default, which is 2.0 — that would quietly
 * halve the image cap (30 → 9) and clamp saved durations (30s → 15s) on work that was set
 * up for 2.5. The official 2.5 row has the identical capability set, so mapping there
 * changes nothing about the project except which contract pays, which is now the only
 * option anyway.
 */
export const LEGACY_MODEL_IDS: Record<string, string> = {
  'seedance-2-5-demo': 'dreamina-seedance-2-5-260628',
};

/** Current id for a possibly-retired one. Unknown ids pass through untouched. */
export function resolveModelId(id: string): string {
  return LEGACY_MODEL_IDS[id] || id;
}

/**
 * model id → the Project_Status column that must be true for the SELECTED billing project
 * before this model may be used. Absent = open to everyone, which is every other model.
 *
 * Adding a gated model is one line here: the client's isModelAllowed() and the server's
 * pre-send check both read this map, so neither can be updated without the other.
 */
export const MODEL_GRANTS: Record<string, 'allow25'> = {
  'dreamina-seedance-2-5-260628': 'allow25',
};

/**
 * 모델 상징 id — 그 모델을 만든 곳을 한 단어로 부르는 이름.
 *
 * 저장되는 모든 이름이 여기서 나온다. 두 곳 다 같은 값을 쓴다:
 *   다운로드 파일  {brand}-{날짜}-{taskId}.{ext}
 *   NCP 객체 키     {brand}/{프로젝트}/{taskId}.{ext}
 * 그래서 받아둔 파일 이름만 보고 NCP 어디에 있는지 알 수 있고, 반대도 된다.
 *
 * ★ 왜 모델 id 접두어로 판정하나 — 같은 회사의 버전 업은 아무것도 안 해도 따라오게
 *   하려고. dreamina-seedance-3-0-… 이 들어와도 규칙이 이미 맞는다. 예전에는
 *   `provider === 'gemini' ? 'google' : 'seedance'` 같은 삼항이 코드 곳곳에 흩어져
 *   있어서, 세 번째 회사가 들어오면 그 삼항을 전부 찾아 고쳐야 했고 하나라도 놓치면
 *   조용히 남의 폴더에 쌓였다. 이제 새 회사는 아래 배열에 한 줄이면 된다.
 *
 * 규칙은 위에서부터 먼저 맞는 것을 쓴다. 더 좁은 규칙을 위에 둘 것.
 */
export const BRAND_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^dreamina-seedance-/i, 'seedance'],
  [/^gemini-/i,            'google'],
  // 새 회사는 여기 한 줄. 예) [/^kling-/i, 'kling'],
];

/**
 * 모르는 모델은 'unknown' 이다 — 기존 회사 폴더에 섞지 않는다.
 *
 * 예전에는 미등록 id 가 조용히 byteplus 로 떨어져서, 남의 브랜드 이름을 달고 남의
 * 폴더에 쌓였다. 오류도 경고도 없었다. 'unknown/' 으로 모이면 최소한 눈에 띈다.
 */
export function brandOf(modelId: string | undefined | null): string {
  const id = resolveModelId(String(modelId || ''));
  for (const [re, brand] of BRAND_RULES) if (re.test(id)) return brand;
  return 'unknown';
}
