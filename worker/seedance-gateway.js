// seedance-gateway v3 — 키 나눠주기. PC 는 출입증(토큰) 하나만 들고, 앱을 켤 때 한 번 키 · 주소 묶음을 받아 간다.
//
// v1(2026-09-04) 은 NCP 키만 나눠줬다(R2 키로 서명). v2(2026-10-08, 배포 안 함)는 BytePlus 호출까지 여기서 중계했는데,
// 이 계정의 워커는 서울이 아니라 LAX 엣지에서 돌아 호출마다 +0.3초가 붙고 Workers Paid 월 포함량(요청 수, 나노바나나와
// 공유)도 그만큼 쓴다. v3 는 중계하지 않는다 — 켤 때 한 번 묶음을 내려주고, 생성 · 업로드는 지금처럼 PC 가 BytePlus · R2 로
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
// ── 어셋 (GET /v1/assets/project · POST /v1/assets/register · POST /v1/assets/status) ─────────────
// AI 로 만든 가상 인물을 BytePlus 비공개 어셋 라이브러리에 올려 영상 요청에서 asset://<id> 로 부르게 한다. 아래 '어셋' 칸.
//   시크릿  BP_ASSET_AK · BP_ASSET_SK — 어셋 전용 IAM 사용자(seedance-asset-gateway). PC 에는 절대 내려주지 않는다.
//   변수    TEAM_PROJECTS(JSON {"TA":"2DT"} — 찾기보다 우선) · BP_OPENAPI_HOST · BP_ASSET_HOST(시험용) · ASSET_TEST_HTTP("1" 이면
//           http://127.0.0.1 · localhost 주소 허용 — 시험용)
//
// ── KV 쓰기 (월 포함량으로 계산, 넘으면 과금, 나노바나나와 공유) ─────────────────────────────
// 등록(PC 당 한 번) · 입장권 기억(키 하나당 한 번) · 묶음을 받은 기록(PC 당 12시간에 한 번까지, 묶음이 바뀌면 바로) ·
// 어셋(팀 → 프로젝트를 처음 찾을 때 · 그룹 · 어셋을 처음 만들 때(잠금 걸기 · 풀기 포함) · 어셋 상태가 바뀔 때)뿐. 생성마다 쓰지 않는다.

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
  // 어셋 서명 키는 PC 몫이 아니다 — PC_* 로 잘못 넣어도 묶음에 실리지 않게 값으로 한 번 더 거른다.
  for (const k of Object.keys(out)) if ((env.BP_ASSET_AK && out[k] === env.BP_ASSET_AK) || (env.BP_ASSET_SK && out[k] === env.BP_ASSET_SK)) delete out[k];
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
  // PC 이름은 표시용일 뿐이다(PC 를 알아보는 건 출입증). 앱(26.10.803~)이 켤 때마다 지금 이름을 보내므로, 윈도우에서 PC 이름을
  // 바꾸면 관리 화면도 따라간다. 802 는 등록 때 한 번만 보냈다.
  const pcNow = r.body ? clip(r.body.pc, 64) : '';
  const now = Date.now();
  const rec = a.rec;
  const where = whereOf(request);
  // 관리 화면용 기록 — 12시간에 한 번, 또는 묶음 · 앱 버전 · IP · PC 이름이 바뀌었을 때만 쓴다(앱은 켤 때만 오므로 그 이상은 안 쓴다).
  if (!rec.seen || now - Date.parse(rec.seen) > SEEN_EVERY_MS || rec.rev !== b.rev || (app && rec.app !== app)
      || (where.ip && rec.ip !== where.ip) || (pcNow && rec.pc !== pcNow)) {
    const next = { ...rec, seen: new Date(now).toISOString(), rev: b.rev, ...(app ? { app } : {}), ...(where.ip ? where : {}), ...(pcNow ? { pc: pcNow } : {}) };
    ctx.waitUntil(env.SD_TOKENS.put(`tok:${a.id}`, JSON.stringify(next), { metadata: tokenMeta(next) }).catch(() => {}));
  }
  ctx.waitUntil(rememberCurrentTickets(env).catch(() => {}));
  return json({ ok: true, v: 3, rev: b.rev, team: b.team, label: b.label, pc: pcNow || rec.pc, env: b.env });
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

// ────────────────────────────────────────────────────────────────── 어셋
// 어셋은 BytePlus 프로젝트마다 따로다 — 팀 키(BP_KEY_<팀>)가 든 프로젝트에 올려야 그 팀 키로 보낸 영상 요청이 asset://<id> 를
// 찾는다. 프로젝트 이름은 팀 코드와 다르다(TA → 2DT). 팀은 출입증이 정한다(본문에 팀 칸 없음) — 남의 프로젝트에 올리지 못하게.
// 서명 키(BP_ASSET_AK/SK)는 ark:*Asset* · ark:ListApiKeys · iam:ListProjects 만 되는 전용 사용자라 여기서만 쓴다.
// KV  ast:proj:<팀>                 { p, fp, at }  fp = 지금 팀 키 sha256 앞 16자 — 키를 재발급하면 맞지 않아 저절로 다시 찾는다
//     ast:g:<프로젝트>:<인물 key>    { id, at }
//     ast:a:<프로젝트>:<내용 key>    { id, status, at }  — 같은 내용을 또 올려도 CreateAsset 을 다시 부르지 않는다
//                                    (무료 등급에서 분당 3건이라 아껴야 하고, 같은 그림이 어셋 둘로 갈라지지 않게)
//     ast:lock:… · ast:glock:…      만드는 동안만(TTL 60초, 끝나면 지움) — 다른 PC 와 동시에 만들지 않게
// 겹침 막기는 세 겹: KV 기록 → BytePlus ListAssets(Name = 내용 key 가 정확히 같은 것) → 잠금. KV 는 곳마다 늦게 맞춰지므로
// 앞의 하나만 믿지 않는다. 그룹은 새 어셋을 정말 만들 때만 만든다(찾은 어셋은 다른 그룹에 있어도 그대로 쓴다).
const BP_REGION = 'ap-southeast-1';
const ARK_VERSION = '2024-01-01';
const ASSET_TYPES = new Set(['Image', 'Video', 'Audio']);
const GROUP_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ITEM_KEY_RE = /^[A-Za-z0-9._-]{1,64}$/;   // 어셋 Name 에 그대로 쓴다(64자까지) — 같은 내용 찾기의 열쇠
const ASSET_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const CREATE_RETRY_AFTER = 25;   // CreateAsset 분당 3건(무료 등급) — 20초에 한 건 + 여유
const PROJECT_RETRY_AFTER = 10;
const PROJECT_MISS_TTL = 600;    // 프로젝트를 못 찾은 답(없음 · 여럿)도 10분 기억 — 그동안 ListProjects + ListApiKeys 수십 번을 되풀이하지 않게
const RATE_CODE_RE = /Throttl|TooManyRequests|FlowLimit|RequestLimitExceeded|RateLimit|QpsLimit|QPSLimit|QpmLimit|QPMLimit/i;

