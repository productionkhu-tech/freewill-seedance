// 개인판의 '내 키' 상태(26.10.2005~) — 값은 서버만 들고 있고(PC 에 암호화 저장, server.ts personal*), 화면은 있는지 · 끝 네 글자만 안다.
// 설정 패널 카드 · 안내 띠 · 키 창 · 보내기(레퍼런스에 R2 가 필요한지)가 같은 상태를 본다.
import { useEffect, useState } from 'react';

export type PersonalKeyStatus = {
  byteplus: { set: boolean; tail: string };
  gemini: { set: boolean; tail: string };
  r2: { set: boolean; bucket: string; host: string };
  /** 켤 때 확인해 보니 쓸 수 없는 키여서 지웠다(회사 팀 키 등) — 사용자에게 한 번 알린다. */
  refused?: string;
  /** 저장된 키를 서버가 아직 여는 중(켠 직후 암호화 준비 전) — 이때는 '키 없음' 으로 보지 않는다. */
  pending?: boolean;
  /** encrypted = Windows 계정 암호화(DPAPI) · dev-plain = 개발 실행(평문 파일) · none = 저장할 수 없음 */
  storage: 'encrypted' | 'dev-plain' | 'none';
};

const OPEN_EVENT = 'seedance:open-personal-keys';
let cache: PersonalKeyStatus | null = null;
const listeners = new Set<(s: PersonalKeyStatus | null) => void>();

export async function refreshPersonalKeyStatus(): Promise<PersonalKeyStatus | null> {
  try {
    const r = await fetch('/api/personal/status');
    if (r.ok) {
      cache = await r.json();
      for (const f of listeners) f(cache);
      if (cache?.pending) setTimeout(() => { void refreshPersonalKeyStatus(); }, 1000);   // 다 열 때까지 다시 묻는다
    }
  } catch { /* 서버가 아직 안 떴다 — 다음에 */ }
  return cache;
}

export function usePersonalKeyStatus(): PersonalKeyStatus | null {
  const [s, setS] = useState(cache);
  useEffect(() => {
    listeners.add(setS);
    if (!cache) void refreshPersonalKeyStatus();
    return () => { listeners.delete(setS); };
  }, []);
  return s;
}

export function openPersonalKeys() { window.dispatchEvent(new CustomEvent(OPEN_EVENT)); }
export function onOpenPersonalKeys(cb: () => void): () => void {
  window.addEventListener(OPEN_EVENT, cb);
  return () => window.removeEventListener(OPEN_EVENT, cb);
}

/** 레퍼런스를 BytePlus 에 넘기려면 R2 가 있어야 한다 — 보내기 직전에 서버에 다시 묻는다(창에서 방금 넣었을 수 있다). */
export async function personalR2Ready(): Promise<boolean> {
  const s = await refreshPersonalKeyStatus();
  return !!s?.r2.set;
}

export const R2_NEEDED_MSG =
  '레퍼런스(이미지 · 영상 · 오디오 · 어셋)를 보내려면 R2 가 필요해요.\n'
  + 'BytePlus 가 파일을 가져갈 수 있게 잠깐 올려 둘 곳이에요. 설정 패널 › 내 키 › R2 에 만드는 법이 있어요.\n'
  + '(레퍼런스 없이 텍스트로만은 지금 바로 보낼 수 있어요.)';
