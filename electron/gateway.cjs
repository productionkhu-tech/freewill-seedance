// ─── 게이트웨이에서 키 · 주소 묶음 받기 (26.10.802~) ───
//
// PC 는 출입증(토큰) 하나만 들고, 앱을 켤 때 한 번 seedance-gateway 에서 묶음(시댄스 키 · R2 · NCP · 시트 주소 · 옴니 키 …)을
// 받아 process.env 에 올린다. 관리자가 Cloudflare 에서 값을 바꾸면 PC 는 다음 실행 때 새 값을 쓴다 — 팀 bat · PC 는 손대지
// 않는다. 게이트웨이 쪽은 worker/seedance-gateway.js 머리말.
//
// ★ 켤 때만 받는다(사용자 결정 2026-10-08: "큐 보낼 때마다 확인할 순 없으니까"). 예외 하나 — BytePlus · R2 가 '키가
//   틀렸다' 고 거절하면 서버가 refresh() 를 한 번 부른다(관리자가 키를 바꾼 직후 켜 둔 PC 가 멈추지 않게). 정상일 땐 0번.
// ★ 마지막으로 받은 묶음은 암호 파일(secrets.cjs openVault)에 둔다. 그게 있으면 그것으로 바로 시작하고 새 묶음은 뒤에서
//   받는다 — 켜는 속도가 그대로고, 게이트웨이가 죽어도 앱은 켜진다. 처음 켜는 PC(보관본 없음)만 받을 때까지 기다린다.
// ★ 처음 등록은 팀 bat 의 키로 만든 입장권으로 한다: HMAC(키, 'seedance-ticket-v1'). 키 원문은 보내지 않는다.
// ★ 관리자가 끊은 PC(revoked)는 보관본도 bat 키도 쓰지 않는다 — 그러지 않으면 끊는 게 아무 뜻이 없다.
//
// 반환값은 로그 · 화면용 요약이다. 값은 담지 않는다(이름 · 팀 · 지문만).

const crypto = require('crypto');

const DEFAULT_URL = 'https://seedance-gateway.production-khu.workers.dev';
const TICKET_MSG = 'seedance-ticket-v1';
// 게이트웨이가 넣을 수 있는 이름. 이 밖의 것(PATH · NODE_OPTIONS …)은 받아도 버린다 — 게이트웨이가 털려도 이 프로세스의
// 실행 방식까지 바꾸지 못하게.
const ALLOW_RE = /^(SEEDANCE_[A-Z0-9_]{1,60}|R2_(ENDPOINT|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY))$/;
// 이 PC 의 실행 환경(main.cjs 가 정한다) · 게이트웨이 주소(메모리에 올리지 않고 암호 파일에만 기억한다 — 메모리의
// SEEDANCE_GATEWAY_URL 은 격리 시험이 가짜 게이트웨이를 가리키는 칸이라, 섞이면 다음 받기가 엉뚱한 곳으로 간다)
const DENY = new Set(['SEEDANCE_PORT', 'SEEDANCE_BACKUP_DIR', 'SEEDANCE_GATEWAY_URL']);
const MAX_VALUE = 8192;
const REFRESH_GAP_MS = 2 * 60 * 1000;    // 실행 중 다시 받기(거절당했을 때)는 2분에 한 번까지

const realKey = (v) => typeof v === 'string' && v.trim() && v.trim() !== 'managed-by-gateway' ? v.trim() : '';
const ticketOf = (key) => crypto.createHmac('sha256', key).update(TICKET_MSG).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const httpsUrl = (u) => (typeof u === 'string' && /^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(u.trim()) ? u.trim().replace(/\/+$/, '') : '');

function pickUrl(env, gw) {
  // SEEDANCE_GATEWAY_URL 환경변수는 시험용(격리 실행에서 가짜 게이트웨이로) — 평소엔 없다. http://127.0.0.1 만 예외로 받는다.
  const fromEnv = typeof env.SEEDANCE_GATEWAY_URL === 'string' ? env.SEEDANCE_GATEWAY_URL.trim().replace(/\/+$/, '') : '';
  if (fromEnv && (httpsUrl(fromEnv) || /^http:\/\/127\.0\.0\.1:\d+$/.test(fromEnv))) return fromEnv;
  return httpsUrl(gw && gw.url) || DEFAULT_URL;
}

