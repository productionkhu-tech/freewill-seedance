// 앱(electron/gateway.cjs) ↔ 게이트웨이(worker/seedance-gateway.js) 를 한 프로세스에서 맞물려 돌린다.
// 네트워크 · Cloudflare · 진짜 키 · 레지스트리는 안 쓴다(가짜 KV · 가짜 암호 파일 · 가짜 값).
//   node scripts/gateway_check.mjs
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createGateway, ticketOf } = require(path.join(ROOT, 'electron', 'gateway.cjs'));
const worker = (await import(pathToFileURL(path.join(ROOT, 'worker', 'seedance-gateway.js')).href)).default;

let pass = 0, fail = 0;
const ok = (c, name, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };

class MemKV {
  constructor() { this.m = new Map(); }
  async get(k) { const v = this.m.get(k); return v ? v.value : null; }
  async put(k, value, o = {}) { this.m.set(k, { value: String(value), metadata: o.metadata }); }
  async list({ prefix = '' } = {}) { return { keys: [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata })), list_complete: true }; }
}

// 게이트웨이(워커) 한 대 — 관리자가 Cloudflare 에서 바꾸는 값이 gwEnv 다.
const BAT_KEY = 'k-bat-6team-original';
const gwEnv = {
  SD_TOKENS: new MemKV(), ADMIN_KEY: 'k-admin', ENROLL_OPEN: '1',
  BP_KEY_T6: BAT_KEY, BP_KEY_TA: 'k-bat-TA',
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET: 'refs', R2_ACCESS_KEY_ID: 'k-r2id', R2_SECRET: 'k-r2sec',
  NCP_ACCESS_KEY_ID: 'k-ncpid', NCP_SECRET_ACCESS_KEY: 'k-ncpsec', NCP_ENDPOINT: 'https://kr.object.ncloudstorage.com', NCP_BUCKET: 'v',
  TRACKER_URL: 'https://script.google.com/macros/s/X/exec', GEMINI_KEY: 'k-gem',
};
let down = false;            // true 면 게이트웨이에 닿지 못함(네트워크)
const seen = [];             // 앱이 부른 주소
const fetchImpl = async (url, init) => {
  seen.push(url);
  if (down) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { name: 'TypeError' });
  const waits = [];
  const res = await worker.fetch(new Request(url, init), gwEnv, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
};
const admin = (p, body) => worker.fetch(new Request('https://gw.test' + p, {
  method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer k-admin', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}), gwEnv, { waitUntil() {} }).then((r) => r.json());

// 이 PC 의 암호 파일(가짜) — 실행이 바뀌어도 남는다
const disk = { obj: {} };
let vaultBroken = false;
const vault = {
  read: () => JSON.parse(JSON.stringify(disk.obj)),
  write: (mutate) => { if (vaultBroken) return false; disk.obj = JSON.parse(JSON.stringify(mutate(JSON.parse(JSON.stringify(disk.obj))))); return true; },
};
// 앱 한 번 켜기 — 새 process.env(loadSecrets 가 bat 키를 올려 둔 상태)
const launch = (envExtra = {}, pc = 'user@PC-01') => {
  const env = { PATH: 'C:\\Windows', SEEDANCE_API_KEY: (disk.obj.keys || {}).SEEDANCE_API_KEY || BAT_KEY, ...envExtra };
  const g = createGateway({ vault, env, app: '26.10.802', pc, fetchImpl, timeoutMs: 2000 });
  return { env, g };
};
disk.obj.keys = { SEEDANCE_API_KEY: BAT_KEY };   // secrets.cjs 가 bat 키를 옮겨 둔 상태(환경변수는 지워짐)

console.log('\n[1] 처음 켬 — 보관본이 없으니 받을 때까지 기다린다');
{
  const { env, g } = launch();
  const r = await g.boot();
  ok(r.mode === 'gateway' && r.label === '6팀', '등록 → 묶음 받음', `${r.mode} ${r.label}`);
  ok(env.SEEDANCE_API_KEY === BAT_KEY && env.R2_SECRET_ACCESS_KEY === 'k-r2sec' && env.SEEDANCE_TEAM_LABEL === '6팀' && env.SEEDANCE_GEMINI_KEY === 'k-gem', '메모리에 키 · R2 · 팀 이름 · 옴니 키');
  ok(env.SEEDANCE_NCP_ACCESS_KEY_ID === 'k-ncpid' && env.SEEDANCE_TRACKER_URL.includes('script.google'), 'NCP · 시트 주소');
  ok(disk.obj.gw.token.startsWith('sfv_') && disk.obj.gw.config.rev === r.rev && disk.obj.keys.SEEDANCE_API_KEY === BAT_KEY, '암호 파일에 출입증 · 묶음, bat 키(입장권)는 그대로');
  ok(!JSON.stringify(r).includes('k-'), '반환값(로그용)에 값 없음');
}

console.log('\n[2] 다시 켬 — 보관본으로 바로 시작, 새 묶음은 뒤에서');
{
  const n = seen.length;
  const { env, g } = launch();
  const r = await g.boot();
  ok(r.mode === 'cache' && env.SEEDANCE_API_KEY === BAT_KEY && env.R2_BUCKET === 'refs', '기다리지 않고 보관본을 올림');
  const p = await r.pending;
  ok(p.mode === 'gateway' && p.changed === false, '뒤에서 받음 — 바뀐 것 없음');
  ok(seen.slice(n).filter((u) => u.endsWith('/v1/enroll')).length === 0, '다시 등록하지 않음(출입증 재사용)');
}

console.log('\n[3] 관리자가 Cloudflare 에서 키 · R2 를 바꿈 → 다음 실행에 새 값');
{
  gwEnv.BP_KEY_T6 = 'k-NEW-6team'; gwEnv.R2_SECRET = 'k-r2sec-NEW';
  const { env, g } = launch();
  const r = await g.boot();
  ok(env.SEEDANCE_API_KEY === BAT_KEY, '처음엔 보관본(옛 키)으로 시작');
  const p = await r.pending;
  ok(p.mode === 'gateway' && p.changed === true && env.SEEDANCE_API_KEY === 'k-NEW-6team' && env.R2_SECRET_ACCESS_KEY === 'k-r2sec-NEW', '뒤에서 새 키로 바뀜(서버는 다음 호출부터 새 키)');
  ok(env.SEEDANCE_TRACKER_SECRET && disk.obj.gw.config.env.SEEDANCE_API_KEY === 'k-NEW-6team', '보관본도 새 값');
}

console.log("\n[4] 실행 중 '키가 틀렸다' → 한 번 다시 받기 (2분에 한 번까지)");
{
  const { env, g } = launch();
  await (await g.boot()).pending;
  gwEnv.BP_KEY_T6 = 'k-NEWER-6team';
  const a = await g.refreshNow('BytePlus 401');
  ok(a.mode === 'gateway' && a.changed && env.SEEDANCE_API_KEY === 'k-NEWER-6team', '다시 받아 새 키');
  const b = await g.refreshNow('BytePlus 401');
  ok(b.mode === 'skipped', '곧바로 또 부르면 건너뜀(폭주 방지)');
}

console.log('\n[5] 게이트웨이가 죽음');
{
  down = true;
  const { env, g } = launch();
  const r = await g.boot();
  const p = await r.pending;
  ok(r.mode === 'cache' && p.mode === 'offline' && env.SEEDANCE_API_KEY === 'k-NEWER-6team', '보관본으로 그대로 켜짐');
  // 처음 켜는 PC 가 게이트웨이에 못 닿으면 — 예전처럼 bat 키로
  const saved = disk.obj; disk.obj = { keys: { SEEDANCE_API_KEY: BAT_KEY } };
  const l2 = launch({ R2_BUCKET: 'bat-bucket' });
  const r2 = await l2.g.boot();
  ok(r2.mode === 'offline' && l2.env.SEEDANCE_API_KEY === BAT_KEY && l2.env.R2_BUCKET === 'bat-bucket', '보관본도 없으면 지금처럼 bat 키로(앱은 켜진다)');
  disk.obj = saved; down = false;
}

console.log('\n[6] 관리자가 이 PC 를 끊음 → 보관본 · bat 키 모두 안 씀 / 되살리면 다시');
{
  const id = disk.obj.gw.tokenId;
  await admin('/admin/revoke', { token_id: id });
  const { env, g } = launch();
  const r = await g.boot();
  const p = await r.pending;
  ok(p.mode === 'revoked' && !env.SEEDANCE_API_KEY && !env.R2_SECRET_ACCESS_KEY && !env.SEEDANCE_GEMINI_KEY, '켠 뒤 끊김을 알면 메모리의 키를 거둠');
  ok(disk.obj.gw.cut && !disk.obj.gw.config, '보관본 지움 · 끊김 표시');
  const l2 = launch();
  const r2 = await l2.g.boot();
  ok(r2.mode === 'revoked' && !l2.env.SEEDANCE_API_KEY, '다음 실행 — 보관본으로 시작하지 않고 끊김');
  down = true;
  const l3 = launch();
  const r3 = await l3.g.boot();
  ok(r3.mode === 'revoked' && !l3.env.SEEDANCE_API_KEY, '끊긴 채 게이트웨이가 안 닿아도 끊긴 것으로');
  down = false;
  await admin('/admin/restore', { token_id: id });
  const l4 = launch();
  const r4 = await l4.g.boot();
  ok(r4.mode === 'gateway' && l4.env.SEEDANCE_API_KEY === 'k-NEWER-6team' && !disk.obj.gw.cut, '되살리면 다시 받음');
}

console.log('\n[7] 게이트웨이가 출입증을 모름(기록이 지워짐) → 저절로 다시 등록');
{
  for (const k of [...gwEnv.SD_TOKENS.m.keys()]) if (k.startsWith('tok:')) gwEnv.SD_TOKENS.m.delete(k);
  const old = disk.obj.gw.token;
  const { env, g } = launch();
  const p = await (await g.boot()).pending;
  ok(p.mode === 'gateway' && disk.obj.gw.token !== old && env.SEEDANCE_API_KEY === 'k-NEWER-6team', '옛 bat 키 입장권으로 다시 등록(키는 이미 재발급됨)');
}

console.log('\n[8] 게이트웨이를 옮김 → 다음 실행부터 새 주소');
{
  gwEnv.GATEWAY_URL = 'https://seedance-gateway-2.example.workers.dev';
  const a = launch();
  await (await a.g.boot()).pending;
  ok(disk.obj.gw.url === gwEnv.GATEWAY_URL, '새 주소를 암호 파일에 기억');
  const n = seen.length;
  const b = launch();
  await (await b.g.boot()).pending;
  ok(seen.slice(n).every((u) => u.startsWith(gwEnv.GATEWAY_URL)), '다음 실행은 새 주소로', seen.slice(n)[0]);
  delete gwEnv.GATEWAY_URL;
  disk.obj.gw.url = 'http://evil.example';   // https 가 아닌 주소는 안 믿는다
  const n2 = seen.length;
  const c = launch();
  await (await c.g.boot()).pending;
  ok(seen.slice(n2).every((u) => u.startsWith('https://seedance-gateway.production-khu.workers.dev')), 'https 가 아닌 주소는 무시하고 기본 주소');
}

console.log('\n[9] 게이트웨이가 위험한 이름을 보내도 안 받음 · 빠진 값은 되돌림');
{
  gwEnv.PC_NODE_OPTIONS = '--require evil.js';
  gwEnv.PC_SEEDANCE_PORT = '1';
  gwEnv.PC_SEEDANCE_FUTURE_THING = 'yes';
  const { env, g } = launch({ NODE_OPTIONS: '' });
  await (await g.boot()).pending;
  ok(env.NODE_OPTIONS === '' && !('SEEDANCE_PORT' in env), 'NODE_OPTIONS · SEEDANCE_PORT 는 버림');
  ok(env.SEEDANCE_FUTURE_THING === 'yes', '앞으로 생길 SEEDANCE_* 값은 받음');
  delete gwEnv.GEMINI_KEY; delete gwEnv.PC_SEEDANCE_FUTURE_THING;
  const a = await g.fetchBundle();
  ok(a.mode === 'gateway' && !('SEEDANCE_GEMINI_KEY' in env) && !('SEEDANCE_FUTURE_THING' in env), '묶음에서 빠진 값은 메모리에서도 빠짐', `${a.mode} ${a.why || ''} gem=${'SEEDANCE_GEMINI_KEY' in env} fut=${'SEEDANCE_FUTURE_THING' in env}`);
  delete gwEnv.PC_NODE_OPTIONS; delete gwEnv.PC_SEEDANCE_PORT;
}

console.log('\n[10] 등록이 닫혔거나 · 입장권이 없거나 · 암호 파일을 못 쓰면 — 지금처럼 bat 키로');
{
  const saved = disk.obj;
  gwEnv.ENROLL_OPEN = '0';
  disk.obj = { keys: { SEEDANCE_API_KEY: BAT_KEY } };
  const a = launch();
  const r = await a.g.boot();
  ok(r.mode === 'offline' && /closed/.test(r.why) && a.env.SEEDANCE_API_KEY === BAT_KEY, '등록 닫힘 → bat 키로', r.why);
  gwEnv.ENROLL_OPEN = '1';
  disk.obj = {};
  const b = launch({ SEEDANCE_API_KEY: 'managed-by-gateway' });
  const rb = await b.g.boot();
  ok(rb.mode === 'offline' && rb.why === 'no-ticket', "가짜값('managed-by-gateway')은 입장권으로 안 씀");
  vaultBroken = true;
  disk.obj = { keys: { SEEDANCE_API_KEY: BAT_KEY } };
  const c = launch();
  const rc = await c.g.boot();
  ok(rc.mode === 'offline' && rc.why === 'vault-write', '출입증을 못 남기면 쓰지 않음(켤 때마다 새로 등록하지 않게)');
  vaultBroken = false;
  disk.obj = saved;
}

console.log('\n[11] 입장권 = HMAC(bat 키) — 키 원문은 나가지 않는다');
{
  const bodies = [];
  const spy = async (url, init) => { bodies.push(String(init.body || '')); return fetchImpl(url, init); };
  const saved = disk.obj; disk.obj = { keys: { SEEDANCE_API_KEY: BAT_KEY } };
  const env = { SEEDANCE_API_KEY: BAT_KEY };
  await createGateway({ vault, env, app: 'x', pc: 'p', fetchImpl: spy }).boot();
  ok(bodies.length >= 2 && bodies.every((b) => !b.includes(BAT_KEY)) && bodies[0].includes(ticketOf(BAT_KEY)), '보낸 본문에 키 원문 없음, 입장권만');
  disk.obj = saved;
}

console.log('\n[12] ★ 다른 팀 bat 을 돌리고 다시 켬 → 그 팀으로 다시 등록, 옛 출입증은 팀 바꿈');
const TA_KEY = 'k-bat-TA';
const tokRec = (id) => JSON.parse(gwEnv.SD_TOKENS.m.get(`tok:${id}`).value);
{
  disk.obj = { keys: { SEEDANCE_API_KEY: BAT_KEY } };
  const a = launch();
  const ra = await a.g.boot();
  const oldId = disk.obj.gw.tokenId;
  ok(ra.mode === 'gateway' && ra.label === '6팀' && !!disk.obj.gw.enrolledWith, '6팀 bat 으로 등록(어느 bat 인지 기록)');
  disk.obj.keys.SEEDANCE_API_KEY = TA_KEY;            // TA bat 을 돌림 → secrets.cjs 가 새 키를 암호 파일로 옮김
  const n = seen.length;
  const b = launch({ SEEDANCE_API_KEY: TA_KEY });
  const rb = await b.g.boot();
  ok(rb.switched && rb.mode === 'gateway' && rb.label === 'TA팀' && b.env.SEEDANCE_API_KEY === TA_KEY && b.env.SEEDANCE_TEAM_LABEL === 'TA팀', 'TA팀으로 바뀜 · TA 키 · TA 이름', `${rb.mode} ${rb.label}`);
  ok(tokRec(oldId).left === 'team-change' && tokRec(oldId).revoked, '옛 6팀 출입증은 팀 바꿈으로 끊김');
  ok(disk.obj.gw.tokenId !== oldId && disk.obj.gw.config.env.SEEDANCE_TEAM === 'TA', '새 출입증 · TA 묶음 보관');
  ok(seen.slice(n).some((u) => u.endsWith('/v1/enroll')) && seen.slice(n).some((u) => u.endsWith('/v1/leave')), '등록 · 내려놓기 요청');
}

console.log('\n[13] 같은 bat 을 또 돌림 → 아무 일 없음');
{
  const n = seen.length;
  const c = launch({ SEEDANCE_API_KEY: TA_KEY });
  const rc = await c.g.boot();
  await rc.pending;
  ok(rc.mode === 'cache' && !rc.switched && c.env.SEEDANCE_TEAM_LABEL === 'TA팀', '보관본으로 바로 · 팀 그대로');
  ok(!seen.slice(n).some((u) => u.endsWith('/v1/enroll')), '다시 등록하지 않음');
}

console.log('\n[14] bat 을 바꿨는데 게이트웨이가 안 닿음 → 지금 팀으로 계속, 다음 실행에 바뀜');
{
  disk.obj.keys.SEEDANCE_API_KEY = BAT_KEY;
  down = true;
  const d = launch({ SEEDANCE_API_KEY: BAT_KEY });
  const rd = await d.g.boot();
  ok(rd.mode === 'cache' && d.env.SEEDANCE_TEAM_LABEL === 'TA팀', '보관본(TA)으로 켜짐 — 멈추지 않음', rd.mode);
  down = false;
  await rd.pending;
  const e = launch({ SEEDANCE_API_KEY: BAT_KEY });
  const re = await e.g.boot();
  ok(re.switched && re.label === '6팀' && e.env.SEEDANCE_TEAM_LABEL === '6팀', '닿는 다음 실행에 6팀으로 바뀜');
}

console.log('\n[15] 관리자가 끊은 PC 는 bat 을 돌려도 다시 등록하지 않음');
{
  const id = disk.obj.gw.tokenId;
  await admin('/admin/revoke', { token_id: id });
  // (가) 앱이 끊김을 아직 모르는 채로 다른 팀 bat 을 돌림 — 바꾸기 전에 물어보고 막는다
  disk.obj.keys.SEEDANCE_API_KEY = TA_KEY;
  let n = seen.length;
  const f = launch({ SEEDANCE_API_KEY: TA_KEY });
  const rf = await f.g.boot();
  ok(rf.mode === 'revoked' && !rf.switched && !f.env.SEEDANCE_API_KEY && disk.obj.gw.cut, '끊김을 몰랐어도 — 물어보고 끊긴 그대로(키 거둠)', rf.mode);
  ok(!seen.slice(n).some((u) => u.endsWith('/v1/enroll')), '다시 등록 안 함');
  // (나) 끊김을 이미 안 뒤(cut) 또 다른 bat — 묻지도 않고 끊긴 그대로
  disk.obj.keys.SEEDANCE_API_KEY = 'k-bat-other';
  n = seen.length;
  const f2 = launch({ SEEDANCE_API_KEY: 'k-bat-other' });
  const rf2 = await f2.g.boot();
  ok(rf2.mode === 'revoked' && !seen.slice(n).some((u) => u.endsWith('/v1/enroll')), '끊긴 걸 안 뒤에도 그대로');
  await admin('/admin/restore', { token_id: id });
  disk.obj.keys.SEEDANCE_API_KEY = BAT_KEY;
  const r3 = await launch({ SEEDANCE_API_KEY: BAT_KEY }).g.boot();
  ok(r3.mode === 'gateway' && !disk.obj.gw.cut, '되살리면 다시 받음(같은 bat)');
}

console.log('\n[16] 모르는 키의 bat → 지금 팀으로 계속');
{
  disk.obj.keys.SEEDANCE_API_KEY = 'k-garbage-key';
  const g = launch({ SEEDANCE_API_KEY: 'k-garbage-key' });
  const rg = await g.g.boot();
  ok(!rg.switched && (rg.mode === 'cache' || rg.mode === 'gateway') && g.env.SEEDANCE_TEAM_LABEL === '6팀', '6팀 그대로', `${rg.mode} ${g.env.SEEDANCE_TEAM_LABEL}`);
  disk.obj.keys.SEEDANCE_API_KEY = BAT_KEY;
}

console.log('\n[17] 어느 bat 으로 받았는지 기록이 없는 출입증(802 첫 시험판)');
{
  delete disk.obj.gw.enrolledWith;
  const h = launch({ SEEDANCE_API_KEY: BAT_KEY });
  const rh = await h.g.boot();
  ok(!rh.switched && disk.obj.gw.enrolledWith && h.env.SEEDANCE_TEAM_LABEL === '6팀', '같은 팀 bat — 물어보고 기록만 남김');
  delete disk.obj.gw.enrolledWith;
  disk.obj.keys.SEEDANCE_API_KEY = TA_KEY;            // 새 판을 깔기 전에 TA bat 을 돌려 둔 경우
  const i = launch({ SEEDANCE_API_KEY: TA_KEY });
  const ri = await i.g.boot();
  ok(ri.switched && ri.label === 'TA팀', '다른 팀 bat — 물어보고 그 팀으로 바뀜');
}

console.log('\n[18] 윈도우에서 PC 이름을 바꿈 → 앱은 그대로, 관리 화면 이름만 따라감');
{
  const before = disk.obj.gw.tokenId;
  const j = launch({ SEEDANCE_API_KEY: (disk.obj.keys || {}).SEEDANCE_API_KEY }, 'user@PC-새이름');
  const rj = await j.g.boot();
  const p = rj.pending ? await rj.pending : rj;
  ok(p.mode === 'gateway' && disk.obj.gw.tokenId === before && !rj.switched, '같은 출입증으로 그대로 받음(다시 등록 안 함)');
  ok(tokRec(before).pc === 'user@PC-새이름', '게이트웨이의 PC 이름이 새 이름으로');
}

console.log(`\n${fail ? '실패 ' + fail + ' / ' : ''}통과 ${pass}`);
process.exit(fail ? 1 : 0);