const assetConfigured = (env) => Boolean(env.BP_ASSET_AK && env.BP_ASSET_SK);
const openapiHost = (env) => env.BP_OPENAPI_HOST || 'open.byteplusapi.com';
const assetHost = (env) => env.BP_ASSET_HOST || 'ark.ap-southeast-1.byteplusapi.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const chars = (s) => [...s].length;

async function hmacBytes(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

// BytePlus 가 돌려준 문구에 서명 키가 섞여 나와도(잘못된 AK 라며 되풀이하는 식) 앱으로 내보내지 않는다.
function scrub(env, s) {
  let t = clip(s, 300);
  for (const v of [env.BP_ASSET_AK, env.BP_ASSET_SK]) if (v) t = t.split(v).join('***');
  return t;
}

// 서명 OpenAPI(HMAC-SHA256, V4 꼴). SK 는 콘솔 글자 그대로 키로 쓴다 — base64 를 풀면 서명이 틀린다.
// 오류는 HTTP 200 이어도 ResponseMetadata.Error 로 온다. → { ok, result } | { ok:false, rate?, code, message }
async function bpCall(env, { host, service, version, action, query = {}, body = null }) {
  const method = body ? 'POST' : 'GET';
  const payload = body ? JSON.stringify(body) : '';
  const xdate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const ds = xdate.slice(0, 8);
  const q = { Action: action, Version: version, ...query };
  const cq = Object.keys(q).sort().map((k) => `${rfc3986(k)}=${rfc3986(String(q[k]))}`).join('&');
  const ph = await sha256Hex(payload);
  const sh = body ? 'content-type;host;x-content-sha256;x-date' : 'host;x-content-sha256;x-date';
  const ch = (body ? 'content-type:application/json\n' : '') + `host:${host}\nx-content-sha256:${ph}\nx-date:${xdate}\n`;
  const scope = `${ds}/${BP_REGION}/${service}/request`;
  const sts = ['HMAC-SHA256', xdate, scope, await sha256Hex([method, '/', cq, ch, sh, ph].join('\n'))].join('\n');
  let k = await hmacBytes(env.BP_ASSET_SK, ds);
  k = await hmacBytes(k, BP_REGION); k = await hmacBytes(k, service); k = await hmacBytes(k, 'request');
  const sig = hex(await hmacBytes(k, sts));
  const headers = { 'X-Date': xdate, 'X-Content-Sha256': ph, Authorization: `HMAC-SHA256 Credential=${env.BP_ASSET_AK}/${scope}, SignedHeaders=${sh}, Signature=${sig}` };
  if (body) headers['Content-Type'] = 'application/json';
  // 시험은 env.FETCH 로 가짜 BytePlus 를 끼운다. 전역 fetch 는 감싸서 부른다(객체의 메서드로 부르면 Illegal invocation).
  const f = env.FETCH || ((u, i) => fetch(u, i));
  let res, text;
  try {
    res = await f(`https://${host}/?${cq}`, { method, headers, ...(body ? { body: payload } : {}) });
    text = await res.text();
  } catch (e) { return { ok: false, code: 'network', message: scrub(env, e && e.message) }; }
  let j = null; try { j = JSON.parse(text); } catch {}
  const err = j && j.ResponseMetadata && j.ResponseMetadata.Error;
  const code = err ? clip(err.Code, 80) : '';
  // '잠깐 막힘'(속도 한도)만 rate — 'Limit' 한 낱말로 보면 개수 한도(에셋 50개 · 그룹 50개)까지 잠깐 막힘으로 읽혀 앱이 영원히 다시 한다.
  // 개수 한도는 일반 오류로 돌려 '등록 실패' + 이유로 보이게 한다.
  if (res.status === 429 || RATE_CODE_RE.test(code)) return { ok: false, rate: true, code: code || 'http_429', message: scrub(env, err && err.Message) };
  if (err) return { ok: false, code: code || 'error', message: scrub(env, err.Message) };
  if (!res.ok) return { ok: false, code: `http_${res.status}`, message: scrub(env, text) };
  return { ok: true, result: (j && j.Result) || {} };
}

// 찾기(목록)는 몰아서 부르니 한 번 막히면 1초 쉬고 한 번만 더.
async function bpCallRetry(env, opts) {
  let r = await bpCall(env, opts);
  if (!r.ok && r.rate) { await sleep(1000); r = await bpCall(env, opts); }
  return r;
}

const arkCall = (env, action, body) => bpCall(env, { host: assetHost(env), service: 'ark', version: ARK_VERSION, action, body });

// 어셋 · 그룹이 없다는 대답 — 코드 이름이 문서마다 달라 낱말로 본다.
const isNotFound = (r) => !r.ok && !r.rate && (/NotFound|NotExist/i.test(r.code) || /not\s*found|not\s*exist|does\s*not\s*exist/i.test(r.message || ''));

async function pool(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const at = i++; out[at] = await fn(list[at], at); }
  }));
  return out;
}

