// seedance-gateway v3 — 키 나눠주기. PC 는 출입증(토큰) 하나만 들고, 앱을 켤 때 한 번 키 · 주소 묶음을 받아 간다.
//
// v1(2026-09-04) 은 NCP 키만 나눠줬다(R2 키로 서명). v2(2026-10-08, 배포 안 함)는 BytePlus 호출까지 여기서 중계했는데,
// 이 계정의 워커는 서울이 아니라 LAX 엣지에서 돌아 호출마다 +0.3초가 붙고 무료 한도(하루 10만 요청, 나노바나나와
// 공유)에 걸렸다. v3 는 중계하지 않는다 — 켤 때 한 번 묶음을 내려주고, 생성 · 업로드는 지금처럼 PC 가 BytePlus · R2 로
// 바로 간다. 관리자가 여기 값을 바꾸면 PC 는 다음 실행 때 새 값을 쓴다. 팀 bat · PC 는 손대지 않는다.
// (앱은 BytePlus · R2 가 '키가 틀렸다' 고 거절할 때만 실행 중에 한 번 더 받으러 온다 — electron/gateway.cjs)
//
// ── 출입증 ───────────────────────────────────────────────────────────────────
// 처음 켤 때 앱이 팀 bat 의 키로 '입장권'을 만들어 보낸다:  ticket = HMAC-SHA256(키, 'seedance-ticket-v1') (hex)
//   ★ 키 원문은 보내지 않는다. 입장권은 BytePlus 에서 아무 쓸모가 없다.
//   ★ 입장권은 해시로 기억한다(tkt:<sha256(ticket)>). 관리자가 키를 재발급해도 옛 bat 의 입장권은 그대로 통한다
//     — bat 을 고쳐 다시 나눠줄 일이 없다. 새 등록을 막으려면 ENROLL_OPEN="0".
//   ★ 팀은 입장권이 정한다(어느 BP_KEY_<팀> 에서 나온 것인지). 앱이 팀을 자칭하는 칸은 없다 — 팀이 곧 어느 BytePlus
//     키로 청구할지다.
// 출입증(sfv_…)은 PC 마다 다르고 원문은 저장하지 않는다(tok:<sha256 앞 16자> → { h: sha256 전체, … }).
//   KV 가 통째로 새도 쓸 수 있는 출입증 · 입장권이 안 나온다.
//
// ── 묶음 (POST /v1/config) — 앱의 process.env 에 들어가는 이름 → 값 ──────────────────
//   SEEDANCE_API_KEY             BP_KEY_<팀>
//   SEEDANCE_TEAM · _TEAM_LABEL  팀 코드 · 시트에 적히는 팀 이름(앱 v1 의 TEAM_KEY_HASHES 이름과 같다)
//   R2_ENDPOINT · R2_BUCKET · R2_ACCESS_KEY_ID · R2_SECRET_ACCESS_KEY(← R2_SECRET, v1 이름)
//   SEEDANCE_NCP_*               NCP_* (v1 이름 그대로)
//   SEEDANCE_TRACKER_URL         TRACKER_URL (크레딧 시트 GAS /exec — GAS 를 다시 배포해 주소가 바뀌어도 여기만)
//   SEEDANCE_TRACKER_SECRET      시트 서명 재료. 예전엔 앱이 R2 키에서 만들어서 R2 키를 바꾸면 시트 기록이 끊겼다.
//                                처음 한 번 그 값을 KV 에 박아 두고(cfg:tracker_secret) 그대로 내려준다. TRACKER_SECRET 시크릿이 우선
//   SEEDANCE_BP_BASE             BP_BASE (BytePlus 주소. 비우면 앱 기본값)
//   SEEDANCE_GEMINI_KEY          GEMINI_KEY (옴니 — 나노바나나와 환경변수를 같이 쓰지 않게)
//   SEEDANCE_GATEWAY_URL         GATEWAY_URL — 게이트웨이를 옮길 때. 앱이 기억했다가 다음 실행부터 거기로 간다
//   그 밖에                      PC_<이름> → <이름> (앞으로 생길 값. 한 팀만 다르게: PC_<이름>__<팀>)
//   rev                          묶음 지문 — 관리 화면에서 'PC 가 지금 값을 받았나' 를 본다(키를 끊기 전에)
//
// ── 시크릿 / 변수 ────────────────────────────────────────────────────────────
//   시크릿  ADMIN_KEY · BP_KEY_<팀> · R2_SECRET · R2_ACCESS_KEY_ID · NCP_ACCESS_KEY_ID · NCP_SECRET_ACCESS_KEY ·
//           GEMINI_KEY · (TRACKER_SECRET)
//   변수    R2_ENDPOINT · R2_BUCKET · NCP_ENDPOINT · NCP_REGION · NCP_BUCKET · NCP_PRESIGN_EXPIRES_SECONDS ·
//           TRACKER_URL · BP_BASE · GATEWAY_URL · TEAM_LABELS(JSON {"T6":"6팀"}) · ENROLL_OPEN("1"/"0") ·
//           LEGACY_NCP("0" 이면 v1 길을 닫는다 — 전 PC 가 v3 앱으로 넘어온 뒤에만)
//   팀 코드  영문 · 숫자 · _ (시크릿 이름이 된다). 이름은 TEAM_LABELS > 앱 v1 의 키 해시 표 > 코드 모양(T6·6T → 6팀,
//           그 밖에 코드+'팀') 순으로 정해지고, 등록 때 출입증에 박힌다 — 키를 재발급해도 시트의 팀 이름은 그대로다.
//
// ── KV 쓰기 (무료 하루 1,000회, 나노바나나와 공유) ─────────────────────────────
// 등록(PC 당 한 번) · 입장권 기억(키 하나당 한 번) · 묶음을 받은 기록(PC 당 12시간에 한 번까지, 묶음이 바뀌면 바로)뿐.
// 생성마다 쓰지 않는다.

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TICKET_MSG = 'seedance-ticket-v1';
const TEAM_RE = /^[A-Za-z0-9_]{1,32}$/;
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SEEN_EVERY_MS = 12 * 60 * 60 * 1000;

