import { NextRequest, NextResponse } from "next/server";

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";
export const maxDuration = 120;

interface VolcFileResponse {
  id: string;
  object: string;
  purpose: string;
  filename: string;
  bytes: number;
  mime_type: string;
  status: string;
  created_at: number;
  expire_at: number;
}

interface AssetGroupResponse {
  Id: string;
  Name: string;
}

interface AssetResponse {
  Id: string;
  URL?: string;
  AssetType?: string;
}

async function uploadToVolcFiles(
  apiKey: string,
  file: File
): Promise<VolcFileResponse> {
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", file);

  const res = await fetch(`${ARK_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err?.error?.message || `Files API error: ${res.status}`
    );
  }

  return res.json();
}

async function createAssetGroup(
  apiKey: string,
  name: string
): Promise<AssetGroupResponse> {
  const res = await fetch(`${ARK_BASE}/contents/asset-groups`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Name: name }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Asset group error: ${res.status}`);
  }

  return res.json();
}

async function createAsset(
  apiKey: string,
  groupId: string,
  name: string,
  fileUrl: string,
  assetType: string
): Promise<AssetResponse> {
  const res = await fetch(`${ARK_BASE}/contents/assets`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      GroupId: groupId,
      Name: name,
      AssetType: assetType,
      URL: fileUrl,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Asset create error: ${res.status}`);
  }

  return res.json();
}

async function uploadAssetMultipart(
  apiKey: string,
  groupId: string,
  name: string,
  file: File
): Promise<AssetResponse> {
  const form = new FormData();
  form.append("GroupId", groupId);
  form.append("Name", name);
  form.append("file", file);

  const res = await fetch(`${ARK_BASE}/contents/assets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      err?.error?.message || `Asset upload error: ${res.status}`
    );
  }

  return res.json();
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const apiKey = formData.get("apiKey") as string | null;
    const groupId = formData.get("groupId") as string | null;

    if (!file || !apiKey) {
      return NextResponse.json(
        { error: "file and apiKey are required" },
        { status: 400 }
      );
    }

    const fileResp = await uploadToVolcFiles(apiKey, file);
    console.log("[upload] File uploaded:", fileResp.id, fileResp.status);

    if (groupId) {
      try {
        const asset = await uploadAssetMultipart(
          apiKey,
          groupId,
          file.name,
          file
        );
        console.log("[upload] Asset created:", asset.Id);
        return NextResponse.json({
          fileId: fileResp.id,
          assetId: asset.Id,
          assetUri: `Asset://${asset.Id}`,
          method: "asset",
        });
      } catch (assetErr) {
        const msg =
          assetErr instanceof Error ? assetErr.message : "Asset error";
        console.warn("[upload] Asset creation failed:", msg);

        if (msg.includes("not activated")) {
          return NextResponse.json({
            fileId: fileResp.id,
            method: "file_only",
            assetServiceRequired: true,
            activationUrl:
              "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%5B%5D&advancedActiveKey=model&tab=ComputerVision",
            error: msg,
          });
        }
      }
    }

    return NextResponse.json({
      fileId: fileResp.id,
      method: "file_only",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[upload] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { apiKey, name } = body;

    if (!apiKey) {
      return NextResponse.json(
        { error: "apiKey is required" },
        { status: 400 }
      );
    }

    const group = await createAssetGroup(
      apiKey,
      name || `sd2-assets-${Date.now()}`
    );
    console.log("[upload] Asset group created:", group.Id);
    return NextResponse.json({ groupId: group.Id });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[upload] Group creation error:", msg);

    if (msg.includes("not activated") || msg.includes("404")) {
      return NextResponse.json({
        error: "Asset Service가 활성화되지 않았습니다.",
        assetServiceRequired: true,
        activationUrl:
          "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%5B%5D&advancedActiveKey=model&tab=ComputerVision",
      }, { status: 403 });
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