// ListApiKeys 의 Key 는 앞 8 + '*'×20 + 뒤 8 로 가려져 온다(길이는 진짜 키와 같다). 앞뒤 8자 · 길이 · Active 가 다 맞아야 같은 키.
const maskedMatch = (item, k) => Boolean(item && item.Status === 'Active' && typeof item.Key === 'string'
  && item.Key.length === k.length && item.Key.slice(0, 8) === k.slice(0, 8) && item.Key.slice(-8) === k.slice(-8));

async function discoverProject(env, key) {
  const names = [];
  let fetched = 0;   // 받은 줄 수(이름 없는 줄 포함) — Offset 은 이걸로. 거른 수로 넘기면 같은 줄을 또 받는다.
  for (let page = 0; page < 20; page++) {
    const r = await bpCallRetry(env, { host: openapiHost(env), service: 'iam', version: '2021-08-01', action: 'ListProjects',
      query: page ? { Limit: 100, Offset: fetched } : { Limit: 100 } });
    if (!r.ok) return r;
    const rows = r.result.Projects || [];
    fetched += rows.length;
    for (const p of rows) { const n = p && p.ProjectName; if (typeof n === 'string' && n && !names.includes(n)) names.push(n); }
    if (rows.length < 100 || !(Number(r.result.Total) > fetched)) break;
  }
  const hits = await pool(names, 6, async (ProjectName) => {
    for (let PageNumber = 1; PageNumber <= 20; PageNumber++) {
      const r = await bpCallRetry(env, { host: openapiHost(env), service: 'ark', version: ARK_VERSION, action: 'ListApiKeys', body: { ProjectName, PageSize: 100, PageNumber } });
      if (!r.ok) return r;
      const items = r.result.Items || [];
      if (items.some((it) => maskedMatch(it, key))) return { ok: true, hit: true };
      if (items.length < 100) break;
    }
    return { ok: true, hit: false };
  });
  // 한 프로젝트라도 못 읽었으면 '없음' · '하나뿐' 을 단정하지 않는다.
  const bad = hits.find((h) => !h.ok && h.rate) || hits.find((h) => !h.ok);
  if (bad) return bad;
  return { ok: true, projects: names.filter((_, i) => hits[i].hit) };
}

// 팀 → BytePlus 프로젝트. TEAM_PROJECTS > KV(지금 키의 지문일 때만) > 찾기.
// '없음' · '여럿' 은 10분 기억한다(ast:projmiss — 같은 키 지문일 때만). 한도 · 네트워크 같은 일시 실패는 기억하지 않는다.
async function assetProjectOf(env, team, ctx) {
  const over = parseJsonVar(env.TEAM_PROJECTS)[team];
  if (typeof over === 'string' && over.trim()) return { project: over.trim() };
  const key = env[`BP_KEY_${team}`];
  if (!key) return { status: 409, code: 'no_project', error: `팀 ${team} 의 키가 게이트웨이에 없습니다.` };
  const fp = (await sha256Hex(key)).slice(0, 16);
  const raw = await env.SD_TOKENS.get(`ast:proj:${team}`);
  if (raw) { try { const c = JSON.parse(raw); if (c.fp === fp && c.p) return { project: c.p }; } catch {} }
  const missRaw = await env.SD_TOKENS.get(`ast:projmiss:${team}`);
  if (missRaw) { try { const m = JSON.parse(missRaw); if (m.fp === fp && m.code && m.error) return { status: 409, code: m.code, error: m.error }; } catch {} }
  const d = await discoverProject(env, key);
  if (!d.ok) return d.rate
    ? { status: 429, code: 'rate_limited', retryAfter: PROJECT_RETRY_AFTER, error: 'BytePlus 가 잠시 막았습니다. 조금 뒤 다시.' }
    : { status: 502, code: 'byteplus', error: `${d.code}: ${d.message}` };
  const miss = d.projects.length === 0
    ? { code: 'no_project', error: `팀 ${team} 의 키가 든 BytePlus 프로젝트를 찾지 못했습니다(키가 꺼졌거나 다른 계정).` }
    : d.projects.length > 1
      ? { code: 'ambiguous_project', error: `팀 ${team} 의 키가 여러 프로젝트에 맞습니다(${d.projects.join(', ')}). 관리자가 TEAM_PROJECTS 로 정해 주세요.` }
      : null;
  if (miss) {
    ctx.waitUntil(env.SD_TOKENS.put(`ast:projmiss:${team}`, JSON.stringify({ ...miss, fp, at: new Date().toISOString() }), { expirationTtl: PROJECT_MISS_TTL }).catch(() => {}));
    return { status: 409, ...miss };
  }
  const p = d.projects[0];
  const at = new Date().toISOString();
  ctx.waitUntil(env.SD_TOKENS.put(`ast:proj:${team}`, JSON.stringify({ p, fp, at }), { metadata: { p, fp } }).catch(() => {}));
  ctx.waitUntil(env.SD_TOKENS.delete(`ast:projmiss:${team}`).catch(() => {}));
  return { project: p };
}

const bad = (error) => json({ ok: false, code: 'invalid', error }, 400);
const projectError = (pr) => json({ ok: false, code: pr.code, error: pr.error, ...(pr.retryAfter ? { retryAfter: pr.retryAfter } : {}) }, pr.status);
const notConfigured = () => json({ ok: false, code: 'not_configured', error: '게이트웨이에 어셋 키(BP_ASSET_AK/SK)가 없습니다. 관리자에게 알려주세요.' }, 503);

