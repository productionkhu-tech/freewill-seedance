// ─── 키 보관: 환경변수(레지스트리 평문) → 이 PC · 이 Windows 계정만 여는 암호 파일 ───
//
// 팀 bat 이 setx 로 심은 키는 HKCU\Environment 에 평문으로 남는다. 레지스트리 덤프·화면 공유·
// `echo %SEEDANCE_API_KEY%` 한 줄로 그대로 보인다. 앱이 켜질 때 그 값을 암호 파일로 옮기고
// 환경변수는 지운다. 서버는 지금처럼 process.env 에서 읽는다 — 여기서 메모리에만 채워 주므로
// server.ts · ncp.ts 는 한 줄도 안 바뀐다.
//
// ★ safeStorage = Windows 에선 DPAPI. 암호 키를 우리가 만들지 않고 Windows 가 로그인 계정에서
//   뽑아 쓴다. secrets.bin 을 다른 PC · 다른 계정으로 복사해 가면 안 열린다.
//   막는 것: 레지스트리 평문 노출(덤프 · 스크린샷 · 백업 · 동기화), 퇴사자가 값을 들고 나가기.
//   못 막는 것: 이 계정으로 도는 악성코드 — 복호화 권한이 이 계정에 있다.
//
// ★ 순서가 전부다. 암호 파일을 쓰고 → 다시 열어 원본과 한 글자도 안 다른지 확인한 다음에만
//   환경변수를 지운다. 어느 단계든 실패하면 아무것도 안 지운다(다음 실행 때 다시 시도한다).
//   지우는 건 되돌릴 수 없고, 지운 뒤 파일이 안 열리면 그 PC 는 생성을 못 한다.
//
// ★ 다시 넣는 길은 지금과 같다 — 팀 bat 을 다시 실행. 새 값이 환경변수에 생기면 다음 실행 때
//   암호 파일을 그 값으로 갈아끼우고 또 지운다. 키 교체 · 신규 입사자 · 프로필이 날아간 PC 모두 이 길.

const fs = require('fs');
const path = require('path');

// 시댄스만 읽는 것 — 옮기고 지운다. (앱개발 폴더 전체를 뒤져 다른 프로그램이 안 읽는 것을 확인, 2026-10-08.
// SEEDANCE_API_KEY 는 크레딧 관리 폴더의 관리자 도구도 읽지만 그건 관리자 PC 에만 있고, 주간 리포트는
// 자기 DPAPI 저장소(secrets_store.py)를 먼저 본다.)
const KEYS = [
  'SEEDANCE_API_KEY',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'R2_BUCKET',
];

// 다른 앱과 같이 쓰는 것 — 진짜 값이면 보관하고 메모리에 올리지만, 환경변수는 절대 안 지운다.
//   NANOBANANA_STUDIO_KEY  나노바나나 앱(app.py)도 읽는다. 나노바나나는 자기 게이트웨이에서 키를 받으면
//                          이 값을 지우지 않고 'managed-by-gateway' 로 바꿔 둔다 — 옛 나노바나나가 이 변수가
//                          없으면 안 켜지기 때문이다(nb_gateway.py scrub_plaintext). 여기서 지우면 그게 깨진다.
//                          가짜값이 들어 있으면 보관해 둔 진짜 값을 대신 올린다(가짜값을 Gemini 에 보내면 400).
const SHARED = ['NANOBANANA_STUDIO_KEY'];
const PLACEHOLDERS = new Set(['managed-by-gateway']);
const realValue = (v) => Boolean(v) && !PLACEHOLDERS.has(String(v).trim());
const ALL = [...KEYS, ...SHARED];

// bat 이 심었지만 이제 아무도 안 읽는 것 — 옮길 필요 없이 지운다.
//   SEEDANCE_25_DEMO_*  2.5 데모 2026-08-14 종료, 앱 코드에서 빠짐
//   NCP_*               NCP 키는 seedance-gateway 가 메모리로 내려준다(ncp.ts). 앱개발 폴더 전체에서
//                       NCP_OBJECT_* 를 읽는 코드 없음 — 2026-10-08 확인
const DEAD = [
  'SEEDANCE_25_DEMO_KEY', 'SEEDANCE_25_DEMO_ENDPOINT',
  'NCP_OBJECT_ACCESS_KEY_ID', 'NCP_OBJECT_SECRET_ACCESS_KEY', 'NCP_OBJECT_BUCKET',
  'NCP_OBJECT_ENDPOINT', 'NCP_OBJECT_REGION', 'NCP_PRESIGN_EXPIRES_SECONDS',
];

