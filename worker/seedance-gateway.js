// seedance-gateway — NCP Object Storage 자격 증명 배포
//
// 왜 있나: NCP 키를 14개 팀 PC 에 손으로 심지 않기 위해서다. PC 는 이미 R2 키를 갖고
// 있으므로(R2.bat), 그 키로 서명해서 보내면 워커가 NCP 자격 증명을 내려준다.
// R2 시크릿 자체는 네트워크를 타지 않는다 — HMAC 재료로만 쓰인다.
//
// ★ 이건 인증 "강화"가 아니라 배포·회전 장치다. R2.bat 을 가진 사람은 누구나 호출할 수
//   있다 — 14팀이 같은 R2 키를 쓰기 때문이다. 얻는 것은 두 가지뿐이고, 둘 다 실질적이다:
//   (1) NCP 키를 한 곳에서 갈아끼우면 다음 실행부터 전 팀에 적용된다. .bat 재배포 없음.
//   (2) NCP 시크릿이 어느 PC 에도 파일로 남지 않는다 (앱은 메모리에만 들고 있는다).
//   팀별 차단이 필요해지면 R2 키를 회전시키는 것이 유일한 수단이다. 그때는
//   nanobanana-gateway 처럼 KV + 머신별 토큰으로 올리면 된다.

const CLOCK_SKEW_MS = 5 * 60 * 1000;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

// 길이가 다르면 바로 false — 길이는 어차피 공개 정보(hex 64자)라 숨길 게 없다.
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/health') {
      // 시크릿 값은 절대 내보내지 않는다. 설정 여부만 참/거짓으로 알린다.
      return json({
        ok: true,
        service: 'seedance-gateway',
        configured: Boolean(env.R2_SECRET && env.NCP_ACCESS_KEY_ID && env.NCP_SECRET_ACCESS_KEY),
        bucket: env.NCP_BUCKET || null,
      });
    }

    if (pathname !== '/ncp/credentials') return json({ ok: false, error: 'not found' }, 404);
    if (request.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'bad request' }, 400); }

    const ts = Number(body && body.ts);
    if (!Number.isFinite(ts)) return json({ ok: false, error: 'missing ts' }, 400);

    // ts 가 서명에 들어가므로 오래된 서명은 재사용할 수 없다. 창을 넘긴 요청은
    // 대개 공격이 아니라 PC 시계가 틀어진 것이므로, 메시지에 그렇게 적는다.
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
  },
};