function assetUrlOk(env, s) {
  if (typeof s !== 'string' || !s || s.length > 4096) return false;
  let u; try { u = new URL(s); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return env.ASSET_TEST_HTTP === '1' && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}

/// 고쳐서 받지 않는다 — 틀린 칸을 알려 주고 거절(앱이 같은 값을 다시 보내 같은 결과를 받게).
// url 은 없어도 된다 — 앱은 먼저 주소 없이 물어 'NeedUpload' 인 것만 R2 에 올린 뒤 주소를 붙여 다시 부른다(이미 올라간 건 안 올림).
function checkRegister(env, b) {
  const g = b.group;
  if (!g || typeof g !== 'object' || Array.isArray(g)) return 'group 이 없습니다';
  if (typeof g.key !== 'string' || !GROUP_KEY_RE.test(g.key)) return 'group.key 는 영문 · 숫자 · _ · - 1~64자';
  if (typeof g.name !== 'string' || chars(g.name) < 1 || chars(g.name) > 64) return 'group.name 은 1~64자 문자열';
  const items = b.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 10) return 'items 는 1~10개';
  const keys = new Set();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || typeof it !== 'object' || Array.isArray(it)) return `items[${i}] 가 객체가 아닙니다`;
    if (typeof it.key !== 'string' || !ITEM_KEY_RE.test(it.key)) return `items[${i}].key 는 영문 · 숫자 · . _ - 1~64자`;
    if (keys.has(it.key)) return `items[${i}].key 가 겹칩니다`;
    keys.add(it.key);
    if (it.url !== undefined && !assetUrlOk(env, it.url)) return `items[${i}].url 은 https 주소(4096자 이하)`;
    if (!ASSET_TYPES.has(it.type)) return `items[${i}].type 은 Image · Video · Audio`;
    if (it.name !== undefined && (typeof it.name !== 'string' || chars(it.name) < 1 || chars(it.name) > 64)) return `items[${i}].name 은 1~64자 문자열`;
  }
  return '';
}

const errOf = (r) => ({ code: r.code, message: r.message || '' });
const assetErr = (e) => (e && typeof e === 'object' ? { code: clip(e.Code, 80), message: clip(e.Message, 300) } : undefined);
const timeOf = (t) => (typeof t === 'number' ? t : Date.parse(t) || Number(t) || Infinity);

// BytePlus 쪽에서 같은 내용(Name = 내용 key)의 어셋을 찾는다 — KV 는 곳마다 늦게 맞춰지고 다른 PC 가 같은 그림을 막 올렸을 수 있어서.
// Name 거르기는 부분 일치라 이름이 똑같은 것만 남기고, 여럿이면 가장 먼저 만든 것(모두가 같은 하나를 고르게).
async function findAsset(env, project, key) {
  const hits = [];
  let NextToken;
  for (let page = 0; page < 5; page++) {
    const r = await arkCall(env, 'ListAssets', { Filter: { GroupType: 'AIGC', Name: key, Statuses: ['Active', 'Processing'] }, MaxResults: 20, ProjectName: project, ...(NextToken ? { NextToken } : {}) });
    if (!r.ok) return r;
    for (const x of r.result.Items || []) if (x && x.Name === key && x.Id && (x.Status === 'Active' || x.Status === 'Processing')) hits.push(x);
    NextToken = r.result.NextToken;
    if (!NextToken) break;
  }
  hits.sort((a, b) => timeOf(a.CreateTime) - timeOf(b.CreateTime) || String(a.Id).localeCompare(String(b.Id)));
  return { ok: true, found: hits[0] || null };
}

// 잠금 — 같은 내용 · 같은 인물을 두 PC 가 동시에 만들지 않게 짧게(KV 최소 TTL 60초) 건다. 잠금 값은 이번 호출만의 표(nonce)이고,
// 적은 뒤 잠깐 기다렸다 다시 읽어 내 표가 남아 있을 때만 잡은 것으로 본다(같은 곳의 두 PC 가 동시에 적으면 나중 것 하나만 남는다).
// KV 는 곳마다 늦게 맞춰지므로 완벽하진 않다 — 잠금을 잡은 뒤 BytePlus ListAssets 를 한 번 더 본다(그 사이 다른 PC 가 만든 것).
// 만들기에 성공하면 잠금 자리에 'done:<만든 id>' 를 60초 남긴다 — 이미 지나간 다른 PC 가 KV 기록 · ListAssets 를 못 보고 잠금을
// 보면, 또 만들지 않고 그 id 를 받아 간다. 실패했을 때는 바로 지운다(다시 부를 때 Busy 로 막히지 않게).
// staleId — 이번 호출에서 죽은 것으로 확인한 id(Failed · 사라짐 · 그룹이 지워짐). 그 id 의 done 표는 비어 있는 것으로 본다
// ('등록 실패' 를 바로 다시 누르면 60초 기다리지 않게).
const LOCK_TTL = 60;
const BUSY_RETRY_AFTER = 10;
const lockSettleMs = (env) => { const n = Number(env.ASSET_LOCK_SETTLE_MS); return Number.isFinite(n) && n >= 0 ? n : 300; };
const doneIdOf = (v) => (typeof v === 'string' && v.startsWith('done:') ? v.slice(5) : '');
async function takeLock(env, kv, k, staleId = '') {
  try {
    const cur = await kv.get(k);
    if (cur) {
      const d = doneIdOf(cur);
      if (!d || d !== staleId) return { ok: false, done: d && d !== staleId ? d : '' };
    }
    const mine = crypto.randomUUID();
    await kv.put(k, mine, { expirationTtl: LOCK_TTL });
    const ms = lockSettleMs(env);
    if (ms) await sleep(ms);
    const now = await kv.get(k);
    if (now === mine) return { ok: true };
    const d = doneIdOf(now);
    return { ok: false, done: d && d !== staleId ? d : '' };
  } catch { return { ok: false, done: '' }; }
}

