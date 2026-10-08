// seedance-gateway v3 시험 — 워커를 그대로 불러 가짜 KV 로 돌린다. Cloudflare · BytePlus · 진짜 키는 안 쓴다.
//   node worker/gateway.test.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const worker = (await import(pathToFileURL(path.join(HERE, 'seedance-gateway.js')).href)).default;

let pass = 0, fail = 0;
const ok = (c, name, d = '') => { c ? pass++ : fail++; console.log(`  ${c ? 'PASS' : 'FAIL'}  ${name}${d ? '  — ' + d : ''}`); };

class MemKV {
  constructor() { this.m = new Map(); this.reads = 0; this.writes = 0; }
  async get(k) { this.reads++; const v = this.m.get(k); return v ? v.value : null; }
  async put(k, value, o = {}) { this.writes++; this.m.set(k, { value: String(value), metadata: o.metadata }); }
  async list({ prefix = '', cursor } = {}) {
    const keys = [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, v]) => ({ name, metadata: v.metadata }));
    return { keys, list_complete: true, cursor };
  }
}

const hmac = (k, m) => crypto.createHmac('sha256', k).update(m).digest('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const ticket = (key) => hmac(key, 'seedance-ticket-v1');

// 가짜 값 — 'k-' 로 시작하는 건 응답에 새면 안 되는 값(관리 화면 · 목록 · 오류문)
const KEY_T6 = 'k-bp-team6-aaaaaaaa', KEY_TA = 'k-bp-teamTA-bbbbbbb', KEY_SP = 'k-bp-special-ccccc';
const baseEnv = () => ({
  SD_TOKENS: new MemKV(),
  ADMIN_KEY: 'k-admin-zzzz',
  BP_KEY_T6: KEY_T6, BP_KEY_TA: KEY_TA, BP_KEY_Special: KEY_SP,
  R2_ENDPOINT: 'https://acct.r2.cloudflarestorage.com', R2_BUCKET: 'refs', R2_ACCESS_KEY_ID: 'k-r2-id', R2_SECRET: 'k-r2-secret-1',
  NCP_ENDPOINT: 'https://kr.object.ncloudstorage.com', NCP_REGION: 'kr-standard', NCP_BUCKET: 'videos',
  NCP_ACCESS_KEY_ID: 'k-ncp-id', NCP_SECRET_ACCESS_KEY: 'k-ncp-secret', NCP_PRESIGN_EXPIRES_SECONDS: '3600',
  TRACKER_URL: 'https://script.google.com/macros/s/TEST/exec',
  GEMINI_KEY: 'k-gemini-1',
  ENROLL_OPEN: '1',
});
const SECRET_VALUES = (env) => Object.entries(env).filter(([, v]) => typeof v === 'string' && v.startsWith('k-')).map(([, v]) => v);

async function call(env, method, p, { body, token, raw, ip } = {}) {
  const waits = [];
  const ctx = { waitUntil: (pr) => waits.push(pr) };
  const headers = {};
  if (ip) headers['CF-Connecting-IP'] = ip;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
  const req = new Request('https://gw.test' + p, { method, headers, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const res = await worker.fetch(req, env, ctx);
  await Promise.all(waits);
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: res.status, j, text, headers: res.headers };
}

console.log('\n[1] v1 길(/ncp/credentials)은 그대로 — 깔려 있는 앱(801 이하)이 쓴다');
{
  const env = baseEnv();
  const ts = Date.now();
  const r = await call(env, 'POST', '/ncp/credentials', { body: { ts, sig: hmac(env.R2_SECRET, `ncp:${ts}`), team: '' } });
  ok(r.status === 200 && r.j.ok && r.j.accessKeyId === 'k-ncp-id' && r.j.bucket === 'videos' && r.j.presignExpiresSeconds === 3600, 'R2 서명 → NCP 자격 증명(v1 모양)');
  const bad = await call(env, 'POST', '/ncp/credentials', { body: { ts, sig: hmac('wrong', `ncp:${ts}`) } });
  ok(bad.status === 403, '틀린 서명 403');
  const old = await call(env, 'POST', '/ncp/credentials', { body: { ts: ts - 10 * 60 * 1000, sig: hmac(env.R2_SECRET, `ncp:${ts - 600000}`) } });
  ok(old.status === 401, '시계 5분 넘게 어긋남 401');
  const closed = await call({ ...env, LEGACY_NCP: '0' }, 'POST', '/ncp/credentials', { body: { ts, sig: hmac(env.R2_SECRET, `ncp:${ts}`) } });
  ok(closed.status === 410, 'LEGACY_NCP=0 이면 410');
  const h = await call(env, 'GET', '/health');
  ok(h.j.configured === true && h.j.bucket === 'videos' && h.j.version === 3 && !SECRET_VALUES(env).some((v) => h.text.includes(v)), '/health — v1 필드 그대로, 값 없음');
}

console.log('\n[2] 등록 — 팀 bat 의 키로 만든 입장권 → 출입증');
const env = baseEnv();
let tok6, id6;
{
  const r = await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'PC-6팀-01', app: '26.10.802' } });
  ok(r.status === 200 && r.j.ok && r.j.token.startsWith('sfv_') && r.j.team === 'T6' && r.j.label === '6팀', '6팀 키 → T6 · 6팀', `${r.j && r.j.team} ${r.j && r.j.label}`);
  tok6 = r.j.token; id6 = r.j.token_id;
  const stored = env.SD_TOKENS.m.get(`tok:${id6}`).value;
  ok(!stored.includes(tok6) && JSON.parse(stored).h === sha(tok6), 'KV 에 출입증 원문 없음(해시만)');
  ok(!r.text.includes(KEY_T6), '응답에 키 원문 없음');
  const ta = await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_TA), pc: 'PC-TA' } });
  ok(ta.j.team === 'TA' && ta.j.label === 'TA팀', 'TA 코드 → TA팀');
  const sp = await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_SP), pc: 'PC-SP' } });
  ok(sp.j.label === 'Special팀', 'Special 코드 → Special팀');
  const unknown = await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket('k-not-a-team-key'), pc: 'x' } });
  ok(unknown.status === 403 && unknown.j.code === 'ticket', '모르는 키 403');
  const rawKey = await call(env, 'POST', '/v1/enroll', { body: { ticket: KEY_T6, pc: 'x' } });
  ok(rawKey.status === 400, '키 원문을 보내면 받지 않음(입장권 모양 아님)');
  const closed = await call({ ...env, ENROLL_OPEN: '0' }, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'x' } });
  ok(closed.status === 403 && closed.j.code === 'closed', 'ENROLL_OPEN=0 이면 닫힘');
  const dup = await call({ ...env, BP_KEY_T7: KEY_T6 }, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'x' } });
  ok(dup.status === 409, '같은 키가 두 팀에 있으면 추측하지 않고 409');
  const over = await call({ ...env, TEAM_LABELS: '{"T6":"6팀(영상)"}' }, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'x' } });
  ok(over.j.label === '6팀(영상)', 'TEAM_LABELS 로 이름을 정할 수 있음');
}

