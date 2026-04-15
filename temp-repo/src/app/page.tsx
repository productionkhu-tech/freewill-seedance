"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import Onboarding from "@/components/Onboarding";
import GenerateView from "@/components/GenerateView";

export default function Home() {
  const { apiKey, setApiKey } = useAppStore();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("ark_api_key");
    if (stored) {
      setApiKey(stored);
    }
    setLoaded(true);
  }, [setApiKey]);

  if (!loaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-white">
        <div className="w-8 h-8 border-2 border-primary-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!apiKey) {
    return <Onboarding />;
  }

  return <GenerateView />;
}
