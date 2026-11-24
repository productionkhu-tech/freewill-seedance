// 옛 코드와 지금 코드에 같은 것을 시켜 BytePlus 로 보내는 내용을 견준다(글: 차이 시험 + 승인한 차이 목록).
//   node tests/harness/compare-send.mjs [--base HEAD]
// 등록한 것이 하나도 없는 PC 에서 — 새 기능을 안 쓰는 사람에게 나가는 내용은 그대로여야 한다. 일부러 바꾼 것만 approved.json 에 이유와 함께.
import fs from 'node:fs';
import path from 'node:path';
import { HARNESS, startSlot, stopSlot, slotFree } from './lib/app.mjs';
import { portsOf } from './lib/ports.mjs';
import { connect, sleep } from './lib/cdp.mjs';
import { makeFixtures, FIX } from './lib/fixtures.mjs';
import { makeTree } from './lib/tree.mjs';
import { stampOf } from './lib/stamp.mjs';

const base = (() => { const i = process.argv.indexOf('--base'); return i < 0 ? 'HEAD' : process.argv[i + 1]; })();
const I = (f, role = 'reference_image') => ({ f, type: 'image_url', role }), V = (f) => ({ f, type: 'video_url', role: 'reference_video' });
const M20 = 'dreamina-seedance-2-0-260128', M25 = 'dreamina-seedance-2-5-260628', FL = 'dreamina-seedance-2-5-flash-261115';
const CASES = [
  ['글만', M20, 'text_to_video', []],
  ['첫 프레임', M20, 'image_to_video_first', [I('raw-night.png', 'first_frame')]],
  ['첫 끝', M20, 'image_to_video_first_last', [I('frame-T1-first.png', 'first_frame'), I('frame-T1-last.png', 'last_frame')]],
  ['첫 끝(끝을 먼저 넣음)', M20, 'image_to_video_first_last', [I('frame-T1-last.png', 'last_frame'), I('frame-T1-first.png', 'first_frame')]],
  ['레퍼런스 사진 셋', M20, 'multimodal_reference', [I('raw-sunrise.png'), I('ai-character.png'), I('raw-night.png')]],
  ['레퍼런스 사진 · 영상', M20, 'multimodal_reference', [V('frame-T1.mp4'), I('ai-character.png')]],
  ['레퍼런스(2.5)', M25, 'multimodal_reference', [I('ai-character.png'), V('frame-T2.mp4')]],
  ['편집(2.5)', M25, 'edit_video', [V('frame-T2.mp4'), I('raw-night.png')]],
  ['연장(2.5 Flash)', FL, 'extend_video', [V('frame-T4.mp4'), V('frame-T1.mp4')]],
  ['초안(2.5)', M25, 'multimodal_reference', [I('raw-sunrise.png')], { draft: true, resolution: '480p' }],
  ['개수 둘', M20, 'multimodal_reference', [I('raw-sunrise.png')], { output_count: 2 }],
  ['마지막 프레임 받기', M20, 'image_to_video_first', [I('raw-sunrise.png', 'first_frame')], { return_last_frame: true }],
];
async function collect(repo) {
  let slot = 0;
  for (let s = 1; s <= 12 && !slot; s++) if (await slotFree(s)) slot = s;
  if (!slot) throw new Error('빈 슬롯이 없음');
  const p = portsOf(slot), at = (n) => `http://127.0.0.1:${n}`;
  await startSlot(slot, { repo });
  try {
    const main = await connect(p.cdp, (t) => t.url.includes(`:${p.app}/`) && !t.url.includes('mini'));
    for (let i = 0; i < 120; i++) { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; await sleep(500); }
    const S = (code) => main.ev(`(async () => { const M = window.__M || (window.__M = await import('/src/store.ts')); const R = window.__R || (window.__R = await import('/src/lib/send-request.ts')); const S = M.useAppStore; ${code} })()`);
    for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(500); }
    await S(`S.getState().setBillingProjectKey('EVK'); return 1;`);
    const out = {};
    for (const [name, model, mode, refs, extra = {}] of CASES) {
      const tag = `CMP${Object.keys(out).length}`;
      const assets = [];
      for (const r of refs) { const c = (await (await fetch(`${at(p.app)}/api/cache`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'x-filename': r.f }, body: fs.readFileSync(path.join(FIX, r.f)) })).json()).cacheId; assets.push({ type: r.type, url: '', role: r.role, file_name: r.f, cacheId: c, thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo=' }); }
      const warn = await S(`const s0 = S.getState(); const before = new Set(s0.projects.map((x) => x.id)); s0.createProject('${tag}'); const id = S.getState().projects.find((x) => !before.has(x.id)).id;
        S.getState().updateProjectSettings(id, ${JSON.stringify({ model, mode, ratio: '16:9', resolution: '720p', duration: 5, output_count: 1, draft: false, return_last_frame: false, ...extra })}); S.getState().setCurrentProjectId(id);
        for (const a of ${JSON.stringify(assets)}) S.getState().addAsset(id, a); const pr = S.getState().projects.find((x) => x.id === id); const w = [];
        await R.sendRequest({ projectId: id, promptHtml: '${tag} 천천히 움직인다', settings: pr.settings, assets: pr.assets }, { warn: (m) => w.push(m) }); return w;`);
      await sleep(400);
      const seen = (await (await fetch(`${at(p.fake)}/__seen`)).json()).filter((x) => JSON.stringify(x).includes(`${tag} `));
      // 주소는 그때그때 다르다 → 그 안의 내용 key 로. 프로젝트 id 도 매번 다르다.
      const plain = JSON.parse(JSON.stringify(seen).replace(/https?:\/\/[^"\\]*?([0-9a-f]{12})[^"\\]*/g, 'FILE($1)').replace(/https?:\/\/[^"\\]+/g, 'URL'));
      out[name] = { 경고: warn, 요청: plain.map(({ project_id, ...x }) => x) };
    }
    return out;
  } finally { await stopSlot(slot); }
}
const flat = (x, at = '', o = {}) => { if (x && typeof x === 'object') for (const k of Object.keys(x)) flat(x[k], `${at}/${k}`, o); else o[at] = x; return o; };

makeFixtures();
const tree = makeTree('compare-base', base);
console.log(`옛 코드 ${base} (${stampOf(tree)}) ↔ 지금 ${stampOf()} · ${CASES.length}가지`);
const two = await Promise.allSettled([collect(tree), sleep(15_000).then(() => collect(undefined))]);   // 한쪽이 멈춰도 다른 쪽 앱을 끄고 끝낸다
for (const r of two) if (r.status === 'rejected') { console.log(`STOP ${r.reason.message}`); process.exit(2); }
const [was, now] = two.map((r) => r.value);
const okd = JSON.parse(fs.readFileSync(path.join(HARNESS, 'approved.json'), 'utf8'));
let bad = 0;
for (const [name] of CASES) {
  const a = flat(was[name]), b = flat(now[name]);
  const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
  const yes = okd[name];
  if (!was[name].요청.length) { bad++; console.log(`FAIL ${name} → 옛 코드가 아무것도 안 보냄(견줄 수 없음) ${JSON.stringify(was[name].경고)}`); continue; }
  if (!diff.length) { console.log(`ok   ${name} → 같음${yes ? '  (승인한 차이가 이제 없음 — approved.json 에서 뺄 것)' : ''}`); continue; }
  if (yes) { console.log(`ok   ${name} → 다름(승인함: ${yes})`); continue; }
  bad++;
  console.log(`FAIL ${name} → 승인하지 않은 차이 ${diff.length}곳`);
  for (const k of diff.slice(0, 6)) console.log(`       ${k}\n         옛 ${JSON.stringify(a[k])}\n         지금 ${JSON.stringify(b[k])}`);
}
console.log(bad ? `\n${bad} FAIL` : '\nALL OK');
process.exit(bad ? 1 : 0);
