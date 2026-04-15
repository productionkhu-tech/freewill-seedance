import { NextRequest, NextResponse } from "next/server";

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export const maxDuration = 600; // Vercel/Next.js route timeout (seconds)

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, ...payload } = body;

    if (!apiKey) {
      return NextResponse.json(
        { error: "API Key is required" },
        { status: 400 }
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const res = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    const data = await res.json();

    if (!res.ok) {
      return NextResponse.json(
        { error: data.error?.message || `API Error: ${res.status}` },
        { status: res.status }
      );
    }

    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[generate] Error:", msg, e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
