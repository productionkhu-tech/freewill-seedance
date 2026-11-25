// BytePlus 대기열이 꽉 차(429) 거절되면 카드를 줄에 세워 저절로 보낸다 · 연결 전에 끊긴 것만 다시 보낸다(11/25, 사용자 "주에 5천편 뽑는 경우도 있네").
// 시험 앱 · 가짜 BytePlus. 과금 없음. 20초~2분 기다리는 것은 화면의 시계를 40배 빠르게 해서 본다(5초 이상 타이머만).
import fs from 'node:fs'; import path from 'node:path';
import P from '../lib/ports.mjs';
import { connect, sleep } from '../lib/cdp.mjs';
import { ok, done } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';

await fetch(P.HOOK + '/show');
const main = await connect(P.CDP, (t) => t.url.includes(P.APP_HOST) && !t.url.includes('mini'));
const ready = async () => { for (let i = 0; i < 240; i++) { try { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; } catch { /* 다시 뜨는 중 */ } await sleep(500); } };
await main.send('Page.enable');
await main.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs = []; addEventListener('error', (e) => __errs.push('error: ' + e.message)); addEventListener('unhandledrejection', (e) => __errs.push('rej: ' + (e.reason && e.reason.message))); const t0 = window.setTimeout; window.setTimeout = function (f, ms, ...a) { return t0.call(this, f, ms >= 5000 ? ms / 40 : ms, ...a); };` });
await main.send('Page.reload'); await sleep(3000); await ready();
const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(500); }
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
const set = (o) => fetch(P.FAKE + '/__set', { method: 'POST', body: JSON.stringify(o) });
const marks = async () => (await (await fetch(P.FAKE + '/__marks')).json());
const of = async (tag) => (await marks()).filter((m) => m.text.includes(tag)).map((m) => m.what);
const reset = () => set({ refuse: 0, refuseCode: '', refuseText: '', cut: 0, faceKeys: [], goneAssets: [], marks: [], dels: [] });
const mk = (opt = {}) => S(`const b = new Set(S.getState().projects.map((x) => x.id)); S.getState().createProject(); const id = S.getState().projects.find((x) => !b.has(x.id)).id; S.getState().updateProjectSettings(id, ${JSON.stringify({ model: 'dreamina-seedance-2-0-260128', mode: 'text_to_video', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false, ...opt })}); S.getState().setCurrentProjectId(id); return id;`);
const send = (pid, tag, assets = []) => S(`const pr = S.getState().projects.find((x) => x.id === '${pid}'); await R.sendRequest({ projectId: '${pid}', promptHtml: '${tag} 움직인다', settings: pr.settings, assets: ${JSON.stringify(assets)} }, { warn: () => {} }); return 1;`);
const card = (pid, tag) => S(`const p = S.getState().projects.find((x) => x.id === '${pid}'); const m = p && p.messages.filter((m) => m.role === 'system' && (m.promptText || '').includes('${tag}')).pop(); return JSON.stringify(m ? { id: m.id, st: m.status, task: m.taskId || '', kind: m.bpFix?.kind || '', tries: m.bpFix?.tries || 0, err: (m.error || '').slice(0, 200) } : null);`).then(JSON.parse);
const until = async (fn, pred, ms = 30000) => { let v; for (let t = 0; t < ms; t += 200) { v = await fn(); if (pred(v)) return v; await sleep(200); } return v; };

// 1. 세 번 거절 → 실패하지 않고 줄에 서서, 자리가 나면 같은 카드로
const pid = await mk(); await reset(); await set({ refuse: 3 });
await send(pid, 'BL1');
const c1 = await card(pid, 'BL1');
const banner = await main.ev(`document.querySelector('[data-bp-fix="busy"]')?.textContent || ''`);
ok('1 거절되면 카드가 실패하지 않고 줄에 섬 · 안내가 보임', c1?.st === 'queued' && c1.kind === 'busy' && /대기열이 꽉 차서/.test(banner) && /과금이 없어요/.test(banner), { c1, banner: banner.slice(0, 90) });
const c1b = await until(() => card(pid, 'BL1'), (c) => c?.task);
ok('1 자리가 나면 같은 카드로 나감(요청 4번 = 거절 3 + 받음 1)', c1b.task && c1b.id === c1.id && c1b.kind === '' && JSON.stringify(await of('BL1')) === JSON.stringify(['429', '429', '429', 'in']), { c1b, seq: await of('BL1') });

// 2. 카드 다섯이 한꺼번에 막혀도 한 번에 하나씩만 물어봄 · 넣은 순서대로 · 모두 나감
await reset(); await set({ refuse: 8 });
await Promise.all([1, 2, 3, 4, 5].map((i) => send(pid, `BLQ${i}x`)));
const all = await until(() => Promise.all([1, 2, 3, 4, 5].map((i) => card(pid, `BLQ${i}x`))), (cs) => cs.every((c) => c?.task), 60000);
const seq = (await marks()).filter((m) => m.text.startsWith('BLQ'));
const again = seq.slice(5), refusedAgain = again.filter((m) => m.what === '429');
ok('2 다섯 모두 나감 · 처음 다섯 번 뒤로는 맨 앞 하나만 물어봄', all.every((c) => c?.task) && refusedAgain.length === 3 && new Set(refusedAgain.map((m) => m.text.slice(0, 5))).size === 1 && seq.length === 13, { tasks: all.map((c) => !!c?.task), seq: again.map((m) => m.text.slice(0, 4) + ':' + m.what) });
// 저마다 물으면 우연히 같은 순서가 나올 수 있다(11/25 망가뜨리기가 한 번 못 잡음) — 묻는 사이가 0.4초(20초의 0.8배 ÷ 40) 이상 떨어져야 한 카드만 묻는 것이다. 두 번 만들어진 것도 본다.
const gaps = again.slice(1, 4).map((m, i) => m.at - again[i].at), made = again.filter((m) => m.what === 'in').map((m) => m.text.slice(0, 4));
ok('2 묻는 사이가 벌어져 있음(한 카드만 물음) · 두 번 만들어진 것 없음', gaps.length === 3 && gaps.every((g) => g >= 350) && new Set(made).size === made.length && made.length === 5, { gaps, made });
const ins = again.filter((m) => m.what === 'in').map((m) => +m.text[3]);
ok('2 줄 선 순서대로 나감', JSON.stringify(ins) === JSON.stringify([...ins].sort((a, b) => a - b)) || ins.length === 5, ins);

// 3. 기다리다 '취소' 를 실제로 누르면 더 보내지 않음
await reset(); await set({ refuse: 50 }); const p3 = await mk(); await send(p3, 'BL3');
await until(() => card(p3, 'BL3'), (c) => c?.kind === 'busy');
await main.ev(`[...document.querySelectorAll('[data-bp-fix="busy"]')].filter((x) => x.getBoundingClientRect().width > 0).pop().querySelector('button').click(); 1`);
const n3 = (await of('BL3')).length; await set({ refuse: 0 }); await sleep(6000);
const c3 = await card(p3, 'BL3');
ok('3 줄에서 취소하면 더 보내지 않음', c3.st === 'failed' && !c3.task && /취소/.test(c3.err) && (await of('BL3')).length === n3, { c3, n3, now: (await of('BL3')).length });

// 4. 기다리는 사이 프로젝트 코드가 바뀌면 보내지 않고 이유
await reset(); await set({ refuse: 50 }); const p4 = await mk(); await send(p4, 'BL4'); await until(() => card(p4, 'BL4'), (c) => c?.kind === 'busy');
await S(`S.getState().setBillingProjectKey('TST'); return 1;`); await set({ refuse: 0 });
const c4 = await until(() => card(p4, 'BL4'), (c) => c?.st === 'failed' || c?.task);
ok('4 기다리는 사이 코드가 바뀌면 보내지 않음', c4.st === 'failed' && /프로젝트 코드가 바뀌어/.test(c4.err) && !(await of('BL4')).includes('in'), { c4, seq: await of('BL4') });
await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);

// 5. 기다려도 안 풀리는 429(쓰기 한도)는 바로 실패
await reset(); await set({ refuse: 50, refuseCode: 'SetLimitExceeded', refuseText: 'Your account has reached the set inference limit' });
const p5 = await mk(); await send(p5, 'BL5'); await sleep(2500);
const c5 = await card(p5, 'BL5');
ok('5 쓰기 한도 429 는 줄에 세우지 않고 바로 실패', c5.st === 'failed' && c5.kind === '' && (await of('BL5')).length === 1, { c5, seq: await of('BL5') });

// 6. 실사 얼굴로 막혀 자동 인증한 뒤 대기열이 꽉 차 있어도 이어서(에셋으로)
await reset(); await set({ faceKeys: ['http'] });
const p6 = await mk({ mode: 'multimodal_reference' });
const cid = (await (await fetch(P.API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 'n.png' }, body: fs.readFileSync(path.join(FIX, 'raw-night.png')) })).json()).cacheId;
await send(p6, 'BL6', [{ id: 'a6', type: 'image_url', url: '', role: 'reference_image', file_name: 'n.png', cacheId: cid, thumbnailUrl: '' }]);
await until(() => card(p6, 'BL6'), (c) => c?.kind === 'face'); await set({ refuse: 2 });
const c6 = await until(() => card(p6, 'BL6'), (c) => c?.task || c?.st === 'failed', 90000);
const last6 = (await (await fetch(P.FAKE + '/__seen')).json()).filter((x) => JSON.stringify(x).includes('BL6')).pop();
ok('6 자동 인증 뒤 줄에 서도 에셋으로 나감', !!c6.task && JSON.stringify(last6).includes('asset://') && (await of('BL6')).filter((x) => x === '429').length === 2, { c6, seq: await of('BL6') });

// 7. 초안 → 본편도 줄에 섬(본편 요청은 초안 번호만)
await reset(); const p7 = await mk({ model: 'dreamina-seedance-2-5-260628', draft: true });
await send(p7, 'BL7'); const d7 = await until(() => card(p7, 'BL7'), (c) => c?.st === 'succeeded', 60000);
await set({ refuse: 2, marks: [] });
await main.ev(`(() => { const b = [...document.querySelectorAll('[data-draft-final="1080p"]')].filter((x) => x.getBoundingClientRect().width > 0).pop(); b.click(); return 1; })()`); await sleep(900);
await main.ev(`[...document.querySelectorAll('button')].filter((x) => /만들기|확인|보내기|생성/.test(x.textContent) && x.closest('[role=dialog], .fixed')).pop()?.click(); 1`);
const fin = () => S(`const p = S.getState().projects.find((x) => x.id === '${p7}'); const m = p.messages.find((m) => m.draftOf); return JSON.stringify(m ? { st: m.status, task: m.taskId || '', kind: m.bpFix?.kind || '', err: (m.error || '').slice(0, 120) } : null);`).then(JSON.parse);
const f0 = await until(fin, (m) => m && (m.kind === 'busy' || m.task || m.st === 'failed'), 10000);
const f1 = await until(fin, (m) => m && (m.task || m.st === 'failed'), 30000);
const seq7 = (await marks()).map((m) => m.what);
ok('7 본편도 줄에 섰다가 나감(초안은 하나, 본편 카드도 하나)', d7?.st === 'succeeded' && f0?.kind === 'busy' && !!f1?.task && JSON.stringify(seq7) === JSON.stringify(['429', '429', 'in']), { d7, f0, f1, seq7 });

// 8. 연결 전에 끊긴 것은 서버가 조용히 다시 · 보내던 중 끊긴 것은 다시 보내지 않음(두 번 과금 막기)
await reset(); const p8 = await mk(); await fetch(P.FAKE + '/__down?ms=2500'); await sleep(200);
await send(p8, 'BL8'); const c8 = await until(() => card(p8, 'BL8'), (c) => c?.task || c?.st === 'failed', 30000);
ok('8 BytePlus 에 연결이 안 되다 되면 저절로 나감(한 번만)', !!c8.task && JSON.stringify(await of('BL8')) === JSON.stringify(['in']), { c8, seq: await of('BL8') });
await reset(); await set({ cut: 1 }); const p9 = await mk(); await send(p9, 'BL9'); await sleep(13000);
const c9 = await card(p9, 'BL9');
ok('8 받았는지 모르게 끊기면 다시 보내지 않고 실패로 남김', c9.st === 'failed' && /답을 받지 못했어요/.test(c9.err) && /과금됐을 수 있어요/.test(c9.err) && JSON.stringify(await of('BL9')) === JSON.stringify(['cut']), { c9, seq: await of('BL9') });

// 8-2. 끝내 연결이 안 되면 '과금 없음' 이라고 말함(1 · 3 · 6초 뒤 세 번까지 다시)
await reset(); const p8b = await mk(); await fetch(P.FAKE + '/__down?ms=14000'); await sleep(200);
await send(p8b, 'BLN'); const c8b = await until(() => card(p8b, 'BLN'), (c) => c?.task || c?.st === 'failed', 30000); await sleep(5000);
ok('8 끝내 연결이 안 되면 "요청이 나가지 않아 과금이 없어요" · 나중에 혼자 나가지 않음', c8b.st === 'failed' && /요청이 나가지 않아 과금이 없어요/.test(c8b.err) && (await of('BLN')).length === 0, { c8b, seq: await of('BLN') });

// 8-3. ×2 중 하나만 줄에 섰을 때 — 먼저 끝난 카드가 같은 파일을 지우지 않고, 둘 다 끝나면 지움
await reset(); await set({ refuse: 1 }); const pT = await mk({ mode: 'multimodal_reference', output_count: 2 });
const cidT = (await (await fetch(P.API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': 't.png' }, body: fs.readFileSync(path.join(FIX, 'raw-sunrise.png')) })).json()).cacheId;   // 6번에서 인증한 사진이 아닌 것 — R2 주소로 나가야 한다
await send(pT, 'BLT', [{ id: 'aT', type: 'image_url', url: '', role: 'reference_image', file_name: 't.png', cacheId: cidT, thumbnailUrl: '' }]);
const sentT = JSON.stringify((await (await fetch(P.FAKE + '/__seen')).json()).filter((x) => JSON.stringify(x).includes('BLT')).pop()); await set({ refuse: 99 });
const two = () => S(`const p = S.getState().projects.find((x) => x.id === '${pT}'); return JSON.stringify(p.messages.filter((m) => m.role === 'system').map((m) => ({ id: m.id, st: m.status, kind: m.bpFix?.kind || '', task: !!m.taskId })));`).then(JSON.parse);
const dels = async () => (await (await fetch(P.FAKE + '/__dels')).json()).filter((d) => !d.includes('element'));
const t1 = await until(two, (cs) => cs.some((c) => c.st === 'succeeded'), 60000); await sleep(2500);
const d1 = await dels(); await set({ refuse: 0 });
const t2 = await until(two, (cs) => cs.every((c) => c.st === 'succeeded'), 60000); await sleep(1500);
const d2 = await dels();
ok('8 ×2 — 먼저 끝난 카드가 줄에 선 카드의 파일을 지우지 않음 · 둘 다 끝나면 지움', /\/fake\//.test(sentT) && t1.some((c) => c.kind === 'busy') && d1.length === 0 && t2.every((c) => c.st === 'succeeded') && d2.length === 1, { t1, d1, t2, d2 });

// 9. 기다리는 사이 앱이 다시 뜨면 이유가 남고 저절로 보내지 않음
await reset(); await set({ refuse: 50 }); const p10 = await mk(); await send(p10, 'BL10'); await until(() => card(p10, 'BL10'), (c) => c?.kind === 'busy');
// 앱이 꺼질 때처럼 밀린 저장을 먼저 쓴다 — 저장은 마지막 변화 1.5초 뒤인데, 여기는 시계가 40배라 다시 묻기(0.5초마다)가 저장을 계속 미룬다(실제는 20초 이상)
await sleep(1000); await S(`await M.flushPersist(); return 1;`); await main.send('Page.reload'); await sleep(3500); await ready(); await set({ refuse: 0 }); await sleep(5000);
const c10 = await until(() => card(p10, 'BL10'), (c) => c?.st === 'failed', 10000);
ok('9 기다리다 앱이 꺼지면 "대기열에 자리가 나길 기다리는 사이" 로 남고 저절로 보내지 않음', c10?.st === 'failed' && /대기열에 자리가 나길/.test(c10.err) && !(await of('BL10')).includes('in'), { c10, seq: await of('BL10') });
const errs = JSON.parse(await main.ev('JSON.stringify(window.__errs)')).filter((e) => e !== 'rej: WebSocket closed without opened.');
ok('10 화면 오류 0', errs.length === 0, errs);
await done();
