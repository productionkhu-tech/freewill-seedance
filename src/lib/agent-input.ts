// 밖(에이전트 · 로컬 API · MCP)에서 들어오는 값 검사 — 받아서 고쳐 쓰지 않고 거절 + 이유(26.11.1802~).
//
// 왜: 2026-11-18 나노바나나 사고. 에이전트가 PowerShell 5.1 로 Get-Content(-Raw 포함) 한 글자를 ConvertTo-Json 으로 보냈더니
// 글자에 숨어 붙은 속성(PSPath · PSParentPath · PSChildName · PSDrive · PSProvider · ReadCount)까지 객체가 되어 나갔다 —
// "prompt": {"value": "...", "PSPath": ..., "PSProvider": {...}}, -Depth 4 면 40자가 38만 자, -Depth 6 이면 4,700만 자.
// 앱이 그걸 글자로 바꿔(str) 프롬프트로 쓰고 결과마다 저장해 프로젝트 파일이 2GB 가 됐다.
// 시댄스는 프롬프트는 막혀 있었지만(작업함이 typeof 를 봄) 이름 · 설명 · 설정 칸 몇 곳은 String() 으로 받아 '[object Object]' 가 됐다
// (같은 날 격리 시험 minitest\ps-probe.ps1). 그래서 글자 칸은 '글자인가 · 너무 길지 않은가' 를 한 곳에서 본다.
//
// 서버(server.ts)와 화면(ChatArea 의 에이전트 명령 · agent-inbox 의 agentSettings)이 같이 쓴다 — UI · 스토어를 들이지 말 것(server 번들).

export class AgentInputError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'AgentInputError'; }
}

/** 글자 칸 길이 상한. 프롬프트 5만 자는 예전 그대로(실제 최장 56,796자는 화면 작성 칸에서 친 것 — 작성 칸은 막지 않는다). */
export const AGENT_LIMITS = { prompt: 50_000, name: 200, id: 200, description: 4_000, path: 4_096, short: 100 } as const;

/** PowerShell 이 글자에 붙여 보내는 속성이 있는 객체인가 */
export const isPowerShellObject = (v: unknown): boolean =>
  !!v && typeof v === 'object' && !Array.isArray(v)
  && ['PSPath', 'PSParentPath', 'PSChildName', 'PSProvider', 'PSDrive'].some((k) => k in (v as object));

export const POWERSHELL_HINT = 'PowerShell 이면 글자를 [string] 으로 바꿔 보내세요 — 예: $p = [string](Get-Content $f -Raw). '
  + '그대로 ConvertTo-Json 하면 글자에 붙은 PSPath · PSProvider 까지 객체로 나갑니다.';

/** 받은 값의 종류를 사람 말로 */
export function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '배열';
  if (isPowerShellObject(v)) return 'PowerShell 이 속성을 붙인 객체';
  if (typeof v === 'object') return '객체';
  if (typeof v === 'number') return '숫자';
  if (typeof v === 'boolean') return 'true/false';
  return typeof v;
}

/** 몸통 어디든 PowerShell 객체가 있으면 그 자리(예: 'args.items[0].name')를 돌려준다. 깊이 8 · 칸 2만 개까지만 본다(그 너머는 몸통 한도가 막는다). */
export function findPowerShellObject(v: unknown, at = '', depth = 0, budget = { n: 20_000 }): string | null {
  if (!v || typeof v !== 'object' || depth > 8 || --budget.n < 0) return null;
  if (isPowerShellObject(v)) return at || '(몸통)';
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const r = findPowerShellObject(v[i], `${at}[${i}]`, depth + 1, budget); if (r) return r; }
    return null;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const r = findPowerShellObject(x, at ? `${at}.${k}` : k, depth + 1, budget); if (r) return r;
  }
  return null;
}

/**
 * 글자 칸 하나. 없으면(undefined · null) required 가 아닐 때 undefined. 글자가 아니면 · 너무 길면 AgentInputError.
 * 고쳐 받지 않는다 — 숫자도 글자로 바꾸지 않는다(무엇이 왔는지 그대로 알려 준다).
 */
export function agentText(v: unknown, key: string, opt: { max: number; required?: boolean; code?: string; allowEmpty?: boolean }): string | undefined {
  const code = opt.code || 'bad_field';
  if (v === undefined || v === null) {
    if (opt.required) throw new AgentInputError(code, `${key} 칸이 없습니다.`);
    return undefined;
  }
  if (typeof v !== 'string') {
    throw new AgentInputError(code, `${key} 칸은 글자여야 합니다(받은 것: ${kindOf(v)}).${isPowerShellObject(v) ? ' ' + POWERSHELL_HINT : ''}`);
  }
  if (v.length > opt.max) {
    throw new AgentInputError(code === 'bad_prompt' ? 'prompt_too_long' : 'too_long', `${key} 칸이 너무 깁니다(${v.length.toLocaleString()}자 — ${opt.max.toLocaleString()}자까지).`);
  }
  if (opt.required && !opt.allowEmpty && !v.trim()) throw new AgentInputError(code, `${key} 칸이 비었습니다.`);
  return v;
}

/** 글자 목록(경로 등) — 배열이고 칸마다 글자 */
export function agentTextList(v: unknown, key: string, opt: { max: number; maxItems: number }): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new AgentInputError('bad_field', `${key} 칸은 글자의 배열이어야 합니다(받은 것: ${kindOf(v)}).`);
  if (v.length > opt.maxItems) throw new AgentInputError('too_long', `${key} 칸은 ${opt.maxItems}개까지입니다(${v.length}개).`);
  return v.map((x, i) => agentText(x, `${key}[${i}]`, { max: opt.max, required: true })!);
}
