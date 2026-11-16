// 본창 → 미니 창 요약(26.11.13~, electron/mini.cjs · src/mini/MiniApp.tsx).
// 미니 창은 스토어를 열지 않으므로, 본창이 지금 돌고 있는 작업 · 방금 끝난 작업 · 코드 상태만 추려 보낸다.
// 바뀐 것이 있을 때만(0.5초에 한 번까지) 보내고, '방금 끝남' 이 시간이 지나 빠지도록 5초마다 한 번 더 본다.
// 목록 정리 시각: 완료는 끝나고 90초, 실패는 10분(알아차리도록 더 오래) 뒤 빠진다. 목록이 비면 저절로 뜬 창은 닫힌다(mini.cjs).
// 그 전이라도 미니 창에서 눌러 본(본창의 그 카드로 간) 끝난 작업은 확인한 것으로 보고 바로 뺀다 — 따로 지우기 단추는 두지 않는다.
import { useAppStore, MODELS, projectBilling, requestFindMessage } from '../store';
import { agentMessageIds, agentInLine, onAgentInLine } from './agent-origin';
import { PERSONAL } from './edition';

export type MiniTask = {
  id: string; projectId: string; project: string; prompt: string;
  model: string; res: string; draft: boolean; agent: boolean;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  start: number; end?: number; taskId?: string; error?: string;
  cancelled?: boolean;   // 사용자가 취소함 — status 는 failed 지만 실패가 아니다(빨간 줄 · 10분 · 실패 수에서 뺀다)
  group: string;         // 같은 프롬프트 · 같은 설정 · 같은 상태 — 미니 창이 이 값이 같은 줄을 '×N' 한 줄로 묶는다(groupOf)
};
export type MiniSnap = {
  theme: 'light' | 'dark'; tasks: MiniTask[]; today: number; todayFail: number;
  billing: { needed: boolean; name: string | null }; waiting: number; version: string;
  running: number; queued: number; more: number;   // 전체 수 — 목록(tasks)은 MAX_TASKS 까지만 보낸다
  inLine: number;   // 서버 작업함에서 차례를 기다리는 MCP 요청(아직 카드가 아님) — 화면이 2초에 하나씩 가져간다
};

export const DONE_KEEP_MS = 90_000;        // 완료를 목록에 남겨 두는 시간
export const FAIL_KEEP_MS = 10 * 60_000;   // 실패는 더 오래 — 자리를 비웠다 와도 보이게
const MAX_TASKS = 50;   // 펼침은 창 높이(최대 640 · 남은 화면) 안에서 스크롤 — 그 너머는 '외 N개'
const seen = new Set<string>();   // 미니 창에서 눌러 본 끝난 작업(이 실행 동안만)
// 진행 중이 먼저(많이 돌려도 진행 중이 끝난 것에 밀려 빠지지 않게), 그다음 실패 · 완료.
// 진행 중 · 대기는 **먼저 온 것부터**, 끝난 것은 최근에 끝난 것부터(26.11.16~). 처음엔 모두 최근 것부터였는데, 에이전트가 몰아서 보내면
// 2초마다 새 작업이 맨 위에 끼어 카드의 두 줄이 계속 한 칸씩 밀려 내려갔다(마지막 점검 25초에 12번 — 사용자 "칸이 움직이면서 정신
// 사나운 건 없는지"). 먼저 온 것부터면 맨 위 줄은 그 작업이 끝날 때까지 그대로고, 새 작업은 아래에 붙는다 — 줄은 무엇이 끝날 때만 바뀐다.
// 미니 창 화면(MiniApp.tsx)도 같은 순서로 다시 정렬한다(값을 import 하면 스토어를 끌고 들어가므로 거기 따로 둔다).
const ORDER: Record<MiniTask['status'], number> = { running: 0, queued: 1, failed: 2, succeeded: 3 };
export const miniRank = (t: Pick<MiniTask, 'status' | 'cancelled'>) => (t.cancelled ? 3 : ORDER[t.status]);
export const miniOrder = (a: MiniTask, b: MiniTask) => miniRank(a) - miniRank(b)
  || (miniRank(a) <= 1 ? a.start - b.start : (b.end || b.start) - (a.end || a.start));
// 취소는 store cancelTask 가 status:'failed' + 이 문구로 적는다(26.11.13 시뮬레이션에서 빨간 실패로 10분 남던 것).
const isCancelled = (m: { status?: string; error?: unknown }) => m.status === 'failed' && /작업을 취소했습니다/.test(String(m.error || ''));

