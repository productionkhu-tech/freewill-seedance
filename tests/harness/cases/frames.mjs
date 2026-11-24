// 프레임 · 패널 칸의 '인증 완료' 사진 → 에셋 격리 시험(11/24) — 시험 앱(3958) → 서버 → 가짜 BytePlus(3946) · 진짜 게이트웨이 코드(3947). 과금 없음.
// 사용자 11/24: "2장씩 넣었을 때나 중간에 삭제하고 넣었을 때 등등 신경쓸게 많긴 하네".
// 실측(진짜 BytePlus, 11/24): 에셋은 첫 · 끝 프레임으로 받는다 · BytePlus 는 role 보다 '항목 순서' 로 첫 프레임을 정한다(사진 · 에셋 모두).
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = path.join(FIX, 'ai-character.png');          // 인증할 사진 1
const Bp = path.join(FIX, 'ai-character-close.png');   // 인증할 사진 2
const X = path.join(FIX, 'raw-sunrise.png');           // 인증 안 한 사진

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

// ── 준비: 프로젝트 · 인물 둘(A · B) 등록 → 인증 완료 ──
const pid = (await cmd('project.create', { name: 'FRAMES ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
await cmd('collection.create', { name: '프레임시험' });
await cmd('collection.bind', { collection: '프레임시험', projectId: pid });
const add = await cmd('elements.add', { collection: '프레임시험', items: [{ name: 'F_A', category: 'character', images: [A] }, { name: 'F_B', category: 'character', images: [Bp] }] });
ok('인물 둘', add?.status === 'done', add?.error);
const ids = JSON.parse(await S(`return JSON.stringify(Object.fromEntries(S.getState().elementAssets.filter(a => ['F_A','F_B'].includes(a.name)).map(a => [a.name, a.id])));`));
for (const n of ['F_A', 'F_B']) await S(`return JSON.stringify(await B.registerElement(${JSON.stringify(ids[n])}));`);
const assetOf = async (n) => { for (let i = 0; i < 40; i++) { const e = JSON.parse(await S(`const a = S.getState().elementAssets.find(x => x.id === ${JSON.stringify(ids[n])}); return JSON.stringify(a.images[0].bpAssets?.['2DT'] || null);`)); if (e?.status === 'active') return e.id; await sleep(1500); } return null; };
const idA = await assetOf('F_A'), idB = await assetOf('F_B');
ok('A · B 인증 완료', !!idA && !!idB, { idA, idB });

// 패널에 넣기 — 화면이 넣는 것과 같은 모양(캐시에 원본을 넣고 cacheId · 썸네일 · 역할)
const cacheOf = async (f) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(path.basename(f)) }, body: fs.readFileSync(f) })).json()).cacheId;
const cA = await cacheOf(A), cB = await cacheOf(Bp), cX = await cacheOf(X);
const panelAdd = (cacheId, role, name) => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: 'image_url', url: '', role: ${JSON.stringify(role)}, file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
const panelRemove = (name) => S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); const a = p.assets.find(a => a.file_name === ${JSON.stringify(name)}); S.getState().removeAsset(p.id, a.id); return 1;`);
const order = () => S(`return JSON.stringify(S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}).assets.map(a => a.file_name + ':' + a.role));`).then(JSON.parse);
const setMode = (mode, model = 'dreamina-seedance-2-0-260128') => S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: ${JSON.stringify(model)}, mode: ${JSON.stringify(mode)}, ratio: 'adaptive', resolution: '480p', duration: 5, output_count: 1, draft: false }); return 1;`);
// 화면의 보내기와 같은 함수(sendRequest) — 그 프로젝트의 지금 설정 · 레퍼런스로
async function send(tag) {
  const seen0 = (await (await fetch(FAKE + '/__seen')).json()).length;
  const warns = JSON.parse(await S(`const w = []; const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: p.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: p.settings, assets: p.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`));
  let sent = null; for (let i = 0; i < 30 && !sent && !warns.length; i++) { await sleep(500); sent = (await (await fetch(FAKE + '/__seen')).json()).slice(seen0).find((x) => JSON.stringify(x).includes(tag)); }
  const imgs = (sent?.content || []).filter((c) => c.type === 'image_url').map((c) => ({ u: c.image_url.url.startsWith('asset://') ? c.image_url.url : c.image_url.url.startsWith('http') ? 'UPLOAD' : c.image_url.url, r: c.role ?? '-' }));
  const card = JSON.parse(await S(`const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); const m = [...p.messages].reverse().find(m => (m.promptText || '').includes(${JSON.stringify(tag)})); return JSON.stringify(m ? { refs: m.bpAssetRefs || 0, used: (m.usedAssets || []).map(a => a.file_name + ':' + a.role + ':' + (String(a.url).startsWith('asset://') ? 'ASSET' : 'thumb')), err: m.error || '' } : null);`));
  return { warns, imgs, card };
}
const fmt = (imgs) => imgs.map((i) => `${i.u === `asset://${idA}` ? 'A' : i.u === `asset://${idB}` ? 'B' : i.u}/${i.r}`).join(' ');

// ── 1. 첫 · 끝: 첫 = 인증 A · 끝 = 인증 안 한 X ──
await setMode('image_to_video_first_last'); await panelClear();
await panelAdd(cA, 'first_frame', 'A.png'); await panelAdd(cX, 'last_frame', 'X.png');
let r = await send('PT-F1');
ok('1 첫 = A 에셋 · 끝 = X 사진 올림(섞어 넣기)', fmt(r.imgs) === 'A/first_frame UPLOAD/last_frame', { got: fmt(r.imgs), warns: r.warns });
ok('1 카드: 에셋 1개 기록 · 썸네일은 사진(재사용에 asset 주소가 안 섞임)', r.card?.refs === 1 && r.card.used.every((u) => u.endsWith(':thumb')), r.card);

// ── 2. 첫 프레임 칸을 지웠다 다시 넣음 → 스토어 순서 [끝, 첫] → 보낼 때는 첫 프레임이 먼저 ──
await panelRemove('A.png'); await panelAdd(cA, 'first_frame', 'A.png');
const ord = await order();
r = await send('PT-F2');
ok('2 지웠다 다시 넣어 스토어는 [끝, 첫]', JSON.stringify(ord) === JSON.stringify(['X.png:last_frame', 'A.png:first_frame']), ord);
ok('2 보낸 순서는 첫 프레임 먼저(A 에셋 → X) — BytePlus 는 순서로 첫 프레임을 정한다', fmt(r.imgs) === 'A/first_frame UPLOAD/last_frame', fmt(r.imgs));
ok('2 카드 레퍼런스도 첫 → 끝 순서', JSON.stringify(r.card?.used) === JSON.stringify(['A.png:first_frame:thumb', 'X.png:last_frame:thumb']), r.card);
ok('2 스토어 순서는 건드리지 않음(보내는 사본만)', JSON.stringify(await order()) === JSON.stringify(ord));

// ── 3. 두 장 모두 인증(끝 칸을 B 로 바꿈) ──
await panelRemove('X.png'); await panelAdd(cB, 'last_frame', 'B.png');
r = await send('PT-F3');
ok('3 첫 = A · 끝 = B 모두 에셋 · 올림 없음', fmt(r.imgs) === 'A/first_frame B/last_frame' && r.card?.refs === 2, { got: fmt(r.imgs), card: r.card });

// ── 4. 첫 프레임만(role 없이 보내는 모드) ──
await setMode('image_to_video_first'); await panelClear(); await panelAdd(cA, 'first_frame', 'A.png');
r = await send('PT-F4');
ok('4 시작 프레임 모드: A 에셋 하나 · role 없음(앱이 예전부터 보내던 모양)', fmt(r.imgs) === 'A/-', fmt(r.imgs));

// ── 5. 이 팀 프로젝트(2DT)에서는 인증 안 됨 · 다른 팀(6T)에서만 → 사진을 올린다 ──
await setMode('image_to_video_first_last'); await panelClear(); await panelAdd(cA, 'first_frame', 'A.png'); await panelAdd(cB, 'last_frame', 'B.png');
const saveA = await S(`const a = S.getState().elementAssets.find(x => x.name === 'F_A'); return JSON.stringify(a.images[0].bpAssets);`);
await S(`const a = S.getState().elementAssets.find(x => x.name === 'F_A'); const im = a.images[0]; S.getState().setElementImageBp([{ elementId: a.id, imageId: im.id, scope: '2DT', entry: { status: 'failed', error: 'test', at: Date.now() } }, { elementId: a.id, imageId: im.id, scope: '6T', entry: { id: 'asset-other-team', status: 'active', at: Date.now() } }]); return 1;`);
r = await send('PT-F5');
ok('5 다른 팀에서만 인증된 A → 사진 올림 · B 는 에셋', fmt(r.imgs) === 'UPLOAD/first_frame B/last_frame', fmt(r.imgs));
// ── 6. 처리 중(아직 인증 전) → 사진 올림(기다리지 않는다) ──
await S(`const a = S.getState().elementAssets.find(x => x.name === 'F_A'); const im = a.images[0]; S.getState().setElementImageBp([{ elementId: a.id, imageId: im.id, scope: '2DT', entry: { id: ${JSON.stringify(idA)}, status: 'processing', at: Date.now() } }]); return 1;`);
r = await send('PT-F6');
ok('6 A 가 처리 중 → 사진 올림', fmt(r.imgs) === 'UPLOAD/first_frame B/last_frame', fmt(r.imgs));
await S(`const a = S.getState().elementAssets.find(x => x.name === 'F_A'); const im = a.images[0]; S.getState().setElementImageBp([{ elementId: a.id, imageId: im.id, scope: '2DT', entry: { id: ${JSON.stringify(idA)}, status: 'active', at: Date.now() } }]); return 1;`);

// ── 7. 라이브러리에서 인물을 지움 → 패널 사진은 남아 있어도 사진 올림 ──
await cmd('elements.add', { collection: '프레임시험', items: [{ name: 'F_A2', category: 'character', images: [A] }] });   // 같은 사진 — 등록 안 함
r = await send('PT-F7a');
ok('7a 같은 사진이 인물 둘(하나는 미등록)에 있어도 인증된 쪽으로 에셋', fmt(r.imgs) === 'A/first_frame B/last_frame', fmt(r.imgs));
await S(`const a = S.getState().elementAssets.find(x => x.name === 'F_B'); S.getState().deleteElementAsset(a.id); return 1;`);
r = await send('PT-F7');
ok('7 B 인물을 라이브러리에서 지움 → B 칸은 사진 올림', fmt(r.imgs) === 'A/first_frame UPLOAD/last_frame', fmt(r.imgs));

// ── 8. 레퍼런스 모드: 패널 [X, A] + @F_A2(미등록, 같은 바이트 A) — 순서 · [Image N] 그대로 ──
await setMode('multimodal_reference'); await panelClear(); await panelAdd(cX, 'reference_image', 'X.png'); await panelAdd(cA, 'reference_image', 'A.png');
r = await send('PT-F8');
ok('8 레퍼런스 칸: X 올림 · A 에셋 · 순서 그대로(프레임 아님 — 줄 세우지 않음)', fmt(r.imgs) === 'UPLOAD/reference_image A/reference_image', fmt(r.imgs));

// ── 9. 에이전트: 첫 · 끝을 경로로, 역할을 거꾸로 적어 보냄 ──
const seen9 = (await (await fetch(FAKE + '/__seen')).json()).length;
const job = await post('/api/agent/jobs', { manual, projectId: pid, prompt: 'PT-F9 천천히 다가간다', refs: [{ path: X, role: 'last_frame' }, { path: A, role: 'first_frame' }], settings: { model: 'dreamina-seedance-2-0-260128', mode: 'image_to_video_first_last', ratio: 'adaptive', resolution: '480p', duration: 5 } });
let s9 = null; for (let i = 0; i < 40 && !s9; i++) { await sleep(1000); s9 = (await (await fetch(FAKE + '/__seen')).json()).slice(seen9).find((x) => JSON.stringify(x).includes('PT-F9')); }
const i9 = (s9?.content || []).filter((c) => c.type === 'image_url').map((c) => ({ u: c.image_url.url.startsWith('asset://') ? c.image_url.url : 'UPLOAD', r: c.role ?? '-' }));
ok('9 에이전트 경로 refs(역할 거꾸로) → A 에셋 첫 프레임 먼저 · X 끝', fmt(i9) === 'A/first_frame UPLOAD/last_frame', { job: job.st, err: job.j?.error, got: fmt(i9) });

// ── 10. 패널 칸의 '인증' 표시(화면) ──
await setMode('image_to_video_first_last'); await panelClear(); await panelAdd(cX, 'first_frame', 'X.png'); await panelAdd(cA, 'last_frame', 'A.png');
await S(`S.getState().setCurrentProjectId(${JSON.stringify(pid)}); return 1;`);
await sleep(1500);
const badge = JSON.parse(await main.ev(`JSON.stringify([...document.querySelectorAll('[title*="BytePlus 인증을 마친"]')].map(e => e.closest('[draggable], div.flex.items-start')?.textContent?.slice(0, 40) || e.textContent))`));
ok('10 인증 표시는 A 칸 하나에만', badge.length === 1 && /A\.png/.test(badge[0]), badge);
await setMode('image_to_video_first_last', 'gemini-omni-1.2-flash'); await sleep(800);
const badgeOmni = await main.ev(`document.querySelectorAll('[title*="BytePlus 인증을 마친"]').length`);
ok('10b 옴니로 바꾸면 표시 없음(옴니는 에셋을 안 받는다)', badgeOmni === 0, badgeOmni);

await done();
