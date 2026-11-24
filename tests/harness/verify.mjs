// 확인 한 번에 — node tests/harness/verify.mjs [--all | --only a,b | (기본) 바뀐 것만] [--base HEAD] [--slots 2] [--plan] [--gate]
//   --plan  무엇을 돌릴지만 보여 준다      --gate  지금 코드에 맞는 결과가 다 있는지만 본다(돌리지 않음)
// 결과는 .results/<코드 도장>.json — 코드가 바뀌면 그 결과는 남의 것이다. 안 돌린 것은 '안 함' 으로 적는다. README.md 참고.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { HARNESS, REPO, DATA, startSlot, stopSlot, slotFree } from './lib/app.mjs';
import { stampOf } from './lib/stamp.mjs';
import { makeFixtures } from './lib/fixtures.mjs';
import { CASES, changedFiles, diffText, select, unlisted } from './lib/select.mjs';
import { checklist } from './lib/checklist.mjs';
import { friction, typicalSeconds } from './lib/friction.mjs';
import { types, gateway } from './lib/units.mjs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : (process.argv[i + 1] || '').startsWith('--') || i + 1 >= process.argv.length ? true : process.argv[i + 1]; };
const base = String(arg('base', 'HEAD')), RESULTS = path.join(HARNESS, '.results');
const stamp = stampOf(), file = path.join(RESULTS, `${stamp}.json`);
const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { stamp, results: {} }; } };
const files = changedFiles(base), picked = select(files);
const only = arg('only', ''), all = !!arg('all', false);
const want = only ? String(only).split(',') : all ? Object.keys(CASES) : picked.cases;
const bad = want.filter((c) => !CASES[c]);
if (bad.length) { console.log(`없는 시험: ${bad.join(', ')} (있는 것: ${Object.keys(CASES).join(', ')})`); process.exit(1); }
if (unlisted().length) console.log(`! 표(lib/select.mjs)에 없는 시험: ${unlisted().join(', ')} — 고르지 못한다`);

console.log(`코드 ${stamp} · ${base} 와 다른 파일 ${files.length}개 · 위험 ${only || all ? '(직접 고름)' : picked.risk}`);
const list = checklist(files, diffText(base));
if (list.length) { console.log('읽고 답할 것:'); for (const x of list) console.log(`  · [${x.id}] ${x.text}`); }

function report(d) {
  const rows = ['types', 'gateway', ...Object.keys(CASES)].map((c) => [c, d.results[c]]);
  const mark = (r) => (!r ? '안 함' : r.void ? '무효(도중에 코드 바뀜)' : r.pass ? '통과' : r.state || '실패');
  const need = new Set(['types', 'gateway', ...picked.cases, ...want]);   // 일부만 돌렸어도 바뀐 것에 필요한 것은 다 적는다
  const lines = [`확인 ${d.stamp} (${new Date().toLocaleString('sv-SE')})`, ...rows.map(([c, r]) => `  ${c.padEnd(14)} ${mark(r)}${r ? `  ok ${r.ok} fail ${r.fail}${r.skip ? ` 못함 ${r.skip}` : ''}  ${r.sec}초${r.boots > 1 ? `  (앱 ${r.boots}번째에 뜸)` : ''}` : ''}${need.has(c) ? '' : '  · 이번 바뀐 것과 무관'}`)];
  const short = rows.filter(([c]) => need.has(c)), fail = short.filter(([, r]) => !r || !r.pass || r.void);
  lines.push(fail.length ? `✗ 아직: ${fail.map(([c, r]) => `${c}(${mark(r)})`).join(', ')}` : `✓ 필요한 ${short.length}가지 모두 이 코드에서 통과`);
  const ranOk = ['types', 'gateway', ...want].every((c) => d.results[c]?.pass && !d.results[c].void);
  return { text: lines.join('\n'), ok: !fail.length, ranOk };
}
if (arg('gate', false)) {
  const r = report(load());
  console.log(r.text);
  // 문지기: off · observe(기본 — 말만) · enforce(모자라면 실패로 끝남). 배포 명령에 묶는 것은 사람이 정한다.
  const mode = process.env.HARNESS_GATE || 'observe';
  if (mode !== 'off') console.log(`문지기 ${mode}${!r.ok && mode === 'observe' ? ' — 지금은 막지 않음' : ''}`);
  process.exit(!r.ok && mode === 'enforce' ? 1 : 0);
}
if (arg('plan', false)) {
  for (const [f, r, c] of picked.why) console.log(`  ${r.padEnd(6)} ${f} → ${c}`);
  console.log(`돌릴 것: types, gateway, ${want.join(', ') || '(없음)'} · 약 ${Math.ceil(want.reduce((n, c) => n + typicalSeconds(c, CASES[c]) + 15, 0) / Number(arg('slots', 2)) / 60)}분(${arg('slots', 2)}벌)`);
  process.exit(0);
}

