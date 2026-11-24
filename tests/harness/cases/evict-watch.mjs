// 보관함 정리 확인을 언제 부르나(11/25 — 켤 때 한 번 + 1시간마다). 시계를 가로채 본다. 시험 앱 · 과금 없음.
import fs from 'node:fs'; import path from 'node:path';
import P from '../lib/ports.mjs'; import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 300; i++) { try { if ((await (await fetch(P.HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(P.HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
await main.send('Page.enable');
// 새로 고침 전부터: 정리 확인 호출 수 · 1분 이상 간격의 setInterval · 8초 setTimeout · 창 포커스 듣는 곳(누가 걸었는지 함수 글로)
await main.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__ev = 0; window.__iv = []; window.__w = []; const f0 = window.fetch; window.fetch = function (u) { if (String(u && u.url || u).includes('/api/bp-assets/evicted')) window.__ev++; return f0.apply(this, arguments); }; const i0 = window.setInterval; window.setInterval = function (f, ms) { if (ms >= 60000) window.__iv.push([ms, String(f).slice(0, 80)]); return i0.apply(this, arguments); }; for (const t of [window, document]) { const a0 = t.addEventListener; t.addEventListener = function (n, f) { if (n === 'focus' || n === 'visibilitychange') window.__w.push(String(f && f.handleEvent || f).slice(0, 120)); return a0.apply(this, arguments); }; }` });
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const S = M.useAppStore; ${code} })()`);
// 인증한 사진이 있는 PC 로 만든다(기록만)
const lib = JSON.parse(await main.ev(`(async () => { const U = await import('/src/lib/utils.ts'); const b = await (await fetch('data:image/png;base64,${fs.readFileSync(path.join(FIX, 'S.png')).toString('base64')}')).blob(); return JSON.stringify({ id: await U.storeLibraryImage(new File([b], 'S.png', { type: 'image/png' }), 'S.png') }); })()`)).id;
await S(`const st = S.getState(); const col = st.createCollection('W'); st.addElementAsset({ collectionId: col, category: 'character', name: 'W', description: '', images: [{ id: 'w1', libId: '${lib}', thumbnailUrl: '', bpAssets: { '2DT': { id: 'asset-w', status: 'active', at: Date.now() } } }] }); return 1;`);
await sleep(6000); await main.send('Page.reload'); await sleep(3000);
for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); }
await sleep(14000);
ok('1 켤 때 한 번 묻는다', (await main.ev('window.__ev')) === 1, await main.ev('window.__ev'));
const iv = JSON.parse(await main.ev('JSON.stringify(window.__iv)'));
ok('2 1시간 간격이 걸려 있고 10분 간격은 없다', iv.filter(([ms]) => ms === 3600000).length === 1 && !iv.some(([ms]) => ms === 600000), iv.map((x) => x[0]));
for (let i = 0; i < 6; i++) { await main.ev(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); 1`); await sleep(400); }
await sleep(62000);   // 1분 겹침 막기가 풀린 뒤에도
for (let i = 0; i < 6; i++) { await main.ev(`window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); 1`); await sleep(400); }
await sleep(2500);
ok('3 창을 들락거려도 더 묻지 않는다(1분 뒤에도)', (await main.ev('window.__ev')) === 1, await main.ev('window.__ev'));
const n = await main.ev(`(async () => { const C = await import('/src/lib/bp-certify.ts'); await C.checkEvicted(true); return window.__ev; })()`);
ok('4 확인 자체는 여전히 동작(부르면 한 번 감)', n === 2, n);
const seen = await S(`return S.getState().elementAssets.find(e => e.name === 'W')?.images[0].bpAssets['2DT'].status;`);
ok('5 멀쩡한 기록은 그대로', seen === 'active', seen);
await done();
