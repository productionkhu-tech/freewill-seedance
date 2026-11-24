// 등록 · 자동 인증 중에 취소하거나 지우거나 바꾸면 — 오류 없이 정리되나(11/24, 사용자 "등록하다가 막 취소하거나 이미지 바꿀 때 오류뜨거나 그러진 않음?").
// 시험 앱(3958) · 가짜 BytePlus(3946) · 진짜 게이트웨이 코드(3947). 과금 없음. 화면의 잡히지 않은 오류(error · unhandledrejection)도 센다.
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, GW = P.GW, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
const A = R('ai-character.png'), Bp = R('ai-character-close.png'), X = R('raw-sunrise.png'), Y = R('raw-night.png'), Z = R('frame-raw-first.png');

for (let i = 0; i < 300; i++) { try { if ((await (await fetch(HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(HOOK + '/show');
let main;
for (let i = 0; i < 120 && !main; i++) { try { main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini')); } catch { await sleep(1000); } }
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
await main.ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.error))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && (e.reason.message || e.reason)))); window.__toasts = []; window.addEventListener('seedance:toast', (e) => window.__toasts.push(e.detail)); 1`);
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
let manual = '';
for (let i = 0; i < 120 && !manual; i++) { try { const r = await fetch(API + '/api/agent/manual'); if (r.ok) manual = (await r.json()).version || ''; } catch {} if (!manual) await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const post = async (p, b) => { const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => null) }; };
const cmd = (command, args) => post('/api/agent/commands', { manual, command, args, wait: 30 }).then((r) => r.j);
const fakeSet = (o) => fetch(FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
const seen = async () => (await (await fetch(FAKE + '/__seen')).json());
const gwStats = async () => (await (await fetch(GW + '/__stats')).json());

let pid = (await cmd('project.create', { name: 'CANCEL ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
await cmd('collection.create', { name: '취소시험' });
await cmd('collection.bind', { collection: '취소시험', projectId: pid });
const setS = (p) => S(`S.getState().updateProjectSettings(${JSON.stringify(p)}, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); return 1;`);
await setS(pid);
await fakeSet({ faceKeys: [], goneAssets: [], copyrightKeys: [] });
const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name || path.basename(f)) }, body: fs.readFileSync(f) })).json()).cacheId;
const panelAdd = (cacheId, name, p = pid) => S(`S.getState().addAsset(${JSON.stringify(p)}, { type: 'image_url', url: '', role: 'reference_image', file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = (p = pid) => S(`S.getState().replaceAllAssets(${JSON.stringify(p)}, []); return 1;`);
const rowSel = (name) => `[...document.querySelectorAll('div')].filter(d => d.className && String(d.className).includes('rounded-[11px]') && d.textContent.includes(${JSON.stringify(name)}))[0]`;
const press = (name) => main.ev(`(() => { const b = ${rowSel(name)}?.querySelector('[data-bp-register-ref]'); if (!b) return 0; b.click(); return 1; })()`);
const entryOf = (n) => S(`const a = S.getState().elementAssets.find(e => e.name === ${JSON.stringify(n)}); return JSON.stringify(a ? (a.images[0].bpAssets?.['2DT'] || null) : 'NO_CARD');`).then(JSON.parse);
const cards = (tag, p = pid) => S(`const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(p)}); if (!pr) return '[]'; return JSON.stringify(pr.messages.filter(m => m.role === 'system' && (m.promptText || '').includes(${JSON.stringify(tag)})).map(m => ({ id: m.id, st: m.status, task: m.taskId || '', fix: m.bpFix || null, err: (m.error || '').slice(0, 300) })));`).then(JSON.parse);
const send = (tag, p = pid) => S(`const w = []; const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(p)}); await R.sendRequest({ projectId: pr.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: pr.settings, assets: pr.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`).then(JSON.parse);
const postsOf = async (tag) => (await seen()).filter((x) => JSON.stringify(x).includes(tag)).length;
const waitFor = async (fn, pred, ms = 60000, step = 300) => { let v; for (let t = 0; t < ms; t += step) { v = await fn(); if (pred(v)) return v; await sleep(step); } return v; };
const errs = () => main.ev(`JSON.stringify(window.__errs)`).then(JSON.parse);

// ── 1. 방패로 등록 중에 그 칸을 지움 → 등록은 끝까지 · 오류 없음 ──
const cA = await cacheOf(A, 'mina.png');
await panelClear(); await panelAdd(cA, 'mina.png');
await sleep(600); await press('mina.png');
await sleep(150);
await panelClear();
const e1 = await waitFor(() => entryOf('mina'), (e) => e && e !== 'NO_CARD' && e.status === 'active', 120000, 800);
ok('1 칸을 지워도 등록은 끝까지(라이브러리 mina active)', e1?.status === 'active', e1);
const toast1 = await waitFor(() => main.ev(`JSON.stringify(window.__toasts)`).then(JSON.parse), (t) => t.some((x) => /\[mina\]/.test(x.msg)), 30000, 500);
ok('1 알림은 정상(오류 알림 아님)', toast1.some((x) => /\[mina\]/.test(x.msg) && x.ok), toast1);

// ── 2. 자동 인증 중에 라이브러리 인물 카드를 지움 → 카드는 이유와 함께 실패 · 다시 안 보냄 ──
const cB = await cacheOf(Bp, 'bora.png');
await fakeSet({ faceKeys: [md5(Bp)] });
await panelClear(); await panelAdd(cB, 'bora.png');
await send('CX-2');
await waitFor(() => cards('CX-2'), (c) => c[0]?.fix, 15000);
const madeCard = await waitFor(() => entryOf('bora'), (e) => e !== 'NO_CARD', 20000, 100);
await S(`const a = S.getState().elementAssets.find(e => e.name === 'bora'); if (a) S.getState().deleteElementAsset(a.id); return 1;`);
const c2 = await waitFor(() => cards('CX-2'), (c) => c[0]?.st === 'failed' || c[0]?.task, 200000, 800);
ok('2 카드는 실패 + "[자동 인증 못 함] 인물 사진이 라이브러리에서 지워졌어요" · 다시 안 보냄', madeCard !== 'NO_CARD' && c2[0]?.st === 'failed' && /자동 인증 못 함/.test(c2[0].err) && /라이브러리에서 지워졌어요/.test(c2[0].err) && (await postsOf('CX-2')) === 1, { madeCard, c2 });

// ── 3. 취소 직후 바로 재생성 → 진행 중인 인증을 이어받아 한 번만 등록 · 새 카드는 에셋으로 ──
const cX = await cacheOf(X, 'sun.png');
await fakeSet({ faceKeys: [md5(X)] });
await panelClear(); await panelAdd(cX, 'sun.png');
const create0 = (await gwStats()).stats.CreateAsset;
await send('CX-3');
const c3a = await waitFor(() => cards('CX-3'), (c) => c[0]?.fix, 15000);
await S(`const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(pid)}); S.getState().updateMessage(pr.id, ${JSON.stringify(c3a[0].id)}, { status: 'failed', content: '취소함', error: '자동 인증 중에 취소했어요 — 다시 보내지 않았어요.', bpFix: undefined, endTime: Date.now() }); return 1;`);
await sleep(200);
await main.ev(`document.querySelector('#msg-${c3a[0].id} button[title^="재생성"]')?.click(); 1`);
const c3 = await waitFor(() => cards('CX-3'), (c) => c.length >= 2 && c.some((x) => x.task), 200000, 800);
const create1 = (await gwStats()).stats.CreateAsset;
const sunCards = await S(`return S.getState().elementAssets.filter(e => e.name === 'sun').length;`);
ok('3 취소한 카드는 그대로 · 재생성한 카드는 task(에셋)', c3.length === 2 && c3.find((x) => x.id === c3a[0].id)?.st === 'failed' && c3.some((x) => x.id !== c3a[0].id && x.task), c3);
ok('3 등록은 한 번만(CreateAsset +1 · 라이브러리 카드 하나)', create1 - create0 === 1 && sunCards === 1, { created: create1 - create0, sunCards });

// ── 4. 자동 인증을 기다리는 사이 프로젝트 코드가 바뀜 → 다시 보내지 않고 이유 ──
const cY = await cacheOf(Y, 'night.png');
await fakeSet({ faceKeys: [md5(Y)] });
await panelClear(); await panelAdd(cY, 'night.png');
await send('CX-4');
await waitFor(() => cards('CX-4'), (c) => c[0]?.fix, 15000);
await S(`S.getState().setBillingProjectKey('TST'); return 1;`);
const c4 = await waitFor(() => cards('CX-4'), (c) => c[0]?.st === 'failed' || c[0]?.task, 200000, 800);
ok('4 코드가 바뀌면 다시 안 보냄 · "프로젝트 코드가 바뀌어" + 자동 인증은 끝남', c4[0]?.st === 'failed' && /프로젝트 코드가 바뀌어/.test(c4[0].err) && /자동 인증은 끝났어요/.test(c4[0].err) && (await postsOf('CX-4')) === 1, c4);
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);

// ── 5. 자동 인증을 기다리는 사이 그 프로젝트(채팅)를 지움 → 조용히 끝(다시 안 보냄 · 오류 없음) ──
const pid5 = (await cmd('project.create', { name: 'CANCEL-DEL ' + Date.now() % 100000, open: true }))?.result?.id;
await setS(pid5);
const cZ = await cacheOf(Z, 'zed.png');
await fakeSet({ faceKeys: [md5(Z)] });
await panelAdd(cZ, 'zed.png', pid5);
await send('CX-5', pid5);
await waitFor(() => cards('CX-5', pid5), (c) => c[0]?.fix, 15000);
await S(`S.getState().deleteProject(${JSON.stringify(pid5)}); return 1;`);
await sleep(25000);
ok('5 프로젝트를 지우면 다시 안 보냄', (await postsOf('CX-5')) === 1);

// ── 6. 화면 오류 0 ──
const er = await errs();
ok('6 시험 내내 화면의 잡히지 않은 오류 0', er.length === 0, er);

await done();
