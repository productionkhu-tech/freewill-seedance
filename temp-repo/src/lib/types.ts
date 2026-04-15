export type GenerationMode = "reference" | "first_last_frame";

export type AspectRatio =
  | "adaptive"
  | "16:9"
  | "4:3"
  | "1:1"
  | "3:4"
  | "9:16"
  | "21:9";

export type Resolution = "480p" | "720p";

export type DurationType = "seconds" | "smart";

export type ModelId =
  | "doubao-seedance-2-0-260128"
  | "doubao-seedance-2-0-fast-260128";

export interface ModelOption {
  id: ModelId;
  name: string;
  badge?: string;
  pricing: {
    includeVideoInput: number;
    excludeVideoInput: number;
  };
}

export const MODELS: ModelOption[] = [
  {
    id: "doubao-seedance-2-0-260128",
    name: "Doubao-Seedance-2.0",
    badge: "추천",
    pricing: { includeVideoInput: 28, excludeVideoInput: 46 },
  },
  {
    id: "doubao-seedance-2-0-fast-260128",
    name: "Doubao-Seedance-2.0-fast",
    badge: "추천",
    pricing: { includeVideoInput: 22, excludeVideoInput: 37 },
  },
];

export interface ModelParams {
  modelId: ModelId;
  mode: GenerationMode;
  ratio: AspectRatio;
  resolution: Resolution;
  durationType: DurationType;
  duration: number;
  outputCount: number;
  generateAudio: boolean;
  watermark: boolean;
  rendering: boolean;
  returnLastFrame: boolean;
  seed: string;
  internetSearch: boolean;
  generationTimeout: number;
}

export interface ReferenceAsset {
  id: string;
  type: "image" | "video" | "audio";
  url: string;
  name: string;
  role: string;
  preview?: string;
}

export interface GenerationTask {
  id: string;
  taskId: string;
  prompt: string;
  status: "pending" | "running" | "succeeded" | "failed";
  videoUrl?: string;
  error?: string;
  params: ModelParams;
  createdAt: number;
}

export const DEFAULT_PARAMS: ModelParams = {
  modelId: "doubao-seedance-2-0-260128",
  mode: "reference",
  ratio: "16:9",
  resolution: "720p",
  durationType: "seconds",
  duration: 5,
  outputCount: 1,
  generateAudio: true,
  watermark: false,
  rendering: true,
  returnLastFrame: false,
  seed: "",
  internetSearch: false,
  generationTimeout: 48,
};

export const ASPECT_RATIOS: { label: string; value: AspectRatio }[] = [
  { label: "Adaptive", value: "adaptive" },
  { label: "16:9", value: "16:9" },
  { label: "4:3", value: "4:3" },
  { label: "1:1", value: "1:1" },
  { label: "3:4", value: "3:4" },
  { label: "9:16", value: "9:16" },
  { label: "21:9", value: "21:9" },
];

export const RATIO_ICONS: Record<AspectRatio, { w: number; h: number }> = {
  adaptive: { w: 16, h: 12 },
  "21:9": { w: 21, h: 9 },
  "16:9": { w: 16, h: 9 },
  "4:3": { w: 12, h: 9 },
  "1:1": { w: 10, h: 10 },
  "3:4": { w: 9, h: 12 },
  "9:16": { w: 9, h: 16 },
};

/**
 * 실측 데이터 기반 토큰 추정:
 * 15s 720p 16:9 audio=true → 324,900 tokens (API 실측)
 * → 약 21,660 tokens/s at 720p
 */
const TOKENS_PER_SEC_720P = 21660;
const TOKENS_PER_SEC_480P = 12000;

export function estimateTokens(params: ModelParams): number {
  const dur = params.durationType === "seconds" ? params.duration : 10;
  const tps =
    params.resolution === "720p" ? TOKENS_PER_SEC_720P : TOKENS_PER_SEC_480P;
  return Math.round(dur * tps * params.outputCount);
}

export function estimateCost(params: ModelParams, hasVideoRef: boolean): number {
  const model = MODELS.find((m) => m.id === params.modelId) ?? MODELS[0];
  const ratePerM = hasVideoRef
    ? model.pricing.includeVideoInput
    : model.pricing.excludeVideoInput;
  const tokens = estimateTokens(params);
  return Math.round((tokens / 1_000_000) * ratePerM * 1000) / 1000;
}

export function ratePerKTokens(params: ModelParams, hasVideoRef: boolean): number {
  const model = MODELS.find((m) => m.id === params.modelId) ?? MODELS[0];
  const ratePerM = hasVideoRef
    ? model.pricing.includeVideoInput
    : model.pricing.excludeVideoInput;
  return Math.round((ratePerM / 1000) * 10000) / 10000;
}
