// 레퍼런스 칸의 방패 격리 시험(11/24, 사용자 "레퍼런스 칸에도 방패 넣어줘") — 시험 앱(3958) → 서버 → 가짜 BytePlus(3946) · 진짜 게이트웨이 코드(3947). 과금 없음.
// 확인: 칸에 방패가 보이나 · 누르면 라이브러리 카드가 생기고(연결 컬렉션 · 이름 겹침 피함) 등록 → '등록 중…' → '인증' · 보낼 때 asset://
//       같은 사진 두 칸 동시에 → 카드 하나 · 이미 라이브러리에 같은 사진 → 새 카드 없이 그 카드 등록 · 영상 칸 · 옴니 · 연결 컬렉션 없음 → '레퍼런스 인물' ·
//       다시 넣어도 인증 · 실패면 '등록 실패' + 방패로 다시.
import P from '../lib/ports.mjs'; 
import path from 'node:path'; import fs from 'node:fs';
import { connect } from '../lib/cdp.mjs';
import { ok, done, skip } from '../lib/t.mjs';
import { FIX } from '../lib/fixtures.mjs';
const API = P.API, FAKE = P.FAKE, HOOK = P.HOOK;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = path.join(FIX, 'ai-character.png');          // 처음 보는 인물 사진(라이브러리에 없음)
const Bp = path.join(FIX, 'ai-character-close.png');   // 미리 라이브러리에 넣어 둘 사진
const X = path.join(FIX, 'raw-sunrise.png');           // 하나 더(이름 겹침 · 옴니 · 연결 없음)
const Y = path.join(FIX, 'raw-night.png');             // 실패 시험용

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
const toasts = [];
await main.ev(`window.__toasts = []; window.addEventListener('seedance:toast', (e) => window.__toasts.push(e.detail)); 1`);
const lastToast = async () => JSON.parse(await main.ev(`JSON.stringify(window.__toasts[window.__toasts.length - 1] || null)`));

