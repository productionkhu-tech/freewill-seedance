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
    const loadProjects = async () => {
      try {
        const r = await fetch('/api/projects');
        const j = await r.json();
        if (!j || j.ok !== true || !Array.isArray(j.projects)) return; // couldn't fetch → keep state untouched
        const active = j.projects
          .filter((p: any) => p && p.status === '진행')
          .map((p: any) => ({ project: String(p.project), status: String(p.status) }));
        // Skip the store write (re-renders subscribers + re-serializes the persisted
        // blob) when the active list is unchanged — this runs every 60s.
        const prev = useAppStore.getState().billingProjects;
        const changed = prev.length !== active.length ||
          active.some((p: any, i: number) => p.project !== prev[i]?.project || p.status !== prev[i]?.status);
        if (changed) useAppStore.getState().setBillingProjects(active);
        const sel = useAppStore.getState().billingProject;
        if (sel && !active.some((p: any) => p.project === sel)) {
          useAppStore.getState().setBillingProject('');
          setProjectEndedNote(`선택했던 프로젝트 "${sel}"가 종료되어 해제되었습니다. 새 프로젝트를 선택해주세요.`);
        }
      } catch { /* network/parse fail → keep current selection + list */ }
    };
    loadProjects();
    const id = setInterval(loadProjects, 60000); // 60s — near real-time 종료 detection
    return () => clearInterval(id);
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
        v26.7.2101
      </div>
    </div>
  );
}
