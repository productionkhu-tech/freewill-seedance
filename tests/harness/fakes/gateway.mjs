// 격리 시험용 게이트웨이(127.0.0.1:3947) — 진짜 worker/seedance-gateway.js 코드에 가짜 BytePlus(서명 OpenAPI)를 붙였다. 과금 · 바깥 호출 없음.
// 가짜 BytePlus: 프로젝트 2DT · 1T, 2DT 의 가린 키 = 팀 키. CreateAsset 은 분당 3번까지(넘으면 AccountFlowLimitExceeded),
// GetAsset 은 만든 뒤 2번째 물음부터 Active. 이름에 FAILIMG 가 든 사진은 Failed. 시험 고리: /__stats · /__assets · /__reset.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const REPO = process.env.REPO; const TOKEN_FILE = process.argv[2];
const worker = (await import(new URL('file:///' + path.join(REPO, 'worker', 'seedance-gateway.js').replace(/\\/g, '/')).href)).default;
class MemKV { constructor() { this.m = new Map(); } async get(k, t) { const v = this.m.get(k); if (v == null) return null; return t === 'json' ? JSON.parse(v.v) : v.v; } async put(k, v, o = {}) { this.m.set(k, { v: String(v), meta: o.metadata }); } async delete(k) { this.m.delete(k); } async list({ prefix = '' } = {}) { return { keys: [...this.m.entries()].filter(([k]) => k.startsWith(prefix)).map(([name, x]) => ({ name, metadata: x.meta })), list_complete: true }; } }
const TEAM_KEY = 'f00dcafe-1234-5678-9abc-0123456789ab';
const mask = (k) => k.slice(0, 8) + '*'.repeat(k.length - 16) + k.slice(-8);
const stats = { CreateAsset: 0, CreateAssetGroup: 0, GetAsset: 0, ListAssets: 0, ListApiKeys: 0, ListProjects: 0, throttled: 0 };
let assets = []; let groups = []; const createTimes = []; let seq = 0;   // id 는 지워도 다시 안 쓰는 번호로
const RATE = Number(process.env.GW_RATE || 3), GROUP_CAP = Number(process.env.GW_GROUP_CAP || 0);   // 분당 등록 한도 · 그룹 수 한도(대량 시험 bulk.mjs)
let cap = 0;           // 시험 고리 /__cap?n=… — 프로젝트의 에셋이 n 개면 CreateAsset 을 개수 한도로 거절(0 = 없음)
const failKeys = [];   // 시험 고리 /__fail?key=… — 이름(내용 key)에 그 글자가 든 에셋은 Failed(BytePlus 가 거절)
const ok = (Result, Action) => new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'r', Action }, Result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const err = (Code, Message, Action, status = 400) => new Response(JSON.stringify({ ResponseMetadata: { RequestId: 'r', Action, Error: { Code, Message } } }), { status, headers: { 'Content-Type': 'application/json' } });
async function fakeBytePlus(url, init) {
  const u = new URL(url); const Action = u.searchParams.get('Action'); stats[Action] = (stats[Action] || 0) + 1;
  if (!/^HMAC-SHA256 Credential=fake-ak\//.test(new Headers(init?.headers || {}).get('authorization') || '')) return err('SignatureDoesNotMatch', 'bad auth', Action, 401);
  const b = init?.body ? JSON.parse(init.body) : {};
  if (Action === 'ListProjects') return ok({ Projects: [{ ProjectName: '1T' }, { ProjectName: '2DT' }] }, Action);
  if (Action === 'ListApiKeys') return ok({ Items: [{ Id: 'k-' + b.ProjectName, Key: b.ProjectName === '2DT' ? mask(TEAM_KEY) : mask('aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb'), ProjectName: b.ProjectName, Status: 'Active' }] }, Action);
  if (Action === 'ListAssets') {
    const items = assets.filter((a) => a.ProjectName === b.ProjectName && (!b.Filter?.Name || a.Name.includes(b.Filter.Name)) && (!b.Filter?.Statuses || b.Filter.Statuses.includes(a.Status)));
    return ok({ Items: items.map(({ polls, ...a }) => a) }, Action);
  }
  if (Action === 'CreateAssetGroup') { if (GROUP_CAP && groups.length >= GROUP_CAP) return err('QuotaExceeded.AssetGroup', 'The number of asset groups exceeds the quota', Action); const id = 'group-fake-' + (groups.length + 1); groups.push({ Id: id, Name: b.Name, ProjectName: b.ProjectName }); return ok({ Id: id }, Action); }
  if (Action === 'CreateAsset') {
    const now = Date.now(); while (createTimes.length && now - createTimes[0] > 60000) createTimes.shift();
    if (createTimes.length >= RATE) { stats.throttled++; return err('AccountFlowLimitExceeded', 'flow limit', Action, 429); }
    if (cap && assets.filter((a) => a.ProjectName === b.ProjectName).length >= cap) return err('QuotaExceeded.AssetCount', 'The number of assets exceeds the quota limit', Action, 400);
    createTimes.push(now);
    const id = `asset-fake-${String(++seq).padStart(3, '0')}`;
    assets.push({ Id: id, Name: b.Name, GroupId: b.GroupId, ProjectName: b.ProjectName, Status: 'Processing', CreateTime: new Date(now).toISOString(), polls: 0, URL: b.URL });
    return ok({ Id: id }, Action);
  }
  if (Action === 'DeleteAsset') {
    const i = assets.findIndex((x) => x.Id === b.Id && x.ProjectName === b.ProjectName);
    if (i < 0) return err('NotFound.Asset', 'asset not found', Action, 404);
    assets.splice(i, 1); stats.deleted = (stats.deleted || 0) + 1;
    return ok({}, Action);
  }
  if (Action === 'GetAsset') {
    const a = assets.find((x) => x.Id === b.Id && x.ProjectName === b.ProjectName);
    if (!a) return err('NotFound.Asset', 'asset not found', Action, 404);
    a.polls++; if (a.Status === 'Processing' && a.polls >= 2) a.Status = /FAILIMG/.test(a.URL || '') || failKeys.some((k) => a.Name.includes(k)) ? 'Failed' : 'Active';
    const { polls, ...out } = a;
    return ok({ ...out, ...(a.Status === 'Failed' ? { Error: { Code: 'InvalidImage', Message: 'fake reject' } } : {}) }, Action);
  }
  return err('InvalidAction', Action, Action);
}
const env = { SD_TOKENS: new MemKV(), ENROLL_OPEN: '1', ADMIN_KEY: 'admin-test', BP_KEY_TA: TEAM_KEY, BP_ASSET_AK: 'fake-ak', BP_ASSET_SK: 'fake-sk', ASSET_TEST_HTTP: '1', FETCH: fakeBytePlus };
const call = async (req) => { const waits = []; const r = await worker.fetch(req, env, { waitUntil: (x) => waits.push(x), passThroughOnException() {} }); await Promise.allSettled(waits); return r; };
// 시험 앱이 쓸 출입증
const ticket = crypto.createHmac('sha256', TEAM_KEY).update('seedance-ticket-v1').digest('hex');
const en = await (await call(new Request('https://gw.local/v1/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, pc: 'harness', app: 'test' }) }))).json();
fs.writeFileSync(TOKEN_FILE, en.token);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (req.url === '/__stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ stats, assets: assets.length, groups: groups.length, names: assets.map((a) => [a.Id, a.Name, a.Status]) })); }
  if (req.url.startsWith('/__cap?n=')) { cap = Number(req.url.slice(9)) || 0; res.writeHead(200); return res.end('ok'); }   // 보관함 한도(0 = 없음)
  if (req.url.startsWith('/__age?')) {   // 그 에셋을 오래 안 쓴 것으로(days 일 전에 만들고 마지막으로 씀)
    const q = new URL('http://x' + req.url).searchParams; const a = assets.find((x) => x.Id === q.get('id'));
    if (a) { const t = new Date(Date.now() - Number(q.get('days') || 10) * 86400e3).toISOString().replace(/\.\d+Z$/, 'Z'); a.CreateTime = t; a.LastInferenceTime = t; }
    res.writeHead(a ? 200 : 404); return res.end(a ? 'ok' : 'no');
  }
  if (req.url.startsWith('/__fail?key=')) { failKeys.push(decodeURIComponent(req.url.slice(12))); res.writeHead(200); return res.end('ok'); }
  if (req.url.startsWith('/__gone?id=')) { const id = decodeURIComponent(req.url.slice(11)); assets = assets.filter((a) => a.Id !== id); res.writeHead(200); return res.end('ok'); }   // 그 에셋이 BytePlus 에서 지워짐(보관함 정리 · 만료)
  if (req.url === '/__expire') { assets = assets.filter((a) => !a.Id.endsWith('001')); res.writeHead(200); return res.end('ok'); }   // 첫 에셋이 BytePlus 에서 지워진 경우
  const r = await call(new Request('https://gw.local' + req.url, { method: req.method, headers: req.headers, body: req.method === 'GET' ? undefined : body }));
  res.writeHead(r.status, { 'Content-Type': 'application/json' }); res.end(await r.text());
}).listen(Number(process.env.GW_PORT || 3947), '127.0.0.1', () => console.log('fake-gw', process.env.GW_PORT || 3947, 'ready'));