const pid = (await cmd('project.create', { name: 'REFSHIELD ' + Date.now() % 100000, open: true }))?.result?.id;
ok('프로젝트', !!pid);
await cmd('collection.create', { name: '방패시험' });
await cmd('collection.bind', { collection: '방패시험', projectId: pid });
await S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); return 1;`);

const cacheOf = async (f, name) => (await (await fetch(API + '/api/cache', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': encodeURIComponent(name || path.basename(f)) }, body: fs.readFileSync(f) })).json()).cacheId;
const panelAdd = (cacheId, name, type = 'image_url', role = 'reference_image') => S(`S.getState().addAsset(${JSON.stringify(pid)}, { type: ${JSON.stringify(type)}, url: '', role: ${JSON.stringify(role)}, file_name: ${JSON.stringify(name)}, cacheId: ${JSON.stringify(cacheId)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
const panelClear = () => S(`S.getState().replaceAllAssets(${JSON.stringify(pid)}, []); return 1;`);
// 화면의 칸(줄)을 파일 이름으로 찾는다
const rowSel = (name) => `[...document.querySelectorAll('[draggable], div')].filter(d => d.className && String(d.className).includes('rounded-[11px]') && d.textContent.includes(${JSON.stringify(name)}))[0]`;
const rowInfo = (name) => main.ev(`(() => { const r = ${rowSel(name)}; if (!r) return JSON.stringify(null); return JSON.stringify({ shield: !!r.querySelector('[data-bp-register-ref]'), cert: !!r.querySelector('[data-bp-ref-state="done"]'), working: !!r.querySelector('[data-bp-ref-state="processing"]'), failed: !!r.querySelector('[data-bp-ref-state="failed"]') }); })()`).then(JSON.parse);
const press = (name) => main.ev(`(() => { const b = ${rowSel(name)}?.querySelector('[data-bp-register-ref]'); if (!b) return 0; b.click(); return 1; })()`);
const libByName = (n) => S(`return JSON.stringify(S.getState().elementAssets.filter(a => a.name === ${JSON.stringify(n)}).map(a => ({ id: a.id, col: S.getState().assetCollections.find(c => c.id === a.collectionId)?.name, desc: a.description, n: a.images.length, bp: a.images[0].bpAssets?.['2DT'] || null })));`).then(JSON.parse);
const waitRow = async (name, pred, ms = 40000) => { let r; for (let t = 0; t < ms; t += 700) { r = await rowInfo(name); if (r && pred(r)) return r; await sleep(700); } return r; };
async function send(tag) {
  const seen0 = (await (await fetch(FAKE + '/__seen')).json()).length;
  const warns = JSON.parse(await S(`const w = []; const p = S.getState().projects.find(p => p.id === ${JSON.stringify(pid)}); await R.sendRequest({ projectId: p.id, promptHtml: ${JSON.stringify(tag + ' 천천히 움직인다')}, settings: p.settings, assets: p.assets }, { warn: (m) => w.push(m) }); return JSON.stringify(w);`));
  let sent = null; for (let i = 0; i < 30 && !sent && !warns.length; i++) { await sleep(500); sent = (await (await fetch(FAKE + '/__seen')).json()).slice(seen0).find((x) => JSON.stringify(x).includes(tag)); }
  return { warns, urls: (sent?.content || []).filter((c) => c.type !== 'text').map((c) => { const u = (c.image_url || c.video_url || {}).url || ''; return u.startsWith('asset://') ? 'ASSET' : u.startsWith('http') ? 'UPLOAD' : u; }) };
}

// ── 1. 처음 보는 인물 사진을 칸에 → 방패가 보임 → 누름 → 연결 컬렉션에 카드 · 등록 중 → 인증 ──
const cA = await cacheOf(A, 'mina.png');
await panelAdd(cA, 'mina.png');
await sleep(600);
let ri = await rowInfo('mina.png');
ok('1 칸에 방패가 보임(인증 전)', ri?.shield === true && !ri.cert, ri);
ok('1 누름', (await press('mina.png')) === 1);
const sawWorking = await waitRow('mina.png', (r) => r.working, 8000);
ri = await waitRow('mina.png', (r) => r.cert);
ok('1 → 등록 중… 을 거쳐 인증', !!sawWorking?.working && ri?.cert === true && !ri.shield, { sawWorking, ri });
let lib = await libByName('mina');
ok('1 라이브러리: 연결 컬렉션(방패시험)에 인물 카드 하나 · 설명 · 사진 1 · 2DT active', lib.length === 1 && lib[0].col === '방패시험' && lib[0].desc === '레퍼런스 칸에서 인증' && lib[0].n === 1 && lib[0].bp?.status === 'active', lib);
ok('1 알림', /\[mina\] BytePlus 에셋 등록\(2DT\)/.test((await lastToast())?.msg || ''), await lastToast());
let r = await send('RS-1');
ok('1 보낼 때 asset://', JSON.stringify(r.urls) === '["ASSET"]', r);

// ── 2. 지웠다 다시 넣어도 인증(방패 없이) ──
await panelClear(); await panelAdd(cA, 'mina_again.png');
await sleep(600);
ri = await rowInfo('mina_again.png');
ok('2 다시 넣으면 바로 인증 · 방패 없음', ri?.cert === true && !ri.shield, ri);
r = await send('RS-2');
ok('2 asset://', JSON.stringify(r.urls) === '["ASSET"]', r);

// ── 3. 이미 라이브러리에 같은 사진(인증 전) → 새 카드 없이 그 카드를 등록 ──
const add = await cmd('elements.add', { collection: '방패시험', items: [{ name: 'Bora', category: 'character', images: [Bp] }] });
ok('3 라이브러리에 Bora(인증 전)', add?.status === 'done', add?.error);
await panelClear();
const cB = await cacheOf(Bp, 'bora_copy.png');
await panelAdd(cB, 'bora_copy.png');
await sleep(600);
const before = await S(`return S.getState().elementAssets.length;`);
await press('bora_copy.png');
ri = await waitRow('bora_copy.png', (x) => x.cert);
const after = await S(`return S.getState().elementAssets.length;`);
lib = await libByName('Bora');
ok('3 새 카드 없이 Bora 가 인증됨', ri?.cert === true && after === before && lib[0]?.bp?.status === 'active', { ri, before, after, lib });

// ── 4. 같은 처음 보는 사진을 두 칸에 넣고 거의 동시에 둘 다 누름 → 카드 하나 ──
await panelClear();
const cX = await cacheOf(X, 'sun.png');
await panelAdd(cX, 'sun.png'); await panelAdd(cX, 'sun_dup.png');
await sleep(600);
await main.ev(`(() => { ${rowSel('sun.png')}?.querySelector('[data-bp-register-ref]')?.click(); ${rowSel('sun_dup.png')}?.querySelector('[data-bp-register-ref]')?.click(); return 1; })()`);
const r4a = await waitRow('sun.png', (x) => x.cert), r4b = await waitRow('sun_dup.png', (x) => x.cert);
lib = await libByName('sun');
ok('4 두 칸 동시에 → 카드 하나 · 두 칸 모두 인증', lib.length === 1 && r4a?.cert && r4b?.cert && (await libByName('sun_dup')).length === 0, { lib, r4a, r4b });

// ── 5. 이름이 겹치면 '이름 2' — 다른 사진인데 파일 이름이 mina.png ──
await panelClear();
const cY = await cacheOf(Y, 'mina.png');
await panelAdd(cY, 'mina.png');
await sleep(600);
// 이 사진은 가짜 BytePlus 에서 실패하게(이름에 FAIL) — 아래 6 에서 씀. 여기서는 이름만 본다.
await press('mina.png');
await waitRow('mina.png', (x) => x.cert || x.failed);
const m2 = await libByName('mina 2');
ok('5 같은 이름 → "mina 2" 로 새 카드(기존 mina 는 그대로)', m2.length === 1 && (await libByName('mina')).length === 1, m2);

// ── 6. 등록 실패 → 칸에 '등록 실패' + 방패로 다시 ──
await panelClear();
const cF = await cacheOf(Y, 'night_FAILIMG.png');   // 같은 바이트(Y) — 5 에서 이미 카드 mina 2 가 있다
await S(`const a = S.getState().elementAssets.find(x => x.name === 'mina 2'); const im = a.images[0]; S.getState().setElementImageBp([{ elementId: a.id, imageId: im.id, scope: '2DT', entry: { status: 'failed', error: '시험 실패 이유', at: Date.now() } }]); return 1;`);
await panelAdd(cF, 'night_FAILIMG.png');
await sleep(600);
ri = await rowInfo('night_FAILIMG.png');
ok('6 실패면 칸에 "등록 실패" + 방패(다시)', ri?.failed === true && ri.shield === true && !ri.cert, ri);
await press('night_FAILIMG.png');
ri = await waitRow('night_FAILIMG.png', (x) => x.cert);
ok('6 방패로 다시 → 인증', ri?.cert === true, ri);

// ── 7. 영상 칸 · 옴니에는 방패 없음 ──
await panelClear();
const vid = path.join(FIX, 'asset-video.mp4');
if (fs.existsSync(vid)) {
  const cV = await cacheOf(vid, 'clip.mp4');
  await panelAdd(cV, 'clip.mp4', 'video_url', 'reference_video');
  await sleep(600);
  ri = await rowInfo('clip.mp4');
  ok('7 영상 칸에도 배지(11/24~ — 영상은 certifyVideo, 사진 라이브러리 카드는 안 만듦)', ri && ri.shield && !ri.cert, ri);
}
await panelClear(); await panelAdd(cX, 'sun_omni.png');
await S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: 'gemini-omni-1.2-flash', omniTask: 'reference_to_video' }); return 1;`);
await sleep(800);
ri = await rowInfo('sun_omni.png');
ok('7 옴니에는 방패 · 인증 표시 없음', ri && !ri.shield && !ri.cert, ri);
await S(`S.getState().updateProjectSettings(${JSON.stringify(pid)}, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference' }); return 1;`);

// ── 8. 연결된 컬렉션이 없는 채팅 → '레퍼런스 인물' 컬렉션에(연결은 그대로 없음) ──
const pid2 = (await cmd('project.create', { name: 'REFSHIELD-NOBIND ' + Date.now() % 100000, open: true }))?.result?.id;
await S(`S.getState().updateProjectSettings(${JSON.stringify(pid2)}, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference' }); return 1;`);
const cZ = await cacheOf(path.join(FIX, 'frame-raw-first.png'), 'zed.png');
await S(`S.getState().addAsset(${JSON.stringify(pid2)}, { type: 'image_url', url: '', role: 'reference_image', file_name: 'zed.png', cacheId: ${JSON.stringify(cZ)}, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); return 1;`);
await sleep(800);
await press('zed.png');
ri = await waitRow('zed.png', (x) => x.cert);
lib = await libByName('zed');
const bound2 = await S(`return S.getState().projectCollectionId[${JSON.stringify(pid2)}] || null;`);
ok('8 연결 없음 → "레퍼런스 인물" 컬렉션에 카드 · 채팅 연결은 그대로 없음', ri?.cert && lib[0]?.col === '레퍼런스 인물' && bound2 === null, { ri, lib, bound2 });

await done();