// 앱 v1(server.ts TEAM_KEY_HASHES)이 쓰던 팀 이름: 키의 sha256 → 이름. 등록할 때 같은 이름을 붙여 시트 기록이 이어지게
// 한다. 원래 공개 저장소에 있던 값이다(해시로 키를 되돌릴 수 없다). 키를 재발급한 뒤의 새 키는 여기 없어도 된다 —
// 이름은 출입증 · 입장권에 이미 박혀 있다.
const KNOWN_LABELS = {
  '75a2bbd0f6a59fabc34712d4d1b70428156930f0a09f15089af5b7f4beff307a': '1팀',
  '276647adf6ebf0cd833aa34d849d15b3284ed620c32db93db8856042cdc110d8': '2팀',
  '75844d45e148d73c3a0688137b00362c6687c7c27bbad3e5edb8a3ebd93f81fe': '3팀',
  'c50dadbb9122af437fc4055818ed8adfaaedf95798f0e49844f975e637219f8a': '4팀',
  '7f386ec974cddc1275fc958610f8f87d89d2545708cafb2c5e7747c2ac09d236': '5팀',
  '46f44ffe5b2d1250afdc432a290090b458d74ba4660bd5ee056b5fe50e166ae9': '6팀',
  'c1b0d1e162f0581baab701c6f3c42d8c22fe4a66cd677d819e84fbf87b167e26': '7팀',
  '2f44415f419f831b005409e2ad102bce3ec02d67a9ace1b0b9f754143a2b5595': '8팀',
  'a363ada0a1c1d39f02ebd47a8e0364ab0de46e127a643dc305d9de3b1701170b': '9팀',
  'a4eccba638ecf60e0bab44575e0ff433938d3290d913b3ad13b2cc0fceccae17': '10팀',
  'a0f79d7874f2e5aabe1db15fc93acdb80512a30326f2fcb9914ae1ee2e9319bb': 'AFX팀',
  '96c54e01db364d162ae628faaad0f5fc1a1dc8933b0b84defcd63bc910612a82': 'AFX_1팀',
  'be80455a50e2aeb7ecd5cab99a48fc68e2d248530b84ddf766531e2876af850e': 'AFX_2팀',
  'c66699dfb03aad9ec1de1f1d2feb315c379f8ec275bce43627aa26a3a3ba0973': 'AFX_3팀',
  'bd0900883cc308becf0fe4e8d629130acea5a59e26b4667bef6f9a861a0e6bbb': 'TA팀',
  '724cf3b6d22b122d01b371eb8e550ffe4053b5eef4731becd3684f5c72bf4d4d': 'Special팀',
  '0e43bc6b870b1d889724d6abe19cf23bda010114b780efcf0635e94964f1e117': 'AIP팀',
};

// ────────────────────────────────────────────────────────────────── 공통
const enc = new TextEncoder();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

async function hmacHex(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

// 길이가 다르면 바로 false — 비교하는 건 언제나 hex 64자라 길이로 새는 정보가 없다.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : '';
}

async function readJson(request, limit) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (limit && len > limit) return { error: 'too large' };
  const text = await request.text();
  if (limit && text.length > limit) return { error: 'too large' };
  try {
    const body = JSON.parse(text || '{}');
    return body && typeof body === 'object' && !Array.isArray(body) ? { body } : { error: 'bad json' };
  } catch { return { error: 'bad json' }; }
}

