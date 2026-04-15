"use client";

import { useState } from "react";
import {
  Download,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  RefreshCw,
  LayoutList,
  LayoutGrid,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { GenerationTask } from "@/lib/types";

type ViewMode = "list" | "grid";

function TaskCard({
  task,
  compact,
}: {
  task: GenerationTask;
  compact?: boolean;
}) {
  const statusConfig = {
    pending: {
      icon: Clock,
      color: "text-amber-500",
      bg: "bg-gray-100",
      label: "Queued",
    },
    running: {
      icon: Loader2,
      color: "text-primary-500",
      bg: "bg-surface-100",
      label: "Generating...",
    },
    succeeded: {
      icon: CheckCircle2,
      color: "text-green-500",
      bg: "bg-green-50",
      label: "Complete",
    },
    failed: {
      icon: XCircle,
      color: "text-red-500",
      bg: "bg-red-50/60",
      label: "Failed",
    },
  };

  const cfg = statusConfig[task.status];
  const Icon = cfg.icon;
  const isFinished = task.status === "succeeded" && task.videoUrl;

  return (
    <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden shadow-sm h-full flex flex-col">
      {isFinished ? (
        <div className="bg-black overflow-hidden flex-shrink-0">
          <video
            src={task.videoUrl}
            controls
            autoPlay
            loop
            className={`w-full object-contain mx-auto ${
              compact ? "max-h-[240px]" : "max-h-[480px]"
            }`}
          />
        </div>
      ) : (
        <div
          className={`${cfg.bg} flex flex-col items-center justify-center gap-2 flex-shrink-0 ${
            compact ? "py-12" : "py-20"
          }`}
        >
          <Icon
            className={`${compact ? "w-6 h-6" : "w-7 h-7"} ${cfg.color} ${
              task.status === "running" ? "animate-spin" : ""
            }`}
          />
          <span
            className={`${compact ? "text-xs" : "text-sm"} font-medium ${
              cfg.color
            }`}
          >
            {cfg.label}
          </span>
          {task.status === "running" && (
            <div
              className={`${
                compact ? "w-20" : "w-32"
              } h-1.5 bg-gray-200 rounded-full overflow-hidden mt-1`}
            >
              <div className="h-full bg-primary-400 rounded-full animate-pulse w-2/3" />
            </div>
          )}
          {task.error && (
            <p className="text-xs text-red-500 max-w-xs text-center mt-1">
              {task.error}
            </p>
          )}
        </div>
      )}

      <div className={`${compact ? "px-3 py-2" : "px-4 py-3"}`}>
        <p
          className={`text-gray-600 leading-relaxed ${
            compact ? "text-[11px] line-clamp-1" : "text-xs line-clamp-2"
          }`}
        >
          {task.prompt}
        </p>

        <div
          className={`${
            compact ? "mt-1.5" : "mt-2"
          } flex items-center justify-between`}
        >
          <div
            className={`flex items-center gap-1.5 ${
              compact ? "text-[9px]" : "text-[10px]"
            } text-gray-400`}
          >
            <span>{task.params.resolution}</span>
            <span>·</span>
            <span>{task.params.ratio}</span>
            <span>·</span>
            <span>
              {task.params.durationType === "seconds"
                ? `${task.params.duration}s`
                : "auto"}
            </span>
            {!compact && (
              <>
                <span>·</span>
                <span>{new Date(task.createdAt).toLocaleTimeString()}</span>
              </>
            )}
          </div>

          {isFinished && (
            <a
              href={task.videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              download
              className={`inline-flex items-center gap-1 bg-primary-500 text-white rounded-lg font-medium hover:bg-primary-600 transition-colors ${
                compact
                  ? "px-2 py-0.5 text-[10px]"
                  : "px-2.5 py-1 text-[11px]"
              }`}
            >
              <Download className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
              {compact ? "DL" : "Download"}
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
  return (
    <div className="inline-flex items-center bg-surface-100 rounded-lg p-0.5">
      <button
        onClick={() => onChange("list")}
        className={`p-1.5 rounded-md transition-colors ${
          mode === "list"
            ? "bg-white shadow-sm text-gray-700"
            : "text-gray-400 hover:text-gray-500"
        }`}
      >
        <LayoutList className="w-4 h-4" />
      </button>
      <button
        onClick={() => onChange("grid")}
        className={`p-1.5 rounded-md transition-colors ${
          mode === "grid"
            ? "bg-white shadow-sm text-gray-700"
            : "text-gray-400 hover:text-gray-500"
        }`}
      >
        <LayoutGrid className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function VideoResult() {
  const { tasks } = useAppStore();
  const [viewMode, setViewMode] = useState<ViewMode>("list");

  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-surface-100 flex items-center justify-center mx-auto mb-3">
            <RefreshCw className="w-5 h-5 text-gray-300" />
          </div>
          <p className="text-sm text-gray-400 mb-1">No generations yet</p>
          <p className="text-xs text-gray-300">
            프롬프트를 입력하고 Generate를 클릭하세요
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-3">
        <ViewToggle mode={viewMode} onChange={setViewMode} />
      </div>

      {viewMode === "list" ? (
        <div className="flex flex-col items-center gap-4">
          {tasks.map((task) => (
            <div key={task.id} className="w-full max-w-2xl">
              <TaskCard task={task} />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-5 gap-3">
          {tasks.map((task) => (
            <TaskCard key={task.id} task={task} compact />
          ))}
        </div>
      )}
    </div>
  );
}
