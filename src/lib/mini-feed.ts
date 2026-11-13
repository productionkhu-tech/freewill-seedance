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
// 진행 중이 먼저(많이 돌려도 진행 중이 끝난 것에 밀려 빠지지 않게), 그다음 실패 · 완료. 같은 무리 안에서는 최근 것부터.
const ORDER: Record<MiniTask['status'], number> = { running: 0, queued: 1, failed: 2, succeeded: 3 };
export const miniRank = (t: Pick<MiniTask, 'status' | 'cancelled'>) => (t.cancelled ? 3 : ORDER[t.status]);
// 취소는 store cancelTask 가 status:'failed' + 이 문구로 적는다(26.11.13 시뮬레이션에서 빨간 실패로 10분 남던 것).
const isCancelled = (m: { status?: string; error?: unknown }) => m.status === 'failed' && /작업을 취소했습니다/.test(String(m.error || ''));

const shortModel = (id?: string) => {
  const name = MODELS.find((m) => m.id === id)?.name || id || '';
  return name.replace(/^Seedance /, '').replace(/^Gemini Omni /, 'Omni ');
};

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
      tasks.push({
        id: m.id, projectId: p.id, project: p.name, prompt: prompt.length > 90 ? prompt.slice(0, 90) + '…' : prompt,
        model: shortModel(us.model), res: us.draft ? 'Draft 480p' : String(us.resolution || ''), draft: !!us.draft,
        agent: agentMessageIds.has(m.id), status: m.status,
        start: m.startTime || m.timestamp, end: m.endTime, taskId: m.taskId,
        error: m.status === 'failed' ? String(m.error || '').split('\n')[0].slice(0, 80) : undefined,
        ...(cancelled ? { cancelled: true } : {}),
      });
    }
  }
  tasks.sort((a, b) => miniRank(a) - miniRank(b) || b.start - a.start);
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
    const m = useAppStore.getState().projects.find((p) => p.id === projectId)?.messages.find((x) => x.id === msgId);
    if (m && (m.status === 'succeeded' || m.status === 'failed')) seen.add(msgId);
    requestFindMessage(projectId, msgId);
    push();
  });
  push();
  return () => { unsub(); offInLine(); window.clearInterval(beat); if (timer !== null) window.clearTimeout(timer); offGoto?.(); };
}