// 표에 없는 모델(새 판에서 만든 작업을 옛 판이 읽을 때 · 모델을 표에 넣기 전) — id 를 그대로 쓰면 'dreamina-seedance-3-0-pro-…' 가
// 칩을 밀어 카드 밖으로 나갔다(11/16 대조 시험). 회사 접두어 · 날짜 꼬리를 떼고 버전에 점을 찍어 사람이 읽는 이름으로 만든다.
const prettyModelId = (id: string) => id
  .replace(/^(dreamina|bytedance)-/, '').replace(/-\d{6}$/, '').replace(/(\d+)-(\d+)/g, '$1.$2')
  .split('-').filter(Boolean).map((w) => (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ');
const shortModel = (id?: string) => {
  const name = MODELS.find((m) => m.id === id)?.name || prettyModelId(id || '');
  return name.replace(/^Seedance /, '').replace(/^Gemini Omni /, 'Omni ');
};

// 같은 프롬프트 · 같은 설정으로 여러 개를 한꺼번에 돌리면(보내기를 여러 번 · 에이전트가 같은 요청을 N번) 미니 창에 같은 줄이 N개
// 늘어서 카드(두 줄)가 그것만으로 찼다(사용자 11/17 "X2 X3 이런 식으로 뜨는 거지? 낭비하지 않고"). 프로젝트 · 프롬프트 전문 ·
// 생성 설정 · 레퍼런스 · 초안 출처가 모두 같고, 상태(진행 · 대기 · 완료 · 실패와 그 문구 · 취소)와 MCP 여부까지 같으면 한 묶음이다.
// 상태를 열쇠에 넣는 까닭: 셋 중 하나가 끝나면 '생성 중 ×2' 와 '완료 ×1' 로 갈라져야 줄의 뜻(아이콘 · 시간)이 그대로 맞는다.
const sortKeys = (o: Record<string, unknown>) => Object.keys(o).sort().map((k) => [k, o[k]]);
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const groupOf = (projectId: string, m: any, agent: boolean, cancelled: boolean) => hash(JSON.stringify([
  projectId, m.promptText || '', sortKeys(m.usedSettings || {}),
  (m.usedAssets || []).map((a: any) => a.id), (m.usedElementImages || []).map((e: any) => e.imageId), m.draftOf || '',
  cancelled ? 'cancelled' : m.status, m.status === 'failed' ? String(m.error || '') : '', agent,
]));

export function buildMiniSnap(now = Date.now()): MiniSnap {
  const st = useAppStore.getState();
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayStart = day.getTime();
  const tasks: MiniTask[] = [];
  let today = 0, todayFail = 0, running = 0, queued = 0;
  for (const p of st.projects) {
    for (const m of p.messages) {
      if (m.role !== 'system' || !m.status) continue;
      const end = m.endTime || 0;
      if (m.status === 'succeeded' && end >= dayStart) today++;
      const cancelled = isCancelled(m);
      if (m.status === 'failed' && !cancelled && (end || m.timestamp) >= dayStart) todayFail++;
      if (m.status === 'running') running++;
      if (m.status === 'queued') queued++;
      const active = m.status === 'queued' || m.status === 'running';
      const keep = m.status === 'failed' && !cancelled ? FAIL_KEEP_MS : DONE_KEEP_MS;
      const recent = !active && now - (end || m.timestamp) < keep && !seen.has(m.id);
      if (!active && !recent) continue;
      const us: any = m.usedSettings || {};
      const prompt = (m.promptText || '').replace(/\s+/g, ' ').trim();
      const agent = agentMessageIds.has(m.id);
      tasks.push({
        id: m.id, projectId: p.id, project: p.name, prompt: prompt.length > 90 ? prompt.slice(0, 90) + '…' : prompt,
        model: shortModel(us.model), res: us.draft ? 'Draft 480p' : String(us.resolution || ''), draft: !!us.draft,
        agent, status: m.status, group: groupOf(p.id, m, agent, cancelled),
        start: m.startTime || m.timestamp, end: m.endTime, taskId: m.taskId,
        error: m.status === 'failed' ? String(m.error || '').split('\n')[0].slice(0, 80) : undefined,
        ...(cancelled ? { cancelled: true } : {}),
      });
    }
  }
  tasks.sort(miniOrder);
  const bill = PERSONAL ? null : projectBilling(st);
  const waiting = Object.values(st.agentWaitingBilling || {}).reduce((n, v) => n + (Number(v) || 0), 0);
  return {
    theme: st.theme === 'dark' ? 'dark' : 'light',
    tasks: tasks.slice(0, MAX_TASKS), today, todayFail, running, queued, more: Math.max(0, tasks.length - MAX_TASKS), inLine: agentInLine(),
    billing: { needed: !PERSONAL, name: bill ? bill.project : null },
    waiting, version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
  };
}

/** 본창에서 한 번 부른다. 돌려준 함수로 멈춘다. 전자 앱이 아니면(브라우저 개발 화면) 아무것도 하지 않는다. */
export function startMiniFeed(): () => void {
  const api = (window as any).electronAPI;
  if (!api?.miniSend) return () => {};
  let last = '';
  let timer: number | null = null;
  const push = () => {
    timer = null;
    try {
      const snap = buildMiniSnap();
      const key = JSON.stringify(snap);
      if (key === last) return;
      last = key;
      api.miniSend(snap);
    } catch (e) { console.warn('[mini] 요약 실패', e); }
  };
  const soon = () => { if (timer === null) timer = window.setTimeout(push, 500); };
  const unsub = useAppStore.subscribe(soon);
  const offInLine = onAgentInLine(soon);
  const beat = window.setInterval(push, 5000);
  const offGoto = api.onMiniGoto?.(({ projectId, msgId }: { projectId: string; msgId: string }) => {
    // 미니 창에서 줄을 누름 → 본창이 그 카드로(Ctrl+F 와 같은 길). 끝난 작업이면 확인한 것 — 목록에서 뺀다.
    // '×N' 묶음 줄이면 미니 창은 그중 먼저 보낸 카드를 보낸다(나머지는 그 아래에 이어진다) — 끝난 묶음은 통째로 확인한 것.
    const m = useAppStore.getState().projects.find((p) => p.id === projectId)?.messages.find((x) => x.id === msgId);
    if (m && (m.status === 'succeeded' || m.status === 'failed')) {
      const all = buildMiniSnap().tasks;
      const g = all.find((t) => t.id === msgId)?.group;
      for (const t of all) if (t.id === msgId || (g && t.group === g)) seen.add(t.id);
    }
    requestFindMessage(projectId, msgId);
    push();
  });
  push();
  return () => { unsub(); offInLine(); window.clearInterval(beat); if (timer !== null) window.clearTimeout(timer); offGoto?.(); };
}
