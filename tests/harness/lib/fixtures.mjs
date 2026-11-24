// 시험에 쓰는 사진 · 영상을 만든다(ffmpeg) — 저장소에는 넣지 않는다. 가짜 BytePlus 는 얼굴을 보지 않으므로 그림이면 된다.
// 이름은 시험이 부르던 그대로. 한 번 만들면 다시 쓴다(판이 바뀌면 다시).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { DATA } from './app.mjs';

export const FIX = path.join(DATA, 'fixtures');
const VER = '3';
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: ['ignore', 'ignore', 'inherit'] });
const at = (f) => path.join(FIX, f);

// 씨앗마다 다른 그림(색 · 자리가 확연히 다르게). 작은 잡음을 얹어 PNG 가 실제 사진만큼 커지게.
function picture(f, w, h, n, noise = 12) {
  const c = (k) => `0x${[(n * 53 + k * 71) % 256, (n * 97 + k * 31) % 256, (n * 151 + k * 113) % 256].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  const box = [0, 1, 2, 3, 4].map((k) => `drawbox=x=${(n * 137 + k * 211) % Math.max(1, w - 60)}:y=${(n * 89 + k * 173) % Math.max(1, h - 60)}:w=${Math.round(w / 5)}:h=${Math.round(h / 6)}:color=${c(k + 3)}:t=fill`).join(',');
  ff('-f', 'lavfi', '-i', `color=c=${c(0)}:s=${w}x${h}`, '-vf', `format=gbrp,${box},noise=alls=${noise}:all_seed=${n + 1}:allf=u,format=rgb24`, '-frames:v', '1', at(f));
}
function video(f, w, h, n, sec = 4) {
  ff('-f', 'lavfi', '-i', `testsrc2=s=${w}x${h}:r=24:d=${sec}`, '-vf', `hue=h=${(n * 67) % 360},drawbox=x=${40 + n * 23}:y=40:w=90:h=70:color=white:t=fill`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '24', at(f));
}
// PNG 에 덩어리를 끼운다(그림은 그대로, 파일만 달라짐)
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, body) => { const t = Buffer.concat([Buffer.from(type, 'latin1'), body]); const len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(body.length); sum.writeUInt32BE(crc(t)); return Buffer.concat([len, t, sum]); };
const withChunk = (src, dst, type, body) => { const b = fs.readFileSync(at(src)); fs.writeFileSync(at(dst), Buffer.concat([b.subarray(0, 33), chunk(type, body), b.subarray(33)])); };
const withText = (src, dst, text) => withChunk(src, dst, 'tEXt', Buffer.from(`Comment\0${text}`, 'latin1'));
/** 그림의 귀퉁이를 칠해 정말 다른 그림으로 */
export const paintCorner = (src, dst, color) => ff('-i', src, '-vf', `format=gbrp,drawbox=x=0:y=0:w=24:h=24:color=${color}:t=fill,format=rgb24`, dst);

const ICC = 'C:/Windows/System32/spool/drivers/color/AdobeRGB1998.icc';
export function makeFixtures() {
  if (fs.existsSync(at('.version')) && fs.readFileSync(at('.version'), 'utf8') === VER) return FIX;
  fs.rmSync(FIX, { recursive: true, force: true });
  fs.mkdirSync(path.join(FIX, 'clips'), { recursive: true });
  // 사진(크기가 서로 다른 것과 같은 것 섞어서)
  [['ai-character.png', 1024, 1536], ['ai-character-close.png', 1024, 1024], ['raw-sunrise.png', 1280, 720], ['raw-night.png', 1280, 720], ['frame-raw-first.png', 864, 496], ['frame-raw-last.png', 864, 496],
    ['frame-T1-first.png', 530, 794], ['frame-T1-last.png', 530, 794], ['frame-T2-first.png', 864, 496], ['frame-T2-last.png', 864, 496], ['frame-T4-first.png', 530, 794], ['frame-T4-last.png', 530, 794]]
    .forEach(([f, w, h], i) => picture(f, w, h, i + 1));
  // 화소 비교
  picture('A.png', 2816, 1584, 31, 20); picture('B.png', 2816, 1584, 47, 20); picture('C.png', 1920, 1080, 53, 20); picture('K4.png', 3840, 2160, 61, 20);
  for (const [f, t] of [['A_meta.png', 'one'], ['A_meta2.png', 'two'], ['A_meta3.png', 'three'], ['A_meta4.png', 'four']]) withText('A.png', f, t);
  withText('B.png', 'B_meta.png', 'b');
  ff('-i', at('A.png'), '-vf', 'format=gbrp,drawbox=x=100:y=100:w=1:h=1:color=0x010203:t=fill,format=rgb24', at('A_1px.png'));
  ff('-i', at('A.png'), '-vf', 'format=gbrp,lutrgb=r=min(val+1\\,255):g=min(val+1\\,255):b=min(val+1\\,255),format=rgb24', at('A_bright.png'));
  ff('-i', at('A.png'), '-q:v', '2', at('A.jpg')); ff('-i', at('A.jpg'), at('A_jpg.png'));
  ff('-i', at('A.png'), '-vf', 'scale=2815:1583,scale=2816:1584', at('A_resize.png'));
  if (fs.existsSync(ICC)) withChunk('A.png', 'A_icc.png', 'iCCP', Buffer.concat([Buffer.from('adobe\0\0', 'latin1'), zlib.deflateSync(fs.readFileSync(ICC))]));
  ff('-i', at('A.png'), '-vf', 'crop=512:512:0:0', at('S.png')); ff('-i', at('B.png'), '-vf', 'crop=512:512:0:0', at('T.png'));
  ff('-i', at('S.png'), at('S.gif'));
  const two = path.join(FIX, 'two.txt'); fs.writeFileSync(two, `file '${at('S.png').split('\\').join('/')}'\nduration 0.2\nfile '${at('T.png').split('\\').join('/')}'\nduration 0.2\n`);
  ff('-f', 'concat', '-safe', '0', '-i', two, '-plays', '0', '-f', 'apng', at('S_anim.png'));
  ff('-f', 'concat', '-safe', '0', '-i', two, '-c:v', 'libwebp_anim', '-lossless', '1', '-loop', '0', at('S_anim.webp'));
  ff('-i', at('S.png'), '-c:v', 'libwebp', '-lossless', '1', at('S_still.webp'));
  // 영상
  [['asset-video.mp4', 864, 496], ['frame-raw.mp4', 864, 496], ['frame-T1.mp4', 864, 496], ['frame-T2.mp4', 864, 496], ['frame-T4.mp4', 864, 496], ['reencoded-face.mp4', 560, 752]].forEach(([f, w, h], i) => video(f, w, h, i + 1));
  ['art01.mp4', 'art02.mp4', 'art03.mp4'].forEach((f, i) => video(path.join('clips', f), 640, 360, 20 + i, 2));
  fs.writeFileSync(at('.version'), VER);
  return FIX;
}
