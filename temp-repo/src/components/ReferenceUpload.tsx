"use client";

import { useRef, useCallback, useState } from "react";
import {
  ImagePlus,
  Film,
  Music,
  X,
  Link2,
  ArrowLeftRight,
  Plus,
  Loader2,
  Upload,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import type { ReferenceAsset } from "@/lib/types";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getFileType(file: File): "image" | "video" | "audio" {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "image";
}

function getRoleForType(type: "image" | "video" | "audio"): string {
  if (type === "video") return "reference_video";
  if (type === "audio") return "reference_audio";
  return "reference_image";
}

function AssetCard({
  asset,
  uploading,
}: {
  asset: ReferenceAsset;
  uploading?: boolean;
}) {
  const removeReference = useAppStore((s) => s.removeReference);

  return (
    <div className="group relative bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
      <div className="aspect-square flex items-center justify-center bg-gray-100 w-16 h-16">
        {uploading ? (
          <Loader2 className="w-5 h-5 text-primary-500 animate-spin" />
        ) : asset.type === "image" && asset.preview ? (
          <img
            src={asset.preview || asset.url}
            alt={asset.name}
            className="w-full h-full object-cover"
          />
        ) : asset.type === "video" ? (
          <Film className="w-5 h-5 text-blue-400" />
        ) : asset.type === "audio" ? (
          <Music className="w-5 h-5 text-purple-400" />
        ) : (
          <ImagePlus className="w-5 h-5 text-gray-400" />
        )}
      </div>
      {asset.url.startsWith("Asset://") && (
        <div className="absolute bottom-0 left-0 right-0 bg-green-500/80 text-[7px] text-white text-center py-0.5 leading-none">
          Asset
        </div>
      )}
      <button
        onClick={() => removeReference(asset.id)}
        className="absolute -top-1 -right-1 p-0.5 bg-gray-600 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

function FirstLastFrameUpload() {
  const { references, addReference, removeReference } = useAppStore();
  const firstRef = useRef<HTMLInputElement>(null);
  const lastRef = useRef<HTMLInputElement>(null);

  const firstFrame = references.find((r) => r.role === "first_frame");
  const lastFrame = references.find((r) => r.role === "last_frame");

  const handleUpload = useCallback(
    async (file: File, role: "first_frame" | "last_frame") => {
      const existing = references.find((r) => r.role === role);
      if (existing) removeReference(existing.id);

      try {
        const url = await fileToBase64(file);
        addReference({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type: "image",
          url,
          name: file.name,
          role,
          preview: url,
        });
      } catch {
        /* skip */
      }
    },
    [addReference, removeReference, references]
  );

  const swapFrames = () => {
    if (!firstFrame && !lastFrame) return;
    const updates: { id: string; role: string }[] = [];
    if (firstFrame) updates.push({ id: firstFrame.id, role: "last_frame" });
    if (lastFrame) updates.push({ id: lastFrame.id, role: "first_frame" });

    const store = useAppStore.getState();
    const newRefs = store.references.map((r) => {
      const up = updates.find((u) => u.id === r.id);
      return up ? { ...r, role: up.role } : r;
    });
    useAppStore.setState({ references: newRefs });
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex-1 border border-dashed border-gray-300 rounded-xl p-3 flex flex-col items-center justify-center cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 transition-all min-h-[80px]"
        onClick={() => firstRef.current?.click()}
      >
        {firstFrame?.preview ? (
          <div className="relative group">
            <img
              src={firstFrame.preview}
              alt="First frame"
              className="w-16 h-16 object-cover rounded-lg"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeReference(firstFrame.id);
              }}
              className="absolute -top-1 -right-1 p-0.5 bg-gray-600 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ) : (
          <Plus className="w-5 h-5 text-gray-400 mb-1" />
        )}
        <span className="text-[10px] text-gray-400 mt-1">首帧</span>
      </div>

      <button
        onClick={swapFrames}
        className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors shrink-0"
        title="Swap frames"
      >
        <ArrowLeftRight className="w-4 h-4" />
      </button>

      <div
        className="flex-1 border border-dashed border-gray-300 rounded-xl p-3 flex flex-col items-center justify-center cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 transition-all min-h-[80px]"
        onClick={() => lastRef.current?.click()}
      >
        {lastFrame?.preview ? (
          <div className="relative group">
            <img
              src={lastFrame.preview}
              alt="Last frame"
              className="w-16 h-16 object-cover rounded-lg"
            />
            <button
              onClick={(e) => {
                e.stopPropagation();
                removeReference(lastFrame.id);
              }}
              className="absolute -top-1 -right-1 p-0.5 bg-gray-600 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        ) : (
          <Plus className="w-5 h-5 text-gray-400 mb-1" />
        )}
        <span className="text-[10px] text-gray-400 mt-1">尾帧</span>
      </div>

      <input
        ref={firstRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f, "first_frame");
          e.target.value = "";
        }}
      />
      <input
        ref={lastRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f, "last_frame");
          e.target.value = "";
        }}
      />
    </div>
  );
}

