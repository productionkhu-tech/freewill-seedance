// 에이전트(MCP)가 보낸 카드 표시 · 서버 작업함에 줄 서 있는 수(26.11.13~, 미니 창 mini-feed 가 읽는다).
// 스토어에 넣지 않는다 — 저장 · 백업 대상이 아니고, 실행 동안만 쓰는 값이다.

/** 이번 실행에서 에이전트 요청으로 만든 카드 id. */
export const agentMessageIds = new Set<string>();
export const markAgentMessages = (ids: string[]) => { for (const id of ids) agentMessageIds.add(id); };

/** 서버 작업함에서 화면이 가져가길 기다리는 에이전트 요청 수(코드 기다림 제외). 작업함 확인(2초)마다 서버 답으로 고친다. */
let inLine = 0;
const listeners = new Set<() => void>();
export const agentInLine = () => inLine;
export const setAgentInLine = (n: number) => {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v === inLine) return;
  inLine = v;
  for (const f of listeners) f();
};
export const onAgentInLine = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
