"use client";

import { useState } from "react";
import { KeyRound, ArrowRight, Video, Sparkles } from "lucide-react";
import { useAppStore } from "@/lib/store";

export default function Onboarding() {
  const setApiKey = useAppStore((s) => s.setApiKey);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) {
      setError("API Key를 입력해주세요.");
      return;
    }
    if (trimmed.length < 10) {
      setError("유효한 API Key를 입력해주세요.");
      return;
    }
    setApiKey(trimmed);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-primary-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary-500 text-white mb-4 shadow-lg shadow-primary-200">
            <Video className="w-8 h-8" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Seedance 2.0 Studio
          </h1>
          <p className="text-gray-500 text-sm">
            Volcengine Ark 기반 AI 비디오 생성 플랫폼
          </p>
        </div>

        <div className="bg-white rounded-2xl shadow-xl shadow-gray-200/50 border border-gray-100 p-8">
          <div className="flex items-center gap-2 mb-6">
            <Sparkles className="w-5 h-5 text-primary-500" />
            <h2 className="text-lg font-semibold text-gray-800">시작하기</h2>
          </div>

          <p className="text-sm text-gray-500 mb-6">
            Volcengine Ark API Key를 입력하여 Seedance 2.0 비디오 생성 모델에
            접근하세요. API Key는 브라우저에만 저장되며 외부로 전송되지 않습니다.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="apiKey"
                className="block text-sm font-medium text-gray-700 mb-1.5"
              >
                API Key
              </label>
              <div className="relative">
                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                <input
                  id="apiKey"
                  type="password"
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setError("");
                  }}
                  placeholder="Volcengine Ark API Key 입력"
                  className="w-full pl-10 pr-4 py-3 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary-400 focus:border-transparent transition-all"
                />
              </div>
              {error && (
                <p className="mt-1.5 text-xs text-red-500">{error}</p>
              )}
            </div>

            <button
              type="submit"
              className="w-full flex items-center justify-center gap-2 bg-primary-500 hover:bg-primary-600 text-white py-3 rounded-xl text-sm font-medium transition-colors shadow-lg shadow-primary-200"
            >
              시작하기
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="mt-6 p-4 bg-surface-50 rounded-xl">
            <p className="text-xs text-gray-400 leading-relaxed">
              <span className="font-medium text-gray-500">지원 모델:</span>{" "}
              doubao-seedance-2-0-260128
              <br />
              <span className="font-medium text-gray-500">해상도:</span> 480p,
              720p
              <br />
              <span className="font-medium text-gray-500">비율:</span> 16:9,
              9:16, 4:3, 3:4, 21:9, 1:1, Adaptive
              <br />
              <span className="font-medium text-gray-500">길이:</span> 5~15초
            </p>
          </div>
        </div>

        <p className="text-center text-xs text-gray-400 mt-6">
          Powered by Volcengine Ark &middot; Seedance 2.0
        </p>
      </div>
    </div>
  );
}
