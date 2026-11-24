// 모드마다 자동 인증이 맞는 칸을 고치나(11/24, 사용자 "i2v도 그러면 인증 들어가긴 하는 거지 · r2v edit 뭐 등등 다 인증 잘 들어가는 거제").
// 시험 앱(3958) · 가짜 BytePlus(3946, faceKeys = 실사 얼굴로 막힘) · 진짜 게이트웨이 코드(3947). 과금 없음.
// A 첫 프레임(2.0) · B 첫/끝(넣은 순서 끝→첫, 둘 다 막힘) · C Edit(2.5, 영상) · D Extend(2.5, 영상 둘) · E 레퍼런스 사진 7장 모두 막힘(MAX_FIX 6 넘김)
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs'; import crypto from 'node:crypto';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);

for (let i = 0; i < 300; i++) { try { if ((await (await fetch(HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(HOOK + '/show');
let main;
for (let i = 0; i < 120 && !main; i++) { try { main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini')); } catch { await sleep(1000); } }
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
await main.ev(`window.__errs = []; window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.error))); window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + (e.reason && (e.reason.message || e.reason)))); 1`);
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
const pid = (await cmd('project.create', { name: 'MODES ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
const M20 = 'dreamina-seedance-2-0-260128', M25 = 'dreamina-seedance-2-5-260628';
const setS = (model, mode) => S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: ${JSON.stringify(model)}, mode: ${JSON.stringify(mode)}, ratio: '16:9', resolution: '720p', duration: 5, output_count: 1, draft: false }); S.getState().setCurrentProjectId(${JSON.stringify(pid)}); return 1;`);
const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body: fs.readFileSync(f) })).json()).cacheId;
const add = (type, role, cacheId, name) => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: ${JSON.stringify(type)}, url: '', role: ${JSON.stringify(role)}, file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
const send = (tag) => S(`const w = []; const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: pr.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: pr.settings, assets: pr.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`).then(JSON.parse);
const cards = (tag) => S(`const pr = S.getState().projects.find(x => x.id === ${JSON.stringify(pid)}); return JSON.stringify(pr.messages.filter(m => m.role === 'system' && (m.promptText || '').includes(${JSON.stringify(tag)})).map(m => ({ st: m.status, task: m.taskId || '', fix: m.bpFix?.label || '', err: (m.error || '').slice(0, 300) })));`).then(JSON.parse);
const waitDone = async (tag, ms = 420000) => { let c; for (let t = 0; t < ms; t += 1000) { c = await cards(tag); if (c[0] && (c[0].task || c[0].st === 'failed')) return c; await sleep(1000); } return c; };
// 그 태그로 BytePlus 에 간 요청들 — 마지막 것의 미디어 칸(종류 · 역할 · 에셋인지 · 원본 key)
const posts = async (tag) => (await seen()).filter((x) => JSON.stringify(x).includes(tag));
const media = (p) => (p?.content || []).filter((c) => c.type !== 'text').map((c) => { const u = c[c.type]?.url || ''; return { t: c.type === 'image_url' ? 'I' : c.type === 'video_url' ? 'V' : 'A', role: c.role || '-', asset: u.startsWith('asset://') }; });
const withKeys = (p, keys) => (p?.content || []).filter((c) => c.type !== 'text').map((c) => { const u = c[c.type]?.url || ''; return keys.find((k) => u.includes(k)) || (u.startsWith('asset://') ? 'ASSET' : '?'); });

// ── A. Image to Video (First Frame), 2.0 ──
const fA = R('frame-raw-first.png');
const cA = await cacheOf(fA, 'a_first.png');
await setS(M20, 'image_to_video_first'); await panelClear(); await add('image_url', 'first_frame', cA, 'a_first.png');
await fakeSet({ faceKeys: [md5(fA)], goneAssets: [], copyrightKeys: [] });
ok('A 보냄(경고 없음)', (await send('MD-A')).length === 0);
const cAr = await waitDone('MD-A');
const pA = await posts('MD-A');
ok('A 첫 프레임 — 막힘 → 인증 → 같은 카드로 task · 다시 보낸 칸은 에셋(역할 없이)', cAr[0]?.task && pA.length === 2 && JSON.stringify(media(pA[1])) === JSON.stringify([{ t: 'I', role: '-', asset: true }]), { cAr, first: media(pA[0]), last: media(pA[1]) });

// ── B. First & Last, 2.0 — 넣은 순서 끝 → 첫, 둘 다 막힘 ──
const fBf = R('frame-T1-first.png'), fBl = R('frame-T1-last.png');
const cBf = await cacheOf(fBf, 'b_first.png'), cBl = await cacheOf(fBl, 'b_last.png');
await setS(M20, 'image_to_video_first_last'); await panelClear();
await add('image_url', 'last_frame', cBl, 'b_last.png'); await add('image_url', 'first_frame', cBf, 'b_first.png');
await fakeSet({ faceKeys: [md5(fBf), md5(fBl)] });
ok('B 보냄(경고 없음)', (await send('MD-B')).length === 0);
const cBr = await waitDone('MD-B');
const pB = await posts('MD-B');
const lastB = pB[pB.length - 1];
ok('B 첫/끝 — 두 칸 다 인증 · 마지막 요청은 [첫 프레임 에셋, 끝 프레임 에셋] 순서 · 역할 그대로', cBr[0]?.task && pB.length === 3
  && JSON.stringify(media(lastB)) === JSON.stringify([{ t: 'I', role: 'first_frame', asset: true }, { t: 'I', role: 'last_frame', asset: true }])
  && JSON.stringify(withKeys(pB[0], [md5(fBf), md5(fBl)])) === JSON.stringify([md5(fBf), md5(fBl)]), { cBr, posts: pB.length, first: withKeys(pB[0], [md5(fBf), md5(fBl)]), last: media(lastB) });

// ── C. Edit Video, 2.5 — 영상이 막힘 ──
const fC = R('frame-T2.mp4');
const cC = await cacheOf(fC, 'c_edit.mp4');
await setS(M25, 'edit_video'); await panelClear(); await add('video_url', 'reference_video', cC, 'c_edit.mp4');
await fakeSet({ faceKeys: [md5(fC)] });
ok('C 보냄(경고 없음)', (await send('MD-C')).length === 0);
const cCr = await waitDone('MD-C');
const pC = await posts('MD-C');
const lastC = pC[pC.length - 1];
ok('C Edit — 영상 인증 → task · 마지막 요청 영상은 에셋 · omni_reference_task_type=edit 그대로', cCr[0]?.task && pC.length === 2
  && JSON.stringify(media(lastC)) === JSON.stringify([{ t: 'V', role: 'reference_video', asset: true }]) && lastC.omni_reference_task_type === 'edit', { cCr, last: media(lastC), tt: lastC?.omni_reference_task_type });

// ── D. Extend Video, 2.5 — 영상 둘 다 막힘 ──
const fD1 = R('frame-T4.mp4'), fD2 = R('reencoded-face.mp4');
const cD1 = await cacheOf(fD1, 'd_1.mp4'), cD2 = await cacheOf(fD2, 'd_2.mp4');
await setS(M25, 'extend_video'); await panelClear();
await add('video_url', 'reference_video', cD1, 'd_1.mp4'); await add('video_url', 'reference_video', cD2, 'd_2.mp4');
await fakeSet({ faceKeys: [md5(fD1), md5(fD2)] });
ok('D 보냄(경고 없음)', (await send('MD-D')).length === 0);
const cDr = await waitDone('MD-D');
const pD = await posts('MD-D');
const lastD = pD[pD.length - 1];
ok('D Extend — 영상 둘 다 인증 → task · 순서 그대로 · omni_reference_task_type=extend', cDr[0]?.task && pD.length === 3
  && JSON.stringify(media(lastD)) === JSON.stringify([{ t: 'V', role: 'reference_video', asset: true }, { t: 'V', role: 'reference_video', asset: true }]) && lastD.omni_reference_task_type === 'extend', { cDr, posts: pD.length, last: media(lastD), tt: lastD?.omni_reference_task_type });

// ── E. Multimodal Reference, 2.0 — 사진 7장 모두 막힘(예전 MAX_FIX 6 이면 7번째에서 실패) ──
const fE = ['ai-character-close.png', 'frame-T2-first.png', 'frame-T2-last.png', 'frame-T4-first.png', 'frame-T4-last.png', 'frame-raw-last.png', 'raw-night.png'].map(R);
const cE = [];
for (let i = 0; i < fE.length; i++) cE.push(await cacheOf(fE[i], `e_${i + 1}.png`));
await setS(M20, 'multimodal_reference'); await panelClear();
for (let i = 0; i < fE.length; i++) await add('image_url', 'reference_image', cE[i], `e_${i + 1}.png`);
await fakeSet({ faceKeys: fE.map(md5) });
ok('E 보냄(경고 없음)', (await send('MD-E')).length === 0);
const cEr = await waitDone('MD-E', 900000);
const pE = await posts('MD-E');
const lastE = pE[pE.length - 1];
ok('E 레퍼런스 7장 — 7칸 다 인증 → task(8번 요청) · 마지막은 7장 모두 에셋', cEr[0]?.task && pE.length === 8 && media(lastE).length === 7 && media(lastE).every((m) => m.asset && m.role === 'reference_image'), { cEr, posts: pE.length, last: media(lastE) });

const er = JSON.parse(await main.ev(`JSON.stringify(window.__errs)`));
ok('화면의 잡히지 않은 오류 0', er.length === 0, er);
await done();
