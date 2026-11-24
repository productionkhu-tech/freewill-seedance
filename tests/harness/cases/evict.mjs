// 보관함 정리로 지워진 에셋 알아차리기 격리 시험(11/24, 사용자 "이것도 대처해두면 좋겠네 앱에서 안 꼬이게 잘").
// 시험 앱(3958) · 가짜 BytePlus(3946) · 진짜 게이트웨이 코드 + 가짜 BytePlus OpenAPI(3947, /__cap · /__age · DeleteAsset). 과금 없음.
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, GW = P.GW, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const A = R('ai-character.png'), Bp = R('ai-character-close.png'), X = R('raw-sunrise.png'), Y = R('raw-night.png');

for (let i = 0; i < 300; i++) { try { if ((await (await fetch(HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(HOOK + '/show');
let main;
for (let i = 0; i < 120 && !main; i++) { try { main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini')); } catch { await sleep(1000); } }
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const B = window.__B || (window.__B = await import('/src/lib/bp-assets.ts')); const C = window.__C || (window.__C = await import('/src/lib/bp-certify.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
let manual = '';
for (let i = 0; i < 120 && !manual; i++) { try { const r = await fetch(API + '/api/agent/manual'); if (r.ok) manual = (await r.json()).version || ''; } catch {} if (!manual) await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const post = async (p, b) => { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => null) }; };
const cmd = (command, args) => post('/api/agent/commands', { manual, command, args, wait: 30 }).then((r) => r.j);
const fakeSet = (o) => fetch(FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
const seen = async () => (await (await fetch(FAKE + '/__seen')).json());

const pid = (await cmd('project.create', { name: 'EVICT ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
await cmd('collection.create', { name: '정리시험' });
await cmd('collection.bind', { collection: '정리시험', projectId: pid });
await S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); return 1;`);
await fakeSet({ faceKeys: [], goneAssets: [], copyrightKeys: [] });
const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name || path.basename(f)) }, body: fs.readFileSync(f) })).json()).cacheId;
const panelAdd = (cacheId, name) => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: 'image_url', url: '', role: 'reference_image', file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
const rowSel = (name) => `[...document.querySelectorAll('div')].filter(d => d.className && String(d.className).includes('rounded-[11px]') && d.textContent.includes(${JSON.stringify(name)}))[0]`;
const rowInfo = (name) => main.ev(`(() => { const r = ${rowSel(name)}; if (!r) return JSON.stringify(null); return JSON.stringify({ shield: !!r.querySelector('[data-bp-register-ref]'), cert: !!r.querySelector('[data-bp-ref-state="done"]'), working: !!r.querySelector('[data-bp-ref-state="processing"]'), gone: !!r.querySelector('[data-bp-ref-state="gone"]'), failed: !!r.querySelector('[data-bp-ref-state="failed"]') }); })()`).then(JSON.parse);
const press = (name) => main.ev(`(() => { const b = ${rowSel(name)}?.querySelector('[data-bp-register-ref]'); if (!b) return 0; b.click(); return 1; })()`);
const waitRow = async (name, pred, ms = 150000) => { let r; for (let t = 0; t < ms; t += 700) { r = await rowInfo(name); if (r && pred(r)) return r; await sleep(700); } return r; };
const entry = (n) => S(`const a = S.getState().elementAssets.find(e => e.name === ${JSON.stringify(n)}); return JSON.stringify(a?.images[0].bpAssets?.['2DT'] || null);`).then(JSON.parse);
const cardState = (n) => S(`const a = S.getState().elementAssets.find(e => e.name === ${JSON.stringify(n)}); return a ? B.bpCardState(a, '2DT') : 'none';`);
const cards = (tag) => S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); return JSON.stringify(p.messages.filter(m => m.role === 'system' && (m.promptText || '').includes(${JSON.stringify(tag)})).map(m => ({ st: m.status, task: m.taskId || '', fix: m.bpFix || null })));`).then(JSON.parse);
const send = (tag) => S(`const w = []; const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: p.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: p.settings, assets: p.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`).then(JSON.parse);
const postsOf = async (tag) => (await seen()).filter((x) => JSON.stringify(x).includes(tag)).map((x) => (x.content || []).filter((c) => c.type !== 'text').map((c) => { const u = (c[c.type] || {}).url || ''; return u.startsWith('asset://') ? 'A:' + u.slice(8) : u.startsWith('http') ? 'UP' : u; }));
const waitCard = async (tag, pred, ms = 200000) => { let c; for (let t = 0; t < ms; t += 800) { c = await cards(tag); if (c.length && pred(c)) return c; await sleep(800); } return c; };

// ── 0. 등록한 적 없는 PC 는 묻지 않는다 ──
const n0 = await S(`return await C.checkEvicted(true);`);
ok('0 등록 기록이 없으면 묻지 않음(0)', n0 === 0);

// ── 1. A · B 를 칸에서 인증 ──
const cA = await cacheOf(A, 'mina.png'), cB = await cacheOf(Bp, 'bora.png');
await panelClear(); await panelAdd(cA, 'mina.png'); await panelAdd(cB, 'bora.png');
await sleep(600); await press('mina.png'); await waitRow('mina.png', (r) => r.cert); await press('bora.png'); await waitRow('bora.png', (r) => r.cert);
const eA = await entry('mina'), eB = await entry('bora');
ok('1 A · B 인증', eA?.status === 'active' && eB?.status === 'active', { eA, eB });

// ── 2. 다른 PC 가 등록하다 보관함이 차서 게이트웨이가 A 를 지움(A 는 오래 안 씀 · B 는 최근) ──
await fetch(`${GW}/__age?id=${eA.id}&days=10`);
const st0 = await (await fetch(GW + '/__stats')).json();
await fetch(`${GW}/__cap?n=${st0.assets}`);
const cX = await cacheOf(X, 'sun.png');
await panelClear(); await panelAdd(cX, 'sun.png');
await sleep(600); await press('sun.png');
const rX = await waitRow('sun.png', (r) => r.cert || r.failed);
const names = (await (await fetch(GW + '/__stats')).json()).names.map((x) => x[0]);
ok('2 보관함이 차 A 를 지우고 X 를 등록(B 는 남김)', rX?.cert && !names.includes(eA.id) && names.includes(eB.id), { rX, names });
await fetch(`${GW}/__cap?n=0`);

// ── 3. 이 PC 가 지운 기록을 물으면 A 칸 · 카드가 '지워짐'(B 는 그대로 '인증') ──
await panelClear(); await panelAdd(cA, 'mina.png'); await panelAdd(cB, 'bora.png');
await S(`for (const k of Object.keys(localStorage)) if (k.startsWith('seedance-bp-evicted-since:')) localStorage.removeItem(k); return 1;`);
const n3 = await S(`return await C.checkEvicted(true);`);
await sleep(700);
const rA3 = await rowInfo('mina.png'), rB3 = await rowInfo('bora.png');
const eA3 = await entry('mina');
ok('3 지운 기록 → A 하나를 지워짐(failed + gone · 같은 id)', n3 === 1 && eA3?.status === 'failed' && eA3.gone === true && eA3.id === eA.id, { n3, eA3 });
ok('3 A 칸은 회색 "지워짐" · 방패 보임 / B 칸은 "인증"', rA3?.gone && !rA3.cert && rA3.shield && rB3?.cert && !rB3.gone, { rA3, rB3 });
ok('3 라이브러리 카드 배지: A gone · B active', (await cardState('mina')) === 'gone' && (await cardState('bora')) === 'active');
// 3b. 다시 물어도(같은 since) 같은 결과 · 새로 바꾸는 것 없음
const n3b = await S(`return await C.checkEvicted(true);`);
ok('3b 다시 물으면 바뀌는 것 없음(0)', n3b === 0, n3b);

// ── 4. 쓸 때 다시 등록: A 를 보내면 사진으로 나가 막히고(실사 얼굴) → 자동 인증 → 같은 카드로 에셋 ──
await panelClear(); await panelAdd(cA, 'mina.png');
await fakeSet({ faceKeys: [md5(A)] });
await send('EV-4');
const c4 = await waitCard('EV-4', (x) => x[0].task || x[0].st === 'failed');
const p4 = await postsOf('EV-4');
const eA4 = await entry('mina');
ok('4 지워진 A 를 보내면 자동으로 다시 등록 → 같은 카드로 새 에셋', !!c4[0]?.task && p4.length === 2 && p4[0][0] === 'UP' && p4[1][0] === 'A:' + eA4?.id && eA4?.id !== eA.id && eA4?.status === 'active' && !eA4.gone, { c4, p4, eA4 });
await fakeSet({ faceKeys: [] });
const rA4 = await rowInfo('mina.png');
ok('4 칸은 다시 "인증"', rA4?.cert && !rA4.gone, rA4);

// ── 5. 그 사이 다시 등록돼 id 가 바뀐 사진은 옛 기록으로 건드리지 않는다 ──
await S(`for (const k of Object.keys(localStorage)) if (k.startsWith('seedance-bp-evicted-since:')) localStorage.removeItem(k); return 1;`);
const n5 = await S(`return await C.checkEvicted(true);`);
const eA5 = await entry('mina');
ok('5 옛 기록(지운 A 의 옛 id)을 다시 받아도 새 id 는 그대로 active', n5 === 0 && eA5?.status === 'active' && eA5.id === eA4.id, { n5, eA5 });

// ── 6. 방패로 바로 다시 등록도 된다(지워짐 → 방패) ──
await fetch(`${GW}/__age?id=${eB.id}&days=10`);
const st6 = await (await fetch(GW + '/__stats')).json();
await fetch(`${GW}/__cap?n=${st6.assets}`);
const cY = await cacheOf(Y, 'night.png');
await panelClear(); await panelAdd(cY, 'night.png');
await sleep(600); await press('night.png'); await waitRow('night.png', (r) => r.cert || r.failed);
await fetch(`${GW}/__cap?n=0`);
await S(`return await C.checkEvicted(true);`);
await panelClear(); await panelAdd(cB, 'bora.png');
await sleep(700);
const rB6 = await rowInfo('bora.png');
await press('bora.png');
const rB6b = await waitRow('bora.png', (r) => r.cert);
const eB6 = await entry('bora');
ok('6 B 지워짐 → 방패 → 다시 "인증"(새 id)', rB6?.gone && rB6.shield && rB6b?.cert && eB6?.id !== eB.id && eB6?.status === 'active', { rB6, rB6b, eB6 });

await done();