function parseJsonVar(s) {
  try { const o = JSON.parse(s || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

// ────────────────────────────────────────────────────────────────── 팀
function teamKeys(env) {
  const out = [];
  for (const name of Object.keys(env)) {
    const m = name.match(/^BP_KEY_([A-Za-z0-9_]{1,32})$/);
    if (m && typeof env[name] === 'string' && env[name]) out.push({ code: m[1], key: env[name] });
  }
  return out.sort((a, b) => a.code.localeCompare(b.code));
}

// TEAM_LABELS > 앱 v1 의 키 해시 표 > 코드 모양
function labelFor(env, code, keyHash) {
  const over = parseJsonVar(env.TEAM_LABELS)[code];
  if (typeof over === 'string' && over.trim()) return clip(over, 32);
  if (keyHash && KNOWN_LABELS[keyHash]) return KNOWN_LABELS[keyHash];
  const m = code.match(/^T(\d{1,3})$|^(\d{1,3})T$/);
  if (m) return `${m[1] || m[2]}팀`;
  return `${code}팀`;
}

// ────────────────────────────────────────────────────────────────── 입장권
const ticketOf = (key) => hmacHex(key, TICKET_MSG);
// 이 isolate 안에서 이미 KV 에 있는 걸 확인한 입장권 해시 — 같은 걸 또 읽지 않는다. KV 마다 따로(시험은 KV 를 여럿 쓴다).
const rememberedBy = new WeakMap();
const rememberedIn = (kv) => { let s = rememberedBy.get(kv); if (!s) rememberedBy.set(kv, (s = new Set())); return s; };

async function rememberTicket(env, th, team, label) {
  const seen = rememberedIn(env.SD_TOKENS);
  if (seen.has(th)) return;
  if (!(await env.SD_TOKENS.get(`tkt:${th}`))) {
    const at = new Date().toISOString();
    await env.SD_TOKENS.put(`tkt:${th}`, JSON.stringify({ team, label, at }), { metadata: { team, label, at } });
  }
  seen.add(th);
}

// 지금 키들의 입장권을 기억해 둔다 — 그 팀 PC 가 아직 하나도 등록하지 않았어도, 나중에 키를 재발급한 뒤
// 옛 bat 으로 등록할 수 있게. isolate 마다 처음 한 번만 KV 를 읽는다.
async function rememberCurrentTickets(env) {
  const seen = rememberedIn(env.SD_TOKENS);
  for (const { code, key } of teamKeys(env)) {
    const th = await sha256Hex(await ticketOf(key));
    if (seen.has(th)) continue;
    await rememberTicket(env, th, code, labelFor(env, code, await sha256Hex(key)));
  }
}

// 입장권 → { team, label }. 지금 키에서 나온 것이면 KV 를 읽지 않는다(등록 폭주가 KV 읽기를 태우지 않게).
async function teamOfTicket(env, ticket) {
  const current = [];
  for (const { code, key } of teamKeys(env)) {
    if (timingSafeEqual(await ticketOf(key), ticket)) current.push({ code, key });
  }
  if (current.length > 1) return { error: `설정 오류: 같은 키가 여러 팀에 있습니다 (${current.map((c) => c.code).join(', ')})`, status: 409 };
  const th = await sha256Hex(ticket);
  if (current.length === 1) {
    const { code, key } = current[0];
    const label = labelFor(env, code, await sha256Hex(key));
    await rememberTicket(env, th, code, label);
    return { team: code, label };
  }
  const raw = await env.SD_TOKENS.get(`tkt:${th}`);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  // 팀이 없어졌으면(BP_KEY_<팀> 을 지웠으면) 그 팀 입장권도 죽은 것이다.
  if (!env[`BP_KEY_${rec.team}`]) return { error: `팀 ${rec.team} 의 키가 게이트웨이에 없습니다.`, status: 403 };
  return { team: rec.team, label: rec.label };
}

// ────────────────────────────────────────────────────────────────── 출입증
function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  // sfv_ 머리 — 로그나 깃 diff 에 섞여 들어갔을 때 사람도 스캐너도 알아본다.
  return 'sfv_' + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const tokenMeta = (rec) => ({
  team: rec.team, label: rec.label, pc: rec.pc, created: rec.created, via: rec.via,
  seen: rec.seen || null, rev: rec.rev || null, app: rec.app || null, revoked: rec.revoked || null, left: rec.left || null,
  ip: rec.ip || null, country: rec.country || null,
});

// 그 요청이 온 곳 — Cloudflare 가 보는 공인 IP 와 나라(관리 화면용, 사용자 요청 2026-10-08). 사무실 PC 들은 공유기 하나로
// 나가 같은 IP 로 보인다 — 사무실 · 집 · 해외를 가리는 용도. PC 의 사내 IP 는 여기서 안 보인다.
const whereOf = (request) => ({
  ip: clip(request.headers.get('CF-Connecting-IP'), 45),
  country: clip(request.cf && request.cf.country, 2),
});

async function issueToken(env, team, label, pc, app, via, where = {}) {
  const token = newToken();
  const h = await sha256Hex(token);
  const id = h.slice(0, 16);
  const rec = { h, team, label, pc, app, created: new Date().toISOString(), via, ip: where.ip || '', country: where.country || '' };
  await env.SD_TOKENS.put(`tok:${id}`, JSON.stringify(rec), { metadata: tokenMeta(rec) });
  return { ok: true, token, token_id: id, team, label, pc };
}

// code: 'unknown'(모르는 출입증 — 앱은 다시 등록해 본다) / 'revoked'(관리자가 끊음 — 앱은 다시 등록하지 않는다)
async function authToken(request, env) {
  const token = bearer(request);
  if (!token || !token.startsWith('sfv_')) return { ok: false, status: 401, code: 'unknown', error: 'token required' };
  const h = await sha256Hex(token);
  const raw = await env.SD_TOKENS.get(`tok:${h.slice(0, 16)}`);
  if (!raw) return { ok: false, status: 401, code: 'unknown', error: 'invalid token' };
  const rec = JSON.parse(raw);
  if (!timingSafeEqual(rec.h, h)) return { ok: false, status: 401, code: 'unknown', error: 'invalid token' };
  if (rec.revoked) return { ok: false, status: 401, code: 'revoked', error: '관리자가 이 PC 의 출입증을 끊었습니다.' };
  return { ok: true, rec, id: h.slice(0, 16) };
}

async function authAdmin(request, env) {
  if (!env.ADMIN_KEY) return false;
  return timingSafeEqual(await sha256Hex(bearer(request)), await sha256Hex(env.ADMIN_KEY));
}

// ────────────────────────────────────────────────────────────────── 묶음
// 앱 v1 과 같은 유도(server.ts trackerAuth) — 시트(GAS)의 APP_SHARED_SECRET 을 안 바꿔도 된다. 처음 한 번 박아 둔다.
async function trackerSecret(env) {
  if (env.TRACKER_SECRET) return env.TRACKER_SECRET;
  const pinned = await env.SD_TOKENS.get('cfg:tracker_secret');
  if (pinned) return pinned;
  if (!env.R2_SECRET) return '';
  const v = await hmacHex(env.R2_SECRET, 'seedance-tracker-v1');
  await env.SD_TOKENS.put('cfg:tracker_secret', v, { metadata: { at: new Date().toISOString() } });
  return v;
}

async function bundleFor(env, rec) {
  const key = env[`BP_KEY_${rec.team}`];
  if (!key) return { error: `팀 ${rec.team} 의 키가 게이트웨이에 없습니다. 관리자에게 알려주세요.`, status: 503 };
  const out = {};
  // 앞으로 생길 값 — 모든 팀 몫 먼저, 그다음 이 팀 몫(PC_<이름>__<팀>)으로 덮는다. 아래 정해진 이름이 마지막에 이긴다.
  const perTeam = {};
  for (const name of Object.keys(env)) {
    if (!name.startsWith('PC_') || typeof env[name] !== 'string') continue;
    const rest = name.slice(3);
    const cut = rest.lastIndexOf('__');
    const base = cut > 0 ? rest.slice(0, cut) : rest;
    const team = cut > 0 ? rest.slice(cut + 2) : '';
    if (!NAME_RE.test(base)) continue;
    if (!team) out[base] = env[name];
    else if (team === rec.team) perTeam[base] = env[name];
  }
  Object.assign(out, perTeam);
  const label = clip(parseJsonVar(env.TEAM_LABELS)[rec.team], 32) || rec.label;
  out.SEEDANCE_API_KEY = key;
  out.SEEDANCE_TEAM = rec.team;
  out.SEEDANCE_TEAM_LABEL = label;
  if (env.R2_ENDPOINT) out.R2_ENDPOINT = env.R2_ENDPOINT;
  if (env.R2_BUCKET) out.R2_BUCKET = env.R2_BUCKET;
  if (env.R2_ACCESS_KEY_ID) out.R2_ACCESS_KEY_ID = env.R2_ACCESS_KEY_ID;
  if (env.R2_SECRET) out.R2_SECRET_ACCESS_KEY = env.R2_SECRET;
  if (env.NCP_ACCESS_KEY_ID && env.NCP_SECRET_ACCESS_KEY) {
    out.SEEDANCE_NCP_ACCESS_KEY_ID = env.NCP_ACCESS_KEY_ID;
    out.SEEDANCE_NCP_SECRET_ACCESS_KEY = env.NCP_SECRET_ACCESS_KEY;
    if (env.NCP_ENDPOINT) out.SEEDANCE_NCP_ENDPOINT = env.NCP_ENDPOINT;
    if (env.NCP_REGION) out.SEEDANCE_NCP_REGION = env.NCP_REGION;
    if (env.NCP_BUCKET) out.SEEDANCE_NCP_BUCKET = env.NCP_BUCKET;
    if (env.NCP_PRESIGN_EXPIRES_SECONDS) out.SEEDANCE_NCP_PRESIGN_EXPIRES_SECONDS = String(env.NCP_PRESIGN_EXPIRES_SECONDS);
  }
  if (env.TRACKER_URL) out.SEEDANCE_TRACKER_URL = env.TRACKER_URL;
  const ts = await trackerSecret(env);
  if (ts) out.SEEDANCE_TRACKER_SECRET = ts;
  if (env.BP_BASE) out.SEEDANCE_BP_BASE = env.BP_BASE;
  if (env.GEMINI_KEY) out.SEEDANCE_GEMINI_KEY = env.GEMINI_KEY;
  if (env.GATEWAY_URL) out.SEEDANCE_GATEWAY_URL = env.GATEWAY_URL;
  for (const k of Object.keys(out)) out[k] = String(out[k]);
  const rev = (await sha256Hex(JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]])))).slice(0, 12);
  return { env: out, rev, team: rec.team, label };
}

