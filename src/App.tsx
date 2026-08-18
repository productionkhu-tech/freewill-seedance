import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { SettingsPanel } from './components/SettingsPanel';
import { useAppStore } from './store';

export default function App() {
  const { projects, createProject, currentProjectId, _hasHydrated } = useAppStore();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Non-blocking notice when a selected project is auto-cleared on 종료 (a native alert()
  // here would de-activate the window and drop the prompt caret mid-typing).
  const [projectEndedNote, setProjectEndedNote] = useState<string | null>(null);

  useEffect(() => {
    if (_hasHydrated && projects.length === 0) createProject();
  }, [_hasHydrated, projects.length, createProject]);

  // The sidebar badges projects that finished something you haven't looked at. The open
  // project is by definition looked at, so clear it — both when you switch in, and again
  // when a clip finishes while you are sitting in it.
  // Keyed on the newest completion time (not a count): a deletion could lower a count and
  // wrongly re-badge, and re-running with an unchanged timestamp costs nothing because
  // markProjectSeen no-ops when there is nothing newer to record.
  const openProjectNewestDone = useAppStore((s) => {
    const p = s.projects.find((x) => x.id === s.currentProjectId);
    if (!p) return 0;
    let newest = 0;
    for (const m of p.messages) {
      if (m.status !== 'succeeded') continue;
      const t = m.endTime || m.timestamp;
      if (t > newest) newest = t;
    }
    return newest;
  });
  useEffect(() => {
    if (_hasHydrated && currentProjectId) useAppStore.getState().markProjectSeen(currentProjectId);
  }, [_hasHydrated, currentProjectId, openProjectNewestDone]);


  // Tell the server which reference originals the history still points at, so its 30-day
  // pruner stops deleting them. Once per launch, after hydration — the id set only grows
  // during a session, and anything added now is fresh by definition, so the next launch
  // covers it.
  // Why this is needed at all: viewing an old message reads the thumbnail stored ON the
  // message, never media-cache, so "last used" was measuring the wrong thing entirely.
  // Fire-and-forget: this is a maintenance nicety, and a failure must never surface.
  useEffect(() => {
    if (!_hasHydrated) return;
    const ids = new Set<string>();
    for (const p of useAppStore.getState().projects) {
      for (const a of p.assets || []) if (a.cacheId) ids.add(a.cacheId);
      for (const m of p.messages) for (const a of m.usedAssets || []) if (a.cacheId) ids.add(a.cacheId);
    }
    if (!ids.size) return;
    fetch('/api/cache/keep', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...ids] }),
    }).catch(() => { /* 캐시 수명 연장 실패는 조용히 넘어간다 */ });
  }, [_hasHydrated]);

  // Ask the browser not to throw our storage away. Without this an origin's IndexedDB is
  // "best effort": browsers evict it under disk pressure, and Safari clears script-written
  // storage for sites it hasn't seen in a while. On Windows that only costs a re-read from
  // the backup file; in the browser build the projects live here, so it matters more.
  // Granting is the browser's call, not ours — this is a request, and the file mirror
  // (store.ts) is what actually guarantees the data survives. Belt and braces.
  useEffect(() => {
    if (!navigator.storage?.persist) return;
    navigator.storage.persisted?.().then(already => {
      if (already) return;
      navigator.storage.persist().then(granted =>
        console.log(`[Storage] persistent storage ${granted ? 'granted' : 'refused'}`));
    }).catch(() => { /* 지원 안 하면 그냥 넘어간다 */ });
  }, []);

  // Single interval polls ALL active tasks every 10 seconds — no setTimeout chains
  useEffect(() => {
    if (!_hasHydrated) return;
    const poll = () => {
      const state = useAppStore.getState();
      // Collect active tasks first, skip if none
      const active: { pid: string; mid: string; tid: string }[] = [];
      for (const p of state.projects) {
        for (const m of p.messages) {
          if ((m.status === 'running' || m.status === 'queued') && m.taskId) {
            active.push({ pid: p.id, mid: m.id, tid: m.taskId });
          }
        }
      }
      if (active.length === 0) return; // nothing to poll
      active.forEach(t => state.pollTask(t.pid, t.mid, t.tid));
    };
    poll();
    const interval = setInterval(poll, 10000);
    return () => clearInterval(interval);
  }, [_hasHydrated]);

  // Billing-project list sync: pull active projects from the tracker every 60s (near
  // real-time so an ended 종료 project is detected + auto-cleared within a minute).
  // Also auto-clears a selection whose project was ended (종료) — but ONLY when the
  // fetch genuinely succeeded (ok:true) and the project is absent, so a network
  // blip / offline never wipes a valid in-session selection.
  useEffect(() => {
    if (!_hasHydrated) return;
    // ★ Three things this loop has to survive, all measured against the real tracker
    // on 2026-08-05: a cold Apps Script /exec takes 127s and answers 404; warm it is 2s.
    //   1) inFlight — the 60s interval used to fire regardless of whether the previous
    //      request was still open, so a 127s call meant overlapping requests piling onto
    //      the very service that was already struggling.
    //   2) AbortController — neither this fetch nor the server's had any timeout, so one
    //      cold call blocked the list for over two minutes. The BytePlus poll has had an
    //      8s hard timeout for exactly this reason; this path was simply missed.
    //   3) backoff — on failure, retry in 3s → 8s → 20s instead of waiting the full 60s.
    //      Once a fetch lands we settle back to the plain 60s cadence.
    let inFlight = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const RETRY_BACKOFF_MS = [3000, 8000, 20000, 40000];
    let cancelled = false;

    const scheduleRetry = () => {
      if (cancelled || retryTimer) return;
      const wait = RETRY_BACKOFF_MS[Math.min(failures - 1, RETRY_BACKOFF_MS.length - 1)];
      retryTimer = setTimeout(() => { retryTimer = null; void loadProjects(); }, wait);
    };

    const loadProjects = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 30000);
      try {
        const r = await fetch('/api/projects', { signal: ac.signal });
        const j = await r.json();
        if (!j || j.ok !== true || !Array.isArray(j.projects)) {
          // couldn't fetch → keep list + selection untouched, but SAY so. The persisted
          // list from the last good run is still on screen, so this is informational.
          useAppStore.getState().setTrackerReachable(false);
          failures++;
          scheduleRetry();
          return;
        }
        // Landed — drop back to the plain 60s cadence and cancel any backoff still armed.
        failures = 0;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        useAppStore.getState().setTrackerReachable(true);
        const active = j.projects
          .filter((p: any) => p && p.status === '진행')
          // allow4k comes from Project_Status column F ("4K 허용"), allow25 from column G
          // ("2.5 허용") — both axes independent of 진행/종료, so a project can be active
          // with neither. Strict === true keeps them fail-closed for older trackers that
          // don't send the fields at all.
          .map((p: any) => ({ project: String(p.project), status: String(p.status), allow4k: p.allow4k === true, allow25: p.allow25 === true }));
        // Skip the store write (re-renders subscribers + re-serializes the persisted
        // blob) when the active list is unchanged — this runs every 60s.
        // ★ EVERY permission flag MUST be in this comparison. Without it a pure permission
        // flip leaves the list "unchanged", the write is skipped, and the grant/revoke never
        // reaches the UI — the feature would silently never work. That is the whole bug this
        // guard exists for, so any new flag added to the map above belongs here too.
        const prev = useAppStore.getState().billingProjects;
        const changed = prev.length !== active.length ||
          active.some((p: any, i: number) => p.project !== prev[i]?.project
            || p.status !== prev[i]?.status
            || p.allow4k !== prev[i]?.allow4k
            || p.allow25 !== prev[i]?.allow25);
        if (changed) useAppStore.getState().setBillingProjects(active);
        const sel = useAppStore.getState().billingProject;
        if (sel && !active.some((p: any) => p.project === sel)) {
          useAppStore.getState().setBillingProject('');
          setProjectEndedNote(`선택했던 프로젝트 "${sel}"가 종료되어 해제되었습니다. 새 프로젝트를 선택해주세요.`);
        }
      } catch {
        // network / abort / parse fail → keep current selection + list, retry sooner
        useAppStore.getState().setTrackerReachable(false);
        failures++;
        scheduleRetry();
      } finally {
        clearTimeout(t);
        inFlight = false;
      }
    };
    void loadProjects();
    const id = setInterval(loadProjects, 60000); // 60s — near real-time 종료 detection
    // Event-driven top-ups so a 4K grant/revoke feels immediate without shortening the
    // interval. Tightening the poll would triple GAS traffic AND triple the cost of the
    // store write, which re-renders every message card (no selectors / no memo yet).
    // Refetch when the user comes back to the window, or deliberately asks for it
    // (project dropdown opened / resolution dropdown opened — see SettingsPanel).
    const onFocus = () => loadProjects();
    window.addEventListener('focus', onFocus);
    window.addEventListener('seedance:refresh-projects', onFocus);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('seedance:refresh-projects', onFocus);
    };
  }, [_hasHydrated]);

  if (!_hasHydrated || !currentProjectId) {
    return (
      <div className="flex h-screen w-full bg-[#000000] text-white items-center justify-center font-sans">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-400">Initializing workspace...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-[#000000] text-gray-900 overflow-hidden font-sans relative">
      <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
      <ChatArea />
      <SettingsPanel />
      {projectEndedNote && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[80] w-[min(92%,30rem)] flex items-start gap-2.5 bg-amber-50 border border-amber-300 text-amber-900 rounded-xl shadow-lg px-3.5 py-2.5">
          <span className="text-[13px] leading-snug flex-1">{projectEndedNote}</span>
          <button onClick={() => setProjectEndedNote(null)} className="shrink-0 text-amber-500 hover:text-amber-800 text-sm font-bold leading-none mt-0.5">✕</button>
        </div>
      )}
      <div className="fixed bottom-1 right-2 text-[10px] text-gray-400 font-mono pointer-events-none select-none z-[999]">
        v26.8.1801
      </div>
    </div>
  );
}
