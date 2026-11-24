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
  async put(k, value, o = {}) { this.writes++; this.m.set(k, { value: String(value), metadata: o.metadata, ttl: o.expirationTtl }); }
  async delete(k) { this.writes++; this.m.delete(k); }   // Cloudflare 도 지우기를 쓰기로 센다
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

const RESP = [];   // 모든 응답 본문 — 어셋 서명 키가 어디에도 안 나갔나 마지막에 본다
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
  RESP.push(text);
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
  // PC 이름을 바꿈(앱 803~ 은 켤 때마다 지금 이름을 보낸다) — 표시만 바뀌고 출입증은 그대로
  const w1 = e3.SD_TOKENS.writes;
  await call(e3, 'POST', '/v1/config', { token: t.token, ip: '198.51.100.20', body: { app: '26.10.803', pc: 'user@PC-새이름' } });
  const rec2 = JSON.parse(e3.SD_TOKENS.m.get(`tok:${t.token_id}`).value);
  ok(rec2.pc === 'user@PC-새이름' && e3.SD_TOKENS.writes === w1 + 1, 'PC 이름이 바뀌면 관리 화면 이름도(쓰기 한 번)');
  const w2 = e3.SD_TOKENS.writes;
  await call(e3, 'POST', '/v1/config', { token: t.token, ip: '198.51.100.20', body: { app: '26.10.803', pc: 'user@PC-새이름' } });
  ok(e3.SD_TOKENS.writes === w2, '같은 이름이면 쓰기 없음');
  await call(e3, 'POST', '/v1/config', { token: t.token, ip: '198.51.100.20', body: { app: '26.10.803' } });
  ok(JSON.parse(e3.SD_TOKENS.m.get(`tok:${t.token_id}`).value).pc === 'user@PC-새이름', '이름을 안 보내는 앱(802)은 이름을 안 건드림');
}

console.log('\n[10] 앱 v1 표와 같은 이름 — 워커 표가 server.ts 표를 그대로 옮겼나');
{
  const src = fs.readFileSync(path.join(HERE, 'seedance-gateway.js'), 'utf8');
  const srv = fs.readFileSync(path.join(HERE, '..', 'server.ts'), 'utf8');
  const pick = (s) => [...s.slice(s.indexOf(s.includes('KNOWN_LABELS = {') ? 'KNOWN_LABELS = {' : 'TEAM_KEY_HASHES')).matchAll(/'([0-9a-f]{64})':\s*'([^']+)'/g)].slice(0, 40).map((m) => m[1] + '=' + m[2]).sort().join('|');
  const a = pick(src), b = pick(srv);
  ok(a === b && a.split('|').length === 17, '17팀 해시 · 이름 일치');
}

// ────────────────────────────────────────────────────────────────── 어셋
// 가짜 BytePlus — 요청마다 서명을 노드 crypto(createHmac)로 따로 다시 계산해 맞춰 본다(워커의 WebCrypto 서명 검사).
const AK = 'k-AKLTfakeassetak0001', SK = 'k-fakeAssetSecretKey==';   // SK 는 base64 처럼 보여도 글자 그대로 키
const enc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const mask = (k) => k.slice(0, 8) + '*'.repeat(20) + k.slice(-8);
const key36 = (tag) => ('k-' + tag + '-' + 'x'.repeat(40)).slice(0, 28) + tag.padEnd(8, '0').slice(0, 8);   // 36자
const KEY_TA36 = key36('ta2dt001'), KEY_T636 = key36('t6none01'), KEY_SP36 = key36('spdup001'), KEY_TA_NEW = key36('ta2dt002');

