import { create } from 'zustand';
import { persist, StateStorage, createJSONStorage } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { get, set, del } from 'idb-keyval';
import { showNotification, setCachedBlob, getCachedBlob } from './lib/utils';

// Debounced IndexedDB storage — prevents lag from writing large base64 data on every state change
let writeTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 1500;

// External backup mirror to Documents/Freewill Seedance Backup/seedance-backup.json.
// Survives any userData loss (app-name rename, uninstall+reinstall, AppData cleanup).
// Longer debounce than IDB so we don't churn the disk during heavy editing.
let backupTimer: ReturnType<typeof setTimeout> | null = null;
const BACKUP_DEBOUNCE_MS = 5 * 60 * 1000;

const idbStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    const fromIdb = await get(name);
    if (fromIdb) return fromIdb;
    // IDB empty — likely fresh install OR userData was wiped. Try external backup.
    try {
      const api = (window as any).electronAPI;
      if (api?.backupLoad) {
        const result = await api.backupLoad();
        if (result?.ok && result.content) {
          // Seed IDB so subsequent reads hit the fast path and the next setItem
          // doesn't race the restored state.
          await set(name, result.content);
          console.log(`[Backup] Restored ${(result.bytes / 1024).toFixed(1)}KB from ${result.path}`);
          return result.content;
        }
      }
    } catch (err) {
      console.warn('[Backup] Load failed:', err);
    }
    return null;
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => set(name, value), DEBOUNCE_MS);

    // Mirror to external backup file (long debounce — 5 min)
    if (backupTimer) clearTimeout(backupTimer);
    backupTimer = setTimeout(() => {
      const api = (window as any).electronAPI;
      if (!api?.backupSave) return;
      api.backupSave(value)
        .then((r: any) => {
          if (r?.ok) console.log(`[Backup] Saved ${(r.bytes / 1024 / 1024).toFixed(2)}MB → ${r.path}`);
          else console.warn('[Backup] Save failed:', r?.error);
        })
        .catch((err: any) => console.warn('[Backup] Save error:', err?.message || err));
    }, BACKUP_DEBOUNCE_MS);
  },
  removeItem: async (name: string): Promise<void> => {
    await del(name);
  },
};

export type AssetRole = 'reference_image' | 'reference_video' | 'reference_audio' | 'first_frame' | 'last_frame';

export type GenerationMode = 'text_to_video' | 'image_to_video_first' | 'image_to_video_first_last' | 'multimodal_reference' | 'edit_video' | 'extend_video';

export interface Asset {
  id: string;
  type: 'image_url' | 'video_url' | 'audio_url';
  url: string;
  role: AssetRole;
  file_name?: string;
  cacheId?: string;
  durationSec?: number;  // measured at attach (video/audio) — enforces the 15s
                         // combined-duration cap across reference videos/audios
  thumbnailUrl?: string; // small base64 preview for image assets (avoids re-fetch)
  originalPath?: string; // Electron absolute path of the source file — last-resort
                         // recovery when both the server media-cache entry and the
                         // tmpfiles URL are gone (e.g. attached on a pre-2408 build).
}

export interface GenerationSettings {
  model: string;
  resolution: string;
  ratio: string;
  duration: number;
  generate_audio: boolean;
  return_last_frame: boolean;
  output_count: number;
  use_asset_id: boolean;
  mode: GenerationMode;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'system';
  content: string;
  taskId?: string;
  status?: 'queued' | 'running' | 'succeeded' | 'failed';
  videoUrl?: string;
  imageUrl?: string;
  error?: string;
  timestamp: number;
  startTime?: number;
  endTime?: number;
  usedSettings?: GenerationSettings;
  usedAssets?: Asset[];
  promptText?: string;
}

export interface Project {
  id: string;
  name: string;
  messages: ChatMessage[];
  settings: GenerationSettings;
  assets: Asset[];
  updatedAt: number;
  draftPrompt?: string; // saved prompt HTML so users can switch projects without losing in-progress text
}

