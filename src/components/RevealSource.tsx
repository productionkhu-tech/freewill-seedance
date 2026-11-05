import { useState } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { canRevealFiles, revealSource } from '../lib/source-path';

// 원본 폴더 열기 버튼 — 레퍼런스 줄 · 카드 썸네일 · 어셋 이미지가 같이 쓴다. 앱이 아니면(맥 브라우저) 안 그린다.
// 경로가 없으면 안 그리는데, findable 이면 그려서 눌렀을 때 디스크에서 내용으로 찾는다(어셋 이미지 — 원본 바이트가 앱에 있어 크기 · 지문을 안다).
// searchId: 내용 id. 경로의 파일이 옮겨졌을 때도 이걸로 찾는다.
// 썸네일 위에 얹을 때는 HoverZoom 바깥에 둔다 — 버튼에 올리면 큰 미리보기가 닫혀 버튼을 가리지 않는다.
export function RevealSourceButton({ path, searchId, fileName, findable, className, size = 14, onMessage, onDone }: {
  path?: string;
  searchId?: string | null;
  fileName?: string;
  findable?: boolean;
  className?: string;
  size?: number;
  onMessage?: (msg: string, sub?: string, ok?: boolean) => void;   // 안 주면 토스트. 토스트가 가려지는 창(어셋 라이브러리)은 자기 칸에 쓴다.
  onDone?: () => void;                                             // 찾은 경로가 저장된 뒤 — 들고 있던 사본을 맞출 때
}) {
  const [busy, setBusy] = useState(false);
  if ((!path && !(findable && searchId)) || !canRevealFiles()) return null;
  const title = busy ? '원본을 찾는 중이에요'
    : path ? `원본 폴더 열기\n${path}`
    : `원본 찾기 — 이 PC에서 내용이 같은 파일을 찾아 엽니다${fileName ? `\n${fileName}` : ''}`;
  return (
    <button type="button" title={title} aria-label="원본 폴더 열기" aria-busy={busy} disabled={busy} className={busy ? `${className} !opacity-100` : className}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        setBusy(true);
        try {
          const r = await revealSource({ path, id: searchId, fileName });
          onDone?.();
          if (!r) return;
          if (onMessage) onMessage(r.msg, r.sub, r.ok);
          else window.dispatchEvent(new CustomEvent('seedance:toast', { detail: { msg: r.msg, sub: r.sub, ok: !!r.ok } }));
        } finally { setBusy(false); }
      }}>
      {busy ? <Loader2 size={size} className="animate-spin" /> : <FolderOpen size={size} />}
    </button>
  );
}

// 썸네일 위에 얹는 모양. 부모에 relative group 이 있어야 한다.
export const REVEAL_ON_THUMB = 'absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 hover:bg-black/85 text-white opacity-0 group-hover:opacity-100 transition-opacity';