// ────────────────────────────────────────────────────────────────── 라우트
async function enroll(request, env, ctx) {
  if (!env.SD_TOKENS) return json({ ok: false, error: 'gateway not configured (SD_TOKENS)' }, 503);
  if (env.ENROLL_OPEN !== '1') {
    return json({ ok: false, code: 'closed', error: '새 PC 등록이 닫혀 있습니다. 관리자에게 알려주세요.' }, 403);
  }
  const r = await readJson(request, 4096);
  if (r.error) return json({ ok: false, error: r.error }, 400);
  const ticket = String(r.body.ticket || '');
  if (!/^[0-9a-f]{64}$/.test(ticket)) return json({ ok: false, error: 'bad ticket' }, 400);
  const found = await teamOfTicket(env, ticket);
  if (!found) return json({ ok: false, code: 'ticket', error: '등록된 팀 키가 아닙니다. 팀 bat 을 확인하세요.' }, 403);
  if (found.error) return json({ ok: false, error: found.error }, found.status);
  const pc = clip(r.body.pc, 64) || 'unknown-pc';
  const app = clip(r.body.app, 24);
  ctx.waitUntil(rememberCurrentTickets(env).catch(() => {}));
  return json(await issueToken(env, found.team, found.label, pc, app, 'ticket', whereOf(request)));
}