const FILE = 'secrets.bin';
const NAME_RE = /^[A-Z0-9_]{1,64}$/;   // PowerShell 명령에 그대로 박히므로 이름 모양을 못 박는다

// 파일 하나에 둘이 산다: keys(bat 이 심은 키 원문 — 아래 loadSecrets) · gw(게이트웨이 출입증과 마지막으로 받은 묶음 —
// gateway.cjs). 한쪽을 쓸 때 다른 쪽을 그대로 둔다.
function readStore(safeStorage, file) {
  if (!fs.existsSync(file)) return { keys: {}, obj: {}, state: 'none' };
  try {
    const obj = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
    return { keys: (obj && obj.keys) || {}, obj: obj && typeof obj === 'object' ? obj : {}, state: 'ok' };
  } catch {
    // 다른 계정 · 다른 PC 에서 만든 파일이거나, 관리자가 비밀번호를 강제로 바꿔 DPAPI 마스터키가 끊긴 경우.
    return { keys: {}, obj: {}, state: 'unreadable' };
  }
}

// 쓰고 → 다시 열어 비교 → 같을 때만 제자리로. 틀리면 임시 파일을 버리고 false.
function writeStoreVerified(safeStorage, file, obj) {
  const tmp = file + '.tmp';
  try {
    const body = JSON.stringify({ ...obj, v: 2, savedAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, safeStorage.encryptString(body));
    if (safeStorage.decryptString(fs.readFileSync(tmp)) !== body) { fs.rmSync(tmp, { force: true }); return false; }
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    return false;
  }
}

/**
 * 게이트웨이(gateway.cjs)가 출입증 · 묶음을 보관하는 손잡이. 암호화를 못 쓰는 곳(맥 소스 실행 · DPAPI 고장)이면 null —
 * 그때 게이트웨이는 아예 쓰지 않는다(출입증을 못 남기면 켤 때마다 새로 등록하게 된다).
 *   read()          → 지금 내용(없으면 {}). 못 여는 파일이면 {} — 쓰면 새 파일이 된다.
 *   write(mutate)   → mutate(지금 내용) 을 쓰고 다시 열어 확인. 확인되면 true.
 */
function openVault({ safeStorage, userDataDir, platform = process.platform }) {
  if (platform !== 'win32' || !safeStorage || !safeStorage.isEncryptionAvailable()) return null;
  const file = path.join(userDataDir, FILE);
  return {
    read: () => readStore(safeStorage, file).obj,
    write: (mutate) => {
      const cur = readStore(safeStorage, file).obj;
      const next = mutate({ ...cur });
      return writeStoreVerified(safeStorage, file, next);
    },
  };
}

/**
 * HKCU\Environment 에서 지우고, 다른 프로그램(탐색기 등)이 알도록 WM_SETTINGCHANGE 를 한 번 보낸다.
 * 기다리지 않는다 — 브로드캐스트는 응답 없는 창이 있으면 몇 초 걸려서 앱 시작을 막으면 안 된다.
 * ★ detached 로 띄우면 안 된다. PowerShell 이 명령을 실행하지 않고 코드 0 으로 끝난다(2026-10-08 실측: 시험용 이름으로
 *   detached 세 가지 모두 안 지워짐, 붙여 띄우면 지워짐 — 802 시험 PC 에서 키가 안 사라진 원인). 붙여 띄워도 기다리지 않으면
 *   (unref) 앱 시작을 막지 않는다.
 * 실패해도 괜찮다: 환경변수가 남아 있으면 다음 실행 때 다시 지운다.
 * ASCII 만 쓴다 — 한국어 Windows 에서 명령 문자열에 한글이 섞이면 명령째 깨진다.
 */
function removeUserEnv(names, { wait = false } = {}) {
  const list = names.filter((n) => NAME_RE.test(n));
  if (list.length === 0) return null;
  const quoted = list.map((n) => `'${n}'`).join(',');
  const cmd =
    `$n=@(${quoted}); ` +
    `foreach($x in $n){ Remove-ItemProperty -Path 'HKCU:\\Environment' -Name $x -ErrorAction SilentlyContinue }; ` +
    // 이미 지운 이름으로 한 번 더 부르면 레지스트리는 그대로고 브로드캐스트만 나간다.
    `[Environment]::SetEnvironmentVariable($n[-1], $null, 'User')`;
  const { spawn } = require('child_process');
  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
    { stdio: 'ignore', windowsHide: true });
  if (!wait) child.unref();
  return child;
}