// 받은 묶음에서 쓸 수 있는 것만 — 이름 모양 · 값 길이
function cleanBundle(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!ALLOW_RE.test(k) || DENY.has(k)) continue;
    if (typeof v !== 'string' || !v || v.length > MAX_VALUE) continue;
    out[k] = v;
  }
  return out;
}

async function post(fetchImpl, url, path, body, token, timeoutMs, method = 'POST') {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetchImpl(url + path, { method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}), signal: ac.signal });
    let j = null;
    try { j = await r.json(); } catch {}
    return { status: r.status, j: j || {} };
  } finally { clearTimeout(timer); }
}

function createGateway({ vault, env = process.env, app = '', pc = '', fetchImpl = globalThis.fetch, timeoutMs = 8000, refreshGapMs = REFRESH_GAP_MS, log = () => {} }) {
  let applied = new Set();     // 게이트웨이가 넣은 이름 — 새 묶음에서 빠지면 거두고, 끊기면 다 거둔다
  const original = {};         // 게이트웨이가 처음 덮기 전의 값(bat 키) — 묶음에서 빠진 이름은 이걸로 돌려놓는다
  let inFlight = null;
  let lastRefreshAt = 0;

  const read = () => (vault && vault.read()) || {};
  const gwOf = (o) => (o && o.gw && typeof o.gw === 'object' ? o.gw : {});
  const saveGw = (patch) => !!(vault && vault.write((o) => ({ ...o, gw: { ...gwOf(o), ...patch } })));

  function apply(bundle) {
    const clean = cleanBundle(bundle);
    const prev = applied;
    for (const k of prev) {
      if (k in clean) continue;
      if (k in original) env[k] = original[k]; else delete env[k];
    }
    applied = new Set();
    for (const [k, v] of Object.entries(clean)) {
      // 원래 값은 게이트웨이가 넣지 않은 것만(앞서 보관본으로 넣은 값을 원래 값으로 착각하지 않게)
      if (!(k in original) && !prev.has(k) && typeof env[k] === 'string') original[k] = env[k];
      env[k] = v;
      applied.add(k);
    }
    return Object.keys(clean);
  }

  // 끊긴 PC — 게이트웨이 값과 bat 키를 메모리에서 거둔다(서버가 더 못 보내게). 암호 파일의 묶음은 fetchBundle 이 지운다.
  function withdraw() {
    for (const k of applied) delete env[k];
    for (const k of ['SEEDANCE_API_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET']) delete env[k];
    applied = new Set();
  }

  async function enroll(url, o) {
    // 입장권 재료: 암호 파일에 옮겨 둔 bat 키가 먼저(bat 이 준 그 키), 없으면 지금 메모리의 키.
    const key = realKey(o.keys && o.keys.SEEDANCE_API_KEY) || realKey(env.SEEDANCE_API_KEY);
    if (!key) return { ok: false, why: 'no-ticket' };
    const ticket = ticketOf(key);
    const r = await post(fetchImpl, url, '/v1/enroll', { ticket, pc, app }, '', timeoutMs);
    if (r.status === 200 && r.j.ok && typeof r.j.token === 'string' && r.j.token.startsWith('sfv_')) {
      // enrolledWith — 어느 bat 키로 받은 출입증인지(입장권의 해시). 나중에 다른 팀 bat 을 돌렸는지 알아본다(boot).
      const saved = saveGw({ token: r.j.token, tokenId: r.j.token_id || '', team: r.j.team || '', label: r.j.label || '', cut: null, enrolledWith: sha256(ticket) });
      if (!saved) return { ok: false, why: 'vault-write' };   // 못 남기면 켤 때마다 새 출입증이 생긴다 — 쓰지 않는다
      log(`[Gateway] 등록됨 — ${r.j.label || r.j.team}`);
      return { ok: true, token: r.j.token };
    }
    return { ok: false, why: `enroll-${r.status}${r.j.code ? '-' + r.j.code : ''}`, message: r.j.error || '' };
  }

  /**
   * 게이트웨이에서 묶음을 받아 올린다. 켤 때(boot)와, 서버가 '키가 틀렸다' 를 받았을 때(refreshNow).
   * 결과 mode: 'gateway'(받음) · 'revoked'(관리자가 끊음) · 'offline'(못 받음 — 있는 것으로 계속)
   */
  async function fetchBundle() {
    let o = read();
    let gw = gwOf(o);
    const url = pickUrl(env, gw);
    const before = gw.config && gw.config.rev;
    try {
      let token = gw.token;
      let enrolledNow = false;
      if (!token) {
        const e = await enroll(url, o);
        if (!e.ok) return { mode: 'offline', why: e.why, message: e.message };
        token = e.token; enrolledNow = true;
      }
      let c = await post(fetchImpl, url, '/v1/config', { app }, token, timeoutMs);
      if (c.status === 401 && c.j.code === 'unknown' && !enrolledNow) {
        // 게이트웨이가 이 출입증을 모른다(기록이 지워졌다) — 끊긴 게 아니니 한 번 다시 등록한다.
        saveGw({ token: null });
        o = read();
        const e = await enroll(url, o);
        if (!e.ok) return { mode: 'offline', why: e.why, message: e.message };
        token = e.token;
        c = await post(fetchImpl, url, '/v1/config', { app }, token, timeoutMs);
      }
      if (c.status === 401 && c.j.code === 'revoked') {
        saveGw({ cut: new Date().toISOString(), config: null });
        withdraw();
        log('[Gateway] 관리자가 이 PC 의 출입증을 끊었습니다');
        return { mode: 'revoked', message: c.j.error || '' };
      }
      if (c.status === 200 && c.j.ok && c.j.env && typeof c.j.env === 'object') {
        const bundle = cleanBundle(c.j.env);
        if (!bundle.SEEDANCE_API_KEY) return { mode: 'offline', why: 'empty-bundle' };
        const rev = String(c.j.rev || '');
        apply(bundle);
        const moved = httpsUrl(c.j.env.SEEDANCE_GATEWAY_URL);   // 메모리엔 안 올리고(DENY) 다음 실행 주소로만
        saveGw({
          token, team: c.j.team || gw.team || '', label: c.j.label || gw.label || '', cut: null,
          ...(moved ? { url: moved } : {}),
          config: { env: bundle, rev, at: new Date().toISOString() },
        });
        return { mode: 'gateway', team: c.j.team, label: c.j.label, rev, changed: rev !== before, names: Object.keys(bundle).length };
      }
      return { mode: 'offline', why: `config-${c.status}${c.j.code ? '-' + c.j.code : ''}`, message: c.j.error || '' };
    } catch (e) {
      return { mode: 'offline', why: e && e.name === 'AbortError' ? 'timeout' : 'network', message: (e && e.message) || '' };
    }
  }

  /**
   * 켤 때 한 번. 보관해 둔 묶음이 있으면 바로 올리고 새 묶음은 뒤에서 받는다(pending). 없으면 받을 때까지 기다린다.
   * 끊긴 PC(cut)는 보관본을 쓰지 않고 게이트웨이에 다시 물어본다(관리자가 되살렸을 수 있다).
   */
  // 그 bat 키가 어느 팀 것인가(게이트웨이 /v1/ticket) — 팀 코드, 모르면 ''.
  async function teamOfBat(url, key) {
    try {
      const r = await post(fetchImpl, url, '/v1/ticket', { ticket: ticketOf(key) }, '', timeoutMs);
      return r.status === 200 && r.j.ok ? String(r.j.team || '') : '';
    } catch { return ''; }
  }

  // 다른 팀 bat 으로 다시 등록한다. 실패하면(인터넷 · 모르는 키 · 등록 닫힘) null — 지금 팀으로 계속하고 다음 실행 때 다시 해 본다.
  async function switchTeam(o, gw) {
    const url = pickUrl(env, gw);
    const oldToken = gw.token;
    // 끊긴 출입증인지 먼저 — 관리자가 끊었는데 앱이 아직 몰랐어도(끊김은 켠 뒤 뒤에서 알게 된다) bat 을 바꿔 피해 가지 못하게.
    try {
      const w = await post(fetchImpl, url, '/v1/whoami', null, oldToken, timeoutMs, 'GET');
      if (w.status === 401 && w.j.code === 'revoked') {
        saveGw({ cut: new Date().toISOString(), config: null });
        withdraw();
        log('[Gateway] 관리자가 이 PC 의 출입증을 끊었습니다 — 팀 bat 을 바꿔도 다시 등록하지 않음');
        return { mode: 'revoked', message: w.j.error || '' };
      }
    } catch { /* 못 물어보면 아래 등록도 대개 실패한다 — 그때는 지금 팀으로 계속 */ }
    let e;
    try { e = await enroll(url, o); } catch (err) { e = { ok: false, why: err && err.name === 'AbortError' ? 'timeout' : 'network' }; }
    if (!e.ok) { log(`[Gateway] 팀 bat 이 바뀌었지만 다시 등록하지 못함(${e.why}) — 지금 팀으로 계속`); return null; }
    // 옛 출입증은 내려놓는다 — 관리 화면에 같은 PC 가 두 팀으로 남지 않게('팀 바꿈'). 실패해도 그만(관리자가 끊을 수 있다).
    try { await post(fetchImpl, url, '/v1/leave', {}, oldToken, timeoutMs); } catch {}
    saveGw({ config: null });   // 옛 팀 묶음은 버린다
    const r = await fetchBundle();
    log(`[Gateway] 팀 bat 이 바뀌어 다시 등록 — ${r.label || r.team || r.mode}`);
    return { ...r, switched: true };
  }

  async function boot() {
    if (!vault) return { mode: 'off', why: 'no-vault' };
    let o = read();
    let gw = gwOf(o);
    // 팀 bat 을 새로 돌렸나 — 출입증을 받을 때 쓴 bat 키와 지금 bat 키(secrets.cjs 가 방금 암호 파일로 옮긴 것)가 다르면 그 bat 의
    // 팀으로 다시 등록한다. 예전처럼 '어느 팀 bat 을 돌리느냐 = 그 PC 의 팀'(사용자 2026-10-08). 같은 bat 을 다시 돌리면 아무 일도
    // 없다. 관리자가 끊은 PC(cut)는 bat 을 돌려도 다시 등록하지 않는다(끊은 뜻이 없어지므로).
    const batKey = realKey(o.keys && o.keys.SEEDANCE_API_KEY);
    const batTicket = batKey ? sha256(ticketOf(batKey)) : '';
    if (gw.token && batTicket && !gw.cut && gw.enrolledWith !== batTicket) {
      let switchIt = true;
      if (!gw.enrolledWith) {
        // 어느 bat 으로 받았는지 기록이 없는 출입증(802 첫 시험판) — 지금 bat 이 어느 팀 것인지 물어, 지금 팀과 같으면 기록만 남긴다.
        // 못 물어보면(인터넷 · 모르는 키) 이번엔 그대로 두고 다음 실행 때 다시.
        const t = await teamOfBat(pickUrl(env, gw), batKey);
        if (t && t === gw.team) { saveGw({ enrolledWith: batTicket }); switchIt = false; }
        else if (!t) switchIt = false;
      }
      if (switchIt) {
        const s = await switchTeam(o, gw);
        if (s) return s;
        o = read(); gw = gwOf(o);
      }
    }
    const cached = gw.config && gw.config.env;
    if (cached && !gw.cut) {
      apply(cached);
      const pending = fetchBundle().then((r) => { log(`[Gateway] 켠 뒤 받기: ${r.mode}${r.why ? ' ' + r.why : ''}${r.changed ? ' (바뀜)' : ''}`); return r; });
      return { mode: 'cache', team: gw.team, label: gw.label, rev: gw.config.rev, pending };
    }
    const r = await fetchBundle();
    if (r.mode === 'offline' && gw.cut) {
      // 끊긴 채로 게이트웨이에 닿지 못했다 — 끊긴 것으로 둔다(보관본 · bat 키를 쓰면 끊은 뜻이 없다).
      withdraw();
      return { mode: 'revoked', why: r.why, message: '' };
    }
    return r;
  }

  // 서버가 BytePlus · R2 에서 '키가 틀렸다' 를 받았을 때. 2분에 한 번까지, 겹치면 하나로.
  async function refreshNow(reason = '') {
    if (!vault) return { mode: 'off', changed: false };
    if (inFlight) return inFlight;
    if (Date.now() - lastRefreshAt < refreshGapMs) return { mode: 'skipped', changed: false };
    lastRefreshAt = Date.now();
    inFlight = fetchBundle().then((r) => {
      log(`[Gateway] 다시 받기(${reason || '요청'}): ${r.mode}${r.why ? ' ' + r.why : ''}${r.changed ? ' (바뀜)' : ''}`);
      return r;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  return { boot, refreshNow, fetchBundle };
}

module.exports = { createGateway, cleanBundle, ticketOf, pickUrl, DEFAULT_URL, TICKET_MSG };
