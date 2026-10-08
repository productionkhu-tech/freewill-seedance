// 검색창 공통 규칙 (26.10.801~) — 채팅 검색 · 프로젝트 갤러리 · 전체 갤러리 · 사이드바가 같은 답을 내게 한 곳에 둔다.
// 프롬프트 글자에 더해 태스크 ID(시댄스 'cgt-20261006233359-kfli4' · 구글 'v1_Chd…' 70자 안팎)로도 찾는다. 받은 영상의
// 파일 이름(seedance-2026-10-08-cgt-…-ki02x.mov)을 통째로 붙여 넣어도 — 그 안에 ID 가 들어 있으니 — 찾는다.
// 5자보다 짧은 조각은 ID 로 보지 않는다: 'cgt' · '2026' 이 모든 카드의 ID 에 걸린다. 5자면 시댄스 ID 끝 다섯 글자로 찾을 수 있다.

/** q 는 이미 trim · 소문자. */
export function taskIdMatches(taskId: string | undefined, q: string): boolean {
  if (!taskId || q.length < 5) return false;
  const t = taskId.toLowerCase();
  return t.includes(q) || q.includes(t);
}

/** q 는 이미 trim · 소문자. 빈 검색어는 부르는 쪽이 거른다. */
export function messageMatchesQuery(m: { promptText?: string; taskId?: string }, q: string): boolean {
  return (m.promptText || '').toLowerCase().includes(q) || taskIdMatches(m.taskId, q);
}
