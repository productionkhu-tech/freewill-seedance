// 시험을 시험한다 — 앱 코드의 사본을 일부러 한 곳씩 망가뜨리고, 맡은 시험이 잡는지 본다(글: 검사하는 것을 검사하기).
//   node tests/harness/break-check.mjs [--only 이름] [--slots 2] [--plan]
// 저장소는 건드리지 않는다(사본만). 실제로 났던 버그나 나면 크게 다치는 곳만 적는다. 못 잡으면 시험을 고친다.
// 먼저 '안 망가뜨린 사본' 에서 그 시험이 통과하는지도 본다 — 원래 깨져 있던 걸 잡았다고 하지 않게.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA, HARNESS, startSlot, stopSlot, slotFree } from './lib/app.mjs';
import { makeFixtures } from './lib/fixtures.mjs';
import { dropTree, makeTree, mutate } from './lib/tree.mjs';
import { friction } from './lib/friction.mjs';

const S = 'src/lib/send-request.ts', C = 'src/lib/bp-certify.ts', P = 'src/lib/same-pixels.ts';
const BREAKS = [
  ['자동 인증이 같은 그림을 못 알아봄', 'same-picture', S, 'pick = (im) => isPhotoOf(im, plan.src.cacheId);', "pick = (im) => (im.libId || '').slice(0, 12) === (plan.src.cacheId || '').slice(0, 12);"],
  ['점 하나 다른 사진을 같다고 함', 'same-picture', P, "const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', all));", "const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(32)));"],
  ['움직이는 PNG 를 멈춘 그림으로 봄', 'same-picture', P, "if (t === 'acTL') return null;", ''],
  ['캐시 정리해도 영상 기록이 남음', 'video-record', 'src/components/Sidebar.tsx', 'if (mediaOk) forgetAllVideos();', ''],
  ['다른 팀 프로젝트의 기록을 씀', 'video-record', C, 'const v = videoAssets.get(vKey(scope, cacheId));', 'const v = [...videoAssets].find(([k]) => k.endsWith(`:${contentKey(cacheId)}`))?.[1];'],
  ['첫 · 끝 프레임 순서(옛 버그)', 'frames', S, 'const currentAssets = assets.length > 1 && assets.every(a => a.role in FRAME_RANK)', 'const currentAssets = assets.length < 0 && assets.every(a => a.role in FRAME_RANK)'],
  ['기다리는 사이 코드가 바뀌어도 보냄', 'cancel', S, '          if (why) { failed(sysMsgId, `${why}\\n\\n(자동 인증은', '          if (false as boolean) { failed(sysMsgId, `${why}\\n\\n(자동 인증은'],
  ['취소해도 다시 보냄', 'cancel', S, "if (!card || card.status === 'failed') return;", 'if (!card) return;'],
  ['저작권 막힘도 자동 인증하려 함', 'auto-certify', S, 'const face = /PrivacyInformation|real person/i.test(err);', 'const face = /PrivacyInformation|real person|PolicyViolation/i.test(err);'],
  ['막힌 칸을 6번까지만 고침(옛 버그)', 'modes', S, 'const MAX_FIX = Math.min(16,', 'const MAX_FIX = Math.min(6,'],
  ['정리 확인을 10분마다', 'evict-watch', C, 'setInterval(run, 60 * 60_000)', 'setInterval(run, 10 * 60_000)'],
  ['대기열이 꽉 차면 카드를 실패시킴(옛 동작)', 'busy-line', S, 'busy: isLineFull(res.status, data) };', 'busy: false };'],
  ['줄에서 취소해도 보냄', 'busy-line', 'src/lib/busy-line.ts', 'for (let i = line.length - 1; i >= 0; i--) if (!line[i].w.wanted()) line.splice(i, 1)[0].w.left?.(false);', ''],
  ['쓰기 한도(안 풀리는 429)도 줄에 세움', 'busy-line', 'src/lib/busy-line.ts', '  return !/SetLimit|Overdue', '  return true || !/SetLimit|Overdue'],
  ['기다린 카드가 저마다 물어봄', 'busy-line', 'src/lib/busy-line.ts', '  if (pumping) return;', ''],
  ['보내던 중 끊긴 것도 다시 보냄(두 번 과금)', 'busy-line', 'server.ts', 'if (!neverSent(e)) throw e;', ''],
  ['줄에 선 카드의 파일을 붙잡지 않음', 'busy-line', 'server.ts', 'for (const k of keys) r2KeyRefCount.set(k, (r2KeyRefCount.get(k) || 0) + 1);', ''],
  ['줄에서 기다린 카드도 코드를 다시 안 봄', 'busy-line', S, '          if (why) { failed(sysMsgId, `${why}\\n\\n(BytePlus 대기열', '          if (false as boolean) { failed(sysMsgId, `${why}\\n\\n(BytePlus 대기열'],
  ['본편이 대기열에 막히면 실패', 'busy-line', 'src/components/ChatArea.tsx', "if (isLineFull(res.status, data)) { busyError = byteplusErrorText(data); return 'busy'; }", ''],
  ['정리 뒤 옛 번호를 돌려줌(옛 버그)', 'evict', 'worker/seedance-gateway.js', 'try { await env.SD_TOKENS.delete(`ast:lock:${project}:${x.Name}`); } catch {}', ''],
];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1] || true; };
const list = BREAKS.filter(([name, c]) => !arg('only', '') || String(arg('only')).split(',').some((x) => name.includes(x) || c === x));
// 자리가 아직 있는지 먼저 다 본다(앱을 띄우기 전에)
const probe = makeTree('break-probe');
let stale = 0;
for (const [name, , file, find, rep] of list) { const raw = fs.readFileSync(path.join(probe, file), 'utf8'); try { mutate(probe, file, find, rep); } catch (e) { stale++; console.log(`STALE ${name} → ${e.message}`); } fs.writeFileSync(path.join(probe, file), raw); }
if (arg('plan', false) || stale) { console.log(`${list.length}가지 · 자리 없음 ${stale}`); process.exit(stale ? 1 : 0); }