// ── 보관함이 찼을 때(26.11.24~, 사용자 "에셋 보관 다 차면 어떻게 정리할 건지") ──
// 보관함은 계정 등급의 개수 한도(무료 Entry 50 · Advanced 100만, 실존 인물(Real-human) 에셋과 나눠 씀)다. CreateAsset 이 개수 때문에
// 거절하면 이 앱이 만든 에셋 중 가장 오래 안 쓴 것부터 몇 개 지우고 한 번 더 만든다. '언제 썼나' 는 BytePlus 가 준다 —
// ListAssets 항목의 LastInferenceTime(마지막으로 생성에 쓰인 때, 11/24 실측 · ISO 시각). 없으면 CreateTime.
// 지우는 것: AIGC 그룹 · 이름이 내용 key 꼴(이 앱이 만든 것 — 콘솔에서 사람이 올린 것 · 실존 인물 에셋은 건드리지 않는다) ·
// 마지막으로 쓰거나 만든 지 24시간이 넘은 것 · 한 번에 EVICT_MAX 개까지. 지운 에셋의 KV 기록(ast:a)도 지운다.
// 거절 문구는 아직 실측 못 했다(한도까지 채워 본 적 없음) — 낱말로 보고, 규격 문구(크기 · 해상도 …)는 빼고, 이번 호출에서 한 번만 지운다.
// 잘못 지워도 되살아난다 — 그 사진을 보낸 PC 는 BytePlus 의 'asset … is not found'(11/24 실측, 동기 400)를 보고 다시 등록해 다시 보낸다(앱 send-request).
const CAPACITY_RE = /quota|capacity|exceed|limit|maximum|insufficient|full/i;
const SPEC_RE = /size|resolution|pixel|dimension|format|duration|aspect|ratio|width|height|byte|MB\b/i;
const looksFull = (r) => Boolean(r && !r.ok && !r.rate && !isNotFound(r) && CAPACITY_RE.test(`${r.code} ${r.message}`) && !SPEC_RE.test(String(r.message || '')));
const OWN_NAME_RE = /^[0-9a-f]{12}\.[a-z0-9]{2,5}$/i;
const EVICT_KEEP_MS = 24 * 3600 * 1000;
const EVICT_MAX = 3;
// 지운 기록(26.11.24~) — 앱이 '지워짐' 을 그리려고 묻는다(/v1/assets/evicted). 한 건에 키 하나(같은 순간 두 정리가 서로 덮지 않게) + 마지막 정리 시각 하나
// (묻는 쪽이 대부분 '새로 지운 것 없음' 을 목록 없이 받게). 30일 뒤 저절로 사라진다. KV 는 곳마다 늦게 맞춰지므로(보통 1분 안) 돌려주는 기준 시각은
// 2분 앞으로 잡는다 — 다음 물음이 그 사이 것을 다시 받아도 앱은 같은 결과다.
const EVICT_LOG_TTL = 30 * 86400;
const EVICT_LIST_LAG_MS = 120 * 1000;
const toMs = (t) => {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  if (typeof t === 'string' && /^\d+$/.test(t)) { const n = Number(t); return n < 1e12 ? n * 1000 : n; }
  const p = Date.parse(t);
  return Number.isFinite(p) ? p : 0;
};
async function evictIdle(env, project, max) {
  const all = [];
  let NextToken;
  for (let page = 0; page < 20; page++) {
    const r = await arkCall(env, 'ListAssets', { Filter: { GroupType: 'AIGC' }, MaxResults: 100, ProjectName: project, ...(NextToken ? { NextToken } : {}) });
    if (!r.ok) return { gone: [], error: r };
    for (const x of r.result.Items || []) if (x && x.Id && typeof x.Name === 'string' && OWN_NAME_RE.test(x.Name)) all.push(x);
    NextToken = r.result.NextToken;
    if (!NextToken) break;
  }
  const now = Date.now();
  const lastOf = (x) => Math.max(toMs(x.LastInferenceTime), toMs(x.CreateTime));
  const cands = all.filter((x) => now - lastOf(x) > EVICT_KEEP_MS).sort((a, b) => lastOf(a) - lastOf(b) || String(a.Id).localeCompare(String(b.Id)));
  const gone = [];
  for (const x of cands.slice(0, max)) {
    const d = await arkCall(env, 'DeleteAsset', { Id: x.Id, ProjectName: project });
    if (d.ok || isNotFound(d)) {
      gone.push(String(x.Id));
      try { await env.SD_TOKENS.delete(`ast:a:${project}:${x.Name}`); } catch {}
      // 잠금 자리의 'done:<id>'(만든 뒤 60초)도 지운다 — 남아 있으면 그 사진을 다시 등록할 때 '방금 만든 것' 으로 지운 옛 id 를 돌려준다(11/24 시험 앱에서 찾음)
      try { await env.SD_TOKENS.delete(`ast:lock:${project}:${x.Name}`); } catch {}
      const at = Date.now();
      try { await env.SD_TOKENS.put(`ast:ev:${project}:${at}:${x.Id}`, JSON.stringify({ id: String(x.Id), name: x.Name, at }), { metadata: { id: String(x.Id), at }, expirationTtl: EVICT_LOG_TTL }); } catch {}
    }
  }
  if (gone.length) { try { await env.SD_TOKENS.put(`ast:evv:${project}`, String(Date.now()), { expirationTtl: EVICT_LOG_TTL }); } catch {} }
  return { gone, candidates: cands.length };
}