function fakeBytePlus() {
  const st = {
    calls: {}, sigBad: [], hostBad: [], groups: new Map(), assets: new Map(), seq: 0,
    createN: 0, throttleCreateAt: new Set(), throttleKeysOnce: new Set(),
    projects: ['default', '2DT', '6T', 'AFX', 'Special'],
    keys: {
      default: [{ Id: 'ak1', Key: mask(KEY_T636).replace(/^k/, 'z'), Status: 'Active' }],
      '2DT': [{ Id: 'ak2', Key: mask(KEY_TA36), Status: 'Active' }, { Id: 'ak3', Key: mask(KEY_T636), Status: 'Inactive' }],
      '6T': [],
      AFX: [{ Id: 'ak4', Key: mask(KEY_SP36), Status: 'Active' }],
      Special: [{ Id: 'ak5', Key: mask(KEY_SP36), Status: 'Active' }],
    },
  };
  const reply = (Result, status = 200) => new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'r' }, Result }), { status });
  const fault = (Code, Message, status = 200) => new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'r', Error: { Code, Message } } }), { status });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const h = new Headers(init.headers || {});
    const method = init.method || 'GET';
    const body = init.body || '';
    const params = [...u.searchParams.entries()];
    const action = u.searchParams.get('Action');
    st.calls[action] = (st.calls[action] || 0) + 1;
    const service = action === 'ListProjects' ? 'iam' : 'ark';
    const wantHost = action === 'ListProjects' || action === 'ListApiKeys' ? 'openapi.fake' : 'ark.fake';
    if (u.hostname !== wantHost) st.hostBad.push(`${action}@${u.hostname}`);
    // ── 서명 다시 계산
    const xdate = h.get('X-Date') || '';
    const ph = crypto.createHash('sha256').update(body).digest('hex');
    const cq = params.map(([k, v]) => [enc3986(k), enc3986(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
    const signed = method === 'POST' ? 'content-type;host;x-content-sha256;x-date' : 'host;x-content-sha256;x-date';
    const canonH = (method === 'POST' ? `content-type:${h.get('Content-Type')}\n` : '') + `host:${u.hostname}\nx-content-sha256:${ph}\nx-date:${xdate}\n`;
    const scope = `${xdate.slice(0, 8)}/ap-southeast-1/${service}/request`;
    const creq = [method, '/', cq, canonH, signed, ph].join('\n');
    const sts = ['HMAC-SHA256', xdate, scope, crypto.createHash('sha256').update(creq).digest('hex')].join('\n');
    let k = crypto.createHmac('sha256', SK).update(xdate.slice(0, 8)).digest();
    for (const p of ['ap-southeast-1', service, 'request']) k = crypto.createHmac('sha256', k).update(p).digest();
    const sig = crypto.createHmac('sha256', k).update(sts).digest('hex');
    const want = `HMAC-SHA256 Credential=${AK}/${scope}, SignedHeaders=${signed}, Signature=${sig}`;
    if (!/^\d{8}T\d{6}Z$/.test(xdate) || h.get('X-Content-Sha256') !== ph || h.get('Authorization') !== want
        || (method === 'POST' && h.get('Content-Type') !== 'application/json')) {
      st.sigBad.push(action);
      return fault('SignatureDoesNotMatch', 'bad signature');
    }
    const b = body ? JSON.parse(body) : {};
    if (action === 'ListProjects') {
      const off = Number(u.searchParams.get('Offset') || 0), lim = Number(u.searchParams.get('Limit') || 10);
      return reply({ Projects: st.projects.slice(off, off + lim).map((ProjectName) => ({ ProjectName })), Total: st.projects.length });
    }
    if (action === 'ListApiKeys') {
      if (st.throttleKeysOnce.has(b.ProjectName)) { st.throttleKeysOnce.delete(b.ProjectName); return fault('AccountFlowLimitExceeded', 'slow down'); }
      return reply({ Items: (st.keys[b.ProjectName] || []).map((x) => ({ ...x, ProjectName: b.ProjectName, Name: 'n' })), TotalCount: 0 });
    }
    if (action === 'CreateAssetGroup') {
      const Id = `group-2026${String(++st.seq).padStart(4, '0')}`;
      st.groups.set(Id, { ...b });
      return reply({ Id });
    }
    if (action === 'DeleteAsset') {
      const a = st.assets.get(b.Id);
      if (!a || a.ProjectName !== b.ProjectName) return fault('NotFound.Asset', 'The specified asset does not exist');
      st.assets.delete(b.Id);
      (st.deleted = st.deleted || []).push(b.Id);
      return reply({});
    }
    if (action === 'CreateAsset') {
      st.createN++;
      if (st.throttleCreateAt.has(st.createN)) return fault('AccountFlowLimitExceeded', 'CreateAsset 3/min');
      if (st.cap && [...st.assets.values()].filter((a) => a.ProjectName === b.ProjectName).length >= st.cap) return fault('QuotaExceeded.AssetCount', 'The number of assets exceeds the quota limit');
      if (st.createFault) return fault(st.createFault.code, st.createFault.message);
      if (!st.groups.has(b.GroupId)) return fault('NotFound.AssetGroup', 'asset group not found');
      if (!/^https?:\/\//.test(b.URL) || !b.AssetType || !b.Name || !b.ProjectName) return fault('InvalidParameter', 'bad');
      const Id = `asset-2026${String(++st.seq).padStart(4, '0')}`;
      st.assets.set(Id, { Id, Status: 'Processing', GroupId: b.GroupId, AssetType: b.AssetType, ProjectName: b.ProjectName, URL: b.URL, Name: b.Name, CreateTime: new Date().toISOString().replace(/\.\d+Z$/, 'Z') });   // 실측 모양(ISO, 초까지)
      return reply({ Id });
    }
    if (action === 'ListAssets') {
      const f = b.Filter;
      if (!f || f.GroupType !== 'AIGC' || !b.ProjectName) return fault('InvalidParameter.Filter', 'Filter.GroupType required');
      const eff = (a) => (/fail/.test(a.URL || '') ? 'Failed' : a.Status);
      const all = [...st.assets.values()].filter((a) => a.ProjectName === b.ProjectName && (!f.Name || a.Name.includes(f.Name))   // 이름은 부분 일치(문서대로)
        && (!f.Statuses || f.Statuses.includes(eff(a)))).map((a) => ({ ...a, Status: eff(a) }));
      const from = Number(b.NextToken || 0), n = b.MaxResults || 10;
      return reply({ Items: all.slice(from, from + n), NextToken: from + n < all.length ? String(from + n) : '' });
    }
    if (action === 'GetAsset') {
      const a = st.assets.get(b.Id);
      if (!a || a.ProjectName !== b.ProjectName) return fault('NotFound.Asset', 'The specified asset does not exist');
      if (/fail/.test(a.URL)) return reply({ ...a, Status: 'Failed', Error: { Code: 'DownloadFailed', Message: 'cannot fetch url' } });
      return reply({ ...a });
    }
    return fault('InvalidAction', action, 400);
  };
  return st;
}

const assetEnv = (bp) => ({
  ...baseEnv(),
  BP_KEY_T6: KEY_T636, BP_KEY_TA: KEY_TA36, BP_KEY_Special: KEY_SP36,
  BP_ASSET_AK: AK, BP_ASSET_SK: SK,
  BP_OPENAPI_HOST: 'openapi.fake', BP_ASSET_HOST: 'ark.fake',
  FETCH: bp.fetch,
  ASSET_LOCK_SETTLE_MS: '0',
});
const enrollAs = async (e, key, pc) => (await call(e, 'POST', '/v1/enroll', { body: { ticket: ticket(key), pc } })).j.token;
const img = (key, url = `https://cdn.example/${key}.png`, extra = {}) => ({ key, url, type: 'Image', ...extra });
const reg = (e, token, items, group = { key: 'char_01', name: '주인공 민지' }, extra = {}) =>
  call(e, 'POST', '/v1/assets/register', { token, body: { group, items, ...extra } });

console.log('\n[11] 어셋 — 팀 → BytePlus 프로젝트 찾기');
const bp = fakeBytePlus();
const ae = assetEnv(bp);
const tTA = await enrollAs(ae, KEY_TA36, 'PC-TA');
const t6 = await enrollAs(ae, KEY_T636, 'PC-6');
const tSP = await enrollAs(ae, KEY_SP36, 'PC-SP');
{
  const none = await call(ae, 'GET', '/v1/assets/project');
  ok(none.status === 401, '출입증 없으면 401');
  const r = await call(ae, 'GET', '/v1/assets/project', { token: tTA });
  ok(r.status === 200 && r.j.ok && r.j.project === '2DT', 'TA 키(가려진 키 앞뒤 8자) → 2DT', r.text);
  ok(bp.sigBad.length === 0 && bp.calls.ListProjects === 1 && bp.calls.ListApiKeys === 5, '서명이 노드 crypto 로 다시 계산한 것과 같음 · 프로젝트마다 한 번', `${bp.sigBad} ${JSON.stringify(bp.calls)}`);
  ok(bp.hostBad.length === 0, 'BP_OPENAPI_HOST · BP_ASSET_HOST 로 주소를 바꿀 수 있음', bp.hostBad.join(','));
  const c = JSON.parse(ae.SD_TOKENS.m.get('ast:proj:TA').value);
  ok(c.p === '2DT' && c.fp === sha(KEY_TA36).slice(0, 16) && !ae.SD_TOKENS.m.get('ast:proj:TA').value.includes(KEY_TA36), 'KV 에 프로젝트 · 키 지문만(키 없음)');
  const n0 = bp.calls.ListApiKeys;
  const again = await call(ae, 'GET', '/v1/assets/project', { token: tTA });
  ok(again.j.project === '2DT' && bp.calls.ListApiKeys === n0 && bp.calls.ListProjects === 1, '두 번째는 KV 에서(BytePlus 안 부름)');
  const w0 = ae.SD_TOKENS.writes;
  const r6 = await call(ae, 'GET', '/v1/assets/project', { token: t6 });
  ok(r6.status === 409 && r6.j.code === 'no_project', '맞는 Active 키 없음(Inactive 만) → 409 no_project', r6.text);
  const rsp = await call(ae, 'GET', '/v1/assets/project', { token: tSP });
  ok(rsp.status === 409 && rsp.j.code === 'ambiguous_project' && /AFX/.test(rsp.j.error), '두 프로젝트에 맞음 → 409 ambiguous_project');
  ok(!ae.SD_TOKENS.m.has('ast:proj:T6') && !ae.SD_TOKENS.m.has('ast:proj:Special') && ae.SD_TOKENS.m.get('ast:projmiss:T6')?.ttl === 600 && ae.SD_TOKENS.m.get('ast:projmiss:Special')?.ttl === 600 && ae.SD_TOKENS.writes - w0 === 2,
    '없음 · 여럿은 10분만 기억(ast:projmiss, TTL 600) · 프로젝트 기록엔 안 적음');
  ok(!ae.SD_TOKENS.m.get('ast:projmiss:T6').value.includes(KEY_T636), '기억에도 키 값 없음(지문만)');
  const lk0 = bp.calls.ListApiKeys, lp0 = bp.calls.ListProjects;
  const r6b = await call(ae, 'GET', '/v1/assets/project', { token: t6 });
  const rspb = await call(ae, 'GET', '/v1/assets/project', { token: tSP });
  ok(r6b.status === 409 && r6b.j.code === 'no_project' && rspb.j.code === 'ambiguous_project' && bp.calls.ListApiKeys === lk0 && bp.calls.ListProjects === lp0, '10분 안에 다시 물으면 BytePlus 안 부르고 같은 답');
  const r6c = await call({ ...ae, BP_KEY_T6: KEY_T636.slice(0, -1) + 'Z' }, 'GET', '/v1/assets/project', { token: t6 });
  ok(r6c.j.code === 'no_project' && bp.calls.ListProjects === lp0 + 1, '키가 바뀌면(지문 다름) 기억을 무시하고 다시 찾음');
  const over = await call({ ...ae, TEAM_PROJECTS: '{"T6":"6T"}' }, 'GET', '/v1/assets/project', { token: t6 });
  ok(over.j.project === '6T', 'TEAM_PROJECTS 가 이김');
  const nc = await call({ ...ae, BP_ASSET_SK: '' }, 'GET', '/v1/assets/project', { token: tTA });
  ok(nc.status === 503 && nc.j.code === 'not_configured', '어셋 키가 없으면 503 not_configured');
  // 찾는 중 한 번 막히면 쉬고 한 번 더
  const bp2 = fakeBytePlus(); bp2.throttleKeysOnce.add('2DT');
  const e2 = assetEnv(bp2);
  const t2 = await enrollAs(e2, KEY_TA36, 'PC-TA');
  const rr = await call(e2, 'GET', '/v1/assets/project', { token: t2 });
  ok(rr.j.project === '2DT' && bp2.calls.ListApiKeys === 6, '목록이 한 번 막혀도 다시 물어 찾음');
  // 끝내 막히면 429 · 다른 오류는 502
  const bp3 = fakeBytePlus(); bp3.throttleKeysOnce = { has: () => true, delete() {} };
  const e3 = assetEnv(bp3);
  const r3 = await call(e3, 'GET', '/v1/assets/project', { token: await enrollAs(e3, KEY_TA36, 'p') });
  ok(r3.status === 429 && r3.j.code === 'rate_limited' && r3.j.retryAfter > 0 && !e3.SD_TOKENS.m.has('ast:projmiss:TA'), '계속 막히면 429 rate_limited + retryAfter · 기억 안 함');
  const e4 = { ...assetEnv(fakeBytePlus()), BP_ASSET_SK: 'k-wrong-sk' };
  const r4 = await call(e4, 'GET', '/v1/assets/project', { token: await enrollAs(e4, KEY_TA36, 'p') });
  ok(r4.status === 502 && r4.j.code === 'byteplus' && /Signature/.test(r4.j.error) && !r4.text.includes('k-wrong-sk') && !e4.SD_TOKENS.m.has('ast:projmiss:TA'), '서명 틀림 → 502 byteplus(키 값은 안 나감) · 기억 안 함');
  // 프로젝트가 100개를 넘으면 넘겨 가며 읽는다(Offset 은 받은 줄 수)
  const bp5 = fakeBytePlus();
  bp5.projects = [...Array.from({ length: 150 }, (_, i) => 'p' + i), '2DT'];
  const e5 = assetEnv(bp5);
  const r5 = await call(e5, 'GET', '/v1/assets/project', { token: await enrollAs(e5, KEY_TA36, 'p') });
  ok(r5.j.project === '2DT' && bp5.calls.ListProjects === 2 && bp5.calls.ListApiKeys === 151, '프로젝트 151개 — 두 쪽 읽어 151번째에서 찾음(겹쳐 읽지 않음)', `${r5.text} ${JSON.stringify(bp5.calls)}`);
}

console.log('\n[12] 어셋 — 입력 검사(고치지 않고 거절)');
{
  const cases = [
    ['그룹 없음', { items: [img('a')] }],
    ['group.key 모양', { group: { key: 'bad key!', name: 'x' }, items: [img('a')] }],
    ['group.name 65자', { group: { key: 'g', name: 'x'.repeat(65) }, items: [img('a')] }],
    ['group.name 숫자', { group: { key: 'g', name: 5 }, items: [img('a')] }],
    ['items 0개', { group: { key: 'g', name: 'n' }, items: [] }],
    ['items 11개', { group: { key: 'g', name: 'n' }, items: Array.from({ length: 11 }, (_, i) => img('k' + i)) }],
    ['item.key 모양', { group: { key: 'g', name: 'n' }, items: [img('a/b')] }],
    ['item.key 겹침', { group: { key: 'g', name: 'n' }, items: [img('a'), img('a')] }],
    ['http 주소', { group: { key: 'g', name: 'n' }, items: [img('a', 'http://cdn.example/a.png')] }],
    ['data: 주소', { group: { key: 'g', name: 'n' }, items: [img('a', 'data:image/png;base64,AAAA')] }],
    ['127.0.0.1 (시험 꺼짐)', { group: { key: 'g', name: 'n' }, items: [img('a', 'http://127.0.0.1:9/a.png')] }],
    ['주소 4097자', { group: { key: 'g', name: 'n' }, items: [img('a', 'https://x.example/' + 'a'.repeat(4080))] }],
    ['type 틀림', { group: { key: 'g', name: 'n' }, items: [{ key: 'a', url: 'https://x.example/a', type: 'image' }] }],
    ['item.key 65자', { group: { key: 'g', name: 'n' }, items: [img('k'.repeat(65))] }],
    ['url 이 문자열 아님', { group: { key: 'g', name: 'n' }, items: [{ key: 'a', url: 5, type: 'Image' }] }],
    ['name 65자', { group: { key: 'g', name: 'n' }, items: [img('a', undefined, { name: 'n'.repeat(65) })] }],
  ];
  const n0 = (bp.calls.CreateAsset || 0) + (bp.calls.CreateAssetGroup || 0);
  const bads = [];
  for (const [name, body] of cases) {
    const r = await call(ae, 'POST', '/v1/assets/register', { token: tTA, body });
    if (!(r.status === 400 && r.j.ok === false && r.j.code === 'invalid' && r.j.error)) bads.push(name);
  }
  ok(bads.length === 0, `잘못된 본문 ${cases.length}가지 모두 400 invalid`, bads.join(', '));
  ok((bp.calls.CreateAsset || 0) + (bp.calls.CreateAssetGroup || 0) === n0, '거절한 요청은 BytePlus 를 안 부름');
  const nojson = await call(ae, 'POST', '/v1/assets/register', { token: tTA, raw: '{oops' });
  ok(nojson.status === 400 && nojson.j.code === 'invalid', 'JSON 아님 400');
  const big = await call(ae, 'POST', '/v1/assets/register', { token: tTA, raw: JSON.stringify({ pad: 'x'.repeat(70000) }) });
  ok(big.status === 400, '너무 큰 본문 400');
  const loc = await call({ ...ae, ASSET_TEST_HTTP: '1' }, 'POST', '/v1/assets/register', { token: tTA, body: { group: { key: 'g_local', name: 'n' }, items: [img('loc1', 'http://127.0.0.1:9/a.png')] } });
  ok(loc.status === 200 && loc.j.items[0].status === 'Processing', 'ASSET_TEST_HTTP=1 이면 127.0.0.1 허용');
  const ids = [['ids 없음', {}], ['ids 21개', { ids: Array.from({ length: 21 }, (_, i) => 'asset-' + i) }], ['id 모양', { ids: ['a b'] }], ['id 숫자', { ids: [5] }]];
  const badIds = [];
  for (const [name, body] of ids) { const r = await call(ae, 'POST', '/v1/assets/status', { token: tTA, body }); if (!(r.status === 400 && r.j.code === 'invalid')) badIds.push(name); }
  ok(badIds.length === 0, 'status 본문 검사 4가지 400', badIds.join(', '));
  const noTok = await call(ae, 'POST', '/v1/assets/register', { body: { group: { key: 'g', name: 'n' }, items: [img('a')] } });
  const noTok2 = await call(ae, 'POST', '/v1/assets/status', { body: { ids: ['asset-1'] } });
  ok(noTok.status === 401 && noTok2.status === 401, 'register · status 도 출입증 없으면 401');
}

console.log('\n[13] 어셋 — 등록 · 같은 내용은 한 번만 · 상태');
let firstId;
{
  const c0 = bp.calls.CreateAsset || 0, g0 = bp.calls.CreateAssetGroup || 0, w0 = ae.SD_TOKENS.writes;
  const r = await reg(ae, tTA, [img('md5aaa.png'), img('md5bbb.png', undefined, { name: '정면' })], undefined, { team: 'Special' });
  ok(r.status === 200 && r.j.ok && r.j.project === '2DT' && /^group-/.test(r.j.groupId), "팀은 출입증에서(본문의 team:'Special' 무시) → 2DT", r.text);
  ok(r.j.items.length === 2 && r.j.items.every((x) => x.status === 'Processing' && /^asset-/.test(x.id)) && r.j.items[0].key === 'md5aaa.png', '두 장 Processing · 요청 순서');
  firstId = r.j.items[0].id;
  const a0 = bp.assets.get(firstId), a1 = bp.assets.get(r.j.items[1].id);
  const grp = bp.groups.get(r.j.groupId);
  ok(a0.Name === 'md5aaa.png' && a1.Name === 'md5bbb.png' && a0.ProjectName === '2DT' && a0.GroupId === r.j.groupId && grp.Name === '주인공 민지' && grp.GroupType === 'AIGC' && grp.ProjectName === '2DT' && grp.Description === 'seedance char_01', 'BytePlus 에 간 값(Name 은 item.name 이 아니라 내용 key · 그룹 · 프로젝트)');
  const lockRows = [...ae.SD_TOKENS.m.entries()].filter(([k]) => /^ast:(g)?lock:2DT:(md5aaa|md5bbb|char_01)/.test(k));
  ok(bp.calls.CreateAsset - c0 === 2 && bp.calls.CreateAssetGroup - g0 === 1 && ae.SD_TOKENS.writes - w0 === 9, '그룹 1 · 어셋 2 · KV 쓰기 9(만들 때마다 잠금 · 기록 · done 표)', `쓰기 ${ae.SD_TOKENS.writes - w0}`);
  ok(lockRows.length === 3 && lockRows.every(([, v]) => /^done:(asset|group)-/.test(v.value) && v.ttl === 60), '만든 뒤 잠금 자리엔 done:<id> 만 60초(진행 중 표 없음)', JSON.stringify(lockRows.map(([k, v]) => k + '=' + v.value)));
  const c1 = bp.calls.CreateAsset, w1 = ae.SD_TOKENS.writes;
  const again = await reg(ae, tTA, [img('md5aaa.png'), img('md5bbb.png')]);
  ok(again.j.items[0].id === firstId && again.j.groupId === r.j.groupId && bp.calls.CreateAsset === c1 && bp.calls.CreateAssetGroup - g0 === 1, '★ 같은 key 를 또 등록 → 새로 안 만듦(같은 id)');
  ok(ae.SD_TOKENS.writes === w1 && again.j.items.every((x) => x.status === 'Processing'), '상태가 그대로면 KV 쓰기 0');
  bp.assets.get(firstId).Status = 'Active';
  const g1 = bp.calls.GetAsset;
  const act = await reg(ae, tTA, [img('md5aaa.png')]);
  ok(act.j.items[0].status === 'Active' && ae.SD_TOKENS.writes === w1 + 1, 'Processing → Active 를 읽어 한 번 기록');
  const wAct = ae.SD_TOKENS.writes;
  const act2 = await reg(ae, tTA, [img('md5aaa.png')]);
  // 26.11.23: Active 도 등록 요청 때는 다시 읽는다(BytePlus 에서 지워진 에셋을 계속 돌려주지 않게) — 상태가 그대로면 KV 는 안 쓴다.
  ok(bp.calls.GetAsset === g1 + 2 && act2.j.items[0].status === 'Active' && ae.SD_TOKENS.writes === wAct, 'Active 도 등록 때 다시 확인 · 그대로면 KV 쓰기 0');
  const st = await call(ae, 'POST', '/v1/assets/status', { token: tTA, body: { ids: [firstId, r.j.items[1].id, 'asset-nope'] } });
  ok(st.status === 200 && st.j.project === '2DT' && st.j.items.map((x) => x.status).join() === 'Active,Processing,NotFound', 'status — Active · Processing · NotFound(요청 순서)', st.text);
  // 다른 프로젝트(팀)에서는 남의 어셋이 안 보인다
  const bpO = await call({ ...ae, TEAM_PROJECTS: '{"T6":"6T"}' }, 'POST', '/v1/assets/status', { token: t6, body: { ids: [firstId] } });
  ok(bpO.j.project === '6T' && bpO.j.items[0].status === 'NotFound', '6T 팀이 2DT 어셋 id 를 물으면 NotFound');
}

console.log('\n[14] 어셋 — 실패는 다시 만들고, 사라진 것도 다시, 한도에 걸리면 Retry');
{
  const r = await reg(ae, tTA, [img('md5fail.png', 'https://cdn.example/fail.png')]);
  const failId = r.j.items[0].id;
  const stF = await call(ae, 'POST', '/v1/assets/status', { token: tTA, body: { ids: [failId] } });
  ok(stF.j.items[0].status === 'Failed' && stF.j.items[0].error.code === 'DownloadFailed', 'status — GetAsset Failed → Failed + error');
  const c0 = bp.calls.CreateAsset;
  const f = await reg(ae, tTA, [{ key: 'md5fail.png', type: 'Image' }]);
  ok(f.j.items[0].status === 'NeedUpload' && bp.calls.CreateAsset === c0, '다시 등록(앱의 첫 물음 · 주소 없음) — Failed 는 없는 것으로 보고 NeedUpload(만들지 않음)', f.text);
  ok(JSON.parse(ae.SD_TOKENS.m.get('ast:a:2DT:md5fail.png').value).status === 'Failed', 'Failed 를 기록');
  const re = await reg(ae, tTA, [img('md5fail.png', 'https://cdn.example/ok-now.png')]);
  ok(re.j.items[0].status === 'Processing' && re.j.items[0].id !== failId && bp.calls.CreateAsset === c0 + 1, '★ 주소를 붙인 두 번째 물음에서 바로 새로 만듦(60초 안이어도 — 죽은 id 의 done 표는 비어 있는 것으로)', re.text);
  ae.SD_TOKENS.m.set('ast:a:2DT:md5fail2.png', { value: JSON.stringify({ id: failId, status: 'Processing', at: 'x' }) });
  const re1 = await reg(ae, tTA, [img('md5fail2.png', 'https://cdn.example/ok-2.png')]);
  ok(re1.j.items[0].status === 'Processing' && re1.j.items[0].id !== failId && bp.calls.CreateAsset === c0 + 2, 'KV 엔 Processing 인데 BytePlus 는 Failed → 같은 호출에서 새로 만듦(두 번 누를 필요 없음)', re1.text);
  // BytePlus 쪽에서 지워진 어셋 → 새로
  const gone = re.j.items[0].id;
  bp.assets.delete(gone);
  const re2 = await reg(ae, tTA, [img('md5fail.png', 'https://cdn.example/ok-now.png')]);
  ok(re2.j.items[0].status === 'Processing' && re2.j.items[0].id !== gone && bp.calls.CreateAsset === c0 + 3, 'GetAsset NotFound → 없는 것으로 보고 새로 만듦', re2.text);
  // 그룹이 지워졌으면 한 번 다시 만들어 이어 간다
  const gid = re2.j.groupId;
  bp.groups.delete(gid);
  const g0 = bp.calls.CreateAssetGroup;
  const rg = await reg(ae, tTA, [img('md5new1.png')]);
  ok(rg.j.items[0].status === 'Processing' && rg.j.groupId !== gid && bp.calls.CreateAssetGroup === g0 + 1 && JSON.parse(ae.SD_TOKENS.m.get('ast:g:2DT:char_01').value).id === rg.j.groupId, '그룹이 사라졌으면 다시 만들고 이어서 등록');
  // 한도 — 이번 묶음의 두 번째 CreateAsset 이 막힘
  bp.throttleCreateAt.add(bp.createN + 2);
  const w0 = ae.SD_TOKENS.writes, n0c = bp.createN;
  const t = await reg(ae, tTA, [img('md5t1.png'), img('md5t2.png'), img('md5aaa.png'), img('md5t3.png')]);
  const s = t.j.items.map((x) => x.status).join();
  ok(t.status === 200 && s === 'Processing,Retry,Active,Retry', '막힌 것부터 Retry · 이미 있는 건 그대로 답함', s);
  ok(t.j.items[1].retryAfter === 25 && t.j.items[3].retryAfter === 25 && !t.j.items[1].id, 'Retry 에 retryAfter 25');
  ok(bp.createN - n0c === 2 && !ae.SD_TOKENS.m.has('ast:a:2DT:md5t2.png') && !ae.SD_TOKENS.m.has('ast:a:2DT:md5t3.png') && !ae.SD_TOKENS.m.has('ast:lock:2DT:md5t2.png'), '막힌 뒤로는 만들지 않음 · 막힌 줄은 기록 없고 잠금도 풀림', `쓰기 ${ae.SD_TOKENS.writes - w0}`);
  const c2 = bp.calls.CreateAsset;
  const t2 = await reg(ae, tTA, [img('md5t1.png'), img('md5t2.png'), img('md5t3.png')]);
  ok(t2.j.items.map((x) => x.status).join() === 'Processing,Processing,Processing' && bp.calls.CreateAsset === c2 + 2, '다시 보내면 남은 둘만 만듦');
  // 그룹을 만들다 막히면 — 그룹은 만들 어셋이 있을 때만 만드므로 그 줄부터 Retry(통째로 막지 않는다)
  const bpT = fakeBytePlus(); const eT = assetEnv(bpT);
  const tT = await enrollAs(eT, KEY_TA36, 'p');
  const origFetch = bpT.fetch;
  eT.FETCH = async (u, i) => (new URL(u).searchParams.get('Action') === 'CreateAssetGroup' ? new Response('{}', { status: 429 }) : origFetch(u, i));
  const gt = await reg(eT, tT, [img('x1')]);
  ok(gt.status === 200 && gt.j.items[0].status === 'Retry' && gt.j.items[0].retryAfter === 25 && gt.j.groupId === null && !eT.SD_TOKENS.m.has('ast:g:2DT:char_01') && !eT.SD_TOKENS.m.has('ast:glock:2DT:char_01') && bpT.calls.CreateAsset === undefined, '그룹 만들다 막히면 그 줄 Retry 25 · 어셋 안 만듦 · 기록 · 잠금 없음', gt.text);
  // 그 밖의 오류는 그 줄만 Failed
  eT.FETCH = async (u, i) => (new URL(u).searchParams.get('Action') === 'CreateAsset'
    ? new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'InvalidParameter.URL', Message: `bad url (${AK})` } } }), { status: 200 }) : origFetch(u, i));
  const ft = await reg(eT, tT, [img('x1')]);
  ok(ft.status === 200 && ft.j.items[0].status === 'Failed' && ft.j.items[0].error.code === 'InvalidParameter.URL' && !ft.text.includes(AK), 'CreateAsset 오류 → 그 줄 Failed + error(문구 속 서명 키는 가림)');
  ok(!eT.SD_TOKENS.m.has('ast:a:2DT:x1'), '만들지 못한 건 기록 안 함');
}

