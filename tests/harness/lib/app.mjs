// 시험 앱 한 벌(가짜 BytePlus + 진짜 게이트웨이 코드 + 진짜 앱) 켜고 끄기.
// 끄기: 이 하네스가 켠 것만 — 명령줄에 이 슬롯의 표가 있는 것, 켤 때 적어 둔 번호 · 시작한 때와 모두 같은 것, 그 자손. 모르는 것이 포트를 쓰면 다른 슬롯을 쓴다.
// (11/25: taskkill /T 로 나무째 껐더니 앱이 먼저 죽으면 서버가 남았다 → 자손을 먼저 다 적고 하나씩 끈다.)
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portsOf } from './ports.mjs';
import { sleep } from './cdp.mjs';

export const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = process.env.HARNESS_REPO ? path.resolve(process.env.HARNESS_REPO) : path.resolve(HARNESS, '..', '..');
// 데이터는 저장소 밖 임시 폴더 — vite · Tailwind 가 저장소를 훑고, 앱 데이터가 수백 MB 라서
export const DATA = path.join(os.tmpdir(), 'fw-harness', crypto.createHash('md5').update(REPO.toLowerCase()).digest('hex').slice(0, 8));
const ID = path.basename(DATA);
// 명령줄에 붙이는 표 — 한글 경로는 PowerShell 을 거치면 깨져서 경로로는 못 알아본다
const markOf = (s) => `--fw-harness=${ID}-${s}`;
const runFile = (s) => path.join(DATA, `slot${s}.json`);

const free = (port) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(port, '127.0.0.1', () => s.close(() => r(true))); });
export const slotFree = async (s) => (await Promise.all(Object.values(portsOf(s)).map(free))).every(Boolean);

// 지금 떠 있는 것 모두(번호 · 부모 · 시작한 때 · 명령줄에 우리 표가 있나) — 한 번에 읽는다
function processes() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | ForEach-Object { $m = ''; if ($_.CommandLine -match '--fw-harness=([0-9a-f]+-[0-9]+)') { $m = $Matches[1] }; '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.Ticks, $m }"], { encoding: 'utf8', maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map((l) => l.trim().split(' ')).filter((x) => x.length >= 3).map(([pid, parent, at, mark]) => ({ pid: +pid, parent: +parent, at: BigInt(at), mark: mark || '' }));
  } catch { return []; }
}
// 우리 것: 명령줄에 이 슬롯의 표가 있거나, 켤 때 적어 둔 것과 번호 · 시작한 때가 모두 같거나, 그 자손(부모보다 나중에 시작한 것만 — 번호가 다시 쓰인 남의 것을 자손으로 보지 않게).
function ours(s, run, all) {
  const mark = markOf(s).slice('--fw-harness='.length), noted = new Map((run.kin || []).map((k) => [k.pid, k.at]));
  const mine = new Map(all.filter((p) => p.mark === mark || (noted.has(p.pid) && noted.get(p.pid) === String(p.at))).map((p) => [p.pid, p]));
  for (let grew = true; grew;) { grew = false; for (const p of all) { const up = mine.get(p.parent); if (up && !mine.has(p.pid) && p.at >= up.at) { mine.set(p.pid, p); grew = true; } } }
  return [...mine.values()];
}
const readRun = (s) => { try { return JSON.parse(fs.readFileSync(runFile(s), 'utf8')); } catch { return null; } };
/** 앱 본체가 먼저 죽어도 남은 서버를 알아볼 수 있게, 뜬 뒤 자손의 번호 · 시작한 때를 적어 둔다. */
function noteKin(s) {
  const run = readRun(s);
  if (!run) return;
  run.kin = ours(s, run, processes()).map((p) => ({ pid: p.pid, at: String(p.at) }));
  fs.writeFileSync(runFile(s), JSON.stringify(run));
}
export async function stopSlot(s) {
  const run = readRun(s);
  if (!run) return;
  for (let round = 0; round < 3; round++) {   // 끄는 사이 새로 뜬 자손까지
    const list = ours(s, run, processes());
    if (!list.length) break;
    run.kin = [...(run.kin || []), ...list.map((p) => ({ pid: p.pid, at: String(p.at) }))];
    for (const p of list.sort((x, y) => (x.at < y.at ? 1 : -1))) { try { execFileSync('taskkill', ['/PID', String(p.pid), '/F'], { stdio: 'ignore' }); } catch { /* 이미 끝남 */ } }
    await sleep(400);
  }
  for (let i = 0; i < 20 && !(await slotFree(s)); i++) await sleep(300);
  if (await slotFree(s)) fs.rmSync(runFile(s), { force: true });   // 못 비웠으면 적어 둔 것을 남겨 다음에 다시
}