makeFixtures();
const queue = [];
if (!arg('no-control', false)) for (const c of [...new Set(list.map((x) => x[1]))]) queue.push({ name: `(안 망가뜨림) ${c}`, c, want: 'pass' });
for (const [name, c, file, find, rep] of list) queue.push({ name, c, file, find, rep, want: 'fail' });
const runCase = (slot, c) => new Promise((r) => {
  let text = '';
  const p = spawn(process.execPath, [path.join(HARNESS, 'cases', `${c}.mjs`)], { cwd: HARNESS, env: { ...process.env, HARNESS_SLOT: String(slot), HARNESS_EVIDENCE: '' }, windowsHide: true });
  p.stdout.on('data', (x) => { text += x; }); p.stderr.on('data', (x) => { text += x; });
  const t = setTimeout(() => { text += '\nTIMEOUT'; p.kill(); }, 15 * 60_000);
  p.on('close', (code) => { clearTimeout(t); r({ code, text }); });
});
let bad = 0;
const broken = new Set(), used = [];
async function worker(n) {
  await new Promise((r) => setTimeout(r, n * 15_000));
  let slot = 0;
  for (let s = 1; s <= 12 && !slot; s++) if (!used.includes(s) && await slotFree(s)) { used.push(s); slot = s; }
  if (!slot) return;
  for (let q; (q = queue.shift());) {
    const dir = makeTree(`break-${slot}-${Date.now()}`);
    if (q.find) mutate(dir, q.file, q.find, q.rep);
    try { await startSlot(slot, { repo: dir }); } catch (e) { dropTree(dir); bad++; console.log(`--   ${q.name} → 시작 못 함 ${e.message}`); continue; }
    const t0 = Date.now(), r = await runCase(slot, q.c);
    await stopSlot(slot);
    dropTree(dir);
    const ok = (r.text.match(/^ok /gm) || []).length, fails = r.text.split('\n').filter((l) => /^(FAIL|STOP|TIMEOUT)/.test(l));
    const sec = Math.round((Date.now() - t0) / 1000);
    const caught = fails.some((l) => l.startsWith('FAIL'));
    if (q.want === 'pass') {
      const good = r.code === 0 && ok && !fails.length;
      if (!good) { bad++; broken.add(q.c); }
      console.log(`${good ? 'ok  ' : 'FAIL'} ${q.name} → ${good ? `통과 ok ${ok}` : `원래 코드에서도 안 됨: ${(fails[0] || '').slice(0, 160)}`}  ${sec}초`);
    } else {
      if (!caught) bad++;
      console.log(`${caught ? 'ok  ' : 'FAIL'} ${q.name} → ${caught ? `${q.c} 이(가) 잡음: ${fails.find((l) => l.startsWith('FAIL')).slice(5, 110)}` : fails.length ? `잡은 게 아니라 멈춤: ${fails[0].slice(0, 140)}` : `${q.c} 이(가) 못 잡음(ok ${ok})`}  ${sec}초`);
    }
    friction({ kind: 'break', case: q.c, name: q.name, caught, sec });
  }
}
const runs = await Promise.allSettled(Array.from({ length: Math.max(1, Math.min(4, Number(arg('slots', 2)))) }, (_, n) => worker(n)));
for (const r of runs) if (r.status === 'rejected') { bad++; console.log(`STOP 도중에 멈춤 — ${r.reason.message}`); }
for (const s of used) await stopSlot(s);
if (queue.length) { bad++; console.log(`못 돌린 것 ${queue.length}: ${queue.map((q) => q.name).join(' · ')}`); }
console.log(`\n${broken.size ? `원래 코드에서 안 되는 시험 ${[...broken].join(', ')} — 그 시험의 '잡음' 은 믿지 말 것\n` : ''}${bad ? `${bad} FAIL` : `ALL OK — ${list.length}가지 모두 잡음`}`);
process.exit(bad ? 1 : 0);
