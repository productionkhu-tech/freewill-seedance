/**
 * 미리보기용 파생물 만들기 — 포스터(정지 이미지)와 프록시(재생용 영상).
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────────────────────
 * 생성 결과물이 전부 HEVC 다. 측정(2026-09-07, 로컬 사본 77개):
 *     720p  .mp4   h264   5개      ← 이것만 어디서나 재생된다
 *     1080p .mp4   hevc  42개
 *     1080p .mov   hevc  18개
 *     4K    .mp4   hevc  12개
 * HEVC 는 윈도우에서 OS 코덱(HEVC Video Extensions)이 있어야 재생된다. 없는 PC 에서는
 * 4K 뿐 아니라 1080p 도 검은 화면이 된다 — 앱은 4K 만 경고하고 있었으니, 1080p 는
 * 아무 설명 없이 안 나왔다. 팀 PC 들이 OEM 코덱을 갖고 있어 아직 안 터졌을 뿐이다.
 *
 * 그래서 보관할 때 H.264 프록시를 같이 만들어 둔다. 코덱과 무관하게 어디서나 재생된다.
 *   원본 4K 101MB  →  프록시 1080p 18.4MB (2초)
 *   원본 1080p HEVC 5.8MB  →  프록시 1080p H.264 1.4MB (0초)
 * 화질은 CRF 20 에서 SSIM 0.9968 · PSNR 50.8dB — 육안으로 구분되지 않는다.
 * 원본보다 작으면서 어디서나 재생되므로, 코덱이 있는 PC 에서도 프리뷰가 가벼워진다.
 *
 * ★ 원본은 손대지 않는다. 다운로드는 언제나 마스터를 받는다(서버의 /api/media/:taskId).
 *   프록시는 화면에 띄우기 위한 것뿐이다.
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

/**
 * ffmpeg 실행 파일 위치.
 *
 * 패키지된 앱에서 server.cjs 는 resources/ 에 놓이고 ffmpeg.exe 도 그 옆에 간다
 * (electron-builder.yml extraResources). asar 안에서는 실행 파일을 돌릴 수 없으므로
 * 일부러 asar 밖에 둔다. 개발 중에는 node_modules 에서 찾고, 그것도 없으면 PATH 를
 * 마지막으로 본다 — 셋 다 없으면 파생물만 못 만들고 나머지는 그대로 돈다.
 */
let ffmpegPathCache: string | null | undefined;
export function ffmpegPath(): string | null {
  if (ffmpegPathCache !== undefined) return ffmpegPathCache;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  // 번들은 esbuild → CJS 라 __dirname 이 정상이지만, ESM 으로 해석되는 경로에서도
  // 터지지 않게 감싼다. 없으면 cwd 로 떨어져 개발 후보에서 찾게 된다.
  const here = (() => { try { return __dirname; } catch { return process.cwd(); } })();
  const candidates = [
    path.join(here, exe),                                                   // 패키지: resources/
    path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'win32-x64', exe), // 개발
    path.join(process.cwd(), 'node_modules', '@ffmpeg-installer', 'darwin-x64', 'ffmpeg'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { ffmpegPathCache = c; return c; } } catch { /* 다음 후보 */ }
  }
  ffmpegPathCache = null;
  console.warn('[Transcode] ffmpeg 을 찾지 못했습니다 — 포스터·프록시를 만들 수 없습니다.');
  return null;
}

function run(args: string[], timeoutMs: number): Promise<void> {
  const bin = ffmpegPath();
  if (!bin) return Promise.reject(new Error('ffmpeg 없음'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

/** 영상의 코덱과 세로 해상도. 못 읽으면 null — 그때는 프록시를 만드는 쪽으로 간다. */
export async function probe(file: string): Promise<{ codec: string; height: number } | null> {
  const bin = ffmpegPath();
  if (!bin) return null;
  return new Promise((resolve) => {
    // ffprobe 를 따로 번들하지 않는다. ffmpeg 은 입력만 주면 stderr 에 스트림 정보를 찍고
    // 종료하므로(출력이 없어 에러로 끝나지만) 그걸 읽으면 된다 — 바이너리 하나로 충분하다.
    execFile(bin, ['-hide_banner', '-i', file], { timeout: 20000, windowsHide: true }, (_e, _o, stderr) => {
      const s = String(stderr || '');
      const m = s.match(/Video:\s*([a-z0-9]+).*?,\s*(\d{2,5})x(\d{2,5})/i);
      if (!m) return resolve(null);
      resolve({ codec: m[1].toLowerCase(), height: Number(m[3]) });
    });
  });
}

/** 목록 썸네일. 1280 폭이면 카드(350~400px)의 2배 밀도에도 해상도가 남는다. */
export async function makePoster(src: string, out: string): Promise<boolean> {
  try {
    // 1초 지점을 쓴다 — 첫 프레임은 검거나 페이드인인 경우가 많다. 영상이 그보다 짧으면
    // ffmpeg 이 알아서 마지막 프레임을 잡는다.
    await run(['-y', '-loglevel', 'error', '-ss', '1', '-i', src,
      '-vframes', '1', '-vf', 'scale=1280:-2', '-c:v', 'libwebp', '-quality', '80', out], 60000);
    return fs.existsSync(out) && fs.statSync(out).size > 256;
  } catch (e: any) {
    console.warn('[Transcode] 포스터 실패:', e?.message || e);
    return false;
  }
}

/**
 * 재생용 프록시. 세로 1080 을 넘지 않게 줄이고 H.264 로 바꾼다.
 * 이미 H.264 면 만들지 않는다 — 그건 그대로 어디서나 재생된다.
 */
export async function makePreview(src: string, out: string): Promise<'made' | 'skipped' | 'failed'> {
  const info = await probe(src);
  if (info && info.codec === 'h264' && info.height <= 1080) return 'skipped';
  try {
    const scale = info && info.height > 1080 ? ['-vf', 'scale=-2:1080'] : [];
    await run(['-y', '-loglevel', 'error', '-i', src, ...scale,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-b:a', '128k',
      // moov 를 앞으로 — 브라우저가 꼬리부터 찾지 않아도 첫 프레임이 바로 나온다.
      '-movflags', '+faststart', out], 10 * 60 * 1000);
    return fs.existsSync(out) && fs.statSync(out).size > 1024 ? 'made' : 'failed';
  } catch (e: any) {
    console.warn('[Transcode] 프록시 실패:', e?.message || e);
    return 'failed';
  }
}