console.log('\n[3] 묶음 — 출입증으로 키 · 주소를 받는다');
let rev1;
{
  const r = await call(env, 'POST', '/v1/config', { token: tok6, body: { app: '26.10.802' } });
  const e = r.j && r.j.env;
  ok(r.status === 200 && e.SEEDANCE_API_KEY === KEY_T6 && e.SEEDANCE_TEAM === 'T6' && e.SEEDANCE_TEAM_LABEL === '6팀', '팀 키 · 팀 이름');
  ok(e.R2_ENDPOINT === env.R2_ENDPOINT && e.R2_BUCKET === 'refs' && e.R2_ACCESS_KEY_ID === 'k-r2-id' && e.R2_SECRET_ACCESS_KEY === 'k-r2-secret-1', 'R2 네 개(R2_SECRET → R2_SECRET_ACCESS_KEY)');
  ok(e.SEEDANCE_NCP_ACCESS_KEY_ID === 'k-ncp-id' && e.SEEDANCE_NCP_BUCKET === 'videos' && e.SEEDANCE_NCP_PRESIGN_EXPIRES_SECONDS === '3600', 'NCP');
  ok(e.SEEDANCE_TRACKER_URL === env.TRACKER_URL && e.SEEDANCE_TRACKER_SECRET === hmac('k-r2-secret-1', 'seedance-tracker-v1'), '시트 주소 · 서명 재료(앱 v1 과 같은 값)');
  ok(e.SEEDANCE_GEMINI_KEY === 'k-gemini-1' && !('SEEDANCE_BP_BASE' in e), '옴니 키 · 비운 값은 안 보냄');
  ok(r.headers.get('Cache-Control') === 'no-store', 'Cache-Control: no-store');
  ok(/^[0-9a-f]{12}$/.test(r.j.rev), '묶음 지문(rev)', r.j.rev);
  rev1 = r.j.rev;
  const rec = JSON.parse(env.SD_TOKENS.m.get(`tok:${id6}`).value);
  ok(rec.rev === rev1 && rec.app === '26.10.802' && rec.seen, '받은 기록(관리 화면용)');
  const ta = await call(env, 'POST', '/v1/config', { token: (await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_TA), pc: 'PC-TA2' } })).j.token });
  ok(ta.j.env.SEEDANCE_API_KEY === KEY_TA && ta.j.env.SEEDANCE_TEAM_LABEL === 'TA팀', '다른 팀은 자기 팀 키만');
}

