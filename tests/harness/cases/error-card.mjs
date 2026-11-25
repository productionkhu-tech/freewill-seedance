// 오류 카드가 상자 밖으로 나가지 않나 · 실사 얼굴 글(다음에 할 일 · 이유 · 다른 방법) · 레퍼런스 영상 화소 한도(2.5 4096x2160 · 2.0 3840x2160).
// 시험 앱 · 가짜 BytePlus. 과금 없음.
import fs from 'node:fs'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import P from '../lib/ports.mjs';
import { connect, sleep } from '../lib/cdp.mjs';
import { ok, done } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';

await fetch(P.HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
await main.send('Page.enable'); await main.send('DOM.enable');
const ready = async () => { for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch { /* 다시 뜨는 중 */ } await sleep(500); } };
await ready();
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(500); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const set = (o) => fetch(P.FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
const mk = (opt = {}) => S(`const b = new Set(S.getState().projects.map((x) => x.id)); S.getState().createProject(); const id = S.getState().projects.find((x) => !b.has(x.id)).id; S.getState().updateProjectSettings(id, ${JSON.stringify({ model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false, ...opt })}); S.getState().setCurrentProjectId(id); return id;`);

// ── 1. 상자 밖으로 나가지 않나 — 여러 오류 글 × 여러 폭(사용자 11/25 사진: 요청 번호와 글이 빨간 상자 밖으로)
const RAW = "The request failed because the input image 'content[2]' may contain real person. Request id: 021793169746096f5fadfdc607fef478c6f908597481cce56be66";
const ERRS = [
  ['옛 카드(이유 없음)', RAW],
  ['자동 인증 못 함', `${RAW}\n\n[자동 인증 못 함] 3분 안에 인증이 끝나지 않았어요`],
  ['저작권', 'InputImageSensitiveContentDetected.PolicyViolation: The request failed because the input image may be related to copyright restrictions. Request ID: 021793169746096f5fadfdc607fef478c6f908597481cce56be66'],
  ['끊을 곳 없는 긴 글', `잘못된 값 ${'x'.repeat(220)}`],
  ['긴 주소', `not valid https://example.com/${'a1b2c3d4e5'.repeat(24)}?X-Amz-Signature=${'0f'.repeat(60)}`],
];
const pid = await mk();
await S(`const s = S.getState(); for (const [i, e] of ${JSON.stringify(ERRS.map((x) => x[1]))}.entries()) { S.getState().addMessage('${pid}', { id: 'err' + i, role: 'system', content: '영상 생성 실패', status: 'failed', error: e, timestamp: Date.now() + i, promptText: 'ERR' + i, usedSettings: s.projects.find((p) => p.id === '${pid}').settings, usedAssets: [] }); } return 1;`);
// 화면 밖 카드는 앱이 배치를 건너뛴다(content-visibility) — 그대로 재면 안 그린 카드를 '안 넘침' 으로 센다(11/25 실제로 헛통과). 시험에서는 모두 그린다.
await main.ev(`(() => { const st = document.createElement('style'); st.textContent = '* { content-visibility: visible !important; }'; document.head.append(st); return 1; })()`);
await sleep(1500);
const shot = async (n) => { if (!process.env.SHOT) return; const r = JSON.parse(await main.ev(`(() => { const e = [...document.querySelectorAll('[data-card-error]')].filter((x) => x.getBoundingClientRect().width)[1].parentElement; e.scrollIntoView({ block: 'center' }); return 1; })()`) && await main.ev(`new Promise((ok) => setTimeout(() => { const e = [...document.querySelectorAll('[data-card-error]')].filter((x) => x.getBoundingClientRect().width)[1].parentElement.getBoundingClientRect(); ok(JSON.stringify({ x: e.x, y: e.y, width: e.width, height: e.height })); }, 800))`)); const s = await main.send('Page.captureScreenshot', { format: 'png', clip: { x: r.x - 14, y: r.y - 14, width: r.width + 28, height: r.height + 28, scale: 1 } }); fs.writeFileSync(`${process.env.SHOT}/err-${n}.png`, Buffer.from(s.data || s.result?.data, 'base64')); };
const measure = () => main.ev(`(() => { const out = []; for (const e of document.querySelectorAll('[data-card-error]')) { if (!e.getBoundingClientRect().width) continue; const box = e.parentElement.getBoundingClientRect(); const over = Math.max(0, ...[e, ...e.querySelectorAll('*')].map((x) => { const r = document.createRange(); r.selectNodeContents(x); return Math.max(x.getBoundingClientRect().right, ...[...r.getClientRects()].map((c) => c.right)) - box.right; })); out.push({ w: Math.round(box.width), h: Math.round(box.height), over: Math.round(over), bad: e.scrollWidth > e.clientWidth + 1 }); } return JSON.stringify({ n: out.length, over: Math.max(...out.map((o) => o.over)), bad: out.filter((o) => o.bad).length, w: out[0]?.w, minH: Math.min(...out.map((o) => o.h)) }); })()`).then(JSON.parse);
const rows = [];
for (const w of [1500, 1200, 1000, 900, 820]) {   // 더 좁으면 채팅 칸 자체가 없다(옆 패널이 다 차지)
  await main.send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: false }); await sleep(500);
  for (const open of [false, true]) { await main.ev(`document.querySelectorAll('[data-card-error] details').forEach((d) => { d.open = ${open}; }); 1`); await sleep(200); rows.push({ vw: w, open, ...(await measure()) }); if (w === 1500 || w === 1000) await shot(`${w}-${open ? 'open' : 'fold'}`); }
}
await main.send('Emulation.clearDeviceMetricsOverride');
ok('1 다섯 가지 오류 × 다섯 폭 × 펼침/접힘 — 글이 상자 밖으로 나가지 않음', rows.every((r) => r.n === ERRS.length && r.over <= 0 && r.bad === 0 && r.minH >= 60), rows);

