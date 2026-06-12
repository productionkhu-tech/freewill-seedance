import { useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { SettingsPanel } from './components/SettingsPanel';
import { useAppStore } from './store';

export default function App() {
  const { projects, createProject, currentProjectId, _hasHydrated } = useAppStore();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
      <div className="fixed bottom-1 right-2 text-[10px] text-gray-400 font-mono pointer-events-none select-none z-[999]">
        v26.6.1205
      </div>
    </div>
  );
}
