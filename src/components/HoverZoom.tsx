import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';

// Wraps a small thumbnail and shows an enlarged floating preview while hovered.
// Rendered via a portal to <body> so it escapes any overflow:auto/hidden clip
// (e.g. the Settings asset panel). Positioned to the LEFT of the thumbnail by
// default (thumbnails live near the right edge), clamped into the viewport.
//
// `fullSrc` (e.g. /api/cache/<id> full-res) is tried first for a crisp preview;
// on load error it falls back to `src` (the small thumbnail). Used in the asset
// panel and message/preview reference thumbnails — NOT the prompt mention pills.
export function HoverZoom({ src, fullSrc, videoSrc, className, children }: {
  src: string;
  fullSrc?: string;
  videoSrc?: string;   // when set, the preview is a <video> showing the first
                       // frame (crisp), with `src` (thumbnail) as poster fallback
  className?: string;
  children: React.ReactNode;
}) {
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const SIZE = 256;
  const GAP = 10;

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // Prefer left of the thumb; if not enough room, place to the right.
    let left = r.left - SIZE - GAP;
    if (left < GAP) left = Math.min(window.innerWidth - SIZE - GAP, r.right + GAP);
    left = Math.max(GAP, left); // never off the left edge (tiny/odd windows)
    const top = Math.max(GAP, Math.min(window.innerHeight - SIZE - GAP, r.top + r.height / 2 - SIZE / 2));
    setBox({ left, top });
  };
  const hide = () => setBox(null);

  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} className={className}>
      {children}
      {box && createPortal(
        <div style={{ position: 'fixed', left: box.left, top: box.top, zIndex: 99999, pointerEvents: 'none' }}>
          {videoSrc ? (
            // First frame of the actual video (media fragment #t pins a frame).
            // poster = the captured thumbnail, shown if the file is gone (cache
            // expired → video errors, poster stays).
            <video
              src={`${videoSrc}#t=0.1`}
              poster={src}
              preload="metadata"
              muted
              playsInline
              style={{ width: SIZE, height: SIZE, maxWidth: 'none', maxHeight: 'none', objectFit: 'contain', background: '#0b0b0d', borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}
            />
          ) : (
            <img
              src={fullSrc || src}
              onError={(e) => { const el = e.currentTarget; if (fullSrc && el.src !== src) el.src = src; }}
              style={{ width: SIZE, height: SIZE, maxWidth: 'none', maxHeight: 'none', objectFit: 'contain', background: '#0b0b0d', borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.08)' }}
            />
          )}
        </div>,
        document.body,
      )}
    </span>
  );
}
