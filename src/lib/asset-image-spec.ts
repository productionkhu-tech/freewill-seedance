// BytePlus 에셋(비공개 가상 인물 라이브러리)에 올릴 수 있는 사진인가 — 올리기 전에 서버가 본다(26.11.2301~).
// 왜: 규격 밖 사진은 CreateAsset 을 한 번 쓰고(무료 등급 분당 3건 · 개수 50) 몇 초 뒤 Failed 로 돌아온다. 미리 거르면 한도를 아끼고
// 이유를 바로 보여 준다. 규격(BytePlus 문서 2333565): jpeg · png · webp · tiff · gif · heic, 가로세로비 0.4~2.5, 변 300~6000px, 30MB 미만.
// 머리 바이트만 읽는다(디코딩 없음). 크기를 못 읽는 형식(tiff · heic)은 막지 않는다 — BytePlus 가 판단하게.

export type ImageDims = { format: string; width: number; height: number } | { format: string; width?: undefined; height?: undefined };

/** 형식과 (읽을 수 있으면) 가로 · 세로. 모르는 형식은 null. */
export function imageDims(b: Uint8Array): ImageDims | null {
  const n = b.length;
  const u16be = (i: number) => (b[i] << 8) | b[i + 1];
  const u16le = (i: number) => b[i] | (b[i + 1] << 8);
  const u24le = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const u32be = (i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const ascii = (i: number, len: number) => String.fromCharCode(...b.subarray(i, i + len));
  // PNG — IHDR 가 언제나 첫 덩어리
  if (n >= 24 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return { format: 'png', width: u32be(16), height: u32be(20) };
  // GIF
  if (n >= 10 && ascii(0, 3) === 'GIF') return { format: 'gif', width: u16le(6), height: u16le(8) };
  // WEBP — VP8 · VP8L · VP8X
  if (n >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const kind = ascii(12, 4);
    if (kind === 'VP8 ') return { format: 'webp', width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (kind === 'VP8L') { const v = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; return { format: 'webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }; }
    if (kind === 'VP8X') return { format: 'webp', width: u24le(24) + 1, height: u24le(27) + 1 };
    return { format: 'webp' };
  }
  // JPEG — SOFn 표지까지 덩어리를 건너뛴다(EXIF · ICC 가 앞에 길게 올 수 있다)
  if (n >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 3 < n) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }                          // 채움 바이트
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }   // 길이 없는 표지
      if (m === 0xd9 || m === 0xda) break;                        // 끝 · 본문 — 그 전에 SOF 가 있어야 한다
      const len = u16be(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        if (i + 8 < n) return { format: 'jpeg', height: u16be(i + 5), width: u16be(i + 7) };
        break;
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { format: 'jpeg' };
  }
  if (n >= 2 && b[0] === 0x42 && b[1] === 0x4d) return { format: 'bmp' };
  if (n >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 0x2a))) return { format: 'tiff' };
  if (n >= 12 && ascii(4, 4) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)$/.test(ascii(8, 4))) return { format: 'heic' };
  return null;
}

export const ASSET_IMAGE_SPEC = { minPx: 300, maxPx: 6000, minRatio: 0.4, maxRatio: 2.5, maxBytes: 30 * 1024 * 1024 } as const;
const OK_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'heic']);

/** 머리를 몇 바이트까지 읽으면 되나 — JPEG 는 SOF 앞에 EXIF · ICC 가 길게 올 수 있다(덩어리 하나 64KB, 보통 몇 개). 못 찾으면 막지 않는다. */
export const ASSET_SPEC_HEAD_BYTES = 1024 * 1024;

/** 에셋으로 못 올리는 까닭(사람 말) — 올릴 수 있으면 null. b 는 파일 앞부분이어도 된다(totalBytes = 파일 크기). */
export function assetImageProblem(b: Uint8Array, totalBytes: number = b.length): string | null {
  const S = ASSET_IMAGE_SPEC;
  if (totalBytes >= S.maxBytes) return `파일이 너무 커요(${(totalBytes / 1048576).toFixed(1)}MB) — 에셋은 30MB 미만만 돼요.`;
  const d = imageDims(b);
  if (!d) return '알 수 없는 이미지 형식이에요 — 에셋은 JPG · PNG · WEBP · GIF · TIFF · HEIC 만 돼요.';
  if (!OK_FORMATS.has(d.format)) return `${d.format.toUpperCase()} 는 에셋으로 올릴 수 없어요 — JPG · PNG · WEBP 로 바꿔 주세요.`;
  if (d.width === undefined) return null;
  const { width: w, height: h } = d;
  if (!(w > 0 && h > 0)) return null;   // 머리를 잘못 읽었으면 막지 않는다
  if (Math.min(w, h) < S.minPx) return `사진이 너무 작아요(${w}×${h}) — 에셋은 가로 · 세로 모두 ${S.minPx}px 이상이어야 해요.`;
  if (Math.max(w, h) > S.maxPx) return `사진이 너무 커요(${w}×${h}) — 에셋은 가로 · 세로 모두 ${S.maxPx}px 이하여야 해요.`;
  const r = w / h;
  if (r <= S.minRatio || r >= S.maxRatio) return `사진 비율이 너무 길어요(${w}×${h}) — 에셋은 가로세로비 0.4~2.5 사이만 돼요.`;
  return null;
}