console.log('\n[15] 어셋 — 겹치지 않게: 주소 없이 묻기 · BytePlus 에서 같은 이름 찾기 · 잠금');
{
  // 주소 없이 — 이미 있는 건 답하고, 없는 건 NeedUpload(만들지 않음 · 그룹도 안 만듦)
  const c0 = bp.calls.CreateAsset, g0 = bp.calls.CreateAssetGroup;
  const nu = await reg(ae, tTA, [{ key: 'md5aaa.png', type: 'Image' }, { key: 'md5new9.png', type: 'Image' }], { key: 'char_nu', name: '새 인물' });
  ok(nu.status === 200 && nu.j.items.map((x) => x.status).join() === 'Active,NeedUpload' && nu.j.items[0].id === firstId && !('id' in nu.j.items[1]), '주소 없이: 있는 건 그대로(Active) · 없는 건 NeedUpload', nu.text);
  ok(bp.calls.CreateAsset === c0 && bp.calls.CreateAssetGroup === g0 && nu.j.groupId === null && !ae.SD_TOKENS.m.has('ast:g:2DT:char_nu'), 'NeedUpload 만이면 BytePlus 에 아무것도 안 만듦(그룹도)');
  const up = await reg(ae, tTA, [{ key: 'md5new9.png', type: 'Image', url: 'https://r2.example/md5new9.png' }], { key: 'char_nu', name: '새 인물' });
  ok(up.j.items[0].status === 'Processing' && bp.calls.CreateAsset === c0 + 1 && /^group-/.test(up.j.groupId), '주소를 붙여 다시 → 그때 그룹 · 어셋을 만듦');
  // 다른 PC 가 먼저 올린 같은 내용 — KV 엔 없지만 BytePlus 에 있다(이름이 정확히 같은 것만, 가장 먼저 만든 것)
  const mk = (Id, Name, CreateTime, extra = {}) => bp.assets.set(Id, { Id, Name, Status: 'Active', GroupId: 'group-elsewhere', AssetType: 'Image', ProjectName: '2DT', URL: 'https://x/' + Id, CreateTime, ...extra });
  mk('asset-fuzzy1', 'xmd5shared.pngx', 1);                    // 부분 일치일 뿐 — 쓰면 안 됨
  mk('asset-other-proj', 'md5shared.png', 2, { ProjectName: '6T' });
  mk('asset-late', 'md5shared.png', 900);
  mk('asset-early', 'md5shared.png', 800, { Status: 'Processing' });
  mk('asset-failed', 'md5shared.png', 5, { URL: 'https://x/fail' });   // Failed — 쓰면 안 됨
  const c1 = bp.calls.CreateAsset, w1 = ae.SD_TOKENS.writes;
  const sh = await reg(ae, tTA, [{ key: 'md5shared.png', type: 'Image', url: 'https://r2.example/md5shared.png' }]);
  ok(sh.j.items[0].id === 'asset-early' && sh.j.items[0].status === 'Processing' && bp.calls.CreateAsset === c1, '★ BytePlus 에 같은 이름이 있으면 새로 안 만들고 가장 먼저 만든 것을 씀(부분 일치 · Failed · 다른 프로젝트는 무시)', sh.text);
  ok(ae.SD_TOKENS.writes - w1 === 1 && JSON.parse(ae.SD_TOKENS.m.get('ast:a:2DT:md5shared.png').value).id === 'asset-early', '찾은 것을 KV 에 한 번 기록 · 다른 그룹에 있어도 옮기지 않음');
  // 부분 일치만 있으면 새로 만든다
  const fz = await reg(ae, tTA, [{ key: 'md5shared', type: 'Image', url: 'https://r2.example/md5shared' }]);
  ok(fz.j.items[0].status === 'Processing' && /^asset-2026/.test(fz.j.items[0].id) && bp.calls.CreateAsset === c1 + 1, '이름이 정확히 같지 않으면(md5shared ⊂ md5shared.png) 새로 만듦');
  // KV 가 가리키는 어셋이 사라짐 → 다시 찾고(있으면 그것), 없으면 다시 만든다
  ae.SD_TOKENS.m.set('ast:a:2DT:md5ghost.png', { value: JSON.stringify({ id: 'asset-vanished', status: 'Processing', at: 'x' }) });
  mk('asset-ghost-copy', 'md5ghost.png', 50);
  const gh = await reg(ae, tTA, [{ key: 'md5ghost.png', type: 'Image' }]);
  ok(gh.j.items[0].id === 'asset-ghost-copy' && gh.j.items[0].status === 'Active', 'KV 의 어셋이 NotFound → BytePlus 에서 다시 찾아 씀(주소 없이도)');
  ae.SD_TOKENS.m.set('ast:a:2DT:md5ghost3.png', { value: JSON.stringify({ id: 'asset-vanished3', status: 'Processing', at: 'x' }) });
  const c2 = bp.calls.CreateAsset;
  const gh3 = await reg(ae, tTA, [{ key: 'md5ghost3.png', type: 'Image' }]);
  ok(gh3.j.items[0].status === 'NeedUpload' && bp.calls.CreateAsset === c2, 'KV 의 어셋이 NotFound · BytePlus 에도 없음 · 주소 없음 → NeedUpload');
  const gh3b = await reg(ae, tTA, [{ key: 'md5ghost3.png', type: 'Image', url: 'https://r2.example/g3' }]);
  ok(gh3b.j.items[0].status === 'Processing' && gh3b.j.items[0].id !== 'asset-vanished3' && bp.calls.CreateAsset === c2 + 1, '… 주소를 주면 새로 만듦');
  // 잠금 — 다른 PC 가 같은 내용을 만드는 중
  ae.SD_TOKENS.m.set('ast:lock:2DT:md5busy.png', { value: 'x' });
  const c3 = bp.calls.CreateAsset;
  const bz = await reg(ae, tTA, [{ key: 'md5busy.png', type: 'Image', url: 'https://r2.example/b' }, { key: 'md5aaa.png', type: 'Image' }, { key: 'md5free.png', type: 'Image', url: 'https://r2.example/f' }]);
  ok(bz.j.items.map((x) => x.status).join() === 'Busy,Active,Processing' && bz.j.items[0].retryAfter === 10 && bp.calls.CreateAsset === c3 + 1, '잠긴 내용은 Busy(retryAfter 10) · 나머지는 그대로', bz.text);
  ok(ae.SD_TOKENS.m.has('ast:lock:2DT:md5busy.png'), '남의 잠금은 건드리지 않음');
  ae.SD_TOKENS.m.delete('ast:lock:2DT:md5busy.png');
  // 그룹 잠금 — 다른 PC 가 이 인물의 그룹을 만드는 중이면 만들 줄은 Busy, 이미 있는 건 답함
  ae.SD_TOKENS.m.set('ast:glock:2DT:char_g', { value: 'x' });
  const g1 = bp.calls.CreateAssetGroup;
  const gb = await reg(ae, tTA, [{ key: 'md5aaa.png', type: 'Image' }, { key: 'md5g1.png', type: 'Image', url: 'https://r2.example/g1' }, { key: 'md5g2.png', type: 'Image', url: 'https://r2.example/g2' }], { key: 'char_g', name: 'G' });
  ok(gb.j.items.map((x) => x.status).join() === 'Active,Busy,Busy' && bp.calls.CreateAssetGroup === g1, '그룹이 다른 곳에서 만들어지는 중 → 만들 줄은 Busy(그룹을 두 번 만들지 않음)', gb.text);
  ae.SD_TOKENS.m.delete('ast:glock:2DT:char_g');
  const gb2 = await reg(ae, tTA, [{ key: 'md5g1.png', type: 'Image', url: 'https://r2.example/g1' }, { key: 'md5g2.png', type: 'Image', url: 'https://r2.example/g2' }], { key: 'char_g', name: 'G' });
  ok(gb2.j.items.every((x) => x.status === 'Processing') && bp.calls.CreateAssetGroup === g1 + 1, '잠금이 풀리면 그룹 하나 · 어셋 둘');
  ok([...ae.SD_TOKENS.m.entries()].filter(([k]) => /^ast:(g)?lock:/.test(k)).every(([, v]) => /^done:/.test(v.value)), '끝나면 진행 중 잠금은 남지 않음(done 표만)');
  const locks = [];
  const origPut = ae.SD_TOKENS.put.bind(ae.SD_TOKENS);
  ae.SD_TOKENS.put = async (k, v, o = {}) => { if (/lock:/.test(k)) locks.push(o.expirationTtl); return origPut(k, v, o); };
  await reg(ae, tTA, [{ key: 'md5ttl.png', type: 'Image', url: 'https://r2.example/t' }], { key: 'char_ttl', name: 'T' });
  ae.SD_TOKENS.put = origPut;
  ok(locks.length === 4 && locks.every((t) => t === 60), '잠금 · done 표는 TTL 60초(그룹 · 어셋)', JSON.stringify(locks));
  // ListAssets 를 못 물으면 만들지 않는다(겹칠 수 있어서)
  const origF = ae.FETCH;
  ae.FETCH = async (u, i) => (new URL(u).searchParams.get('Action') === 'ListAssets' ? new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'InternalError', Message: 'x' } } })) : origF(u, i));
  const c4 = bp.calls.CreateAsset;
  const le = await reg(ae, tTA, [{ key: 'md5le.png', type: 'Image', url: 'https://r2.example/le' }]);
  ae.FETCH = origF;
  ok(le.j.items[0].status === 'Retry' && le.j.items[0].error.code === 'InternalError' && bp.calls.CreateAsset === c4, '같은 이름 찾기가 실패하면 만들지 않고 Retry');
}

