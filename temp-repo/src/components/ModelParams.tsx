"use client";

import { useState } from "react";
import {
  RefreshCw,
  X,
  Dices,
  ChevronDown,
  ChevronUp,
  Layers,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import {
  ASPECT_RATIOS,
  RATIO_ICONS,
  MODELS,
  type AspectRatio,
} from "@/lib/types";

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors ${
        checked ? "bg-primary-500" : "bg-gray-200"
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-sm ring-0 transition-transform mt-0.5 ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function RatioIcon({ ratio }: { ratio: AspectRatio }) {
  const dim = RATIO_ICONS[ratio];
  const scale = 14 / Math.max(dim.w, dim.h);
  const w = Math.round(dim.w * scale);
  const h = Math.round(dim.h * scale);
  return (
    <div className="flex items-center justify-center w-5 h-5">
      <div
        className="border border-current rounded-[2px]"
        style={{ width: w, height: h }}
      />
    </div>
  );
}

export default function ModelParams({ onClose }: { onClose?: () => void }) {
  const { params, setParams, resetParams } = useAppStore();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [modelDropdown, setModelDropdown] = useState(false);

  const currentModel = MODELS.find((m) => m.id === params.modelId) ?? MODELS[0];

  const randomSeed = () => {
    setParams({ seed: String(Math.floor(Math.random() * 2147483647)) });
  };

  return (
    <div className="w-80 bg-white border-l border-gray-100 flex flex-col h-full overflow-y-auto scrollbar-thin">
      <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 sticky top-0 bg-white z-10">
        <h2 className="text-sm font-semibold text-gray-800">Model Params</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={resetParams}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            title="Reset"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="p-5 space-y-6 flex-1">
        {/* Model Selector */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Model
          </label>
          <div className="relative">
            <button
              onClick={() => setModelDropdown(!modelDropdown)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 border border-gray-200 rounded-xl text-sm hover:border-gray-300 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary-500" />
                <div className="text-left">
                  <p className="text-xs font-medium text-gray-800">
                    {currentModel.name}
                  </p>
                  <p className="text-[10px] text-gray-400">260128</p>
                </div>
              </div>
              <ChevronDown className="w-4 h-4 text-gray-400" />
            </button>
            {modelDropdown && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setModelDropdown(false)}
                />
                <div className="absolute top-full mt-1 left-0 right-0 bg-white rounded-xl shadow-lg border border-gray-100 py-1 z-20">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 ${
                        params.modelId === m.id ? "bg-primary-50" : ""
                      }`}
                      onClick={() => {
                        setParams({ modelId: m.id });
                        setModelDropdown(false);
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-medium text-gray-800">
                            {m.name}
                          </p>
                          <p className="text-[10px] text-gray-400">
                            {m.id}
                          </p>
                        </div>
                        {m.badge && (
                          <span className="text-[10px] text-primary-500 font-medium">
                            {m.badge}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex gap-3 text-[10px] text-gray-400">
                        <span>
                          영상입력 포함: ¥{m.pricing.includeVideoInput}/M
                        </span>
                        <span>
                          영상입력 미포함: ¥{m.pricing.excludeVideoInput}/M
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>

        {/* Mode */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Mode
          </label>
          <div className="grid grid-cols-2 gap-1 bg-surface-100 rounded-xl p-1">
            <button
              onClick={() => setParams({ mode: "reference" })}
              className={`py-2 rounded-lg text-xs font-medium transition-all ${
                params.mode === "reference"
                  ? "bg-white text-gray-800 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Reference
            </button>
            <button
              onClick={() => setParams({ mode: "first_last_frame" })}
              className={`py-2 rounded-lg text-xs font-medium transition-all ${
                params.mode === "first_last_frame"
                  ? "bg-white text-gray-800 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              First/Last Frame
            </button>
          </div>
        </section>

        {/* Aspect Ratio */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Aspect Ratio
          </label>
          <div className="grid grid-cols-3 gap-1.5">
            {ASPECT_RATIOS.map((r) => (
              <button
                key={r.value}
                onClick={() => setParams({ ratio: r.value })}
                className={`flex items-center justify-center gap-1 py-2 rounded-xl text-xs font-medium border transition-all ${
                  params.ratio === r.value
                    ? "border-primary-400 bg-primary-50 text-primary-700"
                    : "border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
              >
                <RatioIcon ratio={r.value} />
                {r.label}
              </button>
            ))}
          </div>
        </section>

        {/* Resolution */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Resolution
          </label>
          <div className="grid grid-cols-2 gap-1 bg-surface-100 rounded-xl p-1">
            {(["480p", "720p"] as const).map((res) => (
              <button
                key={res}
                onClick={() => setParams({ resolution: res })}
                className={`py-2 rounded-lg text-xs font-medium transition-all ${
                  params.resolution === res
                    ? "bg-white text-gray-800 shadow-sm"
                    : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {res}
              </button>
            ))}
          </div>
        </section>

        {/* Video Duration */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Video Duration
          </label>
          <div className="grid grid-cols-2 gap-1 bg-surface-100 rounded-xl p-1 mb-3">
            <button
              onClick={() => setParams({ durationType: "seconds" })}
              className={`py-2 rounded-lg text-xs font-medium transition-all ${
                params.durationType === "seconds"
                  ? "bg-white text-gray-800 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Seconds
            </button>
            <button
              onClick={() => setParams({ durationType: "smart" })}
              className={`py-2 rounded-lg text-xs font-medium transition-all ${
                params.durationType === "smart"
                  ? "bg-white text-gray-800 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              Smart length
            </button>
          </div>
          {params.durationType === "seconds" && (
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={15}
                step={1}
                value={params.duration}
                onChange={(e) =>
                  setParams({ duration: Number(e.target.value) })
                }
                className="flex-1 accent-primary-500 h-1.5"
              />
              <div className="flex items-center gap-1 bg-surface-100 rounded-lg px-3 py-1.5 min-w-[60px] justify-center">
                <span className="text-sm font-medium text-gray-700">
                  {params.duration}
                </span>
                <span className="text-xs text-gray-400">s</span>
              </div>
            </div>
          )}
        </section>

        {/* Output Count */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Output Count
          </label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={4}
              step={1}
              value={params.outputCount}
              onChange={(e) =>
                setParams({ outputCount: Number(e.target.value) })
              }
              className="flex-1 accent-primary-500 h-1.5"
            />
            <div className="flex items-center gap-1 bg-surface-100 rounded-lg px-3 py-1.5 min-w-[75px] justify-center">
              <span className="text-sm font-medium text-gray-700">
                {params.outputCount}
              </span>
              <span className="text-xs text-gray-400">items</span>
            </div>
          </div>
        </section>

        {/* Toggles */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700">Audio Output</span>
            <Toggle
              checked={params.generateAudio}
              onChange={(v) => setParams({ generateAudio: v })}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700">Watermark</span>
            <Toggle
              checked={params.watermark}
              onChange={(v) => setParams({ watermark: v })}
            />
          </div>
          <div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-700">Rendering</span>
              <Toggle
                checked={params.rendering}
                onChange={(v) => setParams({ rendering: v })}
              />
            </div>
            <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
              When enabled, generation takes longer. Unlocks layered background
              modeling, finer denoising, and richer texture rendering.
            </p>
          </div>
        </section>

        <hr className="border-gray-100" />

        {/* Return Last Frame */}
        <section>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-700">Return Last Frame</span>
            <Toggle
              checked={params.returnLastFrame}
              onChange={(v) => setParams({ returnLastFrame: v })}
            />
          </div>
        </section>

        {/* Seed */}
        <section>
          <label className="block text-xs font-medium text-gray-500 mb-2">
            Seed
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={params.seed}
              onChange={(e) => setParams({ seed: e.target.value })}
              placeholder="Leave empty for random"
              className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-transparent"
            />
            <button
              onClick={randomSeed}
              className="p-2 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-400 hover:text-gray-600 transition-colors"
              title="Random seed"
            >
              <Dices className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[11px] text-gray-400 mt-1">
            A fixed value can reproduce the same result. Leave empty to
            randomize each run.
          </p>
        </section>

        {/* Advanced */}
        <section className="border-t border-gray-100 pt-4">
          <button
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex items-center justify-between w-full text-sm font-medium text-gray-700"
          >
            Advanced parameter settings
            {advancedOpen ? (
              <ChevronUp className="w-4 h-4 text-gray-400" />
            ) : (
              <ChevronDown className="w-4 h-4 text-gray-400" />
            )}
          </button>
          {advancedOpen && (
            <div className="mt-4 space-y-4">
              {/* Internet Search */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700">Internet search</span>
                <Toggle
                  checked={params.internetSearch}
                  onChange={(v) => setParams({ internetSearch: v })}
                />
              </div>

              {/* Generation Timeout */}
              <div>
                <label className="block text-sm text-gray-700 mb-2">
                  Generation timeout
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={1}
                    max={72}
                    step={1}
                    value={params.generationTimeout}
                    onChange={(e) =>
                      setParams({
                        generationTimeout: Number(e.target.value),
                      })
                    }
                    className="flex-1 accent-primary-500 h-1.5"
                  />
                  <div className="flex items-center gap-1 bg-surface-100 rounded-lg px-3 py-1.5 min-w-[75px] justify-center">
                    <span className="text-sm font-medium text-gray-700">
                      {params.generationTimeout}
                    </span>
                    <span className="text-xs text-gray-400">hour</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