function ReferenceMode() {
  const { references, addReference, apiKey } = useAppStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingIds, setUploadingIds] = useState<Set<string>>(new Set());
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [assetActivationUrl, setAssetActivationUrl] = useState<string | null>(
    null
  );

  const uploadFileToVolcengine = useCallback(
    async (file: File): Promise<{ url: string; preview?: string }> => {
      const type = getFileType(file);

      if (type === "image") {
        const dataUri = await fileToBase64(file);
        return { url: dataUri, preview: dataUri };
      }

      if (!apiKey) throw new Error("API Key가 필요합니다");

      const form = new FormData();
      form.append("file", file);
      form.append("apiKey", apiKey);

      const groupId =
        typeof window !== "undefined"
          ? localStorage.getItem("volc_asset_group_id")
          : null;
      if (groupId) form.append("groupId", groupId);

      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || "업로드 실패");

      if (data.assetUri) {
        return { url: data.assetUri };
      }

      if (data.assetServiceRequired) {
        setAssetActivationUrl(data.activationUrl);
        throw new Error(
          "Asset Service 활성화가 필요합니다. Volcengine 콘솔에서 활성화 후 다시 시도해주세요."
        );
      }

      throw new Error(
        "비디오/오디오는 Asset Service가 필요합니다. 콘솔에서 활성화하거나 URL을 직접 입력해주세요."
      );
    },
    [apiKey]
  );

  const handleFileUpload = useCallback(
    async (files: FileList) => {
      setUploadError(null);

      for (const file of Array.from(files)) {
        const tempId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const type = getFileType(file);
        const role = getRoleForType(type);

        addReference({
          id: tempId,
          type,
          url: "",
          name: file.name,
          role,
          preview: type === "image" ? URL.createObjectURL(file) : undefined,
        });

        setUploadingIds((prev) => new Set(prev).add(tempId));

        uploadFileToVolcengine(file)
          .then(({ url, preview }) => {
            const store = useAppStore.getState();
            const updated = store.references.map((r) =>
              r.id === tempId ? { ...r, url, preview: preview || r.preview } : r
            );
            useAppStore.setState({ references: updated });
          })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : "업로드 실패";
            setUploadError(msg);
            useAppStore.getState().removeReference(tempId);
          })
          .finally(() => {
            setUploadingIds((prev) => {
              const next = new Set(prev);
              next.delete(tempId);
              return next;
            });
          });
      }
    },
    [addReference, uploadFileToVolcengine]
  );

  const handleUrlAdd = useCallback(() => {
    const url = window.prompt(
      "이미지/비디오/오디오 URL을 입력하세요:\n(비디오는 직접 다운로드 가능한 .mp4 URL이 필요합니다)"
    );
    if (!url) return;

    let type: "image" | "video" | "audio" = "image";
    let role = "reference_image";
    if (/\.(mp4|mov|webm)/i.test(url) || url.includes("video")) {
      type = "video";
      role = "reference_video";
    } else if (/\.(mp3|wav|ogg)/i.test(url) || url.includes("audio")) {
      type = "audio";
      role = "reference_audio";
    }

    addReference({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      url,
      name: url.split("/").pop() || "asset",
      role,
      preview: type === "image" ? url : undefined,
    });
  }, [addReference]);

  const handleInitAssetGroup = useCallback(async () => {
    if (!apiKey) return;
    setUploadError(null);

    try {
      const res = await fetch("/api/upload", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, name: `sd2-web-${Date.now()}` }),
      });
      const data = await res.json();

      if (!res.ok) {
        if (data.assetServiceRequired) {
          setAssetActivationUrl(data.activationUrl);
          setUploadError(data.error);
        } else {
          setUploadError(data.error);
        }
        return;
      }

      localStorage.setItem("volc_asset_group_id", data.groupId);
      setUploadError(null);
      setAssetActivationUrl(null);
      alert(`Asset 그룹이 생성되었습니다: ${data.groupId}`);
    } catch (err) {
      setUploadError(
        err instanceof Error ? err.message : "그룹 생성 실패"
      );
    }
  }, [apiKey]);

  const hasGroupId =
    typeof window !== "undefined" &&
    !!localStorage.getItem("volc_asset_group_id");

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {references.map((ref) => (
          <AssetCard
            key={ref.id}
            asset={ref}
            uploading={uploadingIds.has(ref.id)}
          />
        ))}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={references.length >= 12}
          className="w-16 h-16 border border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <Plus className="w-4 h-4 text-gray-400" />
          <span className="text-[9px] text-gray-400 mt-0.5">파일</span>
        </button>
        <button
          onClick={handleUrlAdd}
          className="w-16 h-16 border border-dashed border-gray-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-primary-400 hover:bg-primary-50/30 transition-all shrink-0"
        >
          <Link2 className="w-4 h-4 text-gray-400" />
          <span className="text-[9px] text-gray-400 mt-0.5">URL</span>
        </button>
        {!hasGroupId && (
          <button
            onClick={handleInitAssetGroup}
            title="Volcengine Asset 그룹 생성 (비디오/오디오 업로드 활성화)"
            className="w-16 h-16 border border-dashed border-orange-300 rounded-lg flex flex-col items-center justify-center cursor-pointer hover:border-orange-400 hover:bg-orange-50/50 transition-all shrink-0"
          >
            <Upload className="w-4 h-4 text-orange-400" />
            <span className="text-[8px] text-orange-400 mt-0.5 leading-tight text-center">
              Asset
              <br />
              설정
            </span>
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFileUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {uploadError && (
        <div className="flex items-start gap-1.5 p-2 bg-orange-50 border border-orange-200 rounded-lg text-[11px] text-orange-700">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{uploadError}</p>
            {assetActivationUrl && (
              <a
                href={assetActivationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-1 text-blue-600 hover:underline font-medium"
              >
                Asset Service 활성화
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ReferenceUpload() {
  const { params, references } = useAppStore();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-gray-400">
        <span className="font-medium text-gray-500">
          {params.mode === "first_last_frame"
            ? "First & Last Frame"
            : "이미지 / 비디오 / 오디오"}
        </span>
        {params.mode === "reference" && (
          <span>({references.length}/12)</span>
        )}
      </div>

      {params.mode === "first_last_frame" ? (
        <FirstLastFrameUpload />
      ) : (
        <ReferenceMode />
      )}
    </div>
  );
}