console.log('\n[15b] 어셋 — 두 PC 가 같은 순간 · 방금 만든 표 · 개수 한도 · 저장소 쓰기 실패');
{
  // 같은 순간 두 PC(같은 곳) — 잠금을 적고 기다렸다 다시 읽어, 하나만 만든다
  const bpR = fakeBytePlus(); const eR = { ...assetEnv(bpR), ASSET_LOCK_SETTLE_MS: '30' };
  const tA = await enrollAs(eR, KEY_TA36, 'PC-A'), tB = await enrollAs(eR, KEY_TA36, 'PC-B');
  const item = [{ key: 'md5race.png', type: 'Image', url: 'https://r2.example/race' }];
  const [ra, rb] = await Promise.all([reg(eR, tA, item), reg(eR, tB, item)]);
  const sts = [ra.j.items[0], rb.j.items[0]];
  ok(bpR.calls.CreateAsset === 1 && bpR.calls.CreateAssetGroup === 1 && sts.filter((x) => x.status === 'Processing').length === 1 && sts.filter((x) => x.status === 'Busy').length === 1, '★ 같은 순간 두 PC → 어셋 하나 · 그룹 하나(나머지는 Busy)', JSON.stringify(sts));
  const made = sts.find((x) => x.id).id;
  const loser = sts[0].status === 'Busy' ? tA : tB;
  const again = await reg(eR, loser, item);
  ok(again.j.items[0].id === made && bpR.calls.CreateAsset === 1, 'Busy 였던 PC 가 다시 물으면 같은 id');
  // 방금 만든 표(done) — KV 기록 · ListAssets 에 아직 안 보여도 그 id 를 받아 간다
  eR.SD_TOKENS.m.set('ast:lock:2DT:md5just.png', { value: 'done:asset-just-made', ttl: 60 });
  const jm = await reg(eR, tA, [{ key: 'md5just.png', type: 'Image', url: 'https://r2.example/just' }]);
  ok(jm.j.items[0].id === 'asset-just-made' && jm.j.items[0].status === 'Processing' && bpR.calls.CreateAsset === 1 && JSON.parse(eR.SD_TOKENS.m.get('ast:a:2DT:md5just.png').value).id === 'asset-just-made', '★ 잠금 자리의 done:<id> → 또 만들지 않고 그 id', jm.text);
  // 개수 한도(에셋 50개)는 잠깐 막힘이 아니다 — Failed + 이유(앱이 끝없이 다시 하지 않게)
  const origR = eR.FETCH;
  for (const code of ['QuotaExceeded.AssetCount', 'LimitExceeded.Asset', 'AssetLimitExceeded']) {
    eR.FETCH = async (u, i) => (new URL(u).searchParams.get('Action') === 'CreateAsset'
      ? new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: code, Message: 'asset quota 50 reached' } } }), { status: 400 }) : origR(u, i));
    const q = await reg(eR, tA, [{ key: 'md5quota.png', type: 'Image', url: 'https://r2.example/q' }]);
    // 26.11.24~ 개수 한도면 보관함 정리를 해 본다 — 여기 에셋은 이름이 내용 key 꼴이 아니라(md5…) 지울 것이 없다 → asset_quota_full + 원래 코드
    ok(q.j.items[0].status === 'Failed' && q.j.items[0].error.code === 'asset_quota_full' && q.j.items[0].error.message.includes(code) && !(bpR.deleted || []).length
      && !eR.SD_TOKENS.m.has('ast:lock:2DT:md5quota.png'), `개수 한도 ${code} → Failed asset_quota_full(원래 코드 포함 · 지울 것 없음 · Retry 아님) · 잠금 풀림`, q.text);
  }
  for (const code of ['AccountFlowLimitExceeded', 'Throttling', 'TooManyRequests', 'RequestLimitExceeded']) {
    eR.FETCH = async (u, i) => (new URL(u).searchParams.get('Action') === 'CreateAsset'
      ? new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: code, Message: 'slow down' } } }), { status: 200 }) : origR(u, i));
    const q = await reg(eR, tA, [{ key: 'md5slow.png', type: 'Image', url: 'https://r2.example/s' }]);
    ok(q.j.items[0].status === 'Retry' && q.j.items[0].retryAfter === 25, `속도 한도 ${code} → Retry 25`);
  }
  eR.FETCH = origR;
  // 만든 뒤 KV 쓰기가 실패해도 500 이 아니라 만든 id 를 돌려준다
  const origPutR = eR.SD_TOKENS.put.bind(eR.SD_TOKENS);
  eR.SD_TOKENS.put = async (k, v, o) => { if (/^ast:(a|g):/.test(k)) throw new Error('KV down'); return origPutR(k, v, o); };
  const c5 = bpR.calls.CreateAsset;
  const kd = await reg(eR, tA, [{ key: 'md5kvdown.png', type: 'Image', url: 'https://r2.example/kv' }]);
  eR.SD_TOKENS.put = origPutR;
  ok(kd.status === 200 && kd.j.items[0].status === 'Processing' && /^asset-/.test(kd.j.items[0].id) && bpR.calls.CreateAsset === c5 + 1, '기록 쓰기가 실패해도 200 + 만든 id', kd.text);
  const kd2 = await reg(eR, tB, [{ key: 'md5kvdown.png', type: 'Image', url: 'https://r2.example/kv' }]);
  ok(kd2.j.items[0].id === kd.j.items[0].id && bpR.calls.CreateAsset === c5 + 1, '… 다음 물음은 done 표 · ListAssets 로 같은 id(또 안 만듦)', kd2.text);
}