// 이 팀 프로젝트에서 since(ms) 뒤에 보관함 정리로 지운 에셋 — 앱이 칸 · 카드를 '지워짐' 으로 바꾼다. 마지막 정리 시각이 since 보다 오래면 목록 없이 빈 답.
async function assetsEvicted(request, env, ctx, a) {
  if (!assetConfigured(env)) return notConfigured();
  const r = await readJson(request, 1024);
  if (r.error) return json({ ok: false, code: 'invalid', error: r.error }, 400);
  const since = Number(r.body && r.body.since);
  if (!Number.isFinite(since) || since < 0) return bad('since 는 0 이상의 숫자(ms)');
  const pr = await assetProjectOf(env, a.rec.team, ctx);
  if (!pr.project) return projectError(pr);
  const project = pr.project;
  const until = Math.max(since, Date.now() - EVICT_LIST_LAG_MS);
  let last = 0;
  try { last = Number(await env.SD_TOKENS.get(`ast:evv:${project}`)) || 0; } catch {}
  if (last <= since) return json({ ok: true, project, until, items: [] });
  const items = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const l = await env.SD_TOKENS.list({ prefix: `ast:ev:${project}:`, ...(cursor ? { cursor } : {}) });
    for (const k of l.keys || []) {
      const m = k.metadata || {};
      const at = Number(m.at) || 0;
      if (at > since && typeof m.id === 'string' && ASSET_ID_RE.test(m.id)) items.push({ id: m.id, at });
    }
    if (l.list_complete || !l.cursor) break;
    cursor = l.cursor;
  }
  return json({ ok: true, project, until, items });
}

async function assetsProject(env, ctx, a) {
  if (!assetConfigured(env)) return notConfigured();
  const pr = await assetProjectOf(env, a.rec.team, ctx);
  return pr.project ? json({ ok: true, project: pr.project }) : projectError(pr);
}