console.log('\n[4] KV 쓰기는 아껴 쓴다 — 같은 묶음을 또 받으면 기록을 다시 쓰지 않는다');
{
  const w0 = env.SD_TOKENS.writes;
  for (let i = 0; i < 5; i++) await call(env, 'POST', '/v1/config', { token: tok6, body: { app: '26.10.802' } });
  ok(env.SD_TOKENS.writes === w0, '5번 받아도 쓰기 0', `쓰기 ${env.SD_TOKENS.writes - w0}`);
}

console.log('\n[5] 관리자가 값을 바꾸면 다음 실행에 새 값 — 시트 서명은 R2 키를 바꿔도 그대로');
{
  env.R2_SECRET = 'k-r2-secret-2'; env.R2_ENDPOINT = 'https://new.r2.cloudflarestorage.com';
  env.BP_KEY_T6 = 'k-bp-team6-NEWKEY';
  const r = await call(env, 'POST', '/v1/config', { token: tok6, body: { app: '26.10.802' } });
  const e = r.j.env;
  ok(e.SEEDANCE_API_KEY === 'k-bp-team6-NEWKEY' && e.R2_SECRET_ACCESS_KEY === 'k-r2-secret-2' && e.R2_ENDPOINT.includes('new.'), '새 팀 키 · 새 R2');
  ok(e.SEEDANCE_TRACKER_SECRET === hmac('k-r2-secret-1', 'seedance-tracker-v1'), '★ 시트 서명 재료는 처음 값 그대로(박아 둠) — R2 키를 바꿔도 시트 기록이 안 끊김');
  ok(r.j.rev !== rev1, '묶음 지문이 바뀜');
  ok(JSON.parse(env.SD_TOKENS.m.get(`tok:${id6}`).value).rev === r.j.rev, '받은 기록에 새 지문(관리자가 다 받았는지 본다)');
  ok(e.SEEDANCE_TEAM_LABEL === '6팀', '키를 바꿔도 팀 이름은 그대로');
}

console.log('\n[6] ★ 키를 재발급해도 옛 bat 으로 등록된다 — 입장권을 기억하므로');
{
  const r = await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'PC-6팀-새직원' } });
  ok(r.status === 200 && r.j.team === 'T6' && r.j.label === '6팀', '옛 6팀 키(재발급 전) 입장권 → 6팀');
  const c = await call(env, 'POST', '/v1/config', { token: r.j.token });
  ok(c.j.env.SEEDANCE_API_KEY === 'k-bp-team6-NEWKEY', '받는 키는 새 키');
  // 등록한 PC 가 하나도 없던 팀도 — 묶음 · 관리 화면이 지금 키의 입장권을 미리 기억해 둔다
  const env2 = baseEnv();
  const t = (await call(env2, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_TA), pc: 'p' } })).j.token;
  await call(env2, 'POST', '/v1/config', { token: t });   // 이때 Special 의 입장권도 기억
  env2.BP_KEY_Special = 'k-bp-special-NEW';
  const sp = await call(env2, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_SP), pc: 'p' } });
  ok(sp.status === 200 && sp.j.label === 'Special팀', '아무도 등록 안 한 팀(Special)도 재발급 뒤 옛 bat 으로 등록');
  delete env2.BP_KEY_Special;
  const gone = await call(env2, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_SP), pc: 'p' } });
  ok(gone.status === 403, '팀 키를 지우면 그 팀 입장권도 죽음');
}

