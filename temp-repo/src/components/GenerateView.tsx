"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import {
  Play,
  Settings2,
  ChevronDown,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import { createGenerationTask, getTaskStatus } from "@/lib/api";
import { estimateCost, estimateTokens } from "@/lib/types";
import Header from "./Header";
import ModelParams from "./ModelParams";
import ReferenceUpload from "./ReferenceUpload";
import VideoResult from "./VideoResult";

export default function GenerateView() {
  const {
    apiKey,
    prompt,
    setPrompt,
    references,
    params,
    addTask,
    updateTask,
  } = useAppStore();
  const [error, setError] = useState("");
  const [paramsOpen, setParamsOpen] = useState(true);
  const [modeDropdown, setModeDropdown] = useState(false);
  const pollingRef = useRef<Record<string, NodeJS.Timeout>>({});

  const hasVideoRef = references.some((r) => r.type === "video");
  const cost = estimateCost(params, hasVideoRef);

  const pollTask = useCallback(
    (localId: string, taskId: string) => {
      if (!apiKey) return;

      const poll = async () => {
        try {
          const result = await getTaskStatus(apiKey, taskId);
          const status = result.status;

          if (status === "succeeded") {
            updateTask(localId, {
              status: "succeeded",
              videoUrl: result.content?.video_url,
            });
            if (pollingRef.current[localId]) {
              clearInterval(pollingRef.current[localId]);
              delete pollingRef.current[localId];
            }
          } else if (status === "failed") {
            updateTask(localId, {
              status: "failed",
              error: result.error?.message || "Generation failed",
            });
            if (pollingRef.current[localId]) {
              clearInterval(pollingRef.current[localId]);
              delete pollingRef.current[localId];
            }
          } else {
            updateTask(localId, { status: "running" });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Polling error";
          updateTask(localId, { status: "failed", error: msg });
          if (pollingRef.current[localId]) {
            clearInterval(pollingRef.current[localId]);
            delete pollingRef.current[localId];
          }
        }
      };

      poll();
      pollingRef.current[localId] = setInterval(poll, 10000);
    },
    [apiKey, updateTask]
  );

  const { tasks } = useAppStore();

  useEffect(() => {
    tasks.forEach((t) => {
      if (
        (t.status === "pending" || t.status === "running") &&
        t.taskId &&
        !pollingRef.current[t.id]
      ) {
        pollTask(t.id, t.taskId);
      }
    });
  }, [tasks, pollTask]);

  useEffect(() => {
    return () => {
      Object.values(pollingRef.current).forEach(clearInterval);
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!apiKey || !prompt.trim()) return;
    setError("");

    const count = params.outputCount || 1;
    const singleParams = { ...params, outputCount: 1 };
    const trimmedPrompt = prompt.trim();

    const localIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const localId = `local-${Date.now()}-${i}`;
      localIds.push(localId);
      addTask({
        id: localId,
        taskId: "",
        prompt: trimmedPrompt,
        status: "pending",
        params: singleParams,
        createdAt: Date.now(),
      });
    }

    for (const localId of localIds) {
      createGenerationTask(apiKey, trimmedPrompt, references, singleParams)
        .then((result) => {
          updateTask(localId, { taskId: result.id, status: "running" });
          pollTask(localId, result.id);
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : "Unknown error";
          updateTask(localId, { status: "failed", error: msg });
        });
    }
  }, [apiKey, prompt, references, params, addTask, updateTask, pollTask]);

  return (
    <div className="h-screen flex flex-col bg-surface-50">
      <Header
        onToggleParams={() => setParamsOpen(!paramsOpen)}
        paramsOpen={paramsOpen}
      />

      <div className="flex-1 flex overflow-hidden">
        {/* Main Content */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {/* Results Area */}
          <div className="flex-1 overflow-y-auto p-5 pb-52 scrollbar-thin">
            <VideoResult />
          </div>

          {/* Floating Input Area */}
          <div className="absolute bottom-0 left-0 right-0 flex justify-center pb-5 px-6 pointer-events-none">
            <div className="w-full max-w-2xl pointer-events-auto">
              <div className="bg-white rounded-2xl shadow-xl shadow-gray-200/60 border border-gray-100 overflow-hidden">
                {/* Reference Upload */}
                <div className="px-4 pt-3">
                  <ReferenceUpload />
                </div>

                {/* Prompt Input */}
                <div className="px-4 py-2">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={
                      params.mode === "first_last_frame"
                        ? "Describe the motion you want between the first and last frames..."
                        : "Human faces are not supported in reference mode. Describe your video..."
                    }
                    rows={2}
                    className="w-full px-3 py-2 bg-surface-50 border border-gray-200 rounded-xl text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-transparent placeholder:text-gray-400 transition-all"
                  />
                </div>

                {error && (
                  <div className="mx-4 mb-2 p-2 bg-red-50 border border-red-200 rounded-lg text-xs text-red-600">
                    {error}
                  </div>
                )}

                {/* Bottom Bar */}
                <div className="px-4 pb-3 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-wrap">
                    {/* Mode Dropdown */}
                    <div className="relative">
                      <button
                        className="flex items-center gap-1 px-2 py-1 bg-primary-50 text-primary-600 rounded-lg font-medium text-[11px] hover:bg-primary-100 transition-colors"
                        onClick={() => setModeDropdown(!modeDropdown)}
                      >
                        <Settings2 className="w-3 h-3" />
                        {params.mode === "reference"
                          ? "Reference"
                          : "First&Last Frame"}
                        <ChevronDown className="w-3 h-3" />
                      </button>
                      {modeDropdown && (
                        <>
                          <div
                            className="fixed inset-0 z-10"
                            onClick={() => setModeDropdown(false)}
                          />
                          <div className="absolute bottom-full mb-1 left-0 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20 min-w-[200px]">
                            <p className="px-3 py-1.5 text-[10px] text-gray-400 font-medium">
                              Generation mode
                            </p>
                            <button
                              className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex items-center gap-2 ${
                                params.mode === "reference"
                                  ? "text-primary-600 bg-primary-50"
                                  : "text-gray-700"
                              }`}
                              onClick={() => {
                                useAppStore.getState().setParams({ mode: "reference" });
                                setModeDropdown(false);
                              }}
                            >
                              Reference generation
                              {params.mode === "reference" && (
                                <span className="text-primary-500">&#10003;</span>
                              )}
                            </button>
                            <button
                              className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 flex items-center gap-2 ${
                                params.mode === "first_last_frame"
                                  ? "text-primary-600 bg-primary-50"
                                  : "text-gray-700"
                              }`}
                              onClick={() => {
                                useAppStore.getState().setParams({ mode: "first_last_frame" });
                                setModeDropdown(false);
                              }}
                            >
                              First&last frame
                              {params.mode === "first_last_frame" && (
                                <span className="text-primary-500">&#10003;</span>
                              )}
                            </button>
                          </div>
                        </>
                      )}
                    </div>

                    <span className="text-gray-300">|</span>
                    <span>{params.ratio === "adaptive" ? "Auto" : params.ratio}</span>
                    <span className="text-gray-300">|</span>
                    <span>{params.resolution}</span>
                    <span className="text-gray-300">|</span>
                    <span>
                      {params.durationType === "seconds"
                        ? `${params.duration}s`
                        : "Smart"}
                    </span>
                    <span className="text-gray-300">|</span>
                    <span>{params.outputCount} videos</span>
                    {params.generateAudio && (
                      <>
                        <span className="text-gray-300">|</span>
                        <span className="px-1.5 py-0.5 border border-primary-300 text-primary-600 rounded font-medium text-[10px]">
                          Sound
                        </span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0 ml-2">
                    <span className="text-[10px] text-gray-400">
                      ~{(estimateTokens(params) / 1000).toFixed(0)}K tokens · ¥{cost.toFixed(3)}
                    </span>
                    <button
                      onClick={handleGenerate}
                      disabled={!prompt.trim()}
                      className="p-2 bg-primary-500 hover:bg-primary-600 disabled:bg-gray-200 disabled:text-gray-300 text-white rounded-xl transition-colors"
                    >
                      <Play className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Params Panel */}
        {paramsOpen && <ModelParams onClose={() => setParamsOpen(false)} />}
      </div>
    </div>
  );
}
