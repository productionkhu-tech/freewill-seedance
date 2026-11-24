// 시험이 쓰는 것 — ok(확인) · done(끝). 틀리면 그 순간의 화면 · 상태를 남긴다(글: "실패하면 단계 · 화면 · 쉬운 설명").
import fs from 'node:fs';
import path from 'node:path';
import { lastConnection } from './cdp.mjs';

export { sleep } from './cdp.mjs';
const NAME = path.basename(process.argv[1] || 'case', '.mjs');
const OUT = process.env.HARNESS_EVIDENCE || '';
let fails = 0, n = 0, last = '(시작)';
const pending = [];

async function evidence(title) {
  const c = lastConnection();
  if (!c || !OUT) return;
  const base = path.join(OUT, `${NAME}-${pending.length + 1}`);
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  try { const r = await within(c.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }), 8000); if (r) fs.writeFileSync(`${base}.jpg`, Buffer.from(r.data, 'base64')); } catch { /* 화면이 없으면 글만 */ }
  let state = '';
  try { state = await within(c.ev(`JSON.stringify({ 주소: location.href, 칸: [...document.querySelectorAll('div')].filter((d) => String(d.className).includes('rounded-[11px]')).slice(0, 6).map((d) => d.textContent.slice(0, 60)), 카드: [...document.querySelectorAll('[id^=msg-]')].slice(-3).map((d) => d.textContent.replace(/\\s+/g, ' ').slice(0, 160)) })`, { timeout: 5000 }), 6000) || ''; } catch { /* 글 없이 */ }
  fs.writeFileSync(`${base}.txt`, `${title}\n바로 앞에 맞은 확인: ${last}\n${state}\n`);
}

export function ok(name, cond, detail) {
  n++;
  const d = detail === undefined ? '' : ` → ${JSON.stringify(detail).slice(0, 600)}`;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${d}`);
  if (cond) { last = name; return true; }
  fails++;
  pending.push(evidence(`틀린 확인: ${name}${d}`));
  return false;
}
/** 확인하지 못한 것 — 통과로 치지 않고 따로 센다(글: 어떻게 확인했는지에 "안 함" 도 적는다). */
export function skip(name, why) { console.log(`SKIP ${name} → ${why}`); }

export async function done() {
  await Promise.allSettled(pending);
  console.log(n === 0 ? '\n확인한 것이 없음' : fails ? `\n${fails} FAIL` : '\nALL OK');
  process.exitCode = fails || n === 0 ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode), 100);
  await new Promise(() => {});
}
async function stopped(e) {
  console.log(`STOP 도중에 멈춤 — 바로 앞에 맞은 확인: ${last}\n     ${String((e && (e.stack || e.message)) || e).split('\n').slice(0, 4).join('\n     ')}`);
  await evidence(`도중에 멈춤: ${e && e.message}`).catch(() => {});
  process.exit(2);
}
process.on('uncaughtException', (e) => { void stopped(e); });
process.on('unhandledRejection', (e) => { void stopped(e); });
