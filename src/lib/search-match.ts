// 검색창 공통 규칙 (26.10.801~) — 채팅 검색 · 프로젝트 갤러리 · 전체 갤러리 · 사이드바 · 태스크 찾기(Ctrl+F)가 같은 답을 내게 한 곳에 둔다.
// 프롬프트 글자에 더해 태스크 ID(시댄스 'cgt-20261006233359-kfli4' · 구글 'v1_Chd…' 70자 안팎)로도 찾는다. 받은 영상의
// 파일 이름(seedance-2026-10-08-cgt-…-ki02x.mov)을 통째로 붙여 넣어도 — 그 안에 ID 가 들어 있으니 — 찾는다.
// 5자보다 짧은 조각은 ID 로 보지 않는다: 'cgt' · '2026' 이 모든 카드의 ID 에 걸린다. 5자면 시댄스 ID 끝 다섯 글자로 찾을 수 있다.

export const TASK_QUERY_MIN = 5;

/** rank 가 작을수록 찾는 것에 가깝다 — 0 통째로(ID 또는 ID 가 든 파일 이름) · 1 ID 끝 · 2 ID 앞 · 3 가운데. start · len 은 ID 안에서 맞은 자리. */
export type TaskIdMatch = { rank: 0 | 1 | 2 | 3; start: number; len: number };

/** q 는 이미 trim · 소문자. */
export function taskIdMatch(taskId: string | undefined, q: string): TaskIdMatch | null {
  if (!taskId || q.length < TASK_QUERY_MIN) return null;
  const t = taskId.toLowerCase();
  if (q.includes(t)) return { rank: 0, start: 0, len: t.length };
  const at = t.indexOf(q);
  if (at < 0) return null;
  return { rank: at + q.length === t.length ? 1 : at === 0 ? 2 : 3, start: at, len: q.length };
}

/** q 는 이미 trim · 소문자. */
export function taskIdMatches(taskId: string | undefined, q: string): boolean {
  return taskIdMatch(taskId, q) !== null;
}

/** q 는 이미 trim · 소문자. 빈 검색어는 부르는 쪽이 거른다. */
export function messageMatchesQuery(m: { promptText?: string; taskId?: string }, q: string): boolean {
  return (m.promptText || '').toLowerCase().includes(q) || taskIdMatches(m.taskId, q);
}

// 자판이 한글인 채로 친 ID 를 영문 자판 글자로 되돌린다 — ID 에는 한글이 없고, 프롬프트를 쓰던 자판 그대로 찾기 창을 여는 일이 흔하다
// ('kfli4' → 'ㅏ리ㅑ4'). 낱자는 호환 자모(ㄱ U+3131 ~ ㅣ U+3163) 순서, 완성형은 초성 · 중성 · 종성으로 푼다.
const JAMO = ['r','r','rt','s','sw','sg','e','e','f','fr','fa','fq','ft','fx','fv','fg','a','q','q','qt','t','t','d','w','w','c','z','x','v','g',
  'k','o','i','o','j','p','u','p','h','hk','ho','hl','y','n','nj','np','nl','b','m','ml','l'];
const CHO = ['r','r','s','e','e','f','a','q','q','t','t','d','w','w','c','z','x','v','g'];
const JONG = ['','r','r','rt','s','sw','sg','e','f','fr','fa','fq','ft','fx','fv','fg','a','q','qt','t','t','d','w','c','z','x','v','g'];
const JUNG = JAMO.slice(30);

export function hangulToQwerty(s: string): string {
  return s.replace(/[\u3131-\u3163\uac00-\ud7a3]/g, (ch) => {
    const c = ch.charCodeAt(0);
    if (c <= 0x3163) return JAMO[c - 0x3131];
    const i = c - 0xac00;
    return CHO[Math.floor(i / 588)] + JUNG[Math.floor((i % 588) / 28)] + JONG[i % 28];
  });
}

/** 찾기 창에 들어온 글을 ID 와 맞댈 모양으로 — 앞뒤 공백 · 따옴표(탐색기 '경로로 복사')를 떼고, 자판 실수를 되돌리고, 소문자로. */
export function normalizeTaskQuery(raw: string): string {
  return hangulToQwerty(raw.trim().replace(/^["'`]+|["'`]+$/g, '')).toLowerCase();
}