async function assetsRegister(request, env, ctx, a) {
  if (!assetConfigured(env)) return notConfigured();
  const r = await readJson(request, 64 * 1024);
  if (r.error) return json({ ok: false, code: 'invalid', error: r.error }, 400);
  const why = checkRegister(env, r.body);
  if (why) return bad(why);
  const { group, items } = r.body;
  const pr = await assetProjectOf(env, a.rec.team, ctx);
  if (!pr.project) return projectError(pr);
  const project = pr.project;
  const kv = env.SD_TOKENS;
  const now = () => new Date().toISOString();
  const unlock = (k) => kv.delete(k).catch(() => {});
  // KV 쓰기가 실패해도 이미 만든 에셋의 답은 돌려준다(500 으로 끝나면 앱은 id 를 모른 채 또 부른다 — 그때는 ② 찾기가 같은 것을 돌려준다).
  const put = (k, v, o) => kv.put(k, v, o).then(() => true, () => false);

  // 그룹 — 인물 하나에 하나. 정말 새로 만들 어셋이 있을 때만 만든다(찾은 어셋은 다른 그룹에 있어도 그대로 쓴다 — 옮기지 않는다).
  const gk = `ast:g:${project}:${group.key}`;
  const glk = `ast:glock:${project}:${group.key}`;
  let groupId = '';
  let groupFresh = false;
  let groupLoaded = false;
  let groupFail = null;          // 이번 호출에서 그룹을 못 만든 이유 — 남은 줄도 같은 이유로(같은 실패를 되풀이해 부르지 않게)
  const loadGroup = async () => {
    if (groupLoaded) return;
    groupLoaded = true;
    try { const g = JSON.parse((await kv.get(gk)) || 'null'); if (g && g.id) groupId = g.id; } catch {}
  };
  // staleGid — BytePlus 에서 지워진 것으로 확인한 그룹 id(있으면 그 done 표 · KV 기록은 무시하고 새로 만든다)
  const makeGroup = async (staleGid = '') => {
    const lr = await takeLock(env, kv, glk, staleGid);
    if (!lr.ok) {
      if (!lr.done) return { ok: false, busy: true };
      groupId = lr.done;   // 다른 PC 가 방금 만든 그룹
      await put(gk, JSON.stringify({ id: groupId, at: now() }));
      return { ok: true, result: { Id: groupId } };
    }
    // 잠금을 잡는 사이 다른 PC 가 만들었을 수 있다
    try {
      const g = JSON.parse((await kv.get(gk)) || 'null');
      if (g && g.id && g.id !== staleGid) { groupId = g.id; await put(glk, `done:${g.id}`, { expirationTtl: LOCK_TTL }); return { ok: true, result: { Id: g.id } }; }
    } catch {}
    const c = await arkCall(env, 'CreateAssetGroup', { Name: group.name, Description: `seedance ${group.key}`, GroupType: 'AIGC', ProjectName: project });
    if (c.ok && c.result.Id) {
      groupId = String(c.result.Id); groupFresh = true;
      await put(gk, JSON.stringify({ id: groupId, at: now() }));
      await put(glk, `done:${groupId}`, { expirationTtl: LOCK_TTL });
      return c;
    }
    await unlock(glk);
    if (!c.ok) return c;
    return { ok: false, code: 'no_id', message: 'CreateAssetGroup 이 Id 를 돌려주지 않았습니다' };
  };

  const out = [];
  let throttled = false;
  let evictTried = false;          // 보관함 정리는 한 호출에 한 번만(잘못 짚었을 때 지우는 수를 묶어 둔다)
  const evicted = [];
  for (const it of items) {
    const ak = `ast:a:${project}:${it.key}`;
    const lk = `ast:lock:${project}:${it.key}`;
    let stored = null;
    try { stored = JSON.parse((await kv.get(ak)) || 'null'); } catch {}
    let staleId = stored && stored.id && stored.status === 'Failed' ? String(stored.id) : '';
    // ① KV 에 있는 것 — 상태를 다시 읽는다(Active 도). 등록 요청은 드물고 GetAsset 은 초당 100 이라 부담이 없다. Active 를 그대로 믿으면
    //   BytePlus 에서 지워진 에셋(유료 권리 만료 15일 뒤 등)을 앱이 '다시 등록' 해도 옛 id 를 계속 돌려받는다(26.11.23 앱 시험 중 찾음).
    //   Failed 로 적힌 것 · 다시 읽어 보니 Failed 인 것은 없는 것으로 보고 아래에서 다시 찾거나 만든다 — '등록 실패' 카드에서
    //   한 번 누르면 바로 새로 만들어지게(예전엔 첫 번째 누름이 Failed 를 KV 에 적기만 했다).
    if (stored && stored.id && stored.status !== 'Failed') {
      const g = await arkCall(env, 'GetAsset', { Id: stored.id, ProjectName: project });
      if (g.ok) {
        const status = String(g.result.Status || stored.status);
        if (status !== stored.status) await put(ak, JSON.stringify({ id: stored.id, status, at: now() }));
        if (status !== 'Failed') { out.push({ key: it.key, id: stored.id, status }); continue; }
        staleId = String(stored.id);
      } else if (isNotFound(g)) {
        staleId = String(stored.id);
      } else {
        // 만든 뒤 상태만 못 읽은 것 — 실패로 알리면 앱이 멀쩡한 어셋을 버린다. 다시 물어보라고만.
        out.push({ key: it.key, id: stored.id, status: 'Retry', retryAfter: g.rate ? 2 : CREATE_RETRY_AFTER, ...(g.rate ? {} : { error: errOf(g) }) });
        continue;
      }
      // BytePlus 쪽에서 사라졌거나 Failed — 아래에서 다시 찾는다.
    }
    // ② BytePlus 에 같은 이름이 이미 있나(다른 PC · 다른 인물이 올린 것 포함). 못 물어봤으면 만들지 않는다 — 겹칠 수 있어서.
    const f = await findAsset(env, project, it.key);
    if (!f.ok) { out.push({ key: it.key, status: 'Retry', retryAfter: f.rate ? 2 : CREATE_RETRY_AFTER, ...(f.rate ? {} : { error: errOf(f) }) }); continue; }
    if (f.found) {
      const id = String(f.found.Id), status = f.found.Status;
      await put(ak, JSON.stringify({ id, status, at: now() }));
      out.push({ key: it.key, id, status });
      continue;
    }
    // ③ 새로 만들어야 하는데 주소가 없으면 — 앱이 올리고 다시 부르게.
    if (!it.url) { out.push({ key: it.key, status: 'NeedUpload' }); continue; }
    if (throttled) { out.push({ key: it.key, status: 'Retry', retryAfter: CREATE_RETRY_AFTER }); continue; }
    if (groupFail) { out.push({ key: it.key, ...groupFail }); continue; }
    const lr = await takeLock(env, kv, lk, staleId);
    if (!lr.ok) {
      if (lr.done) {   // 다른 PC 가 방금 만들었다 — 또 만들지 않고 그것을 쓴다
        await put(ak, JSON.stringify({ id: lr.done, status: 'Processing', at: now() }));
        out.push({ key: it.key, id: lr.done, status: 'Processing' });
      } else out.push({ key: it.key, status: 'Busy', retryAfter: BUSY_RETRY_AFTER });
      continue;
    }
    // 잠금을 잡는 사이 다른 PC 가 만들었을 수 있다 — BytePlus 에 한 번 더 묻는다(못 물으면 만들지 않는다).
    const f2 = await findAsset(env, project, it.key);
    if (!f2.ok || f2.found) {
      await unlock(lk);
      if (!f2.ok) { out.push({ key: it.key, status: 'Retry', retryAfter: f2.rate ? 2 : CREATE_RETRY_AFTER, ...(f2.rate ? {} : { error: errOf(f2) }) }); continue; }
      const id = String(f2.found.Id), status = f2.found.Status;
      await put(ak, JSON.stringify({ id, status, at: now() }));
      out.push({ key: it.key, id, status });
      continue;
    }
    await loadGroup();
    if (!groupId) {
      const c = await makeGroup();
      if (!c.ok) {
        await unlock(lk);
        groupFail = c.busy ? { status: 'Busy', retryAfter: BUSY_RETRY_AFTER }
          : c.rate ? { status: 'Retry', retryAfter: CREATE_RETRY_AFTER } : { status: 'Failed', error: errOf(c) };
        if (c.rate) throttled = true;
        out.push({ key: it.key, ...groupFail });
        continue;
      }
    }
    // ④ 만든다. Name 은 내용 key 그대로 — ②의 찾기가 이걸로 같은 내용을 알아본다.
    const body = () => ({ GroupId: groupId, URL: it.url, AssetType: it.type, Name: it.key, ProjectName: project });
    let c = await arkCall(env, 'CreateAsset', body());
    // KV 의 그룹이 BytePlus 쪽에서 지워졌으면 한 번 다시 만들어 이어 간다.
    if (isNotFound(c) && !groupFresh && /group/i.test(`${c.code} ${c.message}`)) {
      const dead = groupId;
      try { await kv.delete(gk); } catch {}
      groupId = '';
      const g2 = await makeGroup(dead);
      c = g2.ok && groupId && groupId !== dead ? await arkCall(env, 'CreateAsset', body()) : g2.ok ? { ok: false, code: 'group_gone', message: '그룹이 BytePlus 에서 지워졌습니다' } : g2;
    }
    // 보관함이 찼다 — 오래 안 쓴 것부터 지우고 한 번 더(위 evictIdle). 지울 것이 없거나 지워도 모자라면 이유를 붙여 Failed.
    if (looksFull(c) && !evictTried) {
      evictTried = true;
      // 이번 호출에 남은 줄 수만큼(EVICT_MAX 까지) — 한 장 등록에 여럿을 지우지 않게
      const ev = await evictIdle(env, project, Math.min(EVICT_MAX, items.length - items.indexOf(it)));
      evicted.push(...ev.gone);
      if (ev.gone.length) c = await arkCall(env, 'CreateAsset', body());
      if (looksFull(c) || (!ev.gone.length && !c.ok && !c.rate)) {
        const was = `${c.code}: ${c.message}`.slice(0, 160);
        c = { ok: false, code: 'asset_quota_full', message: ev.gone.length
          ? `에셋 보관함이 가득 차 오래 안 쓴 ${ev.gone.length}개를 지웠는데도 자리가 없습니다 — ${was}`
          : ev.error ? `에셋 보관함이 가득 찼고, 정리하려고 목록을 읽지 못했습니다(${ev.error.code}) — ${was}`
            : `에셋 보관함이 가득 찼고, 지울 수 있는 것(이 앱이 만든 것 중 24시간 넘게 안 쓴 것)이 없습니다 — ${was}` };
      }
    } else if (looksFull(c)) {
      c = { ok: false, code: 'asset_quota_full', message: `에셋 보관함이 가득 찼습니다(이번 요청에서 이미 정리함) — ${c.code}: ${c.message}`.slice(0, 300) };
    }
    if (c.ok && c.result && c.result.Id) {
      const id = String(c.result.Id);
      await put(ak, JSON.stringify({ id, status: 'Processing', at: now() }));
      await put(lk, `done:${id}`, { expirationTtl: LOCK_TTL });   // 60초 — 위 설명
      out.push({ key: it.key, id, status: 'Processing' });
      continue;
    }
    await unlock(lk);
    if (c.busy) {
      out.push({ key: it.key, status: 'Busy', retryAfter: BUSY_RETRY_AFTER });
    } else if (!c.ok && c.rate) {
      // 분당 한도 — 이번 호출에선 더 만들지 않는다(만들어 둔 것 · 이미 있는 것은 그대로 답한다).
      throttled = true;
      out.push({ key: it.key, status: 'Retry', retryAfter: CREATE_RETRY_AFTER });
    } else {
      out.push({ key: it.key, status: 'Failed', error: c.ok ? { code: 'no_id', message: 'CreateAsset 이 Id 를 돌려주지 않았습니다' } : errOf(c) });
    }
  }
  if (!groupLoaded) await loadGroup();
  return json({ ok: true, project, groupId: groupId || null, items: out, ...(evicted.length ? { evicted } : {}) });
}

