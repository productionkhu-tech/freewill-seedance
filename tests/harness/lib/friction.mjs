// 어디서 자주 막히나(글: 마찰을 지도로) — 시험마다 걸린 시간 · 실패 · 앱이 안 뜬 일을 쌓고, 많은 곳부터 보여 준다.
//   node tests/harness/lib/friction.mjs        → 요약
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS } from './app.mjs';

const FILE = path.join(HARNESS, '.results', 'friction.jsonl');
export function friction(x) {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.appendFileSync(FILE, `${JSON.stringify({ at: Date.now(), ...x })}\n`); } catch { /* 기록만 */ }
}
const rows = () => { try { return fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
/** 실제로 걸린 시간(최근 10번의 가운데값). 없으면 적어 둔 값. */
export function typicalSeconds(c, fallback) {
  const s = rows().filter((r) => r.kind === 'case' && r.case === c && r.state === '통과').slice(-10).map((r) => r.sec).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : fallback;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const all = rows(), by = {};
  for (const r of all) { const k = by[r.case] = by[r.case] || { n: 0, fail: 0, stop: 0, boot: 0, why: {} }; if (r.kind === 'break') continue; if (r.kind === 'boot') { k.boot++; k.why[r.why] = (k.why[r.why] || 0) + 1; } else { k.n++; if (r.state === '실패') k.fail++; else if (r.state !== '통과') { k.stop++; k.why[r.state] = (k.why[r.state] || 0) + 1; } } }
  console.log(`기록 ${all.length}줄`);
  for (const [c, k] of Object.entries(by).sort((a, b) => (b[1].fail + b[1].stop + b[1].boot) - (a[1].fail + a[1].stop + a[1].boot))) console.log(`${c.padEnd(14)} 돌린 ${k.n} · 실패 ${k.fail} · 못 끝냄 ${k.stop} · 앱 다시 띄움 ${k.boot} · 보통 ${typicalSeconds(c, 0)}초 ${Object.entries(k.why).map(([w, n]) => `[${w} ${n}]`).join(' ')}${k.fail + k.stop >= 3 ? '  ← 세 번 넘게 막힘: 고치거나, 원인을 못 찾으면 빼고 이유를 README 에' : ''}`);
}