console.log('\n[7] 끊기 · 모르는 출입증');
{
  const adm = { token: env.ADMIN_KEY };
  const rv = await call(env, 'POST', '/admin/revoke', { ...adm, body: { token_id: id6 } });
  ok(rv.status === 200 && rv.j.revoked, '관리자가 끊음');
  const c = await call(env, 'POST', '/v1/config', { token: tok6 });
  ok(c.status === 401 && c.j.code === 'revoked', "끊긴 PC 는 401 code='revoked'(앱은 다시 등록하지 않는다)");
  const u = await call(env, 'POST', '/v1/config', { token: 'sfv_nope' });
  ok(u.status === 401 && u.j.code === 'unknown', "모르는 출입증 401 code='unknown'(앱은 다시 등록해 본다)");
  const rs = await call(env, 'POST', '/admin/restore', { ...adm, body: { token_id: id6 } });
  const c2 = await call(env, 'POST', '/v1/config', { token: tok6 });
  ok(rs.status === 200 && c2.status === 200, '되살리기');
  const noAdmin = await call(env, 'GET', '/admin/tokens', { token: 'k-wrong' });
  ok(noAdmin.status === 401, '관리 길은 관리자 키 없으면 401');
}

console.log('\n[8] 관리 화면 — 값은 안 나온다');
{
  const s = await call(env, 'GET', '/admin/status', { token: env.ADMIN_KEY });
  const t = await call(env, 'GET', '/admin/tokens', { token: env.ADMIN_KEY });
  ok(s.status === 200 && s.j.teams.length === 3 && s.j.teams.every((x) => /^[0-9a-f]{8}$/.test(x.key8)), '팀 3개, 키는 해시 앞 8자만');
  ok(s.j.teams.every((x) => x.ticket), '지금 키의 입장권 모두 기억됨');
  ok(s.j.tracker.secret === 'pinned' && s.j.gemini === true && s.j.r2.keys === true, '설정 상태');
  ok(t.status === 200 && t.j.tokens.length >= 3 && t.j.tokens.every((x) => x.token_id && !('h' in x)), 'PC 목록(해시 없음)');
  const all = s.text + t.text;
  const leaked = SECRET_VALUES(env).filter((v) => all.includes(v));
  ok(leaked.length === 0 && !all.includes(tok6), '관리 응답에 키 · 출입증 값 없음', leaked.join(','));
  const page = await call(env, 'GET', '/admin');
  ok(page.status === 200 && page.headers.get('Content-Type').startsWith('text/html') && !SECRET_VALUES(env).some((v) => page.text.includes(v)), '관리 페이지(값 없음)');
  ok(/frame-ancestors|DENY/.test(page.headers.get('X-Frame-Options') || '') , '다른 사이트에 끼워 넣기 막음');
}

console.log('\n[9] 앞으로 생길 값(PC_*) · 게이트웨이 이사');
{
  env.PC_SEEDANCE_NEW_FEATURE_URL = 'https://x.example/a';
  env.PC_SEEDANCE_NEW_FEATURE_URL__TA = 'https://x.example/ta-only';
  env.PC_bad_name = 'nope';
  env.GATEWAY_URL = 'https://seedance-gateway-2.example.workers.dev';
  env.BP_BASE = 'https://ark.ap-northeast.bytepluses.com/api/v3';
  const c6 = await call(env, 'POST', '/v1/config', { token: tok6 });
  const t2 = (await call(env, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_TA), pc: 'PC-TA3' } })).j.token;
  const cta = await call(env, 'POST', '/v1/config', { token: t2 });
  ok(c6.j.env.SEEDANCE_NEW_FEATURE_URL === 'https://x.example/a' && cta.j.env.SEEDANCE_NEW_FEATURE_URL === 'https://x.example/ta-only', 'PC_<이름> → 전 팀, PC_<이름>__TA → TA 만');
  ok(!('bad_name' in c6.j.env) && !Object.keys(c6.j.env).some((k) => k.startsWith('PC_')), '이름 모양이 틀린 건 안 보냄');
  ok(c6.j.env.SEEDANCE_GATEWAY_URL === env.GATEWAY_URL && c6.j.env.SEEDANCE_BP_BASE === env.BP_BASE, '새 게이트웨이 주소 · BytePlus 주소');
  env.PC_SEEDANCE_API_KEY = 'k-should-not-win';
  const c7 = await call(env, 'POST', '/v1/config', { token: tok6 });
  ok(c7.j.env.SEEDANCE_API_KEY === 'k-bp-team6-NEWKEY', 'PC_* 가 정해진 이름(팀 키)을 덮지 못함');
}

