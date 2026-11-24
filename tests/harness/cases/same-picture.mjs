// 어디로 들어오든 화소가 전부 같은 사진이면 인증만 이어진다(파일은 그대로) — lib/same-pixels, 11/25. 사용자 "드래그앤드랍할수도 있잖아 로컬에서 변수가 많음".
// 시험 앱 · 가짜 BytePlus(모두 실사 얼굴로 막힘) · 진짜 게이트웨이 코드. 과금 없음. 준비: pix/mk.py · mk2.py
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import P from '../lib/ports.mjs'; import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const F = (f) => path.join(FIX, f);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(F(f))).digest('hex').slice(0, 12);
const M20 = 'dreamina-seedance-2-0-260128';
for (let i = 0; i < 300; i++) { try { if ((await (await fetch(P.HOOK + '/state')).json()).tray) break; } catch {} await sleep(500); }
await fetch(P.HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
const ready = async () => { for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch {} await sleep(500); } };
await ready();
const watch = () => main.ev(`window.__errs = window.__errs || []; if (!window.__w) { window.__w = 1; addEventListener('error', (e) => __errs.push('error: ' + e.message)); addEventListener('unhandledrejection', (e) => __errs.push('rej: ' + (e.reason && e.reason.message))); window.__dec = 0; const g = OffscreenCanvas.prototype.getContext; OffscreenCanvas.prototype.getContext = function (...a) { window.__dec++; return g.apply(this, a); }; } 1`);
await watch();
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
let manual = '';
for (let i = 0; i < 120 && !manual; i++) { try { manual = (await (await fetch(P.API + '/api/agent/manual')).json()).version || ''; } catch {} if (!manual) await sleep(1000); }
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(1000); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const post = async (p, b) => { const r = await fetch(P.API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { st: r.status, j: await r.json().catch(() => null) }; };
const mk = async (name, open) => (await post('/api/agent/commands', { manual, command: 'project.create', args: { name, open }, wait: 30 })).j?.result?.id;
const pid = await mk('SAME', true);
ok('프로젝트', !!pid);
const setS = (id, mode, model = M20) => S(`S.getState().updateProjectSettings('${id}', { model: '${model}', mode: '${mode}', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); return 1;`);
await setS(pid, 'multimodal_reference'); await S(`S.getState().setCurrentProjectId('${pid}'); return 1;`);
const fakeSet = (o) => fetch(P.FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
await fakeSet({ faceKeys: ['http'], goneAssets: [], copyrightKeys: [] });
const clear = (id = pid) => S(`S.getState().replaceAllAssets('${id}', []); return 1;`);
const assets = (id = pid) => S(`return JSON.stringify(S.getState().projects.find(p => p.id === '${id}').assets.map(a => ({ n: a.file_name, k: (a.cacheId || '').slice(0, 12), role: a.role })));`).then(JSON.parse);
const lib = () => S(`return JSON.stringify(S.getState().elementAssets.map(e => e.name));`).then(JSON.parse);
const creates = async () => (await (await fetch(P.GW + '/__stats')).json()).stats.CreateAsset || 0;
const made = async () => (await (await fetch(P.GW + '/__stats')).json()).assets;
const assetOf = (name) => S(`const e = S.getState().elementAssets.find(e => e.name === '${name}'); return e ? (Object.values(e.images[0].bpAssets || {})[0]?.id || '') : '';`);
const row = (i) => `[...document.querySelectorAll('div')].filter((d) => String(d.className).includes('rounded-[11px]') && d.textContent.includes('[Image ${i}]'))[0]`;
const badge = (i = 1) => main.ev(`(() => { const r = ${row(i)}; return r?.querySelector('[data-bp-ref-state]')?.getAttribute('data-bp-ref-state') || (r?.querySelector('[data-bp-register-ref]') ? 'idle' : 'none'); })()`);
const waitBadge = async (want, i = 1, ms = 6000) => { let b; for (let t = 0; t < ms; t += 150) { b = await badge(i); if (b === want) return b; await sleep(150); } return b; };
const type = (f) => 'image/' + f.split('.').pop().replace('jpg', 'jpeg');
const b64 = (f) => fs.readFileSync(F(f)).toString('base64');
const fileJs = (f, as) => `new File([await (await fetch('data:${type(f)};base64,${b64(f)}')).blob()], '${as}', { type: '${type(f)}' })`;
const changed = async (n0) => { for (let i = 0; i < 80; i++) { const a = await assets(); if (a.map((x) => x.k).join() !== n0) return a; await sleep(150); } return assets(); };
const keys = async () => (await assets()).map((x) => x.k).join();
// 진짜 이벤트로: 레퍼런스 칸에 끌어다 놓기 · 파일 고르기 · 프롬프트에 붙여넣기 · 칸 위에 놓아 바꾸기(↻)
const label = `[...document.querySelectorAll('label')].find(l => { const i = l.querySelector('input[type=file]'); return i && i.multiple && /image/.test(i.accept || '') && l.getBoundingClientRect().width > 0; })`;
const target = async () => { for (let i = 0; i < 40; i++) { if (await main.ev(`!!${label}`)) return; await sleep(200); } console.log('  (놓을 자리 없음) ' + await S(`const s = S.getState(), p = s.projects.find(x => x.id === s.currentProjectId); return JSON.stringify({ cur: p?.name, mode: p?.settings.mode, model: p?.settings.model, n: p?.assets.length });`) + ' ' + await main.ev(`JSON.stringify([...document.querySelectorAll('label')].filter(l => l.querySelector('input[type=file]')).map(l => [l.querySelector('input').accept, l.querySelector('input').multiple, Math.round(l.getBoundingClientRect().width)]))`)); };
const drop = async (f, as) => { await target(); const k = await keys(); await main.ev(`(async () => { const dt = new DataTransfer(); dt.items.add(${fileJs(f, as)}); const t = ${label}; for (const ty of ['dragenter', 'dragover', 'drop']) t.dispatchEvent(new DragEvent(ty, { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`); return changed(k); };
const pick = async (f, as) => { await target(); const k = await keys(); await main.ev(`(async () => { const dt = new DataTransfer(); dt.items.add(${fileJs(f, as)}); const i = ${label}.querySelector('input[type=file]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); return changed(k); };
const replace = async (i, f, as) => { const k = await keys(); await main.ev(`(async () => { const dt = new DataTransfer(); dt.items.add(${fileJs(f, as)}); ${row(i)}.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return 1; })()`); return changed(k); };
const paste = async (f, recode) => { const k = await keys(); await main.ev(`(async () => { let b = await (await fetch('data:${type(f)};base64,${b64(f)}')).blob(); if (${!!recode}) { const bm = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0); b = await new Promise((r) => c.toBlob(r, 'image/png')); } const dt = new DataTransfer(); dt.items.add(new File([b], 'image.png', { type: 'image/png' })); [...document.querySelectorAll('[contenteditable="true"]')].find((x) => x.getBoundingClientRect().width > 0).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return 1; })()`); return changed(k); };
const cache = async (f, as) => (await (await fetch(P.API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(as) }, body: fs.readFileSync(F(f)) })).json()).cacheId;
const put = async (f, as, role = 'reference_image', id = pid) => { const c = await cache(f, as); await S(`S.getState().addAsset('${id}', { type: 'image_url', url: '', role: '${role}', file_name: '${as}', cacheId: '${c}', thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`); };
const card = (tag, id = pid) => S(`const m = S.getState().projects.find(x => x.id === '${id}').messages.filter(m => m.role === 'system' && (m.promptText || '').includes('${tag}')).pop(); return JSON.stringify(m ? { id: m.id, task: !!m.taskId, st: m.status, err: (m.error || '').slice(0, 200) } : null);`).then(JSON.parse);
const send = async (tag, id = pid, ms = 150000) => {
  await S(`const pr = S.getState().projects.find(x => x.id === '${id}'); await R.sendRequest({ projectId: '${id}', promptHtml: '${tag} 천천히', settings: pr.settings, assets: pr.assets }, { warn: () => {} }); return 1;`);
  for (let t = 0; t < ms; t += 600) { const c = await card(tag, id); if (c && (c.task || c.st === 'failed')) break; await sleep(600); }
  return posts(tag);
};
const posts = async (tag) => (await (await fetch(P.FAKE + '/__seen')).json()).filter((x) => JSON.stringify(x).includes(tag)).map((x) => (x.content || []).filter((c) => c.type === 'image_url').map((c) => (c.image_url.url.startsWith('asset://') ? c.image_url.url.slice(8) : 'UPLOAD')));
const register = async (f, as) => { await clear(); await put(f, as); await sleep(800); await main.ev(`${row(1)}.querySelector('[data-bp-register-ref]').click(); 1`); return waitBadge('done', 1, 150000); };

// 1. 등록한 것이 없으면 사진을 풀지 않는다
await clear(); await drop('A_meta.png', '먼저.png'); await sleep(1500);
ok('1 등록한 사진이 없으면 아무것도 안 함(사진을 풀지 않음)', (await badge()) === 'idle' && (await main.ev('window.__dec')) === 0, { b: await badge(), dec: await main.ev('window.__dec') });

// 2. A 등록 → 다시 저장된 A 를 여러 길로
ok('2 A 등록', (await register('A.png', 'intern.png')) === 'done');
const idA = await assetOf('intern');
const c0 = await creates(), l0 = (await lib()).join();
for (const [why, fn, name, k] of [
  ['끌어다 놓기', () => drop('A_meta.png', '최종_진짜최종.png'), '최종_진짜최종.png', md5('A_meta.png')],
  ['파일 고르기', () => pick('A_meta2.png', '고른 파일.png'), '고른 파일.png', md5('A_meta2.png')],
  ['붙여넣기(다시 포장)', () => paste('A.png', true), null, null],
]) {
  await clear(); const a = await fn(); const b = await waitBadge('done');
  ok(`2 ${why} — 파일은 넣은 그대로 · 인증만 이어짐`, a.length === 1 && b === 'done' && (name ? a[0].n === name && a[0].k === k : /^clipboard-/.test(a[0].n) && a[0].k !== md5('A.png')), { a, b });
}
await clear(); await drop('B.png', '다른.png'); let a = await replace(1, 'A_meta.png', '바꾼 것.png');
ok('2 ↻ 바꾸기 — 이름은 바꾼 파일 · 인증', a.length === 1 && a[0].n === '바꾼 것.png' && (await waitBadge('done')) === 'done', { a, b: await badge() });
let ps = await send('SM-2');
ok('2 보내면 막히지 않고 A 의 에셋 · 새 등록 0 · 카드 그대로', JSON.stringify(ps) === JSON.stringify([[idA]]) && (await creates()) === c0 && (await lib()).join() === l0, { ps, idA, made: (await creates()) - c0, lib: await lib() });

// 3. 재사용 — 파일은 그 파일, 인증도 이어짐
const c2 = await card('SM-2'); await clear();
await main.ev(`document.querySelector('#msg-${c2.id} button[title="프롬프트 재사용"]')?.click(); 1`); await sleep(1500);
a = await assets();
ok('3 재사용 — 넣었던 파일 그대로 되살고 인증', a.length === 1 && a[0].k === md5('A_meta.png') && (await waitBadge('done')) === 'done', { a, b: await badge() });

// 4. 조금이라도 다르거나 움직이는 그림이면 이어지지 않음
for (const [f, why] of [['A_1px.png', '점 1개'], ['A_bright.png', '밝기 0.5%'], ['A_jpg.png', 'JPG 로 다시 저장'], ['A.jpg', 'JPG 파일'], ['A_resize.png', '줄였다 되돌림'], ...(fs.existsSync(F('A_icc.png')) ? [['A_icc.png', '색 프로필만']] : []), ['B.png', '크기만 같은 다른 사진'], ['C.png', '크기가 다른 사진']]) {
  await clear(); a = await drop(f, 'intern' + path.extname(f)); await sleep(1300);
  ok(`4 ${why}(원본과 같은 이름) — 이어지지 않음`, a.length === 1 && a[0].k === md5(f) && (await badge()) === 'idle', { a, b: await badge() });
}

if (!fs.existsSync(F('A_icc.png'))) skip('4 색 프로필만', '이 PC 에 AdobeRGB1998.icc 가 없어 사진을 못 만듦');
// 5. 화면에 안 떠 있는 프로젝트에서 보내기 · 에이전트 경로
const pid2 = await mk('SAME-2', false); await setS(pid2, 'multimodal_reference'); await put('A_meta3.png', '안 보이는.png', 'reference_image', pid2);
ps = await send('SM-5', pid2);
ok('5 화면에 없는 프로젝트에서 보내도 바로 에셋', JSON.stringify(ps) === JSON.stringify([[idA]]) && (await creates()) === c0, ps);
const job = await post('/api/agent/jobs', { manual, projectId: pid2, prompt: 'SM-6 천천히', refs: [{ path: F('A_meta2.png') }], settings: { model: M20, mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5 } });
for (let i = 0; i < 60 && !(await posts('SM-6')).length; i++) await sleep(500);
ps = await posts('SM-6');
ok('5 에이전트가 경로로 넘겨도 바로 에셋', JSON.stringify(ps) === JSON.stringify([[idA]]) && (await creates()) === c0, { st: job.st, err: job.j?.error, ps });

// 6. 첫 · 끝 프레임(끝은 다른 사진 → 그것만 막혀 인증) · 역할과 순서 그대로
await clear(); await setS(pid, 'image_to_video_first_last'); await put('A_meta.png', '첫.png', 'first_frame'); await put('B.png', '끝.png', 'last_frame'); await sleep(800);
ps = await send('SM-7'); const idB = await assetOf('끝');
ok('6 첫/끝 — 첫 칸은 처음부터 A 에셋, 끝 칸만 막혀 인증', ps.length === 2 && JSON.stringify(ps[0]) === JSON.stringify([idA, 'UPLOAD']) && JSON.stringify(ps[1]) === JSON.stringify([idA, idB]) && !!idB && (await creates()) === c0 + 1, { ps, idA, idB });
await clear(); await setS(pid, 'multimodal_reference'); await sleep(500);

// 7. 먼저 넣어 둔 사진 — 나중에 같은 그림이 등록되면 저절로 인증
await drop('S_still.webp', '먼저 넣음.webp'); await sleep(900); const b7 = await badge(1);
await put('S.png', 'small.png'); await sleep(700); await main.ev(`${row(2)}.querySelector('[data-bp-register-ref]').click(); 1`); await waitBadge('done', 2, 150000);
ok('7 먼저 넣어 둔 webp 가 같은 그림 png 등록 뒤 저절로 인증', b7 === 'idle' && (await waitBadge('done', 1, 8000)) === 'done', { before: b7, after: await badge(1) });
for (const [f, why] of [['S_anim.png', '움직이는 PNG(첫 장면만 같음)'], ['S_anim.webp', '움직이는 webp'], ['S.gif', 'gif']]) {
  await clear(); await put(f, f); await sleep(1600);
  ok(`7 ${why} — 이어지지 않음`, (await badge()) === 'idle', await badge());
}

// 8. 앱을 다시 켜도(새로 고침) 이어짐 · 다시 풀지 않음
await clear(); await drop('A_meta.png', '다시켜기.png'); await waitBadge('done'); await sleep(1500);
await main.send('Page.reload'); await sleep(3500); await ready(); await watch();
await S(`S.getState().setCurrentProjectId('${pid}'); return 1;`); await sleep(1500);
ok('8 다시 켜도(적어 둔 것 없이) 인증이 이어짐', (await waitBadge('done', 1, 15000)) === 'done', { b: await badge(), dec: await main.ev('window.__dec') });
const left = await main.ev(`JSON.stringify(Object.keys(localStorage).filter((k) => /px|pixel|same/i.test(k) || /\\d+x\\d+:[0-9a-f]{32}/.test(localStorage.getItem(k) || '')))`);
ok('8 이 PC 에 화소 지문이 남지 않음', left === '[]', left);

// 9. 배지를 바로 눌러도(확인이 끝나기 전) 새 등록 없음
await clear(); const c9 = await creates(), l9 = (await lib()).join();
await S(`const C = await import('/src/lib/bp-certify.ts'); const c = '${await cache('A_meta4.png', '바로.png')}'; await C.certifyPhoto({ cacheId: c, file_name: '바로.png' }); return 1;`);
ok('9 바로 인증을 눌러도 새 등록 0 · 새 카드 0', (await creates()) === c9 && (await lib()).join() === l9, { made: (await creates()) - c9, lib: await lib() });

// 10. A 의 에셋이 BytePlus 에서 지워짐 → 다시 저장된 사진으로 보내도 A 를 다시 등록해 같은 카드로
await clear(); await drop('A_meta.png', '지워진 뒤.png'); await waitBadge('done'); const idOld = await assetOf('intern');
await fetch(P.GW + '/__gone?id=' + idOld); await fakeSet({ goneAssets: [idOld] });
ps = await send('SM-10', pid, 200000); const cd = await card('SM-10'), idNew = await assetOf('intern');
ok('10 지워졌으면 A 를 다시 등록해 같은 카드로(잘못된 "지워졌어요" 실패 없음)', cd.task && ps.length === 2 && ps[0][0] === idOld && ps[1][0] === idNew && idNew !== idOld && (await lib()).join() === l9, { ps, idOld, idNew, cd, lib: await lib() });

// 11. 카드를 지우면 이어질 데가 없으니 새로 등록(실패 없이)
await S(`S.getState().elementAssets.filter(e => e.name === 'intern').forEach(e => S.getState().deleteElementAsset(e.id)); return 1;`); await clear(); await drop('A_meta.png', '새 카드.png'); await sleep(1300);
const b11 = await badge(), c11 = await creates(), n11 = await made(); ps = await send('SM-11', pid, 200000);
ok('11 카드를 지운 뒤엔 새로 인증', b11 === 'idle' && (await card('SM-11')).task && ps.length === 2 && (await made()) === n11 + 1 && (await lib()).includes('새 카드'), { b11, ps, cd: await card('SM-11'), 부른횟수: (await creates()) - c11, 생긴에셋: (await made()) - n11, lib: await lib() });

// 12. 카드를 지우고 새로 등록한 카드에도 다시 이어짐
await clear(); await drop('A_meta2.png', '다시 이어짐.png');
ok('12 새로 등록한 카드에도 이어짐(지운 카드에 묶여 있지 않음)', (await waitBadge('done', 1, 8000)) === 'done', await badge());
const errs = JSON.parse(await main.ev('JSON.stringify(window.__errs)'));
ok('13 화면 오류 0', errs.length === 0, errs);
await done();