async function config(request, env, ctx, a) {
  const b = await bundleFor(env, a.rec);
  if (b.error) return json({ ok: false, error: b.error }, b.status);
  const r = await readJson(request, 4096);
  const app = r.body ? clip(r.body.app, 24) : '';
  const now = Date.now();
  const rec = a.rec;
  const where = whereOf(request);
  // 관리 화면용 기록 — 12시간에 한 번, 또는 묶음 · 앱 버전 · IP 가 바뀌었을 때만 쓴다(앱은 켤 때만 오므로 그 이상은 안 쓴다).
  if (!rec.seen || now - Date.parse(rec.seen) > SEEN_EVERY_MS || rec.rev !== b.rev || (app && rec.app !== app) || (where.ip && rec.ip !== where.ip)) {
    const next = { ...rec, seen: new Date(now).toISOString(), rev: b.rev, ...(app ? { app } : {}), ...(where.ip ? where : {}) };
    ctx.waitUntil(env.SD_TOKENS.put(`tok:${a.id}`, JSON.stringify(next), { metadata: tokenMeta(next) }).catch(() => {}));
  }
  ctx.waitUntil(rememberCurrentTickets(env).catch(() => {}));
  return json({ ok: true, v: 3, rev: b.rev, team: b.team, label: b.label, pc: rec.pc, env: b.env });
}

// 이 출입증을 내려놓는다 — PC 에서 다른 팀 bat 을 돌려 그 팀으로 다시 등록했을 때 앱이 옛 출입증으로 부른다.
// 관리 화면에 같은 PC 가 두 팀으로 남지 않게 '팀 바꿈' 으로 끊어 둔다(되살리기 가능).
async function leave(env, a) {
  const rec = { ...a.rec, revoked: new Date().toISOString(), left: 'team-change' };
  await env.SD_TOKENS.put(`tok:${a.id}`, JSON.stringify(rec), { metadata: tokenMeta(rec) });
  return json({ ok: true });
}

// 입장권이 어느 팀 것인가 — 키 확인 bat(키확인.ps1)이 '이 PC 에 깔린 키 = ○○팀 키' 를 보여 줄 때. 출입증을 주지 않고
// 아무것도 쓰지 않는다(지금 키에서 나온 입장권이면 기억만 — 등록과 같은 규칙). 입장권은 키 원문이 아니다.
async function ticketTeam(request, env) {
  if (!env.SD_TOKENS) return json({ ok: false, error: 'gateway not configured (SD_TOKENS)' }, 503);
  const r = await readJson(request, 1024);
  if (r.error) return json({ ok: false, error: r.error }, 400);
  const ticket = String(r.body.ticket || '');
  if (!/^[0-9a-f]{64}$/.test(ticket)) return json({ ok: false, error: 'bad ticket' }, 400);
  const found = await teamOfTicket(env, ticket);
  if (!found) return json({ ok: false, code: 'ticket', error: '등록된 팀 키가 아닙니다.' }, 404);
  if (found.error) return json({ ok: false, error: found.error }, found.status);
  return json({ ok: true, team: found.team, label: found.label });
}