console.log('\n[15c] 어셋 — 보관함이 차면 오래 안 쓴 것부터 정리(26.11.24~)');
{
  const bpE = fakeBytePlus();
  const eE = assetEnv(bpE);
  const tE = await enrollAs(eE, KEY_TA36, 'PC-E');
  const day = 86400e3, now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');   // 실측 모양 "2026-11-24T01:39:55Z"
  const seed = (Id, Name, last, created = last) => bpE.assets.set(Id, { Id, Name, Status: 'Active', GroupId: 'g0', AssetType: 'Image', ProjectName: '2DT', URL: 'https://x/' + Name, CreateTime: iso(created), LastInferenceTime: iso(last) });
  seed('asset-old20', '000000000020.png', now - 20 * day);
  seed('asset-old10', '000000000010.png', now - 10 * day);
  seed('asset-recent', '00000000000e.png', now - 3600e3, now - 30 * day);   // 30일 전에 만들었지만 1시간 전에 씀 → 남김
  seed('asset-manual', 'hero_manual', now - 40 * day);                       // 콘솔에서 사람이 올린 것(이름이 내용 key 꼴이 아님) → 남김
  bpE.cap = 4;
  eE.SD_TOKENS.m.set('ast:a:2DT:000000000020.png', { value: JSON.stringify({ id: 'asset-old20', status: 'Active' }) });
  const r1 = await reg(eE, tE, [{ key: 'aaaaaaaaaaaa.png', type: 'Image', url: 'https://r2.example/new1' }]);
  ok(r1.j.items[0].status === 'Processing' && JSON.stringify(r1.j.evicted) === '["asset-old20"]' && !bpE.assets.has('asset-old20')
    && ['asset-old10', 'asset-recent', 'asset-manual'].every((x) => bpE.assets.has(x)),
    '★ 찼으면 가장 오래 안 쓴 것 하나만 지우고 만든다(최근에 쓴 것 · 사람이 올린 것은 남김)', r1.text);
  ok(!eE.SD_TOKENS.m.has('ast:a:2DT:000000000020.png'), '지운 에셋의 KV 기록도 지움(같은 사진을 다시 등록하면 새로 만든다)');
  // 지운 기록 — 앱이 '지워짐' 을 그리려고 묻는다(26.11.24~)
  const ev0 = await call(eE, 'POST', '/v1/assets/evicted', { token: tE, body: { since: 0 } });
  ok(ev0.status === 200 && ev0.j.project === '2DT' && JSON.stringify(ev0.j.items.map((x) => x.id)) === '["asset-old20"]' && ev0.j.until <= Date.now() - 100000, '★ /v1/assets/evicted since 0 → 지운 것(asset-old20) · 기준 시각은 2분 앞', ev0.text);
  const evNow = await call(eE, 'POST', '/v1/assets/evicted', { token: tE, body: { since: Date.now() } });
  ok(evNow.status === 200 && evNow.j.items.length === 0, '그 뒤로는 지운 것 없음 → 빈 목록(목록을 훑지 않음)', evNow.text);
  ok((await call(eE, 'POST', '/v1/assets/evicted', { token: tE, body: { since: -1 } })).status === 400 && (await call(eE, 'POST', '/v1/assets/evicted', { token: tE, body: {} })).status === 400, 'since 가 없거나 음수면 400');
  const t6E = await enrollAs(eE, KEY_T636, 'PC-6E');
  const ev6 = await call(eE, 'POST', '/v1/assets/evicted', { token: t6E, body: { since: 0 } });
  ok(ev6.status !== 200 || (ev6.j.items || []).length === 0, '다른 팀(프로젝트)은 2DT 에서 지운 것을 못 받는다', ev6.text);
  ok(Object.keys(Object.fromEntries(eE.SD_TOKENS.m)).filter((k) => k.startsWith('ast:ev:2DT:')).every((k) => eE.SD_TOKENS.m.get(k).ttl === 30 * 86400), '지운 기록은 30일 뒤 저절로 사라짐(TTL)');
  // 두 장 — 지울 수 있는 것이 하나(old10)뿐: 첫 장은 그 자리에, 둘째 장은 '이미 정리함' 으로 Failed(한 호출에 정리는 한 번)
  const r2 = await reg(eE, tE, [{ key: 'bbbbbbbbbbbb.png', type: 'Image', url: 'https://r2.example/b' }, { key: 'cccccccccccc.png', type: 'Image', url: 'https://r2.example/c' }]);
  ok(r2.j.items[0].status === 'Processing' && JSON.stringify(r2.j.evicted) === '["asset-old10"]' && r2.j.items[1].status === 'Failed'
    && r2.j.items[1].error.code === 'asset_quota_full' && /이미 정리함/.test(r2.j.items[1].error.message), '남은 줄 수만큼 지우려 하되 한 호출에 정리는 한 번 — 모자라면 asset_quota_full', r2.text);
  // 지울 것이 없다(모두 24시간 안에 썼거나 만든 것) → 아무것도 안 지우고 asset_quota_full + 이유
  const d0 = (bpE.deleted || []).length;
  const r3 = await reg(eE, tE, [{ key: 'dddddddddddd.png', type: 'Image', url: 'https://r2.example/d' }]);
  ok(r3.j.items[0].status === 'Failed' && r3.j.items[0].error.code === 'asset_quota_full' && /24시간/.test(r3.j.items[0].error.message) && (bpE.deleted || []).length === d0 && !r3.j.evicted,
    '지울 것이 없으면 안 지우고 asset_quota_full(이유 · 원래 코드 포함)', r3.text);
  // 규격 거절(크기 · 해상도 …)은 보관함 문제가 아니다 — 지우지 않는다
  bpE.cap = 0; bpE.createFault = { code: 'InvalidParameter.Image', message: 'image size exceeds the limit of 30MB' };
  const r4 = await reg(eE, tE, [{ key: 'eeeeeeeeeeee.png', type: 'Image', url: 'https://r2.example/e' }]);
  ok(r4.j.items[0].status === 'Failed' && r4.j.items[0].error.code === 'InvalidParameter.Image' && (bpE.deleted || []).length === d0, '규격 거절은 정리하지 않음(원래 오류 그대로)', r4.text);
  bpE.createFault = null;
  // 정리하려는데 목록을 못 읽으면 지우지 않는다
  bpE.cap = 99; seed('asset-old30', '000000000030.png', now - 30 * day); bpE.cap = 1;
  const origE = eE.FETCH;
  eE.FETCH = async (u, i) => (new URL(u).searchParams.get('Action') === 'ListAssets' && JSON.parse(i.body).Filter.Name === undefined
    ? new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'InternalError', Message: 'x' } } })) : origE(u, i));
  const r5 = await reg(eE, tE, [{ key: 'ffffffffffff.png', type: 'Image', url: 'https://r2.example/f' }]);
  eE.FETCH = origE;
  ok(r5.j.items[0].status === 'Failed' && r5.j.items[0].error.code === 'asset_quota_full' && /목록을 읽지 못했/.test(r5.j.items[0].error.message) && bpE.assets.has('asset-old30'), '목록을 못 읽으면 지우지 않고 asset_quota_full', r5.text);
  // 지운 에셋의 잠금 자리 done 표도 지운다 — 남으면 다시 등록할 때 '방금 만든 것' 으로 지운 옛 id 를 돌려준다(11/24 시험 앱에서 찾음)
  bpE.cap = 0; bpE.createFault = null; bpE.assets.delete('asset-old30');
  const m1 = await reg(eE, tE, [{ key: 'abcabcabcabc.png', type: 'Image', url: 'https://r2.example/m1' }]);
  const m1id = m1.j.items[0].id;
  ok(eE.SD_TOKENS.m.get('ast:lock:2DT:abcabcabcabc.png')?.value === `done:${m1id}`, '만든 뒤 잠금 자리에 done 표', m1.text);
  const a1 = bpE.assets.get(m1id); a1.CreateTime = iso(now - 9 * day); a1.LastInferenceTime = iso(now - 9 * day);
  bpE.cap = [...bpE.assets.values()].filter((a) => a.ProjectName === '2DT').length;
  const m2 = await reg(eE, tE, [{ key: 'defdefdefdef.png', type: 'Image', url: 'https://r2.example/m2' }]);
  ok((m2.j.evicted || []).includes(m1id) && !eE.SD_TOKENS.m.has('ast:lock:2DT:abcabcabcabc.png'), '★ 지울 때 그 사진의 done 표도 지움', m2.text);
  bpE.cap = 0;
  const m3 = await reg(eE, tE, [{ key: 'abcabcabcabc.png', type: 'Image', url: 'https://r2.example/m1' }]);
  ok(m3.j.items[0].status === 'Processing' && m3.j.items[0].id !== m1id && bpE.assets.has(m3.j.items[0].id), '★ 지운 사진을 다시 등록 → 옛 id 가 아니라 새로 만듦', m3.text);
  ok(bpE.sigBad.length === 0 && (bpE.calls.DeleteAsset || 0) === (bpE.deleted || []).length, `DeleteAsset ${bpE.calls.DeleteAsset || 0}번 · 서명 모두 맞음`);
}

