// 가짜 BytePlus + 시트(홍보 영상 녹화용). 돈이 나가는 곳 없음. 생성 작업마다 클립 하나를 돌려준다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const DIR = process.env.FAKE_CLIPS;   // 결과 영상(fixtures 가 만든다)
const FAKE_PORT = Number(process.env.FAKE_PORT || 3946);   // 슬롯(병렬 시험, 11/24)
const state = { delayMs: 3500, queue: [], tasks: {}, n: 0, seen: [] };
// 켤 때마다 다른 번호 — 다시 켜도 앞 회차의 task id 와 겹치지 않게(겹치면 옛 카드의 본편 · 짝이 새 카드에 붙는다, 11/18)
const BOOT = Date.now() % 1000000;
const ROSTER = [
  { project: 'EVIKIA 런칭 필름', id: 'EVK', status: '진행', allow4k: true, allow25: true },
  { project: '시험용 두 번째 프로젝트 — 이름이 아주 길어서 한 줄에 다 안 들어가는 경우', id: 'TST', status: '진행', allow4k: true, allow25: true },
];
const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const read = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
const clips = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.mp4')).sort();
const serveFile = (req, res, file) => {
  const size = fs.statSync(file).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const s = m[1] ? +m[1] : 0, e = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': e - s + 1, 'Content-Range': `bytes ${s}-${e}/${size}`, 'Access-Control-Allow-Origin': '*' });
    return fs.createReadStream(file, { start: s, end: e }).pipe(res);
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(file).pipe(res);
};
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const raw = await read(req);
  const body = raw.toString('utf8');
  if (u.pathname === '/__set') { Object.assign(state, JSON.parse(body)); return send(res, 200, { ok: true }); }
  if (u.pathname === '/__seen') return send(res, 200, state.seen);
  // 시험용: 시트 권한 바꾸기 — { "EVK": { "allow4k25": true, "allow4k": false } } (26.11.1801 2.5 4K 시험)
  if (u.pathname === '/__roster_add') { const p = JSON.parse(body || '{}'); if (p.id && !ROSTER.some((r) => r.id === p.id)) ROSTER.push(p); return send(res, 200, ROSTER); }
  if (u.pathname === '/__roster') { const p = JSON.parse(body || '{}'); for (const r of ROSTER) if (p[r.id]) Object.assign(r, p[r.id]); return send(res, 200, ROSTER); }
  if (u.pathname === '/__tasks') return send(res, 200, state.tasks);
  if (u.searchParams.get('action') === 'projects') return send(res, 200, { ok: true, projects: ROSTER });
  if (u.pathname === '/__puts') return send(res, 200, state.puts || []);
  if (req.method === 'POST' && u.pathname.endsWith('/contents/generations/tasks')) {
    const p = JSON.parse(body); state.seen.push(p);
    // 시험용(11/24 자동 인증): 실제 BytePlus 와 같은 문구 · 칸 번호로 거절 — 앞에서부터 처음 걸린 칸 하나만(실측과 같다)
    //   state.goneAssets: [에셋 id]  → asset://그 id 칸: "The specified asset … is not found"(11/24 실측 문구)
    //   state.faceKeys:  [글자]      → 주소(asset:// 아님)에 그 글자가 든 이미지 · 영상 칸: PrivacyInformation + 'content[N]'
    for (const [i, c] of (p.content || []).entries()) {
      const t = c?.type, url = c?.[t]?.url || '';
      if (url.startsWith('asset://') && (state.goneAssets || []).includes(url.slice(8)))
        return send(res, 400, { error: { code: 'InvalidParameter', message: `The parameter \`content[${i}].${t}.url\` specified in the request is not valid: The specified asset ${url.slice(8)} is not found. Request id: fake`, type: 'BadRequest' } });
      if ((t === 'image_url' || t === 'video_url') && (state.copyrightKeys || []).some((k) => url.includes(k))) {   // 저작권(유명인 · 캐릭터) — 문서 문구
        const kind = t === 'image_url' ? 'Image' : 'Video';
        return send(res, 400, { error: { code: `Input${kind}SensitiveContentDetected.PolicyViolation`, message: `The request failed because the input ${kind.toLowerCase()} may be related to copyright restrictions. Request ID: fake`, type: 'BadRequest' } });
      }
      if (!url.startsWith('asset://') && (t === 'image_url' || t === 'video_url') && (state.faceKeys || []).some((k) => url.includes(k))) {
        const kind = t === 'image_url' ? 'Image' : 'Video';
        return send(res, 400, { error: { code: `Input${kind}SensitiveContentDetected.PrivacyInformation`, message: `The request failed because the input ${kind.toLowerCase()} 'content[${i}]' may contain real person. Request id: fake`, type: 'BadRequest' } });
      }
    }
    // 시험용(11/23): 프롬프트에 FACEIMG · FACEVID → 동기 400(실존 인물 얼굴), FACEFAIL → 태스크가 실패로 끝남
    if (body.includes('FACEIMG')) return send(res, 400, { error: { code: 'InputImageSensitiveContentDetected.PrivacyInformation', message: 'The request failed because the input image may contain real person.Request ID: fake', type: 'BadRequest' } });
    if (body.includes('FACEVID')) return send(res, 400, { error: { code: 'InputVideoSensitiveContentDetected.PrivacyInformation', message: 'The request failed because the input video may contain real person.Request ID: fake', type: 'BadRequest' } });
    const id = `cgt-20261111${String((BOOT + (++state.n) * 7919) % 1000000).padStart(6, '0')}-ev${((state.n + BOOT) * 2654435761 >>> 0).toString(16).slice(0, 5)}`;
    const list = clips();
    const clip = state.queue.length ? state.queue.shift() : list[(state.n - 1) % list.length];
    const dly = /DLY(\d+)/.exec(body);   // 시험용: 프롬프트에 DLY12 → 12초 · FAILTEST → 실패
    state.tasks[id] = { clip, at: Date.now(), delay: dly ? +dly[1] * 1000 : state.delayMs, fail: body.includes('FAILTEST') ? 'test' : body.includes('FACEFAIL') ? 'face' : false };
    return send(res, 200, { id });
  }
  const m = /\/contents\/generations\/tasks\/([^/]+)$/.exec(u.pathname);
  if (m && req.method === 'DELETE') {   // 시험용 취소 — 있으면 지우고 200
    const had = !!state.tasks[m[1]]; delete state.tasks[m[1]];
    return send(res, had ? 200 : 404, had ? {} : { error: { code: 'NotFound' } });
  }
  if (m) {
    const t = state.tasks[m[1]];
    const done = t && Date.now() - t.at >= t.delay;
    if (done && t.fail === 'face') return send(res, 200, { id: m[1], status: 'failed', error: { code: 'InputVideoSensitiveContentDetected.PrivacyInformation', message: 'The request failed because the input video may contain real person.Request ID: fake' } });
    if (done && t.fail) return send(res, 200, { id: m[1], status: 'failed', error: { code: 'OutputVideoSensitiveContentDetected', message: 'fake failure for test' } });
    return send(res, 200, { id: m[1], status: done ? 'succeeded' : 'running', ...(done ? { content: { video_url: `http://127.0.0.1:${FAKE_PORT}/v/${m[1]}.mp4?sig=x` }, usage: { total_tokens: 1 } } : {}) });
  }
  let vm = /^\/v\/(.+)\.mp4$/.exec(u.pathname);
  if (vm) {
    const name = decodeURIComponent(vm[1]);
    const clip = state.tasks[name]?.clip || (name.startsWith('file/') ? name.slice(5) + '.mp4' : null);
    if (clip && fs.existsSync(path.join(DIR, clip))) return serveFile(req, res, path.join(DIR, clip));
    return send(res, 404, { error: 'no clip' });
  }
  if (req.method === 'POST') return send(res, 200, { ok: true });
  if (req.method === 'PUT') {   // 시험용 보관함(NCP · R2) 올리기 — 받은 바이트 크기 · 끝 상자를 적어 둔다(11/23)
    (state.puts ||= []).push({ path: u.pathname, size: raw.length, fwsd: raw.subarray(Math.max(0, raw.length - 400)).includes('FWSD'), md5: (await import('node:crypto')).createHash('md5').update(raw).digest('hex'), at: Date.now() });
    res.writeHead(200, { ETag: '"fake"' }); return res.end();
  }   // 시험용 보관함(NCP · R2) 올리기
  if (req.method === 'HEAD') { res.writeHead(404); return res.end(); }
  return send(res, 503, { error: 'fake' });
}).listen(FAKE_PORT, '127.0.0.1', () => console.log('fake', FAKE_PORT, DIR));