console.log('\n[9b] 팀 바꿈(/v1/leave) · 입장권의 팀(/v1/ticket)');
{
  const e2 = baseEnv();
  const t = (await call(e2, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'PC-바꿈' } })).j;
  const l = await call(e2, 'POST', '/v1/leave', { token: t.token });
  const rec = JSON.parse(e2.SD_TOKENS.m.get(`tok:${t.token_id}`).value);
  ok(l.status === 200 && rec.revoked && rec.left === 'team-change', '옛 출입증을 내려놓음 — 끊김 + 팀 바꿈 표시');
  const after = await call(e2, 'POST', '/v1/config', { token: t.token });
  ok(after.status === 401 && after.j.code === 'revoked', '내려놓은 출입증으로는 못 받음');
  const list = await call(e2, 'GET', '/admin/tokens', { token: e2.ADMIN_KEY });
  ok(list.j.tokens.some((x) => x.left === 'team-change'), '관리 목록에 팀 바꿈으로 보임');
  await call(e2, 'POST', '/admin/restore', { token: e2.ADMIN_KEY, body: { token_id: t.token_id } });
  const back = JSON.parse(e2.SD_TOKENS.m.get(`tok:${t.token_id}`).value);
  ok(!back.revoked && !back.left, '되살리면 팀 바꿈 표시도 지움');
  const w0 = e2.SD_TOKENS.writes;
  const a = await call(e2, 'POST', '/v1/ticket', { body: { ticket: ticket(KEY_TA) } });
  ok(a.status === 200 && a.j.label === 'TA팀' && !('token' in a.j), '입장권 → 팀 이름(출입증은 안 줌)');
  const n = await call(e2, 'POST', '/v1/ticket', { body: { ticket: ticket('k-unknown') } });
  ok(n.status === 404 && n.j.code === 'ticket', '모르는 키 404');
  const raw = await call(e2, 'POST', '/v1/ticket', { body: { ticket: KEY_TA } });
  ok(raw.status === 400, '키 원문은 받지 않음');
  ok(!SECRET_VALUES(e2).some((v) => (a.text + n.text).includes(v)), '응답에 키 값 없음');
  e2.BP_KEY_TA = 'k-bp-teamTA-NEW';
  const old = await call(e2, 'POST', '/v1/ticket', { body: { ticket: ticket(KEY_TA) } });
  ok(old.status === 200 && old.j.label === 'TA팀', '재발급 전 키(옛 bat)도 어느 팀 것인지 앎');
  ok(e2.SD_TOKENS.writes - w0 <= 1, 'KV 쓰기는 입장권 기억 정도', `쓰기 ${e2.SD_TOKENS.writes - w0}`);
}

console.log('\n[9c] IP — 등록 · 묶음을 받은 곳(관리 화면용)');
{
  const e3 = baseEnv();
  const t = (await call(e3, 'POST', '/v1/enroll', { body: { ticket: ticket(KEY_T6), pc: 'PC-IP' }, ip: '203.0.113.7' })).j;
  ok(JSON.parse(e3.SD_TOKENS.m.get(`tok:${t.token_id}`).value).ip === '203.0.113.7', '등록할 때 IP 기록');
  await call(e3, 'POST', '/v1/config', { token: t.token, ip: '203.0.113.7' });
  const w0 = e3.SD_TOKENS.writes;
  await call(e3, 'POST', '/v1/config', { token: t.token, ip: '203.0.113.7' });
  ok(e3.SD_TOKENS.writes === w0, '같은 IP 로 또 받으면 쓰기 없음');
  await call(e3, 'POST', '/v1/config', { token: t.token, ip: '198.51.100.20' });
  const list = await call(e3, 'GET', '/admin/tokens', { token: e3.ADMIN_KEY });
  ok(list.j.tokens.find((x) => x.token_id === t.token_id).ip === '198.51.100.20', 'IP 가 바뀌면 새 IP 로(관리 목록)');
}

console.log('\n[10] 앱 v1 표와 같은 이름 — 워커 표가 server.ts 표를 그대로 옮겼나');
{
  const src = fs.readFileSync(path.join(HERE, 'seedance-gateway.js'), 'utf8');
  const srv = fs.readFileSync(path.join(HERE, '..', 'server.ts'), 'utf8');
  const pick = (s) => [...s.slice(s.indexOf(s.includes('KNOWN_LABELS = {') ? 'KNOWN_LABELS = {' : 'TEAM_KEY_HASHES')).matchAll(/'([0-9a-f]{64})':\s*'([^']+)'/g)].slice(0, 40).map((m) => m[1] + '=' + m[2]).sort().join('|');
  const a = pick(src), b = pick(srv);
  ok(a === b && a.split('|').length === 17, '17팀 해시 · 이름 일치');
}

console.log(`\n${fail ? '실패 ' + fail + ' / ' : ''}통과 ${pass}`);
process.exit(fail ? 1 : 0);