// v1 그대로. 문구 · 상태코드까지 바꾸지 않는다 — 깔려 있는 앱(26.10.801 이하)이 이걸 보고 동작한다.
async function legacyNcp(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad request' }, 400); }
  const ts = Number(body && body.ts);
  if (!Number.isFinite(ts)) return json({ ok: false, error: 'missing ts' }, 400);
  const skew = Date.now() - ts;
  if (Math.abs(skew) > CLOCK_SKEW_MS) {
    return json({
      ok: false,
      error: `타임스탬프가 허용 창(5분)을 벗어났습니다. PC 시계를 확인하세요. (차이 ${Math.round(skew / 1000)}초)`,
    }, 401);
  }
  if (!env.R2_SECRET) return json({ ok: false, error: 'gateway not configured (R2_SECRET)' }, 503);
  const want = await hmacHex(env.R2_SECRET, `ncp:${ts}`);
  if (!timingSafeEqual(String((body && body.sig) || ''), want)) {
    return json({ ok: false, error: 'R2 키로 만든 서명이 아닙니다. R2.bat 을 실행한 PC 인지 확인하세요.' }, 403);
  }
  if (!env.NCP_ACCESS_KEY_ID || !env.NCP_SECRET_ACCESS_KEY) {
    return json({ ok: false, error: 'gateway not configured (NCP keys)' }, 503);
  }
  return json({
    ok: true,
    endpoint: env.NCP_ENDPOINT,
    region: env.NCP_REGION,
    bucket: env.NCP_BUCKET,
    accessKeyId: env.NCP_ACCESS_KEY_ID,
    secretAccessKey: env.NCP_SECRET_ACCESS_KEY,
    presignExpiresSeconds: Number(env.NCP_PRESIGN_EXPIRES_SECONDS || 3600),
  });
}