// ── 2. 실사 얼굴 글 — 이유가 없으면 '재생성하면 자동 인증', 있으면 그 이유. 원문에 우리 표가 섞이지 않음
const face = JSON.parse(await S(`const T = await import('/src/lib/translate-error.ts'); return JSON.stringify(${JSON.stringify(ERRS.map((x) => x[1]))}.map((e) => T.faceBlock(e)));`));
ok('2 실사 얼굴 글 — 한 줄 설명 · 다음에 할 일 · 이유', /레퍼런스 이미지에 실사 얼굴/.test(face[0].head) && /재생성\(✦\)하면 앱이 자동으로 인증/.test(face[0].next) && /자동 인증도 하지 못했어요 — 3분 안에/.test(face[1].next) && !/자동 인증 못 함/.test(face[1].raw) && face[2] === null && face[3] === null && face[0].ways.length === 5, face.slice(0, 2));
const cardText = await main.ev(`[...document.querySelectorAll('[data-card-error]')].filter((e) => e.getBoundingClientRect().width).map((e) => e.innerText).join('\\n---\\n')`);
ok('2 카드에 옛 글("Seedance 2.0은 … 받지 않습니다")이 없고 "다른 방법 보기" 가 있음', !/받지 않습니다/.test(cardText) && /다른 방법 보기/.test(cardText) && /재생성\(✦\)하면/.test(cardText), cardText.slice(0, 300));

// ── 3. 자동 인증을 시작할 수 없는 칸(원본 없이 주소만) — 이유가 카드에 남음 · 다시 보내지 않음
await set({ faceKeys: ['noorigin'], goneAssets: [], copyrightKeys: [], refuse: 0, cut: 0, marks: [] });
const p3 = await mk();
await S(`const pr = S.getState().projects.find((x) => x.id === '${p3}'); await R.sendRequest({ projectId: '${p3}', promptHtml: 'EC3 움직인다', settings: pr.settings, assets: [{ id: 'u1', type: 'image_url', url: 'https://example.com/noorigin.png', role: 'reference_image', file_name: 'noorigin.png' }] }, { warn: (m) => { window.__warn3 = m; } }); return 1;`);
let c3 = null; for (let i = 0; i < 60; i++) { c3 = JSON.parse(await S(`const m = S.getState().projects.find((x) => x.id === '${p3}').messages.filter((m) => m.role === 'system').pop(); return JSON.stringify(m ? { st: m.status, err: m.error || '' } : null);`)); if (c3?.st === 'failed') break; await sleep(300); }
const n3 = (await (await fetch(P.FAKE + '/__seen')).json()).filter((x) => JSON.stringify(x).includes('EC3')).length;
ok('3 원본 없는 칸이 막히면 이유를 남기고 다시 보내지 않음', c3?.st === 'failed' && /\[자동 인증 못 함\] 어느 사진/.test(c3.err) && n3 === 1, { c3, n3, warn: await main.ev('window.__warn3 || null') });

