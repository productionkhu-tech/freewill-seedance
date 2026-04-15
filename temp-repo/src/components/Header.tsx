"use client";

import { Video, Settings, LogOut, ChevronDown } from "lucide-react";
import { useAppStore } from "@/lib/store";
import { MODELS } from "@/lib/types";

export default function Header({
  onToggleParams,
  paramsOpen,
}: {
  onToggleParams: () => void;
  paramsOpen: boolean;
}) {
  const { apiKey, clearApiKey, params } = useAppStore();
  const masked = apiKey ? `...${apiKey.slice(-6)}` : "";
  const currentModel =
    MODELS.find((m) => m.id === params.modelId) ?? MODELS[0];

  return (
    <header className="h-14 border-b border-gray-100 bg-white flex items-center justify-between px-5 shrink-0">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary-500 text-white">
            <Video className="w-4 h-4" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-gray-800">
              {currentModel.name}
            </span>
            <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded">
              260128
            </span>
            <ChevronDown className="w-3 h-3 text-gray-400" />
          </div>
        </div>
        <button
          onClick={onToggleParams}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
        >
          <Settings className="w-3.5 h-3.5" />
          Configure
        </button>
      </div>

      <div className="flex items-center gap-3">
        {masked && (
          <span className="text-[11px] text-gray-400 font-mono bg-gray-50 px-2 py-1 rounded-md">
            {masked}
          </span>
        )}
        <button
          onClick={onToggleParams}
          className={`p-2 rounded-lg transition-colors ${
            paramsOpen
              ? "bg-primary-50 text-primary-600"
              : "hover:bg-gray-100 text-gray-400 hover:text-gray-600"
          }`}
          title="Configure"
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          onClick={clearApiKey}
          className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          title="Sign out"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
