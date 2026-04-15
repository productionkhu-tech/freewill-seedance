import type { ModelParams, ReferenceAsset } from "./types";

export function buildPayload(
  prompt: string,
  references: ReferenceAsset[],
  params: ModelParams
) {
  const content: Record<string, unknown>[] = [
    { type: "text", text: prompt },
  ];

  for (const ref of references) {
    if (ref.type === "image") {
      content.push({
        type: "image_url",
        image_url: { url: ref.url },
        role: ref.role || "reference_image",
      });
    } else if (ref.type === "video") {
      content.push({
        type: "video_url",
        video_url: { url: ref.url },
        role: ref.role || "reference_video",
      });
    } else if (ref.type === "audio") {
      content.push({
        type: "audio_url",
        audio_url: { url: ref.url },
        role: ref.role || "reference_audio",
      });
    }
  }

  const body: Record<string, unknown> = {
    model: params.modelId,
    content,
    generate_audio: params.generateAudio,
    watermark: params.watermark,
  };

  if (params.ratio !== "adaptive") {
    body.ratio = params.ratio;
  }

  if (params.durationType === "seconds") {
    body.duration = params.duration;
  } else {
    body.duration = -1;
  }

  if (params.resolution) {
    body.resolution = params.resolution;
  }

  if (params.seed && params.seed.trim() !== "") {
    body.seed = parseInt(params.seed, 10);
  }

  if (params.returnLastFrame) {
    body.return_last_frame = true;
  }

  return body;
}

export async function createGenerationTask(
  apiKey: string,
  prompt: string,
  references: ReferenceAsset[],
  params: ModelParams
) {
  const payload = buildPayload(prompt, references, params);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  const res = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey, ...payload }),
    signal: controller.signal,
  });

  clearTimeout(timer);

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API Error: ${res.status}`);
  return data;
}

export async function getTaskStatus(apiKey: string, taskId: string) {
  const res = await fetch(`/api/task/${taskId}`, {
    headers: { "x-api-key": apiKey },
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API Error: ${res.status}`);
  return data;
}
