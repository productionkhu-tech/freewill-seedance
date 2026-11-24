// 사람이 직접 만져 볼 시험 앱(0번 슬롯) — node tests/harness/play.mjs [--open]  · 끄기 --stop
//   기본: 넣는 사진 · 영상을 모두 '실사 얼굴' 로 막는다(인증 흐름을 바로 보게). --open 이면 막지 않는다.
//   결과 영상은 샘플이다. 옴니(Gemini)만 진짜 구글로 나간다(키가 틀려 생성은 안 됨) — 쓰지 말 것. 다시 켜면 넣은 것이 지워진다.
import { startSlot, stopSlot, slotFree } from './lib/app.mjs';
import { portsOf } from './lib/ports.mjs';
import { connect, sleep } from './lib/cdp.mjs';
import { makeFixtures } from './lib/fixtures.mjs';

if (process.argv.includes('--stop')) { await stopSlot(0); console.log('껐음'); process.exit(0); }
const p = portsOf(0), at = (n) => `http://127.0.0.1:${n}`;
if (!(await slotFree(0))) { console.log('이미 켜져 있음(또는 다른 것이 포트를 씀). 끄려면 --stop'); process.exit(1); }
makeFixtures();
await startSlot(0);
await fetch(`${at(p.hook)}/show`);
const main = await connect(p.cdp, (t) => t.url.includes(`:${p.app}/`) && !t.url.includes('mini'));
for (let i = 0; i < 120; i++) { if (await main.ev(`!!document.querySelector('[data-mini-toggle]')`)) break; await sleep(500); }
const S = (code) => main.ev(`(async () => { const M = await import('/src/store.ts'); const S = M.useAppStore; ${code} })()`);
for (let i = 0; i < 60; i++) { if (await S(`return S.getState().billingProjects.length > 0;`)) break; await sleep(500); }
await S(`const s = S.getState(); s.setBillingProjectKey('EVK'); s.createProject('★시험 앱 (가짜 BytePlus)'); return 1;`);
await fetch(`${at(p.fake)}/__set`, { method: 'POST', body: JSON.stringify({ faceKeys: process.argv.includes('--open') ? [] : ['http'], goneAssets: [], copyrightKeys: [] }) });
console.log('켰음 — ★시험 앱 (가짜 BytePlus) 프로젝트. 끄기: node tests/harness/play.mjs --stop');
process.exit(0);
