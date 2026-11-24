// 막히면 자동으로 고쳐 같은 카드로 다시 보내기 격리 시험(11/24, 사용자 "오류 뜨면 … 자동으로 인증 날려준다고 뜨면 되지 않을까 기다리라고" — 완전 자동).
// 시험 앱(3958) → 서버 → 가짜 BytePlus(3946, 실제 문구 · 칸 번호로 거절) · 진짜 게이트웨이 코드(3947). 과금 없음.
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX, paintCorner } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, GW = P.GW, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const A = R('ai-character.png'), Bp = R('ai-character-close.png'), X = R('raw-sunrise.png'), Y = R('raw-night.png'), Z = R('frame-raw-first.png'), W = R('frame-raw-last.png');
const V = R('asset-video.mp4');

for (let i = 0; i < 300; i++) { try { if ((await (await fetch(HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const B = window.__B || (window.__B = await import('/src/lib/bp-assets.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
let manual = '';
for (let i = 0; i < 120 && !manual; i++) { try { const r = await fetch(API + '/api/agent/manual'); if (r.ok) manual = (await r.json()).version || ''; } catch {} if (!manual) await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const post = async (p, b) => { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => null) }; };
const cmd = (command, args) => post('/api/agent/commands', { manual, command, args, wait: 30 }).then((r) => r.j);
const fakeSet = (o) => fetch(FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
const seen = async () => (await (await fetch(FAKE + '/__seen')).json());

const pid = (await cmd('project.create', { name: 'AUTOFIX ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
await cmd('collection.create', { name: '자동시험' });
await cmd('collection.bind', { collection: '자동시험', projectId: pid });
const setS = (o) => S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, ${JSON.stringify({ model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false, ...o })}); return 1;`);
await setS({});
const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name || path.basename(f)) }, body: fs.readFileSync(f) })).json()).cacheId;
const panelAdd = (cacheId, name, type = 'image_url', role = 'reference_image') => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: ${JSON.stringify(type)}, url: '', role: ${JSON.stringify(role)}, file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
const cards = (tag) => S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); return JSON.stringify(p.messages.filter(m => m.role === 'system' && (m.promptText || '').includes(${JSON.stringify(tag)})).map(m => ({ id: m.id, st: m.status, task: m.taskId || '', fix: m.bpFix || null, err: (m.error || '').slice(0, 260), refs: m.bpAssetRefs || 0, content: m.content })));`).then(JSON.parse);
const send = (tag, promptHtml) => S(`const w = []; const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: p.id, promptHtml: ${JSON.stringify(promptHtml || (tag + ' 천천히 움직인다'))}, settings: p.settings, assets: p.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`).then(JSON.parse);
const postsOf = async (tag) => (await seen()).filter((x) => JSON.stringify(x).includes(tag)).map((x) => (x.content || []).filter((c) => c.type !== 'text').map((c) => { const u = (c[c.type] || {}).url || ''; return u.startsWith('asset://') ? u.slice(8) : u.startsWith('http') ? 'UPLOAD' : u; }));
const waitCard = async (tag, pred, ms = 200000) => { let c; for (let t = 0; t < ms; t += 800) { c = await cards(tag); if (c.length && pred(c)) return c; await sleep(800); } return c; };
const sawFix = async (tag, ms = 15000) => { for (let t = 0; t < ms; t += 250) { const c = await cards(tag); if (c.some((x) => x.fix)) return c.find((x) => x.fix); await sleep(250); } return null; };
const libBy = (n) => S(`return JSON.stringify(S.getState().elementAssets.filter(a => a.name === ${JSON.stringify(n)}).map(a => ({ id: a.id, desc: a.description, bp: a.images[0].bpAssets?.['2DT'] || null })));`).then(JSON.parse);

// ── 1. 처음 보는 실사 인물 사진(칸) → 막힘 → 자동 인증(라이브러리 카드 생김) → 같은 카드로 다시 → 생성 ──
const cA = await cacheOf(A, 'mina.png');
await fakeSet({ faceKeys: [md5(A)], goneAssets: [] });
await panelClear(); await panelAdd(cA, 'mina.png');
let w = await send('AF-1');
ok('1 보내기는 바로 돌아옴(경고 없음)', w.length === 0, w);
let fx = await sawFix('AF-1');
ok('1 카드가 "인증 중" 으로(bpFix face · [Image 1] mina.png)', fx?.fix?.kind === 'face' && fx.fix.label === '[Image 1] mina.png' && fx.st === 'queued', fx);
let c = await waitCard('AF-1', (x) => x[0].task);
let ps = await postsOf('AF-1');
ok('1 같은 카드 하나가 task 를 받음 · bpFix 지워짐 · 에셋 1', c.length === 1 && !!c[0].task && !c[0].fix && c[0].refs === 1, c);
ok('1 첫 요청은 사진(UPLOAD) · 다시 보낸 요청은 asset://', ps.length === 2 && ps[0][0] === 'UPLOAD' && /^asset-fake-/.test(ps[1][0]), ps);
let lib = await libBy('mina');
ok('1 라이브러리에 인물 카드(레퍼런스 칸에서 인증) · 2DT active', lib.length === 1 && lib[0].desc === '레퍼런스 칸에서 인증' && lib[0].bp?.status === 'active', lib);
const assetA = ps[1][0];

// ── 2. @이름 (인증 안 된 라이브러리 인물) → 막힘 → 그 인물 등록 → 다시 ──
const add = await cmd('elements.add', { collection: '자동시험', items: [{ name: 'Bora', category: 'character', images: [Bp] }] });
ok('2 라이브러리 Bora(인증 전)', add?.status === 'done', add?.error);
const boraId = (await libBy('Bora'))[0]?.id;
await fakeSet({ faceKeys: [md5(Bp)] });
await panelClear();
await send('AF-2', `<span class="element-pill" data-element-id="${boraId}" data-name="Bora" contenteditable="false">@Bora</span> 가 걷는다 AF-2`);
fx = await sawFix('AF-2');
ok('2 @이름 막힘 → 인증 중([Image 1] Bora)', fx?.fix?.kind === 'face' && fx.fix.label === '[Image 1] Bora', fx);
c = await waitCard('AF-2', (x) => x[0].task);
ps = await postsOf('AF-2');
lib = await libBy('Bora');
ok('2 Bora 인증 → asset:// 로 다시 보내 task', !!c[0]?.task && ps.length === 2 && /^asset-fake-/.test(ps[1][0]) && lib[0].bp?.status === 'active' && (await libBy('Bora')).length === 1, { c, ps, lib });

// ── 3. 얼굴 두 장(둘 다 처음) → 하나씩 두 번 고쳐 다시 ──
const cX = await cacheOf(X, 'sun.png'), cY = await cacheOf(Y, 'night.png');
await fakeSet({ faceKeys: [md5(X), md5(Y)] });
await panelClear(); await panelAdd(cX, 'sun.png'); await panelAdd(cY, 'night.png');
await send('AF-3');
c = await waitCard('AF-3', (x) => x[0].task || x[0].st === "failed", 240000);
ps = await postsOf('AF-3');
ok('3 두 칸을 차례로 고쳐 세 번째 요청이 둘 다 asset:// → task', !!c[0]?.task && ps.length === 3 && ps[0].join() === 'UPLOAD,UPLOAD' && /^asset-fake-/.test(ps[1][0]) && ps[1][1] === 'UPLOAD' && ps[2].every((u) => /^asset-fake-/.test(u)), { c, ps });

// ── 4. 에셋이 BytePlus 에서 지워짐(보관함 정리 · 만료) → "not found" → 다시 등록 → 새 에셋으로 다시 ──
await fetch(GW + '/__gone?id=' + encodeURIComponent(assetA));
await fakeSet({ faceKeys: [md5(A)], goneAssets: [assetA] });
await panelClear(); await panelAdd(cA, 'mina_again.png');
await send('AF-4');
fx = await sawFix('AF-4');
ok('4 지워진 에셋 → "다시 등록 중"(bpFix gone)', fx?.fix?.kind === 'gone', fx);
c = await waitCard('AF-4', (x) => x[0].task || x[0].st === 'failed');
ps = await postsOf('AF-4');
ok('4 첫 요청은 옛 에셋 · 다시 보낸 요청은 새 에셋 → task', !!c[0]?.task && ps.length === 2 && ps[0][0] === assetA && /^asset-fake-/.test(ps[1][0]) && ps[1][0] !== assetA, { c, ps });
lib = await libBy('mina');
ok('4 라이브러리 mina 는 새 id 로 active(카드는 그대로 하나)', lib.length === 1 && lib[0].bp?.status === 'active' && lib[0].bp.id === ps[1][0], lib);
await fakeSet({ goneAssets: [] });

// ── 5. 영상(v2v) 칸의 얼굴 → 영상을 Video 에셋으로 자동 인증 → 같은 카드로 다시(26.11.24~, 사용자 "v2v 인증 절차도 해야겠지") ──
const cV = await cacheOf(V, 'clip.mp4');
await fakeSet({ faceKeys: [cV.slice(0, 12)] });
await panelClear(); await panelAdd(cV, 'clip.mp4', 'video_url', 'reference_video');
await send('AF-5');
fx = await sawFix('AF-5');
ok('5 영상 막힘 → "인증 중"([Video 1] clip.mp4)', fx?.fix?.kind === 'face' && fx.fix.label === '[Video 1] clip.mp4', fx);
c = await waitCard('AF-5', (x) => x[0].task || x[0].st === 'failed');
ps = await postsOf('AF-5');
ok('5 영상을 에셋으로 인증 → asset:// 로 다시 보내 task(라이브러리 카드는 안 만듦)', !!c[0]?.task && ps.length === 2 && ps[0][0] === 'UPLOAD' && /^asset-fake-/.test(ps[1][0]) && (await libBy('clip')).length === 0, { c, ps });
const assetV = ps[1][0];
const gwNames = (await (await fetch(GW + '/__stats')).json()).names;
ok('5 게이트웨이에 Video 에셋(이름 = 영상 내용 key)', gwNames.some(([id, name]) => id === assetV && name === cV), gwNames.slice(-3));
// 5b. 같은 영상을 또 보내면(이 PC 가 기억) 처음부터 asset:// — 막히는 요청 없음
await send('AF-5b');
c = await waitCard('AF-5b', (x) => x[0].task || x[0].st === 'failed', 20000);
ps = await postsOf('AF-5b');
ok('5b 같은 영상 다시 → 처음부터 asset://(요청 1번)', !!c[0]?.task && ps.length === 1 && ps[0][0] === assetV, { c, ps });

// ── 9. 저작권(유명인 · 캐릭터, PolicyViolation) 은 자동 인증하지 않는다 — 실사 얼굴(인증 안 된 인물)과 다른 글 ──
const cC = await cacheOf(Bp, 'famous.png');
await fakeSet({ faceKeys: [], copyrightKeys: [md5(Bp)] });
await panelClear(); await panelAdd(cC, 'famous.png');
// @Bora 는 2 에서 인증됐지만 같은 바이트를 패널 칸에 넣었으니 asset:// 로 나간다 — 저작권 검사는 주소 글자로 하는 가짜라 다른 사진으로
const tmpC = path.join(FIX, 'copyright-tmp.png'); paintCorner(Bp, tmpC, 'red');
const cC2 = await cacheOf(tmpC, 'famous2.png');
await fakeSet({ copyrightKeys: [md5(tmpC)] });
await panelClear(); await panelAdd(cC2, 'famous2.png');
await send('AF-9');
c = await waitCard('AF-9', (x) => x[0].st === 'failed' || x[0].task, 20000);
const friendly9 = await S(`const T = await import('/src/lib/translate-error.ts'); const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); const m = p.messages.find(m => (m.promptText || '').includes('AF-9')); return T.translateError(m.error || '');`);
ok('9 저작권 → 자동 인증 없이 바로 실패 · 요청 1번', c[0]?.st === 'failed' && !c[0].fix && /PolicyViolation/.test(c[0].err) && (await postsOf('AF-9')).length === 1, c);
ok('9 카드 글: "저작권 · 유명인" — 에셋 인증으로 안 풀린다(실사 얼굴 글과 다름)', /저작권 · 유명인/.test(friendly9) && /에셋 인증으로 풀리지 않아요/.test(friendly9) && !/아직 인증\(등록\)되지 않은 인물/.test(friendly9), friendly9.slice(0, 200));
fs.unlinkSync(tmpC);
await fakeSet({ copyrightKeys: [] });

// ── 10. 영상 에셋을 BytePlus 가 거절(실존 배우로 판단 등) → 카드 실패 + 이유 + Real-human 길 ──
const tmpV = path.join(FIX, 'video-reject-tmp.mp4'); fs.writeFileSync(tmpV, Buffer.concat([fs.readFileSync(V), Buffer.from('ACTOR')]));
const cV2 = await cacheOf(tmpV, 'actor.mp4');
await fetch(GW + '/__fail?key=' + cV2.slice(0, 12));
await fakeSet({ faceKeys: [cV2.slice(0, 12)] });
await panelClear(); await panelAdd(cV2, 'actor.mp4', 'video_url', 'reference_video');
await send('AF-10');
c = await waitCard('AF-10', (x) => x[0].st === 'failed' || x[0].task);
ok('10 영상 에셋 거절 → 실패 + "에셋으로 받지 않았어요 … Real-human" · 다시 안 보냄', c[0]?.st === 'failed' && /에셋으로 받지 않았어요/.test(c[0].err) && (await postsOf('AF-10')).length === 1, c);
fs.unlinkSync(tmpV);

// ── 6. 인증 중에 취소 → 다시 보내지 않는다 ──
const cZ = await cacheOf(Z, 'zed.png');
await fakeSet({ faceKeys: [md5(Z)] });
await panelClear(); await panelAdd(cZ, 'zed.png');
await send('AF-6');
fx = await sawFix('AF-6');
await S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); const m = p.messages.find(m => m.id === ${JSON.stringify(fx?.id || '')}); if (m) S.getState().updateMessage(p.id, m.id, { status: 'failed', content: '취소함', error: '자동 인증 중에 취소했어요 — 다시 보내지 않았어요.', bpFix: undefined, endTime: Date.now() }); return 1;`);
await sleep(20000);
c = await cards('AF-6'); ps = await postsOf('AF-6');
ok('6 취소하면 인증은 끝나도 다시 보내지 않음(요청 1번 · 카드 취소함 그대로)', fx && c[0]?.st === 'failed' && c[0].content === '취소함' && ps.length === 1 && !c[0].task, { c, ps });

// ── 7. 출력 2개 — 고치기는 한 번, 다시 보내기는 카드마다 ──
const cW = await cacheOf(W, 'wave.png');
await fakeSet({ faceKeys: [md5(W)] });
await setS({ output_count: 2 });
await panelClear(); await panelAdd(cW, 'wave.png');
await send('AF-7');
c = await waitCard('AF-7', (x) => x.length === 2 && x.every((y) => y.task));
ps = await postsOf('AF-7');
ok('7 카드 둘 다 task · 요청 4번(처음 2 + 다시 2) · 라이브러리 카드 하나', c.length === 2 && c.every((y) => y.task) && ps.length === 4 && ps.filter((p) => /^asset-fake-/.test(p[0])).length === 2 && (await libBy('wave')).length === 1, { c, ps });
await setS({ output_count: 1 });

// ── 8. 인증이 실패하면(BytePlus 가 에셋을 거절) 카드는 실패 + 이유 ──
const tmp = path.join(FIX, 'failimg-tmp.png'); paintCorner(W, tmp, 'lime');   // 새 바이트
const cT = await cacheOf(tmp, 'FAILIMG.png');
await fetch(GW + '/__fail?key=' + md5(tmp));   // 가짜 BytePlus 가 이 사진의 에셋을 Failed 로
await fakeSet({ faceKeys: [md5(tmp)] });
await panelClear(); await panelAdd(cT, 'FAILIMG.png');
await send('AF-8');
c = await waitCard('AF-8', (x) => x[0].st === 'failed' || x[0].task, 120000);
ok('8 인증 실패면 카드 실패 + [자동 인증 못 함] 이유 · 다시 안 보냄', c[0]?.st === 'failed' && /자동 인증 못 함/.test(c[0].err) && (await postsOf('AF-8')).length === 1, c);
fs.unlinkSync(tmp);

await done();