// 앱은 개발 방식일 때 서버를 'npx tsx server.ts' 로 켠다. Node 의 npx.cmd 는 안에서 또 명령(FOR /F … CALL)을 부르는데 그게 가끔 실패해 서버가 안 떴다
// (11/25 마찰 기록 — 네 번 중 두 번). 시험에서는 PATH 맨 앞에 곧장 tsx 를 켜는 npx.cmd 를 둔다. 설치본은 이 길을 안 쓴다.
function withDirectNpx(env) {
  const bin = path.join(DATA, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'npx.cmd'), ['@"%FW_NODE%" "%REPO%', 'node_modules', 'tsx', 'dist', 'cli.mjs" %2 %3 %4'].join(String.fromCharCode(92)) + String.fromCharCode(13, 10));
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'Path';
  return { ...env, FW_NODE: process.execPath, [key]: `${bin}${path.delimiter}${env[key] || ''}` };
}
const upNow = async (p) => {
  try {
    if (!(await fetch(`http://127.0.0.1:${p.app}/api/agent/manual`, { signal: AbortSignal.timeout(3000) })).ok) return false;
    return (await (await fetch(`http://127.0.0.1:${p.cdp}/json`, { signal: AbortSignal.timeout(3000) })).json()).some((t) => t.url.includes(`:${p.app}/`));
  } catch { return false; }
};

/** 켠다. repo: 다른 코드(비교 · 망가뜨리기)로도 켤 수 있다. onTry(왜): 다시 켤 때마다 — 마찰 기록용. */
export async function startSlot(s, { repo = REPO, clips = path.join(DATA, 'fixtures', 'clips'), tries = 3, onTry = () => {} } = {}) {
  const p = portsOf(s), root = path.join(DATA, `slot${s}`);
  const logs = path.join(DATA, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  for (let n = 1; n <= tries; n++) {
    await stopSlot(s);
    if (!(await slotFree(s))) throw new Error(`${s}번 슬롯의 포트를 이 하네스가 켜지 않은 것이 쓰고 있음`);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    fs.mkdirSync(root, { recursive: true });
    const token = path.join(root, 'gw.token');
    const env = { ...process.env, REPO: repo, FAKE_PORT: String(p.fake), FAKE_CLIPS: clips, GW_PORT: String(p.gw), HARNESS_ROOT: root, HARNESS_FAKE: `http://127.0.0.1:${p.fake}`, HARNESS_APP_PORT: String(p.app), HARNESS_HOOK_PORT: String(p.hook), HARNESS_CDP_PORT: String(p.cdp), DISABLE_HMR: 'true' };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = (name, exe, args, e = env) => {
      const out = fs.openSync(path.join(logs, `slot${s}-${name}.log`), 'w');
      const c = spawn(exe, [...args, markOf(s)], { cwd: repo, env: e, stdio: ['ignore', out, out], windowsHide: true });
      c.on('error', () => {});
      c.unref();
      fs.writeFileSync(runFile(s), JSON.stringify({ at: Date.now() }));
      return c;
    };
    run('fake', process.execPath, [path.join(HARNESS, 'fakes', 'byteplus.mjs')]);
    run('gateway', process.execPath, [path.join(HARNESS, 'fakes', 'gateway.mjs'), token]);
    for (let i = 0; i < 60 && !fs.existsSync(token); i++) await sleep(300);
    let why = '';
    if (!fs.existsSync(token)) why = '게이트웨이가 안 뜸';
    else {
      let ended = null;
      const app = run('app', path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [path.join(HARNESS, 'fakes', 'app.cjs')],
        { ...withDirectNpx(env), SEEDANCE_ASSETS_TEST_GATEWAY: `http://127.0.0.1:${p.gw}`, SEEDANCE_ASSETS_TEST_TOKEN: fs.readFileSync(token, 'utf8').trim() });
      app.on('exit', (code) => { ended = code; });
      for (const t0 = Date.now(); Date.now() - t0 < 90_000 && ended === null;) {
        if (await upNow(p)) { noteKin(s); return { slot: s, tries: n }; }
        await sleep(1000);
      }
      const log = fs.existsSync(path.join(logs, `slot${s}-app.log`)) ? fs.readFileSync(path.join(logs, `slot${s}-app.log`), 'utf8') : '';
      why = ended !== null ? `앱이 ${ended} 로 끝남` : /npm-prefix|is not recognized|npx/i.test(log) && !/localhost:/.test(log) ? '앱 서버가 안 뜸(npx)' : '90초 안에 안 뜸';
    }
    try { fs.copyFileSync(path.join(logs, `slot${s}-app.log`), path.join(logs, `slot${s}-app-안뜸-${Date.now()}.log`)); } catch { /* 없으면 말고 */ }
    onTry(why);
  }
  await stopSlot(s);
  throw new Error(`시험 앱이 ${tries}번 안에 안 뜸(${s}번 슬롯)`);
}