interface AppState {
  _hasHydrated: boolean;
  projects: Project[];
  currentProjectId: string | null;
  setCurrentProjectId: (id: string) => void;
  createProject: () => void;
  renameProject: (id: string, name: string) => void;
  deleteProject: (id: string) => void;
  updateProjectSettings: (projectId: string, settings: Partial<GenerationSettings>) => void;
  addAsset: (projectId: string, asset: Omit<Asset, 'id'>) => void;
  removeAsset: (projectId: string, assetId: string) => void;
  replaceAsset: (projectId: string, assetId: string, updates: Partial<Omit<Asset, 'id'>>) => void;
  replaceAllAssets: (projectId: string, assets: Omit<Asset, 'id'>[]) => void;
  clearAssets: (projectId: string) => void;
  updateDraftPrompt: (projectId: string, draft: string) => void;
  addMessage: (projectId: string, message: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  updateMessage: (projectId: string, messageId: string, updates: Partial<ChatMessage>) => void;
  deleteMessage: (projectId: string, messageId: string) => void;
  clearMessages: (projectId: string) => void;
  pollTask: (projectId: string, messageId: string, taskId: string) => Promise<void>;
  cancelTask: (projectId: string, messageId: string, taskId: string) => Promise<void>;
}

export const defaultSettings: GenerationSettings = {
  model: 'dreamina-seedance-2-0-260128',
  resolution: '720p',
  ratio: '16:9',
  duration: 5,
  generate_audio: true,
  return_last_frame: false,
  output_count: 1,
  use_asset_id: false,
  mode: 'text_to_video',
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      _hasHydrated: false,
      projects: [],
      currentProjectId: null,
      setCurrentProjectId: (id) => set({ currentProjectId: id }),
      createProject: () => {
        const newProject: Project = {
          id: uuidv4(),
          name: `Project ${get().projects.length + 1}`,
          messages: [],
          settings: { ...defaultSettings },
          assets: [],
          updatedAt: Date.now(),
        };
        set((state) => ({
          projects: [newProject, ...state.projects],
          currentProjectId: newProject.id,
        }));
      },
      renameProject: (id, name) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === id ? { ...p, name, updatedAt: Date.now() } : p
          ),
        }));
      },
      deleteProject: (id) => {
        set((state) => {
          const newProjects = state.projects.filter((p) => p.id !== id);
          let newCurrentId = state.currentProjectId;
          if (state.currentProjectId === id) {
            newCurrentId = newProjects.length > 0 ? newProjects[0].id : null;
          }
          return { projects: newProjects, currentProjectId: newCurrentId };
        });
      },
      updateProjectSettings: (projectId, settings) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, settings: { ...p.settings, ...settings }, updatedAt: Date.now() }
              : p
          ),
        }));
      },
      addAsset: (projectId, asset) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, assets: [...p.assets, { ...asset, id: uuidv4() }], updatedAt: Date.now() }
              : p
          ),
        }));
      },
      removeAsset: (projectId, assetId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, assets: p.assets.filter((a) => a.id !== assetId), updatedAt: Date.now() }
              : p
          ),
        }));
      },
      // Atomically swap the entire asset list for a project. Used by reuse
      // (clearAssets + N addAssets used to be sequential set() calls; if
      // anything double-invoked an updater along the way the list would
      // double up). Single set() = no possible interleaving.
      replaceAllAssets: (projectId, assets) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, assets: assets.map(a => ({ ...a, id: uuidv4() })), updatedAt: Date.now() }
              : p
          ),
        }));
      },
      // Replace an asset's content while keeping its id stable. This preserves
      // any mention pills in the prompt (their data-asset-id stays valid) and
      // keeps the asset's display position/numbering — so "@[Video 1]" still
      // refers to the same slot, just pointing at new bytes.
      replaceAsset: (projectId, assetId, updates) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  assets: p.assets.map((a) =>
                    a.id === assetId ? { ...a, ...updates, id: a.id } : a
                  ),
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
      },
      clearAssets: (projectId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, assets: [], updatedAt: Date.now() } : p
          ),
        }));
      },
      updateDraftPrompt: (projectId, draft) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, draftPrompt: draft } : p
          ),
        }));
      },
      addMessage: (projectId, message) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  messages: [...p.messages, { ...message, id: (message as any).id || uuidv4(), timestamp: Date.now() }],
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
      },
      updateMessage: (projectId, messageId, updates) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? {
                  ...p,
                  messages: p.messages.map((m) =>
                    m.id === messageId ? { ...m, ...updates } : m
                  ),
                  updatedAt: Date.now(),
                }
              : p
          ),
        }));
      },
      deleteMessage: (projectId, messageId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId
              ? { ...p, messages: p.messages.filter((m) => m.id !== messageId), updatedAt: Date.now() }
              : p
          ),
        }));
      },
      clearMessages: (projectId) => {
        set((state) => ({
          projects: state.projects.map((p) =>
            p.id === projectId ? { ...p, messages: [], updatedAt: Date.now() } : p
          ),
        }));
      },
      // Single-shot check — interval in App.tsx drives the loop.
      _pollingSet: new Set<string>(),
      pollTask: async (projectId, messageId, taskId) => {
        const project = get().projects.find(p => p.id === projectId);
        const message = project?.messages.find(m => m.id === messageId);
        if (!message || message.status === 'succeeded' || message.status === 'failed') return;

        // Prevent duplicate concurrent requests for the same task
        const pollingSet = (get() as any)._pollingSet as Set<string>;
        if (pollingSet.has(taskId)) return;
        pollingSet.add(taskId);

        // Hard timeout — without this, a hung fetch keeps the taskId stuck in the polling set
        // forever and the UI freezes on "생성 중". 8s is well above normal RTT (sub-second).
        const ac = new AbortController();
        const timeoutId = setTimeout(() => ac.abort(), 8000);

        try {
          console.log(`[Poll] Checking ${taskId}...`);
          const res = await fetch(`/api/byteplus/tasks/${taskId}`, { signal: ac.signal });
          if (!res.ok) {
            // Transient HTTP error (5xx, 502, etc.) — leave status unchanged so the next
            // interval retries. Only AbortError + JSON parse fall through to the catch.
            console.warn(`[Poll] ${taskId} HTTP ${res.status} — will retry next cycle`);
            return;
          }
          const text = await res.text();
          console.log(`[Poll] ${taskId} raw response: ${text.substring(0, 200)}`);

          let data: any;
          try { data = JSON.parse(text); } catch { console.error(`[Poll] JSON parse failed`); return; }

          const status = data.status;
          const contentData = data.content;
          const errorData = data.error;

          if (status === 'succeeded') {
            console.log(`[Poll] ${taskId} SUCCEEDED!`);
            get().updateMessage(projectId, messageId, {
              content: `Task ${taskId} succeeded!`,
              status: 'succeeded',
              videoUrl: contentData?.video_url,
              imageUrl: contentData?.last_frame_url,
              endTime: Date.now(),
            });
            // Full pre-fetch into memory cache → subsequent download saves from RAM (zero CDN round-trip).
            // Validate response before caching: a 404/500 body would otherwise be served as a "video"
            // resulting in blank playback and broken downloads.
            const safePrefetch = (url: string, expectedTypePrefix: string) => {
              const pAc = new AbortController();
              const pTimer = setTimeout(() => pAc.abort(), 60000); // big videos can take a while
              fetch(url, { signal: pAc.signal })
                .then(r => {
                  if (!r.ok) throw new Error(`HTTP ${r.status}`);
                  return r.blob();
                })
                .then(b => {
                  if (b.size < 1024) throw new Error(`blob too small (${b.size}B) — likely error response`);
                  // BytePlus serves with content-type set; accept octet-stream or empty as fallback.
                  if (b.type && !b.type.startsWith(expectedTypePrefix) && b.type !== 'application/octet-stream') {
                    throw new Error(`unexpected blob type: ${b.type}`);
                  }
                  setCachedBlob(url, b);
                })
                .catch(err => console.warn(`[Cache] skip prefetch ${url.substring(0, 60)}…:`, err.message))
                .finally(() => clearTimeout(pTimer));
            };
            if (contentData?.video_url && !getCachedBlob(contentData.video_url)) {
              safePrefetch(contentData.video_url, 'video/');
            }
            if (contentData?.last_frame_url && !getCachedBlob(contentData.last_frame_url)) {
              safePrefetch(contentData.last_frame_url, 'image/');
            }
            showNotification('영상 생성 완료', { body: '영상이 성공적으로 생성되었습니다.' });
          } else if (status === 'failed' || status === 'expired') {
            console.log(`[Poll] ${taskId} FAILED: ${errorData?.message || errorData}`);
            get().updateMessage(projectId, messageId, {
              content: `Task ${taskId} ${status}.`,
              status: 'failed',
              error: errorData?.message || errorData || status,
              endTime: Date.now(),
            });
            showNotification('영상 생성 실패', { body: errorData?.message || '오류가 발생했습니다.' });
          } else {
            get().updateMessage(projectId, messageId, {
              content: `Task ${taskId} — ${status}`,
              status: status === 'queued' ? 'queued' : 'running',
            });
          }
        } catch (error: any) {
          if (error.name === 'AbortError') console.warn(`[Poll] ${taskId} timed out after 8s — will retry`);
          else console.error(`[Poll] ${taskId} fetch error:`, error.message);
        } finally {
          clearTimeout(timeoutId);
          pollingSet.delete(taskId);
        }
      },
      cancelTask: async (projectId, messageId, taskId) => {
        try {
          const res = await fetch(`/api/byteplus/tasks/${taskId}`, { method: 'DELETE' });
          get().updateMessage(projectId, messageId, {
            content: `Task ${taskId} cancelled.`,
            status: 'failed',
            error: '사용자가 작업을 취소했습니다.',
            endTime: Date.now(),
          });
        } catch (error: any) {
          console.error('Cancel task error:', error);
        }
      },
    }),
    {
      name: 'seedance-app-storage',
      storage: createJSONStorage(() => idbStorage),
      partialize: (state) => ({
        projects: state.projects,
        currentProjectId: state.currentProjectId,
      }),
      onRehydrateStorage: () => {
        return () => {
          // Migrate: fill missing settings fields with defaults + clamp invalid values
          const validResolutions = ['480p', '720p', '1080p'];
          const state = useAppStore.getState();
          const patched = state.projects.map(p => {
            const s = { ...defaultSettings, ...p.settings };
            // Clamp duration to seedance 2.0 range (4–15)
            if (s.duration < 4) s.duration = 4;
            if (s.duration > 15) s.duration = 15;
            // Clamp resolution to supported values
            if (!validResolutions.includes(s.resolution)) s.resolution = '720p';
            // Clear in-progress draft prompts on app restart (session-only persistence)
            return { ...p, settings: s, draftPrompt: '' };
          });
          useAppStore.setState({ projects: patched, _hasHydrated: true });
        };
      },
    }
  )
);