console.log('\n[16] 어셋 — 팀 키를 재발급하면 프로젝트를 다시 찾는다');
{
  const lp = bp.calls.ListProjects;
  bp.keys['2DT'].push({ Id: 'ak9', Key: mask(KEY_TA_NEW), Status: 'Active' });
  ae.BP_KEY_TA = KEY_TA_NEW;
  const r = await call(ae, 'GET', '/v1/assets/project', { token: tTA });
  ok(r.j.project === '2DT' && bp.calls.ListProjects === lp + 1, '키 지문이 달라 다시 찾음');
  ok(JSON.parse(ae.SD_TOKENS.m.get('ast:proj:TA').value).fp === sha(KEY_TA_NEW).slice(0, 16), '새 지문으로 기록');
  const again = await reg(ae, tTA, [img('md5aaa.png')]);
  ok(again.j.items[0].id === firstId, '같은 프로젝트면 예전 어셋 기록 그대로');
  // 새 키가 다른 프로젝트로 옮겨 갔으면 그 프로젝트로
  bp.keys['2DT'] = bp.keys['2DT'].filter((x) => x.Id !== 'ak9');
  bp.keys['6T'].push({ Id: 'ak10', Key: mask(KEY_TA_NEW), Status: 'Active' });
  ae.SD_TOKENS.m.delete('ast:proj:TA');
  const moved = await call(ae, 'GET', '/v1/assets/project', { token: tTA });
  ok(moved.j.project === '6T', '키가 든 프로젝트가 바뀌면 따라감');
}

