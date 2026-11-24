// 영상 칸 인증 배지(11/24, 사용자 "이런 경우엔 어떻게 들어가는 거임 인증 버튼이") — 시험 앱(3958) · 가짜 BytePlus(3946) · 진짜 게이트웨이 코드(3947). 과금 없음.
// 확인: 영상 칸에 배지 · 누르면 등록 중 → 인증 · 보낼 때 asset:// · 누른 직후 보내도 등록 한 번 · 거절되면 빨강 + 이유 · 지워지면 등록 전으로 · 옴니엔 없음 · 오류 0
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, GW = P.GW, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);

for (let i = 0; i < 300; i++) { try { if ((await (await fetch(HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(HOOK + '/show'); let main;
for (let i = 0; i < 120 && !main; i++) { try { main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini')); } catch { await sleep(1000); } }
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
await main.ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.error))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && (e.reason.message || e.reason)))); window.__toasts = []; window.addEventListener('seedance:toast', (e) => window.__toasts.push(e.detail)); 1`);
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const C = window.__C || (window.__C = await import('/src/lib/bp-certify.ts')); const S = M.useAppStore; ${code} })()`);
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
const pid = (await cmd('project.create', { name: 'VIDBADGE ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
const setS = (model = 'dreamina-seedance-2-0-260128') => S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: ${JSON.stringify(model)}, mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); S.getState().setCurrentProjectId(${JSON.stringify(pid)}); return 1;`);
await setS();
await fakeSet({ faceKeys: [], goneAssets: [], copyrightKeys: [] });
const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: fs.readFileSync(f) })).json()).cacheId;
const addVid = (cacheId, name) => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: 'video_url', url: '', role: 'reference_video', file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
const rowJs = (name) => `[...document.querySelectorAll('div')].filter(d => d.className && String(d.className).includes('rounded-[11px]') && d.textContent.includes(${JSON.stringify(name)}))[0]`;
const press = (name) => main.ev(`(() => { const b = ${rowJs(name)}?.querySelector('[data-bp-register-ref]'); if (!b) return 0; b.click(); return 1; })()`);
const badge = (name) => main.ev(`(() => { const r = ${rowJs(name)}; if (!r) return JSON.stringify({ row: false }); const s = r.querySelector('[data-bp-ref-state]'); const b = r.querySelector('[data-bp-register-ref]'); return JSON.stringify({ row: true, state: s ? s.getAttribute('data-bp-ref-state') : (b ? 'idle' : 'none'), title: (s || b)?.getAttribute('title') || '' }); })()`).then(JSON.parse);
const waitBadge = async (name, want, ms = 90000) => { let b; for (let t = 0; t < ms; t += 300) { b = await badge(name); if (b.state === want) return b; await sleep(300); } return b; };
const send = (tag) => S(`const w = []; const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: pr.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: pr.settings, assets: pr.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`).then(JSON.parse);
const lastVideoUrl = async (tag) => { const s = (await seen()).filter((x) => JSON.stringify(x).includes(tag)); const last = s[s.length - 1]; const v = (last?.content || []).find((c) => c.type === 'video_url'); return { posts: s.length, url: v?.video_url?.url || '' }; };
const cards = (tag) => S(`const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(pid)}); return JSON.stringify(pr.messages.filter(m => m.role === 'system' && (m.promptText || '').includes(${JSON.stringify(tag)})).map(m => ({ st: m.status, task: m.taskId || '', err: (m.error || '').slice(0, 200) })));`).then(JSON.parse);
const waitFor = async (fn, pred, ms = 60000, step = 300) => { let v; for (let t = 0; t < ms; t += step) { v = await fn(); if (pred(v)) return v; await sleep(step); } return v; };

const fV1 = R('frame-raw.mp4'), fV2 = R('frame-T1.mp4'), fV3 = R('frame-T2.mp4');
const cV1 = await cacheOf(fV1, 'kling_a.mp4'), cV2 = await cacheOf(fV2, 'kling_b.mp4'), cV3 = await cacheOf(fV3, 'kling_c.mp4');

// 1. 영상 칸에 배지(등록 전) — 손을 올려야 보이지만 단추는 있다
await panelClear(); await addVid(cV1, 'kling_a.mp4');
await sleep(800);
const b1 = await badge('kling_a.mp4');
ok('1 영상 칸에 등록 전 배지(단추) · 설명은 영상용', b1.state === 'idle' && /이 영상을 BytePlus 에셋으로 인증/.test(b1.title) && /이 앱\(Seedance\)에서 만든 영상은 원래 통과/.test(b1.title), b1);

// 2. 누르면 등록 중 → 인증 · 알림 · 보낼 때 asset://
const create0 = (await gwStats()).stats.CreateAsset || 0;
await press('kling_a.mp4');
await sleep(150);
const b2a = await badge('kling_a.mp4');
const b2 = await waitBadge('kling_a.mp4', 'done');
ok('2 누르면 등록 중 → 인증(제목에 에셋 id)', b2a.state === 'processing' && b2.state === 'done' && /asset-/.test(b2.title), { b2a, b2 });
const t2 = await waitFor(() => main.ev(`JSON.stringify(window.__toasts)`).then(JSON.parse), (t) => t.some((x) => /kling_a/.test(x.msg)), 10000);
ok('2 알림 "[kling_a] … 인증 완료"', t2.some((x) => /\[kling_a\].*인증 완료/.test(x.msg) && x.ok), t2);
await send('VB-2');
const v2 = await waitFor(() => lastVideoUrl('VB-2'), (v) => v.posts >= 1, 20000);
ok('2 보낼 때 영상은 asset://(막히지 않고 한 번에)', v2.posts === 1 && v2.url.startsWith('asset://'), v2);

// 3. 누른 직후 바로 보내면(얼굴로 막힘) — 자동 인증이 진행 중인 등록을 이어받아 등록은 한 번
await fakeSet({ faceKeys: [md5(fV2)] });
await panelClear(); await addVid(cV2, 'kling_b.mp4');
await sleep(600);
const c3a = (await gwStats()).stats.CreateAsset || 0;
await press('kling_b.mp4');
await send('VB-3');
const c3 = await waitFor(() => cards('VB-3'), (c) => c[0]?.task || c[0]?.st === 'failed', 120000, 600);
const c3b = (await gwStats()).stats.CreateAsset || 0;
const v3 = await lastVideoUrl('VB-3');
ok('3 누르고 바로 보내도 등록 한 번 · 카드는 에셋으로 다시 나감', c3[0]?.task && c3b - c3a === 1 && v3.url.startsWith('asset://'), { c3, created: c3b - c3a, v3 });
ok('3 배지도 인증', (await waitBadge('kling_b.mp4', 'done', 10000)).state === 'done');

// 4. 거절(실존 배우 등) → 빨강 + 이유
await fetch(GW + '/__fail?key=' + md5(fV3));
await panelClear(); await addVid(cV3, 'kling_c.mp4');
await sleep(600);
await press('kling_c.mp4');
const b4 = await waitBadge('kling_c.mp4', 'failed', 60000);
ok('4 거절되면 빨간 배지 + 이유(Real-human)', b4.state === 'failed' && /받지 않았어요/.test(b4.title) && /Real-human/.test(b4.title), b4);

// 5. 지워지면(정리 알아채기 · 'not found') 등록 전으로
await panelClear(); await addVid(cV1, 'kling_a.mp4');
await sleep(600);
const b5a = await badge('kling_a.mp4');
const id5 = (b5a.title.match(/asset-[A-Za-z0-9._-]+/) || [''])[0];
await S(`window.__C.forgetVideoAsset(${JSON.stringify(id5)}); return 1;`);
await sleep(300);
const b5 = await badge('kling_a.mp4');
ok('5 기억을 지우면(정리로 지워짐) 배지가 곧바로 등록 전으로', b5a.state === 'done' && !!id5 && b5.state === 'idle', { b5a, b5 });

// 6. 옴니 · 사진 칸은 그대로
await setS('gemini-omni-1.2-flash'); await sleep(800);
const b6 = await badge('kling_a.mp4');
ok('6 옴니면 영상 칸에 배지 없음', b6.state === 'none', b6);
await setS();

// 7. 오류 0
const er = JSON.parse(await main.ev(`JSON.stringify(window.__errs)`));
ok('7 화면의 잡히지 않은 오류 0', er.length === 0, er);
await done();
