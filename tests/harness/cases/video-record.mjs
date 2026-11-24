// 인증한 영상의 기억이 앱을 다시 켜도 남나 · 캐시 정리하면 같이 지워지나 · 워커를 덜 부르나(11/25, 사용자 "껐다 킬 때마다 신호 보내면 워커에 부담").
// 시험 앱 · 가짜 BytePlus(모두 막힘) · 진짜 게이트웨이 코드. 과금 없음.
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import P from '../lib/ports.mjs'; import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const V = (f) => path.join(FIX, f); const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
for (let i = 0; i < 300; i++) { try { if ((await (await fetch(P.HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(P.HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
const ready = async () => { for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); } };
// 화면이 게이트웨이 쪽(/api/bp-assets/*)을 몇 번 부르나 — 새로 고침 전부터 센다
await main.send('Page.enable');
await main.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__calls = []; window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message)); addEventListener('unhandledrejection', (e) => __errs.push('rej: ' + (e.reason && e.reason.message))); const f0 = window.fetch; window.fetch = function (u, o) { const s = String(u && u.url || u); const m = /\\/api\\/(bp-assets\\/[a-z]+|reupload|byteplus\\/tasks)/.exec(s); if (m) window.__calls.push(m[1]); return f0.apply(this, arguments); };` });
const reload = async () => { await sleep(5000); await main.send('Page.reload'); await sleep(3000); await ready(); for (let i = 0; i < 40; i++) { if (await S(`return S.getState().projects.some(p => p.id === '${pid}');`)) break; await sleep(300); } await S(`S.getState().setCurrentProjectId('${pid}'); return 1;`); };
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
let pid = '';
await ready();
let manual = ''; for (let i = 0; i < 120 && !manual; i++) { try { manual = (await (await fetch(P.API + '/api/agent/manual')).json()).version || ''; } catch {} if (!manual) await sleep(1000); }
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
pid = (await (await fetch(P.API + '/api/agent/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manual, command: 'project.create', args: { name: 'VIDKEEP', open: true }, wait: 30 }) })).json())?.result?.id;
await S(`S.getState().updateProjectSettings('${pid}', { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); S.getState().setCurrentProjectId('${pid}'); return 1;`);
const fakeSet = (o) => fetch(P.FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
await fakeSet({ faceKeys: ['http'], goneAssets: [], copyrightKeys: [] });
const made = async () => (await (await fetch(P.GW + '/__stats')).json()).assets;
const rec = () => main.ev(`localStorage.getItem('seedance-vid') || ''`);
const badge = () => main.ev(`(() => { const r = [...document.querySelectorAll('div')].filter((d) => String(d.className).includes('rounded-[11px]') && d.textContent.includes('[Video 1]'))[0]; return r?.querySelector('[data-bp-ref-state]')?.getAttribute('data-bp-ref-state') || (r?.querySelector('[data-bp-register-ref]') ? 'idle' : 'none'); })()`);
const waitBadge = async (w, ms = 12000) => { let b; for (let t = 0; t < ms; t += 200) { b = await badge(); if (b === w) return b; await sleep(200); } return b; };
const put = async (f, as) => { const c = (await (await fetch(P.API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(as) }, body: fs.readFileSync(f) })).json()).cacheId; await S(`S.getState().replaceAllAssets('${pid}', []); S.getState().addAsset('${pid}', { type: 'video_url', url: '', role: 'reference_video', file_name: '${as}', cacheId: '${c}', thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`); await sleep(700); };
const send = async (tag) => { await S(`const pr = S.getState().projects.find(x => x.id === '${pid}'); await R.sendRequest({ projectId: '${pid}', promptHtml: '${tag} 천천히', settings: pr.settings, assets: pr.assets }, { warn: () => {} }); return 1;`);
  for (let i = 0; i < 250; i++) { const m = JSON.parse(await S(`const m = S.getState().projects.find(x => x.id === '${pid}').messages.filter(m => m.role === 'system' && (m.promptText || '').includes('${tag}'))[0]; return JSON.stringify({ t: !!m?.taskId, st: m?.status });`)); if (m.t || m.st === 'failed') break; await sleep(500); }
  return (await (await fetch(P.FAKE + '/__seen')).json()).filter((x) => JSON.stringify(x).includes(tag)).map((x) => (x.content || []).filter((c) => c.type === 'video_url').map((c) => (c.video_url.url.startsWith('asset://') ? c.video_url.url.slice(8) : 'UPLOAD'))[0]); };
const calls = () => main.ev(`JSON.stringify(window.__calls.reduce((o, c) => { o[c] = (o[c] || 0) + 1; return o; }, {}))`).then(JSON.parse);
const A = V('frame-T1.mp4'), kA = md5(A);

await reload();
ok('0 등록한 적 없으면 켤 때 게이트웨이를 부르지 않음 · 남는 것 없음', !Object.keys(await calls()).some((k) => k.startsWith('bp-assets')) && (await rec()) === '', { c: await calls(), r: await rec() });
// 1. 처음 — 한 번 막히고 등록, 기록 한 줄
await put(A, 'kling.mp4'); let ps = await send('VK-1'); const id = ps[1];
ok('1 처음은 한 번 막히고 등록 · 기록 한 줄', ps.length === 2 && ps[0] === 'UPLOAD' && /^asset-/.test(id || '') && Object.keys(JSON.parse(await rec())).length === 1, { ps, rec: await rec(), 글자수: (await rec()).length });
// 2. 다시 켜도 배지 · 바로 나감 · 새 등록 0
const n0 = await made(); await reload();
ok('2 다시 켜면 누르지 않아도 배지 인증', (await waitBadge('done')) === 'done', await badge());
await sleep(9000); const start = await calls(); ok('2 켤 때 부르는 횟수(프로젝트 확인 · 정리 확인 각 한 번 안쪽)', (start['bp-assets/project'] || 0) <= 1 && (start['bp-assets/evicted'] || 0) <= 1 && !start['bp-assets/register'], start);
await main.ev('window.__calls.length = 0; 1'); ps = await send('VK-2'); const withRec = await calls();
ok('2 다시 켠 뒤 첫 보내기도 바로 에셋 · 새 등록 0', JSON.stringify(ps) === JSON.stringify([id]) && (await made()) === n0, { ps, withRec });
// 3. 켜자마자(프로젝트 이름을 아직 모를 때) 보내도 바로
await reload(); ps = await send('VK-3');
ok('3 켜자마자 보내도 바로 에셋', JSON.stringify(ps) === JSON.stringify([id]), ps);
// 4. 화면의 '캐시 정리' 를 실제로 누르면 같이 지워짐 → 다음 보내기는 한 번 막히고 같은 에셋(새 등록 0)
await main.ev(`[...document.querySelectorAll('button')].find((b) => /캐시 정리/.test(b.title || '') || b.textContent.trim().startsWith('캐시 정리')).click(); 1`); await sleep(800);
const dlg = await main.ev(`(() => { const t = [...document.querySelectorAll('p')].find((p) => /를 정리합니다/.test(p.textContent)); let box = t; for (let i = 0; i < 6 && box; i++) { const b = [...box.querySelectorAll('button')].find((x) => /정리|비우기|삭제/.test(x.textContent)); if (b) { b.click(); return b.textContent.trim(); } box = box.parentElement; } return ''; })()`);
for (let i = 0; i < 40 && (await rec()) !== ''; i++) await sleep(250);
ok('4 캐시 정리를 누르면 영상 기록도 지워짐', !!dlg && (await rec()) === '', { dlg, rec: await rec() });
await put(A, 'kling.mp4'); const b4 = await badge(); await main.ev('window.__calls.length = 0; 1'); ps = await send('VK-4'); const noRec = await calls();
ok('4 지운 뒤 첫 보내기 — 한 번 막히고 같은 에셋 · 새 등록 0 · 다시 적힘', b4 === 'idle' && JSON.stringify(ps) === JSON.stringify(['UPLOAD', id]) && (await made()) === n0 && (await rec()).includes(kA), { b4, ps });
const sum = (c) => Object.values(c).reduce((a, b) => a + b, 0);
ok('5 기록이 있으면 보내기 한 번의 부르는 횟수가 줄어듦', sum(withRec) < sum(noRec), { 기록있음: withRec, 기록없음: noRec });
// 6. 다른 팀 프로젝트의 기록은 쓰지 않음
await main.ev(`localStorage.setItem('seedance-vid', JSON.stringify({ ['1T:${kA}']: ['asset-other-team', Date.now()] })); 1`); await reload(); await put(A, 'kling.mp4'); await sleep(1500); const b6 = await badge(); ps = await send('VK-6');
ok('6 다른 팀 프로젝트의 기록으로는 안 나감', b6 === 'idle' && !ps.includes('asset-other-team') && ps[ps.length - 1] === id, { b6, ps });
// 7. 에셋이 지워졌으면 다시 켠 뒤에도 같은 카드로 자동 복구 · 기록도 새 것으로
await fetch(P.GW + '/__gone?id=' + id); await fakeSet({ goneAssets: [id] }); await reload(); await waitBadge('done'); ps = await send('VK-7');
ok('7 지워진 에셋이면 자동으로 다시 등록해 같은 카드로 · 기록도 새 것', ps.length === 2 && ps[0] === id && /^asset-/.test(ps[1]) && ps[1] !== id && (await rec()).includes(ps[1]) && !(await rec()).includes('"' + id + '"'), { ps, rec: await rec() });
const id2 = ps[1];
// 8. 너무 많으면 300개 · 30일 지난 것 · 깨진 것
await main.ev(`localStorage.setItem('seedance-vid', JSON.stringify(Object.fromEntries([...Array(500)].map((_, i) => ['2DT:' + (0xa00000000000 + i).toString(16), ['asset-x' + i, Date.now() - i * 1000]])))); 1`); await reload(); await put(A, 'kling.mp4'); await send('VK-8');
const r8 = await rec(); ok('8 500개여도 300개까지만 남음 · 방금 것은 남음', Object.keys(JSON.parse(r8)).length === 300 && r8.includes(kA), { n: Object.keys(JSON.parse(r8)).length, KB: +(r8.length / 1024).toFixed(1) });
await main.ev(`localStorage.setItem('seedance-vid', JSON.stringify({ ['2DT:${kA}']: ['${id2}', Date.now() - 31 * 86400000] })); 1`); await reload(); await sleep(2500);
ok('8 30일 안 쓴 것은 버림', (await badge()) === 'idle', await badge());
await main.ev(`localStorage.setItem('seedance-vid', '{broken'); 1`); await reload(); await put(A, 'kling.mp4'); ps = await send('VK-9');
ok('8 깨져 있어도 보내기는 됨', ps[ps.length - 1] === id2, ps);
const errs = JSON.parse(await main.ev('JSON.stringify(window.__errs)')).filter((e) => e !== 'rej: WebSocket closed without opened.');   // vite 개발 클라이언트(앱 아님)
ok('9 화면 오류 0', errs.length === 0, errs);
await done();