console.log('\n[17] 어셋 — 값은 어디에도 안 나간다 · KV 는 작게');
{
  const s = await call(ae, 'GET', '/admin/status', { token: ae.ADMIN_KEY });
  ok(s.status === 200 && s.j.assets.configured === true && s.j.assets.projects.TA === '6T' && s.j.assets.projects.T6 === null, '관리 화면 assets — 키 있음 · 팀별 프로젝트(모르면 null)', JSON.stringify(s.j.assets));
  const sOver = await call({ ...ae, TEAM_PROJECTS: '{"Special":"Special"}' }, 'GET', '/admin/status', { token: ae.ADMIN_KEY });
  ok(sOver.j.assets.projects.Special === 'Special', 'TEAM_PROJECTS 도 관리 화면에');
  ae.BP_KEY_TA = KEY_TA36;   // 재발급 전 키로 되돌리면 KV 의 지문(새 키)과 안 맞음 → 모름
  const sOld = await call(ae, 'GET', '/admin/status', { token: ae.ADMIN_KEY });
  ok(sOld.j.assets.projects.TA === null, '지문이 지금 키와 다르면 null(다음 요청 때 다시 찾음)');
  const nc = await call({ ...ae, BP_ASSET_AK: undefined }, 'GET', '/admin/status', { token: ae.ADMIN_KEY });
  ok(nc.j.assets.configured === false, '키 없으면 configured false');
  const cfg = await call({ ...ae, PC_SEEDANCE_LEAK: SK, PC_SEEDANCE_LEAK2: AK }, 'POST', '/v1/config', { token: tTA });
  ok(cfg.status === 200 && !cfg.text.includes(AK) && !cfg.text.includes(SK) && !Object.keys(cfg.j.env).some((k) => /ASSET/.test(k)), '묶음(bundleFor)에 BP_ASSET_* 없음 — PC_* 로 잘못 넣어도');
  const page = await call(ae, 'GET', '/admin');
  const h = await call(ae, 'GET', '/health');
  // 묶음은 원래 자기 팀 키 · R2 를 싣는다 — 거기선 AK/SK 만 본다(위). 관리 · health 는 값이 하나도 없어야 한다.
  const all = [s.text, sOver.text, sOld.text, nc.text, page.text, h.text].join('\n');
  const leaked = SECRET_VALUES(ae).filter((v) => all.includes(v));
  ok(leaked.length === 0 && !all.includes(AK) && !all.includes(SK), '관리 · health 응답에 AK/SK · 팀 키 값 없음', leaked.join(','));
  const big = [...ae.SD_TOKENS.m.entries()].filter(([k]) => k.startsWith('ast:'));
  ok(big.length > 0 && big.every(([, v]) => v.value.length < 200), `어셋 KV 값은 모두 200자 미만(${big.length}개)`, String(Math.max(...big.map(([, v]) => v.value.length))));
  ok(big.every(([, v]) => !SECRET_VALUES(ae).some((x) => v.value.includes(x)) && !v.value.includes(AK) && !v.value.includes(SK)), '어셋 KV 에 키 값 없음');
  ok(RESP.every((t) => !t.includes(AK) && !t.includes(SK)), `이 시험의 응답 ${RESP.length}개 어디에도 AK/SK 없음(어셋 응답 · 오류문 포함)`);
  ok(bp.sigBad.length === 0, `가짜 BytePlus 가 받은 요청 ${Object.values(bp.calls).reduce((a, b) => a + b, 0)}건 모두 서명 맞음`, bp.sigBad.join(','));
}

console.log(`\n${fail ? '실패 ' + fail + ' / ' : ''}통과 ${pass}`);
process.exit(fail ? 1 : 0);
