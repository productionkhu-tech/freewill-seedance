import { create } from "zustand";
import {
  type ModelParams,
  type ReferenceAsset,
  type GenerationTask,
  DEFAULT_PARAMS,
} from "./types";

interface AppState {
  apiKey: string | null;
  setApiKey: (key: string) => void;
  clearApiKey: () => void;

  params: ModelParams;
  setParams: (params: Partial<ModelParams>) => void;
  resetParams: () => void;

  prompt: string;
  setPrompt: (prompt: string) => void;

  references: ReferenceAsset[];
  addReference: (ref: ReferenceAsset) => void;
  removeReference: (id: string) => void;
  clearReferences: () => void;

  tasks: GenerationTask[];
  addTask: (task: GenerationTask) => void;
  updateTask: (id: string, update: Partial<GenerationTask>) => void;

  activeTaskId: string | null;
  setActiveTaskId: (id: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  apiKey: null,
  setApiKey: (key) => {
    if (typeof window !== "undefined") {
      localStorage.setItem("ark_api_key", key);
    }
    set({ apiKey: key });
  },
  clearApiKey: () => {
    if (typeof window !== "undefined") {
      localStorage.removeItem("ark_api_key");
    }
    set({ apiKey: null });
  },

  params: DEFAULT_PARAMS,
  setParams: (partial) =>
    set((s) => ({ params: { ...s.params, ...partial } })),
  resetParams: () => set({ params: DEFAULT_PARAMS }),

  prompt: "",
  setPrompt: (prompt) => set({ prompt }),

  references: [],
  addReference: (ref) =>
    set((s) => ({ references: [...s.references, ref] })),
  removeReference: (id) =>
    set((s) => ({ references: s.references.filter((r) => r.id !== id) })),
  clearReferences: () => set({ references: [] }),

  tasks: typeof window !== "undefined"
    ? JSON.parse(localStorage.getItem("sd2_tasks") || "[]")
    : [],
  addTask: (task) =>
    set((s) => {
      const next = [task, ...s.tasks];
      if (typeof window !== "undefined")
        localStorage.setItem("sd2_tasks", JSON.stringify(next));
      return { tasks: next };
    }),
  updateTask: (id, update) =>
    set((s) => {
      const next = s.tasks.map((t) =>
        t.id === id ? { ...t, ...update } : t
      );
      if (typeof window !== "undefined")
        localStorage.setItem("sd2_tasks", JSON.stringify(next));
      return { tasks: next };
    }),

  activeTaskId: null,
  setActiveTaskId: (id) => set({ activeTaskId: id }),
}));
