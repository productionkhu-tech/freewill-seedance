// 게이트웨이(seedance-gateway)에 키를 넣는 도우미 — ★ 관리자가 직접 실행한다. 키 값은 화면에 찍지 않는다.
//
//   node worker/setup-secrets.mjs "<팀 bat 이 있는 폴더>" [--dry] [--new-admin-key] [--bp-asset-key]
//
//   --dry             무엇을 넣을지(팀 · 이름)만 보여 주고 올리지 않는다. 먼저 이걸로 확인할 것.
//   --new-admin-key   관리 화면 키를 새로 만든다(처음이거나 잃어버렸을 때). 화면에 한 번만 나온다.
//   --bp-asset-key    어셋 서명 키(BP_ASSET_AK · BP_ASSET_SK)도 함께 올린다 — 주간 리포트의 DPAPI 저장소(secrets.dat)에서
//                     읽는다(이 Windows 계정에서만 열림). 폴더는 REPORT_SECRETS_DIR 로 바꿀 수 있다. 값은 파이프로만 받고 찍지 않는다.
//
// 하는 일
//   1. 폴더의 *.bat · *.cmd 에서 setx / set 으로 심는 값을 읽는다.
//   2. SEEDANCE_API_KEY 마다 sha256 을 떠서 앱 v1 의 17팀 표(seedance-gateway.js KNOWN_LABELS)와 맞춰 본다 →
//      BP_KEY_<팀 코드> 로 넣는다. 파일 이름은 안 믿는다(이름이 틀려도 엉뚱한 팀으로 청구되지 않게). 표에 없는 키는 건너뛰고 알린다.
//   3. R2_ACCESS_KEY_ID · R2_ENDPOINT · R2_BUCKET, 옴니 키(GEMINI_KEY ← NANOBANANA_STUDIO_KEY), ENROLL_OPEN="1".
//      R2_SECRET(v1 부터 있음)은 건드리지 않는다 — 옛 앱(801 이하)이 그 값으로 NCP 키를 받는다. bat 이 옛 값이면 전 PC 보관이 멈춘다.
//   4. 한 번에 올린다: npx wrangler secret bulk (임시 파일은 끝나면 지운다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const DRY = args.includes('--dry');
const NEW_ADMIN = args.includes('--new-admin-key');
const BP_ASSET = args.includes('--bp-asset-key');
// --only-bp-asset-key(26.11.23): 어셋 서명 키 둘만 올린다 — bat 폴더 없이. 팀 키 · R2 를 bat 에서 다시 올리면 Cloudflare 에서만 바꾼 값이
// 옛 bat 값으로 되돌아갈 수 있어서, 어셋 키만 넣을 때는 이걸로. [--dry] 같이 쓸 수 있다.
if (args.includes('--only-bp-asset-key')) {
  const cwd = process.env.REPORT_SECRETS_DIR || 'C:/Users/user/Desktop/기획 파일/TA/앱개발/26.05.04 시댄스 크레딧 관리/weekly_report';
  const py = "import json,secrets_store as s; print(json.dumps({n: s.resolve('secret:' + n) for n in ('BP_ASSET_AK', 'BP_ASSET_SK')}))";
  const r = spawnSync(process.env.PYTHON || 'python', ['-c', py], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let got = null;
  try { got = r.status === 0 ? JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()) : null; } catch {}
  if (!got || !got.BP_ASSET_AK || !got.BP_ASSET_SK) {
    const why = r.error ? r.error.message : (String(r.stderr || '').trim().split(/\r?\n/).pop() || `exit ${r.status}`);
    console.error(`어셋 키를 못 읽었습니다(${cwd}) — ${got ? 'BP_ASSET_AK · BP_ASSET_SK 중 빈 값' : why.slice(0, 200)}. 아무것도 올리지 않았습니다.`);
    process.exit(1);
  }
  console.log(`올릴 것: BP_ASSET_AK · BP_ASSET_SK (값은 안 찍음, AK 길이 ${got.BP_ASSET_AK.length} · SK 길이 ${got.BP_ASSET_SK.length})`);
  if (DRY) { console.log('--dry: 올리지 않았습니다.'); process.exit(0); }
  const tmp = path.join(os.tmpdir(), `sd-asset-${crypto.randomBytes(6).toString('hex')}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ BP_ASSET_AK: got.BP_ASSET_AK, BP_ASSET_SK: got.BP_ASSET_SK }), { mode: 0o600 });
    const u = spawnSync(`npx --yes wrangler@4.148.0 secret bulk "${tmp}"`, { cwd: HERE, stdio: 'inherit', shell: true });
    if (u.status !== 0) { console.error(`실패(exit ${u.status}). 'npx wrangler login' 이 되어 있는지 확인하세요.`); process.exitCode = 1; }
    else console.log('올림: 2개 (값은 화면에 안 찍었습니다)');
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  process.exit(process.exitCode || 0);
}
if (!dir || !fs.existsSync(dir)) {
  console.error('사용법: node worker/setup-secrets.mjs "<팀 bat 폴더>" [--dry] [--new-admin-key] [--bp-asset-key]');
  process.exit(2);
}

// 17팀 표 — 워커 파일에서 그대로 읽는다(두 곳이 어긋나지 않게)
const src = fs.readFileSync(path.join(HERE, 'seedance-gateway.js'), 'utf8');
const KNOWN = Object.fromEntries([...src.slice(src.indexOf('const KNOWN_LABELS = {')).matchAll(/'([0-9a-f]{64})':\s*'([^']+)'/g)].slice(0, 64).map((m) => [m[1], m[2]]));
// 시트 이름 → 팀 코드(시크릿 이름). 코드 모양이 이름을 만든다(T6 → 6팀) — 키를 재발급한 뒤에도 같은 이름이 나오게.
const codeOf = (label) => {
  const m = label.match(/^(\d{1,3})팀$/);
  if (m) return `T${m[1]}`;
  return label.replace(/팀$/, '').replace(/[^A-Za-z0-9_]/g, '_');
};

// bat 읽기 — setx NAME "value" / setx NAME value / set NAME=value / set "NAME=value"
const found = {};          // NAME → [{ value, file }]
const files = fs.readdirSync(dir).filter((f) => /\.(bat|cmd)$/i.test(f));
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'latin1');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = line.match(/^setx\s+([A-Za-z0-9_]+)\s+"([^"]*)"/i) || line.match(/^setx\s+([A-Za-z0-9_]+)\s+([^\s"]+)/i)
      || line.match(/^set\s+"([A-Za-z0-9_]+)=([^"]*)"/i) || line.match(/^set\s+([A-Za-z0-9_]+)=(.+)$/i);
    if (!m) continue;
    const name = m[1].toUpperCase();
    const value = m[2].trim();
    if (!value || value.includes('%')) continue;            // %다른변수% 같은 건 값이 아니다
    (found[name] ||= []).push({ value, file: f });
  }
}

const secrets = {};
const report = [];
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// 팀 키
const seen = new Set();
for (const { value, file } of found.SEEDANCE_API_KEY || []) {
  const h = sha(value);
  if (seen.has(h)) continue;
  seen.add(h);
  const label = KNOWN[h];
  if (!label) { report.push(`  ? 표에 없는 키 — 해시 앞 8자 ${h.slice(0, 8)} (${file}) → 건너뜀. 새 팀이면 BP_KEY_<코드> 로 직접 넣으세요`); continue; }
  const code = codeOf(label);
  secrets[`BP_KEY_${code}`] = value;
  report.push(`  ✓ ${label.padEnd(10)} → BP_KEY_${code}   (${file})`);
}
const teams = Object.keys(secrets).length;
const missing = [...new Set(Object.values(KNOWN))].filter((l) => !secrets[`BP_KEY_${codeOf(l)}`]);

// R2 (R2_SECRET 은 건드리지 않는다 — 위 머리말)
const one = (name) => {
  const vals = [...new Set((found[name] || []).map((x) => x.value))];
  if (vals.length > 1) { report.push(`  ! ${name} 값이 bat 마다 다릅니다(${vals.length}가지) — 넣지 않습니다. 대시보드에서 직접 넣으세요`); return ''; }
  return vals[0] || '';
};
for (const n of ['R2_ACCESS_KEY_ID', 'R2_ENDPOINT', 'R2_BUCKET']) { const v = one(n); if (v) secrets[n] = v; }

// 옴니 키 — bat 의 NANOBANANA_STUDIO_KEY, 없으면 이 PC 환경변수(가짜값 제외)
const gem = one('NANOBANANA_STUDIO_KEY') || (process.env.NANOBANANA_STUDIO_KEY && process.env.NANOBANANA_STUDIO_KEY !== 'managed-by-gateway' ? process.env.NANOBANANA_STUDIO_KEY : '');
if (gem) secrets.GEMINI_KEY = gem;

secrets.ENROLL_OPEN = '1';

// 어셋 서명 키 — 주간 리포트 저장소에서. 둘 다 있어야 넣는다(하나만 올라가면 서명이 틀려 어셋이 통째로 막힌다).
// 못 읽으면 아무것도 올리지 않고 멈춘다 — 플래그를 줬는데 조용히 빠지면 올라간 줄 알게 된다.
if (BP_ASSET) {
  const cwd = process.env.REPORT_SECRETS_DIR || 'C:/Users/user/Desktop/기획 파일/TA/앱개발/26.05.04 시댄스 크레딧 관리/weekly_report';
  const py = "import json,secrets_store as s; print(json.dumps({n: s.resolve('secret:' + n) for n in ('BP_ASSET_AK', 'BP_ASSET_SK')}))";
  const r = spawnSync(process.env.PYTHON || 'python', ['-c', py], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let got = null;
  try { got = r.status === 0 ? JSON.parse(String(r.stdout).trim().split(/\r?\n/).pop()) : null; } catch {}
  if (!got || !got.BP_ASSET_AK || !got.BP_ASSET_SK) {
    // 표준 출력은 값일 수 있어 안 찍는다. 오류 쪽 마지막 줄만(파이썬 예외 이름 · 문구).
    const why = r.error ? r.error.message : (String(r.stderr || '').trim().split(/\r?\n/).pop() || `exit ${r.status}`);
    console.error(`\n어셋 키를 못 읽었습니다(${cwd}) — ${got ? 'BP_ASSET_AK · BP_ASSET_SK 중 빈 값' : why.slice(0, 200)}`);
    console.error("  주간 리포트 폴더에서 'python secrets_store.py --set BP_ASSET_AK' · '--set BP_ASSET_SK' 로 넣은 뒤 다시. 아무것도 올리지 않았습니다.");
    process.exit(1);
  }
  secrets.BP_ASSET_AK = got.BP_ASSET_AK;
  secrets.BP_ASSET_SK = got.BP_ASSET_SK;
}
let adminKey = '';
if (NEW_ADMIN) { adminKey = crypto.randomBytes(24).toString('base64url'); secrets.ADMIN_KEY = adminKey; }

console.log(`\nbat ${files.length}개 읽음`);
console.log(`\n팀 키 ${teams}개`);
console.log(report.join('\n'));
if (missing.length) console.log(`\n  bat 이 없는 팀 ${missing.length}개: ${missing.join(', ')} — 그 팀 bat 을 같은 폴더에 넣고 다시 실행하거나 대시보드에서 BP_KEY_<코드>`);
console.log(`\n그 밖에: ${Object.keys(secrets).filter((k) => !k.startsWith('BP_KEY_')).join(', ') || '없음'}`);
if (!secrets.R2_ACCESS_KEY_ID || !secrets.R2_ENDPOINT || !secrets.R2_BUCKET) console.log('  ! R2 값 일부가 bat 에 없습니다 — 새 PC 는 R2 를 게이트웨이에서 받으므로 꼭 있어야 합니다(R2.bat 을 같은 폴더에)');
if (!secrets.GEMINI_KEY) console.log('  ! 옴니 키(GEMINI_KEY)를 못 찾았습니다 — 대시보드에서 직접 넣으세요');

if (DRY) { console.log('\n--dry: 올리지 않았습니다.'); process.exit(0); }

const tmp = path.join(os.tmpdir(), `sd-secrets-${crypto.randomBytes(6).toString('hex')}.json`);
try {
  fs.writeFileSync(tmp, JSON.stringify(secrets), { mode: 0o600 });
  console.log('\nCloudflare 에 올리는 중 (wrangler secret bulk)…');
  // 버전을 박는다 — 설치할지 묻는 질문 없이, 배포에 쓴 것과 같은 wrangler 로(2026-10-08 v3 배포: 4.148.0).
  // 명령은 한 줄 문자열로 — 윈도우의 npx(.cmd)는 셸로만 띄울 수 있고, 셸에 인자 배열을 주면 Node 가 경고(DEP0190)를 낸다.
  const r = spawnSync(`npx --yes wrangler@4.148.0 secret bulk "${tmp}"`, { cwd: HERE, stdio: 'inherit', shell: true });
  if (r.status !== 0) { console.error(`\n실패(exit ${r.status}). 'npx wrangler login' 이 되어 있는지 확인하세요.`); process.exitCode = 1; }
  else console.log(`\n올림: ${Object.keys(secrets).length}개 (값은 화면에 안 찍었습니다)`);
} finally {
  try { fs.rmSync(tmp, { force: true }); } catch {}
}
if (adminKey) {
  console.log('\n관리 화면 키 (지금 한 번만 보입니다 — 비밀번호 관리자에 저장하세요):');
  console.log('  ' + adminKey);
  console.log('관리 화면: https://seedance-gateway.production-khu.workers.dev/admin');
}