const d = load();
const keep = (c, r) => { d.results[c] = r; fs.mkdirSync(RESULTS, { recursive: true }); fs.writeFileSync(file, JSON.stringify(d, null, 1)); };
const same = () => stampOf() === stamp;
for (const [c, fn] of [['types', types], ['gateway', gateway]]) {
  const r = await fn();
  keep(c, { ...r, at: Date.now(), void: !same() });
  console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${c}  ${r.note || ''}`);
}
makeFixtures();
const queue = [...want].sort((a, b) => typicalSeconds(b, CASES[b]) - typicalSeconds(a, CASES[a]));
const evidence = path.join(RESULTS, `${stamp}-evidence`);
const used = [];
async function worker(n) {
  await new Promise((r) => setTimeout(r, n * 20_000));   // 동시에 처음 띄우면 앱 서버(npx)가 가끔 죽는다 — 어긋나게
  let slot = 0;
  for (let s = 1; s <= 12 && !slot; s++) if (!used.includes(s) && await slotFree(s)) { used.push(s); slot = s; }
  if (!slot) { console.log('빈 슬롯이 없음'); return; }
  for (let c; (c = queue.shift());) {
    const boots = [];
    try { await startSlot(slot, { onTry: (why) => { boots.push(why); friction({ kind: 'boot', case: c, why }); } }); } catch (e) {
      keep(c, { pass: false, state: '시작 못 함', ok: 0, fail: 0, sec: 0, why: e.message, at: Date.now() });
      console.log(`--   ${c} 시작 못 함 — ${e.message}`);
      continue;
    }
    const t0 = Date.now();
    fs.mkdirSync(evidence, { recursive: true });
    const out = await new Promise((r) => {
      let text = '';
      const p = spawn(process.execPath, [path.join(HARNESS, 'cases', `${c}.mjs`)], { cwd: HARNESS, env: { ...process.env, HARNESS_SLOT: String(slot), HARNESS_EVIDENCE: evidence }, windowsHide: true });
      p.stdout.on('data', (x) => { text += x; }); p.stderr.on('data', (x) => { text += x; });
      const t = setTimeout(() => { text += '\nTIMEOUT 15분'; p.kill(); }, 15 * 60_000);
      p.on('close', (code) => { clearTimeout(t); r({ code, text }); });
    });
    const count = (re) => (out.text.match(re) || []).length, ok = count(/^ok /gm), fail = count(/^FAIL/gm), sec = Math.round((Date.now() - t0) / 1000);
    const state = /^TIMEOUT/m.test(out.text) ? '시간 넘김' : /^STOP/m.test(out.text) || out.code === 2 ? '도중에 멈춤' : fail ? '실패' : out.code === 0 && ok ? '통과' : '확인 없음';
    const r = { pass: state === '통과', state, ok, fail, skip: count(/^SKIP/gm), sec, boots: boots.length + 1, at: Date.now(), void: !same() };
    fs.writeFileSync(path.join(RESULTS, `${stamp}-${c}.log`), out.text);
    keep(c, r);
    friction({ kind: 'case', case: c, state, ok, fail, sec, boots: r.boots });
    console.log(`${r.void ? 'VOID' : r.pass ? 'ok  ' : 'FAIL'} ${c}  ${state}  ok ${ok} fail ${fail}  ${sec}초${r.void ? '  ← 도중에 코드가 바뀌어 무효' : ''}`);
    if (!r.pass) for (const l of out.text.split('\n').filter((x) => /^(FAIL|STOP|TIMEOUT)/.test(x)).slice(0, 4)) console.log(`       ${l.slice(0, 260)}`);
  }
  await stopSlot(slot);
}
await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Number(arg('slots', 2)))) }, (_, n) => worker(n)));
try { if (!fs.readdirSync(evidence).length) fs.rmdirSync(evidence); } catch { /* 없음 */ }
const r = report(d);
console.log(`\n${r.text}`);
if (fs.existsSync(evidence)) console.log(`틀린 순간의 화면 · 상태: ${path.relative(REPO, evidence)}`);
process.exit((only ? r.ranOk : r.ok) ? 0 : 1);