/**
 * 앱 시작 때 한 번. startServer() 가 서버를 띄우기 직전에 부른다.
 *   migrate=true  (설치본) 환경변수 → 암호 파일로 옮기고 환경변수를 지운다
 *   migrate=false (개발 모드) 암호 파일을 읽어 비어 있는 것만 채운다. 쓰지도 지우지도 않는다
 *                 — 개발자 PC 의 환경변수를 몰래 지우면 다른 스크립트가 같이 끊긴다
 * 반환값은 로그용 요약이다. 값은 절대 담지 않는다(이름 · 개수만).
 */
function loadSecrets({
  safeStorage, userDataDir, env = process.env, platform = process.platform,
  migrate = true, remove = removeUserEnv,
}) {
  const out = { loaded: [], migrated: [], removed: [], store: 'none', error: null };
  // 맥은 소스 실행(브라우저)이라 이 길을 안 탄다. Electron 맥 빌드가 생기면 safeStorage 가 Keychain 을 쓰므로
  // 이 조건만 풀면 된다 — 다만 지우는 쪽(reg)은 Windows 전용이다.
  if (platform !== 'win32') return out;
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) { out.error = 'encryption unavailable'; return out; }

  const file = path.join(userDataDir, FILE);
  const stored = readStore(safeStorage, file);
  out.store = stored.state;

  // 환경변수에 있는 진짜 값 = 더 새 값으로 본다. 팀 bat 을 다시 돌렸다는 뜻이다(키 교체 · 재설치).
  // 공용 키의 가짜값('managed-by-gateway')은 값으로 치지 않는다 — 보관해 둔 진짜 값을 덮으면 안 된다.
  const fromEnv = {};
  for (const k of ALL) if (realValue(env[k])) fromEnv[k] = env[k];
  const kept = {};
  for (const k of ALL) if (realValue(stored.keys[k])) kept[k] = stored.keys[k];

  if (!migrate) {
    for (const [k, v] of Object.entries(kept)) if (!realValue(env[k])) { env[k] = v; out.loaded.push(k); }
    return out;
  }

  const merged = { ...kept, ...fromEnv };
  const changedKeys = Object.keys(fromEnv).filter((k) => kept[k] !== fromEnv[k]);
  const changed = changedKeys.length > 0 || stored.state === 'unreadable';

  let safe;                    // 암호 파일에 지금 값이 확실히 들어 있나 — 이게 참일 때만 지운다
  if (Object.keys(merged).length === 0) safe = false;                 // 옮길 것도 읽을 것도 없음
  else if (changed) safe = writeStoreVerified(safeStorage, file, { ...stored.obj, keys: merged });   // gw(출입증)는 그대로
  else safe = stored.state === 'ok';                                  // 이미 같은 값이 들어 있음
  if (changed && safe) out.migrated = changedKeys;
  if (changed && !safe && Object.keys(merged).length) out.error = 'store write/verify failed';

  // 메모리에 올린다. 확인이 안 됐어도 이번 실행은 돌아야 하니 있는 값은 다 올린다.
  // 공용 키는 환경변수가 가짜값이면 보관해 둔 진짜 값으로 덮인다 — 서버는 process.env 에서 읽는다.
  for (const [k, v] of Object.entries(merged)) { env[k] = v; out.loaded.push(k); }

  if (safe) {
    // ★ 지우는 건 시댄스만 쓰는 KEYS 와 죽은 키뿐. SHARED 는 절대 안 지운다(다른 앱이 쓴다).
    const doomed = [...KEYS.filter((k) => fromEnv[k]), ...DEAD.filter((k) => env[k])];
    if (doomed.length) {
      remove(doomed);
      out.removed = doomed;
      // 이번 프로세스의 죽은 값도 치운다 — 옮긴 KEYS 는 서버가 써야 하니 남긴다.
      for (const k of DEAD) delete env[k];
    }
  }
  return out;
}

module.exports = { loadSecrets, openVault, removeUserEnv, KEYS, SHARED, DEAD, FILE };
