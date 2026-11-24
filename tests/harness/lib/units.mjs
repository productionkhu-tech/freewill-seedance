// 앱을 띄우지 않는 확인 — 타입(기준 목록과 같은지 · 개수가 아니라 줄로) · 게이트웨이.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { HARNESS, REPO } from './app.mjs';

const run = (args, cwd = REPO) => new Promise((r) => {
  let out = '';
  const p = spawn(process.execPath, args, { cwd, windowsHide: true });
  p.stdout.on('data', (x) => { out += x; }); p.stderr.on('data', (x) => { out += x; });
  p.on('close', (code) => r({ code, out }));
});
const BASE = path.join(HARNESS, 'types', 'baseline.txt');
/** 타입 오류가 기준 목록과 같은가(새로 생기거나 사라진 줄을 말한다). 줄 번호는 뺀다. --update 면 기준을 다시 쓴다. */
export async function types({ update = false } = {}) {
  const t0 = Date.now();
  const cfg = path.join(HARNESS, 'types', 'tsconfig.json');
  const { out } = await run([path.join(REPO, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg]);
  const now = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l)).map((l) => l.replace(/^(\.\.\/)+/, '').replace(/\(\d+,\d+\)/, '')).sort();
  if (update) { fs.writeFileSync(BASE, `${now.join('\n')}\n`); return { pass: true, ok: now.length, fail: 0, sec: 0, note: `기준을 다시 씀 ${now.length}줄` }; }
  const was = fs.readFileSync(BASE, 'utf8').split(/\r?\n/).filter(Boolean);
  const left = [...was], fresh = [];
  for (const l of now) { const i = left.indexOf(l); if (i >= 0) left.splice(i, 1); else fresh.push(l); }
  return { pass: !fresh.length, ok: now.length - fresh.length, fail: fresh.length, sec: Math.round((Date.now() - t0) / 1000), note: `${now.length}개(기준 ${was.length})${fresh.length ? ` · 새 오류: ${fresh.slice(0, 3).join(' | ').slice(0, 300)}` : ''}${left.length ? ` · 사라짐 ${left.length}` : ''}` };
}
export async function gateway() {
  const t0 = Date.now();
  const { code, out } = await run([path.join(REPO, 'worker', 'gateway.test.mjs')]);
  const ok = (out.match(/^\s*PASS/gm) || []).length, fail = (out.match(/^\s*FAIL/gm) || []).length;
  return { pass: code === 0 && ok > 0 && !fail, ok, fail, sec: Math.round((Date.now() - t0) / 1000), note: `통과 ${ok} 실패 ${fail}` };
}