// ────────────────────────────────────────────────────────────────── 관리
// 값은 절대 내보내지 않는다 — 있나 없나, 키는 sha256 앞 8자(어느 키가 들어갔는지 맞춰 보는 용도)만.
async function adminStatus(env) {
  const tickets = new Set();
  let cursor;
  do {
    const page = await env.SD_TOKENS.list({ prefix: 'tkt:', cursor });
    for (const k of page.keys) tickets.add(k.name.slice(4));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const teams = [];
  for (const { code, key } of teamKeys(env)) {
    const kh = await sha256Hex(key);
    const th = await sha256Hex(await ticketOf(key));
    teams.push({
      code, label: labelFor(env, code, kh), key8: kh.slice(0, 8), known: KNOWN_LABELS[kh] || null,
      ticket: tickets.has(th),
    });
  }
  const generic = Object.keys(env).filter((n) => n.startsWith('PC_')).sort();
  return {
    ok: true,
    version: 3,
    enrollOpen: env.ENROLL_OPEN === '1',
    legacyNcp: env.LEGACY_NCP !== '0',
    teams,
    r2: { endpoint: env.R2_ENDPOINT || null, bucket: env.R2_BUCKET || null, keys: Boolean(env.R2_ACCESS_KEY_ID && env.R2_SECRET) },
    ncp: { endpoint: env.NCP_ENDPOINT || null, bucket: env.NCP_BUCKET || null, keys: Boolean(env.NCP_ACCESS_KEY_ID && env.NCP_SECRET_ACCESS_KEY) },
    tracker: { url: Boolean(env.TRACKER_URL), secret: env.TRACKER_SECRET ? 'secret' : (await env.SD_TOKENS.get('cfg:tracker_secret')) ? 'pinned' : (env.R2_SECRET ? 'not yet' : 'none') },
    gemini: Boolean(env.GEMINI_KEY),
    bpBase: env.BP_BASE || null,
    gatewayUrl: env.GATEWAY_URL || null,
    generic,
  };
}

async function admin(request, env, path) {
  if (!env.SD_TOKENS) return json({ ok: false, error: 'gateway not configured (SD_TOKENS)' }, 503);
  if (!(await authAdmin(request, env))) return json({ ok: false, error: 'admin key required' }, 401);

  if (path === '/admin/status' && request.method === 'GET') {
    await rememberCurrentTickets(env);   // 키를 넣고 이 화면을 열면 그 키의 입장권이 기억된다
    return json(await adminStatus(env));
  }

  // 목록 — 원문도 해시도 내보내지 않는다. 메타데이터만(목록 한 번으로 끝나서 읽기도 1회).
  if (path === '/admin/tokens' && request.method === 'GET') {
    const out = [];
    let cursor;
    do {
      const page = await env.SD_TOKENS.list({ prefix: 'tok:', cursor });
      for (const k of page.keys) out.push({ token_id: k.name.slice(4), ...(k.metadata || {}) });
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json({ ok: true, tokens: out });
  }

  // 끊기 / 되살리기 — 그 PC 하나만. 팀 키 · 다른 PC 는 그대로. 끊긴 PC 의 앱은 다시 등록하지 않는다.
  if ((path === '/admin/revoke' || path === '/admin/restore') && request.method === 'POST') {
    const r = await readJson(request, 1024);
    if (r.error) return json({ ok: false, error: r.error }, 400);
    const id = String(r.body.token_id || '');
    if (!/^[0-9a-f]{16}$/.test(id)) return json({ ok: false, error: 'bad token_id' }, 400);
    const raw = await env.SD_TOKENS.get(`tok:${id}`);
    if (!raw) return json({ ok: false, error: 'no such token' }, 404);
    const rec = JSON.parse(raw);
    if (path === '/admin/revoke') rec.revoked = new Date().toISOString(); else { delete rec.revoked; delete rec.left; }
    await env.SD_TOKENS.put(`tok:${id}`, JSON.stringify(rec), { metadata: tokenMeta(rec) });
    return json({ ok: true, token_id: id, revoked: rec.revoked || null });
  }

  return json({ ok: false, error: 'not found' }, 404);
}

// 관리 화면 — 워커가 직접 준다. 관리자 키는 이 브라우저(localStorage)에만 둔다.
const ADMIN_HTML = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>시댄스 게이트웨이</title>
<style>
:root{--bg:#f6f6f8;--card:#fff;--line:#e4e4ea;--tx:#1d1d22;--tx2:#6e6e78;--ok:#1a7f37;--bad:#c62828;--acc:#0071e3}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:13px/1.55 'Malgun Gothic','Segoe UI',system-ui,sans-serif;padding:20px}
h1{font-size:18px;margin:0 0 4px}.sub{color:var(--tx2);margin:0 0 16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px;overflow-x:auto}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--tx2);font-weight:600}.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--tx2)}
button{border:1px solid var(--line);background:#fff;border-radius:6px;padding:3px 10px;cursor:pointer;font:inherit}
button.danger{color:var(--bad)}code{background:#f0f0f4;border-radius:4px;padding:1px 5px}
</style></head><body>
<h1>시댄스 게이트웨이</h1><p class="sub">PC 는 앱을 켤 때 여기서 키 · 주소 묶음을 받아 갑니다. 값은 이 화면에 나오지 않습니다.</p>
<div class="card" id="status">불러오는 중…</div>
<div class="card"><b>PC</b> <span class="muted" id="cnt"></span><table id="tok"></table></div>
<script>
const KEY_LS='sd_admin_key';let KEY=localStorage.getItem(KEY_LS)||'';
if(!KEY){KEY=prompt('관리자 키')||'';if(KEY)localStorage.setItem(KEY_LS,KEY);}
const H=()=>({Authorization:'Bearer '+KEY,'Content-Type':'application/json'});
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const yes=b=>b?'<span class="ok">있음</span>':'<span class="bad">없음</span>';
const kst=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const day=s=>{if(!s)return '';try{return kst.format(new Date(s));}catch(e){return String(s).slice(0,16);}};
async function api(p,o){const r=await fetch(p,{...o,headers:H()});if(r.status===401){localStorage.removeItem(KEY_LS);throw new Error('관리자 키가 틀렸습니다 — 새로고침해서 다시 넣으세요');}return r.json();}
async function load(){
 try{
  const s=await api('/admin/status');
  let h='<b>설정</b><table><tr><th>팀 코드</th><th>시트 이름</th><th title="키 자체가 아니라 키의 지문(SHA-256)의 앞 8자입니다. 키 값은 이 화면에 나오지 않습니다 — 어느 키가 들어갔는지 맞춰 보는 용도">키 지문(해시 앞 8자)</th><th>앱 v1 표와</th><th>입장권 기억</th></tr>';
  for(const t of s.teams)h+='<tr><td><code>BP_KEY_'+esc(t.code)+'</code></td><td>'+esc(t.label)+'</td><td>'+esc(t.key8)+'</td><td>'+(t.known?(t.known===t.label?'<span class="ok">'+esc(t.known)+' 맞음</span>':'<span class="bad">'+esc(t.known)+' 키인데 이름이 다름</span>'):'<span class="muted">새 키</span>')+'</td><td>'+(t.ticket?'<span class="ok">예</span>':'<span class="bad">아니오</span>')+'</td></tr>';
  const sig={secret:'<span class="ok">직접 넣은 값</span>',pinned:'<span class="ok">고정됨</span>','not yet':'<span class="muted">첫 묶음 때 고정</span>',none:'<span class="bad">없음</span>'}[s.tracker.secret]||esc(s.tracker.secret);
  const opt=(v,label)=>v?'<span class="ok">'+label+'</span>':'<span class="muted">앱 기본값</span>';
  h+='</table><p>새 PC 등록 '+(s.enrollOpen?'<span class="ok">열림</span>':'<span class="bad">닫힘</span>')+' · v1 NCP 길 '+(s.legacyNcp?'열림':'닫힘')+' · R2 '+yes(s.r2.keys&&s.r2.endpoint&&s.r2.bucket)+' · NCP '+yes(s.ncp.keys)+' · 시트 서명 '+sig+' · 옴니 키 '+yes(s.gemini)+'</p>';
  h+='<p class="muted">바뀔 때만 넣는 값 — 시트 주소 '+opt(s.tracker.url,'게이트웨이 값')+' · BytePlus 주소 '+opt(s.bpBase,esc(s.bpBase))+(s.gatewayUrl?' · 게이트웨이 새 주소 '+esc(s.gatewayUrl):'')+(s.generic.length?' · 그 밖에 '+s.generic.map(esc).join(', '):'')+'</p>';
  document.getElementById('status').innerHTML=h;
  const t=await api('/admin/tokens');
  const rows=t.tokens.sort((a,b)=>String(a.label).localeCompare(String(b.label))||String(a.pc).localeCompare(String(b.pc)));
  let g='<tr><th>팀</th><th>PC</th><th title="Cloudflare 가 본 공인 IP · 나라. 사무실 PC 들은 같은 IP 로 보입니다">IP</th><th>앱</th><th>등록 (한국 시간)</th><th>마지막으로 받음</th><th>묶음</th><th></th></tr>';
  for(const x of rows)g+='<tr'+(x.revoked?' class="muted"':'')+'><td>'+esc(x.label)+'</td><td>'+esc(x.pc)+'</td><td>'+(x.ip?esc(x.ip)+(x.country?' <span class="muted">'+esc(x.country)+'</span>':''):'<span class="muted">-</span>')+'</td><td>'+esc(x.app||'')+'</td><td>'+day(x.created)+'</td><td>'+day(x.seen)+'</td><td><code>'+esc(x.rev||'-')+'</code></td><td>'+(x.revoked?(x.left==='team-change'?'<span title="이 PC 는 다른 팀 bat 으로 새 출입증을 받았습니다 — 할 일 없음">팀 바꿈</span>':'끊김 <button title="잘못 끊었을 때 되돌립니다" onclick="act(\\'restore\\',\\''+x.token_id+'\\')">되살리기</button>'):'<button class="danger" onclick="act(\\'revoke\\',\\''+x.token_id+'\\')">끊기</button>')+'</td></tr>';
  document.getElementById('tok').innerHTML=g;
  document.getElementById('cnt').textContent=rows.filter(x=>!x.revoked).length+'대';
 }catch(e){document.getElementById('status').textContent=e.message;}
}
async function act(a,id){if(a==='revoke'&&!confirm('이 PC 의 출입증을 끊을까요? 그 PC 는 키를 다시 받지 못합니다.'))return;await api('/admin/'+a,{method:'POST',body:JSON.stringify({token_id:id})});load();}
load();
</script></body></html>`;

// ────────────────────────────────────────────────────────────────── 라우터
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      // 시크릿 값은 절대 내보내지 않는다. configured · bucket 은 v1 이 내던 필드 — 이름 · 뜻 그대로 둔다.
      return json({
        ok: true,
        service: 'seedance-gateway',
        version: 3,
        configured: Boolean(env.R2_SECRET && env.NCP_ACCESS_KEY_ID && env.NCP_SECRET_ACCESS_KEY),
        bucket: env.NCP_BUCKET || null,
        tokens: Boolean(env.SD_TOKENS),
      });
    }

    if (path === '/ncp/credentials') {
      if (env.LEGACY_NCP === '0') return json({ ok: false, error: 'legacy auth closed — update the app' }, 410);
      return legacyNcp(request, env);
    }

    if (path === '/admin' && request.method === 'GET') {
      return new Response(ADMIN_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
          'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
        },
      });
    }
    if (path.startsWith('/admin/')) return admin(request, env, path);

    // 출입증을 받으러 오는 길이라 출입증 검사보다 앞에 있다. 입장권을 스스로 검사한다.
    if (path === '/v1/enroll' && request.method === 'POST') return enroll(request, env, ctx);
    if (path === '/v1/ticket' && request.method === 'POST') return ticketTeam(request, env);

    if (path.startsWith('/v1/')) {
      if (!env.SD_TOKENS) return json({ ok: false, error: 'gateway not configured (SD_TOKENS)' }, 503);
      const a = await authToken(request, env);
      if (!a.ok) return json({ ok: false, code: a.code, error: a.error }, a.status);
      if (path === '/v1/config' && request.method === 'POST') return config(request, env, ctx, a);
      if (path === '/v1/leave' && request.method === 'POST') return leave(env, a);
      if (path === '/v1/whoami' && request.method === 'GET') {
        return json({ ok: true, team: a.rec.team, label: a.rec.label, pc: a.rec.pc });
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