// ── 4. 레퍼런스 영상 화소 한도 — 붙이기(드래그 · 에이전트와 같은 attachFilesTo)
const clip = (n, s, sec = 2.2) => { const f = path.join(FIX, n); if (!fs.existsSync(f)) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${s}:rate=24`, '-t', String(sec), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', f]); return f; };
const SIZES = [['px4096.mp4', '4096x2160'], ['pxuhd.mp4', '3840x2160'], ['px4400.mp4', '4400x2160'], ['px852.mp4', '852x480'], ['px848.mp4', '848x480']];
const files = SIZES.map(([n, s]) => clip(n, s));
const ids = []; for (const f of files) ids.push((await (await fetch(P.API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': path.basename(f) }, body: fs.readFileSync(f) })).json()).cacheId);
const attach = (model) => S(`const out = {}; const sizes = ${JSON.stringify(SIZES.map((x) => x[1]))}; for (const [i, id] of ${JSON.stringify(ids)}.entries()) { const b = await (await fetch('/api/cache/' + id)).blob(); const sink = R.memoryAssetSink({ ...M.defaultSettings, model: '${model}', mode: 'multimodal_reference' }); const rej = await R.attachFilesTo(sink, [new File([b], sizes[i] + '.mp4', { type: 'video/mp4' })]); out[sizes[i]] = sink.list.length ? 'ok' : (rej[0] || '?'); } return JSON.stringify(out);`).then(JSON.parse);
const a25 = await attach('dreamina-seedance-2-5-260628'), aF = await attach('dreamina-seedance-2-5-flash-261115'), a20 = await attach('dreamina-seedance-2-0-260128');
const base = (a) => a['3840x2160'] === 'ok' && a['852x480'] === 'ok' && a['848x480'] !== 'ok' && a['4400x2160'] !== 'ok';
ok('4 2.5 · 2.5 Flash 는 4096x2160 을 받고 4400x2160 은 거절', base(a25) && base(aF) && a25['4096x2160'] === 'ok' && aF['4096x2160'] === 'ok' && /4096x2160 상당까지/.test(a25['4400x2160']), { a25, aF });
ok('4 2.0 은 4096x2160 을 이유와 함께 거절(3840x2160 까지 · 2.5 는 된다고 말함)', base(a20) && /3840x2160 상당까지/.test(a20['4096x2160']) && /Seedance 2\.5 는 4096x2160/.test(a20['4096x2160']) && !/2\.5 는/.test(a20['4400x2160']), a20);

// 설정 패널의 파일 고르기도 같은 규칙(따로 검사한다)
const panel = async (model, file) => {
  const id = await mk({ model }); await sleep(900);
  const doc = await main.send('DOM.getDocument', { depth: -1 }); const root = (doc.root || doc.result.root).nodeId;
  const q = await main.send('DOM.querySelectorAll', { nodeId: root, selector: 'input[type=file]' }); const nodeIds = q.nodeIds || q.result.nodeIds;
  for (const n of nodeIds) { const at = await main.send('DOM.getAttributes', { nodeId: n }); const a = at.attributes || at.result.attributes; if (String(a[a.indexOf('accept') + 1]).includes('video')) { await main.send('DOM.setFileInputFiles', { nodeId: n, files: [file] }); break; } }
  for (let i = 0; i < 30; i++) { await sleep(300); const r = JSON.parse(await S(`const p = S.getState().projects.find((x) => x.id === '${id}'); return JSON.stringify(p.assets.map((a) => a.type));`)); if (r.length) return r.length; }
  return 0;
};
await main.ev(`window.alert = (m) => { window.__alert = m; }; 1`);
const pn25 = await panel('dreamina-seedance-2-5-260628', files[0]), pn20 = await panel('dreamina-seedance-2-0-260128', files[0]);
ok('4 설정 패널에서 골라도 같음(2.5 들어감 · 2.0 안 들어감)', pn25 === 1 && pn20 === 0, { pn25, pn20, alert: await main.ev('window.__alert || null') });

// ── 5. 2.5 에 넣은 채 2.0 으로 바꿔 보냈을 때 BytePlus 문구(11/25 실측) → 사람 말
const t5 = await S(`const T = await import('/src/lib/translate-error.ts'); return T.translateError('InvalidParameter: The parameter \`content[1]\` specified in the request is not valid: the parameter video pixel count specified in the request must be less than or equal to 8295044 for model dreamina-seedance-2-0-fast in r2v. Request id: 0217');`);
ok('5 화소 초과 거절 문구를 사람 말로', /레퍼런스 영상 해상도 초과/.test(t5) && /3840x2160/.test(t5) && /2\.5 는 4096x2160/.test(t5), t5);
await set({ faceKeys: [] });
await done();
