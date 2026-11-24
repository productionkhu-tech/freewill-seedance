// 우리 앱이 받은 영상 끝에 붙인 생성 설정 상자(FWSD)를 떼어 BytePlus 원본 바이트로 되돌린다(26.11.2301~).
//
// 왜: BytePlus 는 실존 인물 얼굴이 든 레퍼런스를 막는다(InputVideoSensitiveContentDetected.PrivacyInformation). 예외가 '신뢰 결과물' —
// 같은 계정이 30일 안에 만든 **원본** 결과물만. 문서: "Only original model outputs are trusted; they cannot be used after secondary
// editing", "Compressing or forwarding files may invalidate trust verification". 그런데 앱이 받은 영상(다운로드 폴더 · 에이전트
// card.download 경로)에는 끝에 우리 설정 상자가 붙어 있다(electron/main.cjs embedSettings, 26.10.801~). 그 파일을 다시 레퍼런스로
// 넣으면 BytePlus 가 받는 바이트는 원본 + 상자다. 상자는 맨 끝에 덧붙이기만 했으므로(moov · mdat 은 한 바이트도 안 건드림) 떼면
// 원본과 바이트까지 같다. 그래서 R2 에 올리기 직전(server.ts /api/reupload · /api/reupload-from-path)에만 뗀다 — 캐시 파일 ·
// cacheId(첨부 때의 md5) · '수정됐나' 검사는 그대로 둔다(바꾸면 옛 카드의 재사용이 '수정됨' 으로 잘못 멈춘다).
//
// 모양은 main.cjs embedSettings 와 같다: top-level 상자가 처음부터 끝까지 맞아떨어지고, 맨 끝 연속된 'free' 상자 가운데 몸통이
// 'FWSD' 로 시작하는 것만. 맞아떨어지지 않거나(덜 받음 · 다른 형식) 끝까지 가는 상자(크기 0)가 있으면 손대지 않는다.
// 노드 · 브라우저 모두 돌게 Uint8Array 만 쓴다(server 번들 · 시험).

const BMFF_TOP = new Set(['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'uuid', 'pnot', 'meta', 'moof', 'mfra', 'sidx', 'styp', 'pdin']);
const MAGIC = 'FWSD';

const latin1 = (b: Uint8Array, at: number, n: number): string => {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
};

/** 끝의 우리 설정 상자를 뗀 바이트(같은 메모리를 가리키는 subarray)와 뗀 길이. 뗄 것이 없으면 그대로 · 0. */
export function stripSettingsBoxes<T extends Uint8Array>(buf: T): { bytes: T; stripped: number } {
  const same = { bytes: buf, stripped: 0 };
  const n = buf.length;
  if (n < 16) return same;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes: { type: string; pos: number; len: number; hl: number }[] = [];
  let pos = 0;
  while (pos < n) {
    if (pos + 8 > n || boxes.length > 4096) return same;
    let len = dv.getUint32(pos);
    const type = latin1(buf, pos + 4, 4);
    if (!BMFF_TOP.has(type)) return same;
    let hl = 8;
    if (len === 1) {
      if (pos + 16 > n) return same;
      const big = dv.getBigUint64(pos + 8);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) return same;
      len = Number(big); hl = 16;
    } else if (len === 0) {
      return same;   // 파일 끝까지 가는 상자 — embedSettings 는 이런 파일에 붙이지 않는다
    }
    if (len < hl) return same;
    boxes.push({ type, pos, len, hl });
    pos += len;
  }
  if (pos !== n || !boxes.some((b) => b.type === 'ftyp')) return same;
  let cut = n;
  for (let i = boxes.length - 1; i >= 0; i--) {
    const b = boxes[i];
    if (b.type !== 'free' || b.len < b.hl + 4 || latin1(buf, b.pos + b.hl, 4) !== MAGIC) break;
    cut = b.pos;
  }
  if (cut === n) return same;
  return { bytes: buf.subarray(0, cut) as T, stripped: n - cut };
}
