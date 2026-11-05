import { FolderOpen } from 'lucide-react';
import { canRevealFiles, revealSourceFile } from '../lib/source-path';

// 원본 폴더 열기 버튼 — 레퍼런스 줄 · 카드 썸네일 · 어셋 이미지가 같이 쓴다. 경로가 없거나(클립보드로 넣은 것 등) 앱이 아니면(맥 브라우저) 안 그린다.
// 썸네일 위에 얹을 때는 HoverZoom 바깥에 둔다 — 버튼에 올리면 큰 미리보기가 닫혀 버튼을 가리지 않는다.
export function RevealSourceButton({ path, className, size = 14, onMessage }: {
  path?: string;
  className?: string;
  size?: number;
  onMessage?: (msg: string, sub: string) => void;   // 안 주면 토스트. 토스트가 가려지는 창(어셋 라이브러리)은 자기 칸에 쓴다.
}) {
  if (!path || !canRevealFiles()) return null;
  return (
    <button type="button" title={`원본 폴더 열기\n${path}`} aria-label="원본 폴더 열기" className={className}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const msg = await revealSourceFile(path);
        if (!msg) return;
        if (onMessage) onMessage(msg, path);
        else window.dispatchEvent(new CustomEvent('seedance:toast', { detail: { msg, sub: path, ok: false } }));
      }}>
      <FolderOpen size={size} />
    </button>
  );
}

// 썸네일 위에 얹는 모양. 부모에 relative group 이 있어야 한다.
export const REVEAL_ON_THUMB = 'absolute top-0.5 right-0.5 p-0.5 rounded bg-black/60 hover:bg-black/85 text-white opacity-0 group-hover:opacity-100 transition-opacity';
