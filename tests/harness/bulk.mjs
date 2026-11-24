// 한꺼번에 많이 — 한 PC 가 서로 다른 영상 N 개(모두 '실사 인물' 로 막힘)를 동시에 보내면 몇 개가 나가고 몇 개가 왜 실패하나. 과금 없음.
//   node tests/harness/bulk.mjs --videos 30 --rate 3 [--groupcap 50] [--reuse]     rate = 분당 등록 한도(무료 3 · Advanced 120)
//   --cap 20 --task 40   BytePlus 가 동시에 20개까지만 받고(넘으면 429) 한 편이 40초 걸림 — 대기열 자동 재전송(lib/busy-line)을 실제 시계로
//   --reuse  같은 영상 하나를 N 번      --groupcap  프로젝트의 그룹 수 한도(0 = 없음)
// 판정이 아니라 재는 것 — 결과를 그대로 보여 준다. 진짜 BytePlus 의 처리 시간 · 동시 한도는 흉내 내지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { startSlot, stopSlot, slotFree } from './lib/app.mjs';
import { portsOf } from './lib/ports.mjs';
import { connect, sleep } from './lib/cdp.mjs';
import { makeFixtures, FIX } from './lib/fixtures.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : Number(process.argv[i + 1]); };
const N = arg('videos', 30), RATE = arg('rate', 3), GROUPS = arg('groupcap', 0), CAP = arg('cap', 0), TASK = arg('task', 0), REUSE = process.argv.includes('--reuse');
process.env.GW_RATE = String(RATE); process.env.GW_GROUP_CAP = String(GROUPS);
makeFixtures();
let slot = 0;
for (let s = 1 + arg('first', 0); s <= 12 && !slot; s++) if (await slotFree(s)) slot = s;
const p = portsOf(slot), at = (n) => `http://127.0.0.1:${n}`;
await startSlot(slot);
let code = 0;
try {
  const main = await connect(p.cdp, (t) => t.url.includes(`:${p.app}/`) && !t.url.includes('mini'));
  for (let i = 0; i < 120; i++) { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; await sleep(500); }
  const S = (c) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${c} })()`, { timeout: 600_000 });
  for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(500); }
  await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
  await fetch(`${at(p.fake)}/__set`, { method: 'POST', body: JSON.stringify({ faceKeys: ['http'], goneAssets: [], copyrightKeys: [], cap: CAP, marks: [], ...(TASK ? { delayMs: TASK * 1000 } : {}) }) });
  const base = fs.readFileSync(path.join(FIX, 'frame-T1.mp4')), ids = [];
  for (let i = 0; i < N; i++) ids.push((await (await fetch(`${at(p.app)}/api/cache`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': `v${i}.mp4` }, body: REUSE ? base : Buffer.concat([base, Buffer.from(`#${i}`)]) })).json()).cacheId);
  await main.ev(`window.__bp = {}; const f0 = window.fetch; window.fetch = function (u) { const m = /\\/api\\/(bp-assets\\/[a-z]+|byteplus\\/tasks(?=$|\\?)|reupload)/.exec(String(u && u.url || u)); if (m) window.__bp[m[1]] = (window.__bp[m[1]] || 0) + 1; return f0.apply(this, arguments); }; 1`);
  const t0 = Date.now();
  // 프로젝트(채팅) 하나에서 한꺼번에 — 카드마다 영상 하나
  await S(`const before = new Set(S.getState().projects.map((x) => x.id)); S.getState().createProject('BULK'); const id = S.getState().projects.find((x) => !before.has(x.id)).id; S.getState().updateProjectSettings(id, { model: 'dreamina-seedance-2-0-260128', mode: 'multimodal_reference', ratio: '16:9', resolution: '480p', duration: 5, output_count: 1, draft: false }); window.__BID = id;
    const st = S.getState().projects.find((x) => x.id === id).settings; const ids = ${JSON.stringify(ids)};
    await Promise.all(ids.map((c, i) => R.sendRequest({ projectId: id, promptHtml: 'BULK' + i + ' 움직인다', settings: st, assets: [{ id: 'a' + i, type: 'video_url', url: '', role: 'reference_video', file_name: 'v' + i + '.mp4', cacheId: c, thumbnailUrl: '' }] }, { warn: (m) => { window.__warn = (window.__warn || []).concat(m); } }).catch((e) => { window.__warn = (window.__warn || []).concat('ERR ' + e.message); }))); return 1;`);
  let cards = [], last = 0;
  for (;;) {
    cards = JSON.parse(await S(`return JSON.stringify(S.getState().projects.find((x) => x.id === window.__BID).messages.filter((m) => m.role === 'system').map((m) => ({ t: !!m.taskId, st: m.status, fix: !!m.bpFix, e: (m.error || '').split('[자동 인증 못 함]').pop().trim().slice(0, 130) })));`));
    const ended = cards.filter((c) => c.t || c.st === 'failed').length, sec = Math.round((Date.now() - t0) / 1000);
    if (sec - last >= 30) { last = sec; console.log(`  ${sec}초 — 나감 ${cards.filter((c) => c.t).length} · 실패 ${cards.filter((c) => c.st === 'failed').length} · 기다림 ${cards.length - ended}`); }
    if ((ended >= N && cards.length >= N) || sec > 1500) break;
    await sleep(2000);
  }
  const why = {};
  for (const c of cards.filter((x) => x.st === 'failed')) why[c.e.replace(/v\d+|[0-9a-f]{12}/g, '…')] = (why[c.e.replace(/v\d+|[0-9a-f]{12}/g, '…')] || 0) + 1;
  const g = await (await fetch(`${at(p.gw)}/__stats`)).json();
  console.log(`결과: 영상 ${N}개${REUSE ? '(같은 것)' : ''} · 분당 ${RATE}${GROUPS ? ` · 그룹 한도 ${GROUPS}` : ''} → 나감 ${cards.filter((c) => c.t).length} · 실패 ${cards.filter((c) => c.st === 'failed').length} · 안 끝남 ${cards.filter((c) => !c.t && c.st !== 'failed').length} · ${Math.round((Date.now() - t0) / 1000)}초`);
  console.log(`  에셋 ${g.assets} · 그룹 ${g.groups} · 분당 한도에 막힌 등록 ${g.stats.throttled} · 화면이 부른 것 ${JSON.stringify(await main.ev('window.__bp'))}`);
  for (const [w, n] of Object.entries(why)) console.log(`  실패 ${n}: ${w}`);
  const marks = await (await fetch(`${at(p.fake)}/__marks`)).json(), asked = marks.filter((m) => m.what === '429').length;
  const per = {}; for (const m of marks) if (m.what === 'in') per[m.text.split(' ')[0]] = (per[m.text.split(' ')[0]] || 0) + 1;
  console.log(`  BytePlus 에 만들어진 작업 ${Object.values(per).reduce((a, b) => a + b, 0)}(문장 ${Object.keys(per).length}가지 · 두 번 만들어진 문장 ${Object.values(per).filter((n) => n > 1).length}) · 429 ${asked}번`);
  const warn = await main.ev('JSON.stringify((window.__warn || []).slice(0, 3))');
  if (warn !== '[]') console.log(`  알림 ${warn}`);
} catch (e) { code = 2; console.log('STOP', e.message); }
await stopSlot(slot);
process.exit(code);