async function assetsStatus(request, env, ctx, a) {
  if (!assetConfigured(env)) return notConfigured();
  const r = await readJson(request, 8 * 1024);
  if (r.error) return json({ ok: false, code: 'invalid', error: r.error }, 400);
  const ids = r.body.ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) return bad('ids 는 1~20개');
  for (let i = 0; i < ids.length; i++) if (typeof ids[i] !== 'string' || !ASSET_ID_RE.test(ids[i])) return bad(`ids[${i}] 모양이 틀립니다`);
  const pr = await assetProjectOf(env, a.rec.team, ctx);
  if (!pr.project) return projectError(pr);
  const project = pr.project;
  const items = await pool(ids, 5, async (id) => {
    const g = await arkCall(env, 'GetAsset', { Id: id, ProjectName: project });
    if (g.ok) {
      // 다른 프로젝트의 어셋은 이 팀에게 없는 것이다.
      if (g.result.ProjectName && g.result.ProjectName !== project) return { id, status: 'NotFound' };
      const status = String(g.result.Status || 'Processing');
      const error = status === 'Failed' ? assetErr(g.result.Error) : undefined;
      return { id, status, ...(error ? { error } : {}) };
    }
    if (isNotFound(g)) return { id, status: 'NotFound' };
    return { id, status: 'Retry', retryAfter: g.rate ? 2 : CREATE_RETRY_AFTER, ...(g.rate ? {} : { error: errOf(g) }) };
  });
  return json({ ok: true, project, items });
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
  // 어셋 — 팀마다 찾아 둔 프로젝트(KV 메타데이터, 목록 한 번). 키를 재발급해 지문이 안 맞으면 아직 모르는 것(null).
  const projCache = {};
  cursor = undefined;
  do {
    const page = await env.SD_TOKENS.list({ prefix: 'ast:proj:', cursor });
    for (const k of page.keys) projCache[k.name.slice(9)] = k.metadata || {};
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const projOver = parseJsonVar(env.TEAM_PROJECTS);
  const projects = {};
  const teams = [];
  for (const { code, key } of teamKeys(env)) {
    const kh = await sha256Hex(key);
    const c = projCache[code];
    projects[code] = typeof projOver[code] === 'string' && projOver[code].trim() ? projOver[code].trim()
      : (c && c.fp === kh.slice(0, 16) && c.p) || null;
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
    assets: { configured: assetConfigured(env), projects },
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
  h+='</table><p>새 PC 등록 '+(s.enrollOpen?'<span class="ok">열림</span>':'<span class="bad">닫힘</span>')+' · v1 NCP 길 '+(s.legacyNcp?'열림':'닫힘')+' · R2 '+yes(s.r2.keys&&s.r2.endpoint&&s.r2.bucket)+' · NCP '+yes(s.ncp.keys)+' · 시트 서명 '+sig+' · 옴니 키 '+yes(s.gemini)+' · 어셋 키 '+yes(s.assets&&s.assets.configured)+'</p>';
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
      if (path === '/v1/assets/project' && request.method === 'GET') return assetsProject(env, ctx, a);
      if (path === '/v1/assets/register' && request.method === 'POST') return assetsRegister(request, env, ctx, a);
      if (path === '/v1/assets/status' && request.method === 'POST') return assetsStatus(request, env, ctx, a);
      if (path === '/v1/assets/evicted' && request.method === 'POST') return assetsEvicted(request, env, ctx, a);
      if (path === '/v1/whoami' && request.method === 'GET') {
        return json({ ok: true, team: a.rec.team, label: a.rec.label, pc: a.rec.pc });
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
};
