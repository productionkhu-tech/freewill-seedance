// 레퍼런스를 바꾸고 · 순서를 바꾸고 · 재사용 · 재생성 · 등록 중에 바꾸기 — 인증이 엉뚱한 칸에 붙거나 빠지지 않나(11/24, 사용자 "래퍼런스 바꾸기 했을 때 ·
// 순서 바꿀 때 · 불러오기 할 때 등등 짜잘한 인증 오류 없는지 체크"). 시험 앱(3958) · 가짜 BytePlus(3946) · 진짜 게이트웨이 코드(3947). 과금 없음.
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, GW = P.GW, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const A = R('ai-character.png'), X = R('raw-sunrise.png'), Y = R('raw-night.png'), Bp = R('ai-character-close.png'), V = R('asset-video.mp4');

for (let i = 0; i < 300; i++) { try { if ((await (await fetch(HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(HOOK + '/show');
let main;
for (let i = 0; i < 120 && !main; i++) { try { main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini')); } catch { await sleep(1000); } }
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

const pid = (await cmd('project.create', { name: 'REFEDGE ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
await cmd('collection.create', { name: '엣지시험' });
await cmd('collection.bind', { collection: '엣지시험', projectId: pid });
await S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); return 1;`);
await fakeSet({ faceKeys: [], goneAssets: [], copyrightKeys: [] });
const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name || path.basename(f)) }, body: fs.readFileSync(f) })).json()).cacheId;
const panelAdd = (cacheId, name, type = 'image_url', role = 'reference_image') => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: ${JSON.stringify(type)}, url: '', role: ${JSON.stringify(role)}, file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
const rows = () => S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); return JSON.stringify(p.assets.map(a => ({ id: a.id, f: a.file_name, c: a.cacheId, u: a.url })));`).then(JSON.parse);
const rowSel = (name) => `[...document.querySelectorAll('div')].filter(d => d.className && String(d.className).includes('rounded-[11px]') && d.textContent.includes(${JSON.stringify(name)}))[0]`;
const rowInfo = (name) => main.ev(`(() => { const r = ${rowSel(name)}; if (!r) return JSON.stringify(null); return JSON.stringify({ shield: !!r.querySelector('[data-bp-register-ref]'), cert: !!r.querySelector('[data-bp-ref-state="done"]'), working: !!r.querySelector('[data-bp-ref-state="processing"]'), failed: !!r.querySelector('[data-bp-ref-state="failed"]') }); })()`).then(JSON.parse);
const press = (name) => main.ev(`(() => { const b = ${rowSel(name)}?.querySelector('[data-bp-register-ref]'); if (!b) return 0; b.click(); return 1; })()`);
const waitRow = async (name, pred, ms = 120000) => { let r; for (let t = 0; t < ms; t += 700) { r = await rowInfo(name); if (r && pred(r)) return r; await sleep(700); } return r; };
const cards = (tag) => S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); return JSON.stringify(p.messages.filter(m => m.role === 'system' && (m.promptText || '').includes(${JSON.stringify(tag)})).map(m => ({ id: m.id, st: m.status, task: m.taskId || '', used: (m.usedAssets || []).map(a => ({ f: a.file_name, c: a.cacheId, u: String(a.url || '').slice(0, 30) })) })));`).then(JSON.parse);
const send = (tag) => S(`const w = []; const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: p.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: p.settings, assets: p.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`).then(JSON.parse);
const postsOf = async (tag) => (await seen()).filter((x) => JSON.stringify(x).includes(tag)).map((x) => (x.content || []).filter((c) => c.type !== 'text').map((c) => { const u = (c[c.type] || {}).url || ''; return u.startsWith('asset://') ? 'A:' + u.slice(8) : u.startsWith('http') ? 'UP' : u; }));
const waitCard = async (tag, pred, ms = 200000) => { let c; for (let t = 0; t < ms; t += 800) { c = await cards(tag); if (c.length && pred(c)) return c; await sleep(800); } return c; };
const sendAndWait = async (tag) => { await send(tag); await waitCard(tag, (x) => x.every((y) => y.task || y.st === 'failed')); return postsOf(tag); };

// ── 준비: A 를 칸에서 인증 ──
const cA = await cacheOf(A, 'mina.png'), cX = await cacheOf(X, 'sun.png'), cY = await cacheOf(Y, 'night.png');
await panelClear(); await panelAdd(cA, 'mina.png');
await sleep(600); await press('mina.png');
let ri = await waitRow('mina.png', (r) => r.cert);
ok('준비 A 인증', ri?.cert === true, ri);
const assetA = JSON.parse(await S(`const a = S.getState().elementAssets.find(e => e.name === 'mina'); return JSON.stringify(a.images[0].bpAssets['2DT'].id);`));

// ── 1. 칸 교체(↻): 인증된 A → 인증 안 된 X — 표시가 사라지고, 보낼 때 사진으로 ──
let rs = await rows();
await S(`S.getState().replaceAsset(${JSON.stringify(pid)}, ${JSON.stringify(rs[0].id)}, { cacheId: ${JSON.stringify(cX)}, file_name: 'sun.png', thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=', url: '' }); return 1;`);
await sleep(700);
ri = await rowInfo('sun.png');
ok('1 교체 → "인증" 사라짐 · 방패 보임', ri && !ri.cert && ri.shield, ri);
let ps = await sendAndWait('RE-1');
ok('1 교체 뒤 보내기 → 사진 올림(옛 에셋 안 나감)', JSON.stringify(ps) === '[["UP"]]', ps);
// ── 2. 다시 A 로 교체 → 인증 표시 · 에셋 ──
await S(`S.getState().replaceAsset(${JSON.stringify(pid)}, ${JSON.stringify(rs[0].id)}, { cacheId: ${JSON.stringify(cA)}, file_name: 'mina.png', thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=', url: '' }); return 1;`);
await sleep(700);
ri = await rowInfo('mina.png');
ok('2 A 로 되돌리면 "인증" · 방패 없음', ri?.cert && !ri.shield, ri);
ps = await sendAndWait('RE-2');
ok('2 → asset://A', JSON.stringify(ps) === JSON.stringify([['A:' + assetA]]), ps);

// ── 3. 순서 바꾸기: [A, X] → [X, A] — 에셋이 A 칸을 따라간다 ──
await panelAdd(cX, 'sun.png');
ps = await sendAndWait('RE-3a');
ok('3 [A, X] → [에셋, 사진]', JSON.stringify(ps) === JSON.stringify([['A:' + assetA, 'UP']]), ps);
rs = await rows();
await S(`S.getState().setAssetOrder(${JSON.stringify(pid)}, ${JSON.stringify([rs[1].id, rs[0].id])}); return 1;`);
ps = await sendAndWait('RE-3b');
ok('3 순서 바꿔 [X, A] → [사진, 에셋]', JSON.stringify(ps) === JSON.stringify([['UP', 'A:' + assetA]]), ps);

// ── 4. 재사용(카드의 ↻): RE-3b 카드 → 칸이 [X, A] 로 되살고, A 칸은 다시 "인증" ──
let c = await cards('RE-3b');
ok('4 카드 기록(usedAssets)에 asset 주소가 안 섞임', c[0]?.used.every((u) => !u.u.startsWith('asset://')), c[0]?.used);
await panelClear();
await main.ev(`document.querySelector('#msg-${c[0].id} button[title="프롬프트 재사용"]')?.click(); 1`);
for (let i = 0; i < 20; i++) { if ((await rows()).length === 2) break; await sleep(500); }
rs = await rows();
await sleep(500);
ri = await rowInfo('mina.png');
ok('4 재사용 → 칸 [sun, mina] · mina 칸 "인증"', rs.map((r) => r.f).join() === 'sun.png,mina.png' && ri?.cert, { rs, ri });
ps = await sendAndWait('RE-4');
ok('4 재사용 뒤 보내기 → [사진, 에셋]', JSON.stringify(ps) === JSON.stringify([['UP', 'A:' + assetA]]), ps);

// ── 5. 재생성(카드의 ✦): 같은 레퍼런스로 다시 → 에셋 그대로 ──
c = await waitCard('RE-4', (x) => x.every((y) => y.st === 'succeeded'), 30000);   // 생성 중엔 재생성 단추가 잠긴다
const before5 = (await cards('RE-4')).length;
await main.ev(`document.querySelector('#msg-${c[0].id} button[title^="재생성"]')?.click(); 1`);
const c5 = await waitCard('RE-4', (x) => x.length > before5 && x.every((y) => y.task || y.st === 'failed'));
ps = await postsOf('RE-4');
ok('5 재생성 → 새 카드도 [사진, 에셋]', c5.length === before5 + 1 && JSON.stringify(ps[ps.length - 1]) === JSON.stringify(['UP', 'A:' + assetA]), { n: c5.length, ps });

// ── 6. 등록 중에 칸을 바꿈 — 끝나도 바뀐 칸에 "인증" 이 붙지 않고, 등록은 원래 사진에 ──
await panelClear();
const cB = await cacheOf(Bp, 'bora.png');
await panelAdd(cB, 'bora.png');
await sleep(600); await press('bora.png');
await waitRow('bora.png', (r) => r.working, 5000);
rs = await rows();
await S(`S.getState().replaceAsset(${JSON.stringify(pid)}, ${JSON.stringify(rs[0].id)}, { cacheId: ${JSON.stringify(cY)}, file_name: 'night.png', thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=', url: '' }); return 1;`);
await sleep(400);
const ri6a = await rowInfo('night.png');
let lib6;
for (let i = 0; i < 120; i++) { lib6 = JSON.parse(await S(`const a = S.getState().elementAssets.find(e => e.name === 'bora'); return JSON.stringify(a?.images[0].bpAssets?.['2DT'] || null);`)); if (lib6?.status === 'active') break; await sleep(1000); }
const ri6 = await rowInfo('night.png');
ok('6 바꾼 칸(night)은 "등록 중" 도 "인증" 도 아님 · 방패 보임', ri6a && !ri6a.working && !ri6a.cert && ri6 && !ri6.cert && ri6.shield, { ri6a, ri6 });
ok('6 등록은 원래 사진(bora) 카드에 Active', lib6?.status === 'active', lib6);
ps = await sendAndWait('RE-6');
ok('6 보내기 → night 는 사진', JSON.stringify(ps) === '[["UP"]]', ps);

// ── 7. 라이브러리 카드를 지우면 칸의 "인증" 도 사라진다 ──
await panelClear(); await panelAdd(cB, 'bora.png');
await sleep(600);
const ri7a = await rowInfo('bora.png');
await S(`const a = S.getState().elementAssets.find(e => e.name === 'bora'); S.getState().deleteElementAsset(a.id); return 1;`);
await sleep(700);
const ri7 = await rowInfo('bora.png');
ok('7 카드 지우기 전 "인증" → 지운 뒤 "인증" 없음 · 방패', ri7a?.cert && ri7 && !ri7.cert && ri7.shield, { ri7a, ri7 });

// ── 8. 영상(v2v): 자동 인증된 영상 카드의 기록 · 재사용 · 순서 ──
await panelClear();
const cV = await cacheOf(V, 'clip.mp4');
await fakeSet({ faceKeys: [cV.slice(0, 12)] });
await panelAdd(cV, 'clip.mp4', 'video_url', 'reference_video'); await panelAdd(cX, 'sun.png');
await send('RE-8');
c = await waitCard('RE-8', (x) => x[0].task || x[0].st === 'failed');
ps = await postsOf('RE-8');
const assetV = (ps[ps.length - 1] || [])[0];
ok('8 영상 자동 인증 → [에셋(영상), 사진]', !!c[0]?.task && /^A:/.test(assetV) && ps[ps.length - 1][1] === 'UP', ps);
ok('8 카드 기록의 영상 주소는 asset 이 아님(재사용 · 받은 영상 설정에 asset id 가 안 섞임)', c[0]?.used.every((u) => !u.u.startsWith('asset://')), c[0]?.used);
await panelClear();
await main.ev(`document.querySelector('#msg-${c[0].id} button[title="프롬프트 재사용"]')?.click(); 1`);
for (let i = 0; i < 20; i++) { if ((await rows()).length === 2) break; await sleep(500); }
rs = await rows();
ok('8 재사용 → 영상 칸 url 은 비고 cacheId 그대로', rs[0]?.f === 'clip.mp4' && rs[0].u === '' && rs[0].c === cV, rs);
await S(`S.getState().setAssetOrder(${JSON.stringify(pid)}, ${JSON.stringify([rs[1].id, rs[0].id])}); return 1;`);
ps = await sendAndWait('RE-8b');
ok('8 순서 바꿔 [사진, 영상] → 영상은 기억된 에셋으로 바로(막힘 없음 · 요청 1번)', JSON.stringify(ps) === JSON.stringify([['UP', assetV]]), ps);
await fakeSet({ faceKeys: [] });

// ── 9. 프로젝트를 오가도 칸의 표시 그대로 ──
await panelClear(); await panelAdd(cA, 'mina.png');
const pid2 = (await cmd('project.create', { name: 'REFEDGE-2 ' + Date.now() % 100000, open: true }))?.result?.id;
await sleep(800);
await S(`S.getState().setCurrentProjectId(${JSON.stringify(pid)}); return 1;`);
await sleep(1000);
ri = await rowInfo('mina.png');
ok('9 다른 프로젝트를 열었다 돌아와도 "인증"', ri?.cert === true, { ri, pid2 });

await done();
