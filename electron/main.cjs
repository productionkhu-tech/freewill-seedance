const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, Notification, shell, ipcMain, powerMonitor } = require('electron');
const { autoUpdater } = require('electron-updater');
// 업데이트 흐름(켤 때 · 트레이 · 켜 둔 동안). ★ electron-builder.yml files 에 이 파일이 있어야 한다.
const { createUpdater, BACKGROUND_EVERY_MS } = require('./updater.cjs');
const path = require('path');
const fs = require('fs');

// ─── Single Instance Lock ───
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); return; }

let mainWindow = null;
let tray = null;
let hiddenToTrayOnce = false;
// 3000 고정. SEEDANCE_PORT 는 격리 시험용(진짜 앱이 3000 을 쓰는 중에 같은 PC 에서 띄울 때)이다.
// 서버에는 아래 startServer 가 PORT 로 넘긴다 — PC 에 다른 프로그램용 PORT 환경변수가 있어도 창과 서버가 갈리지 않게.
const PORT = Number(process.env.SEEDANCE_PORT) || 3000;
const isDev = !app.isPackaged;

function getIconPath() {
  return isDev
    ? path.join(__dirname, 'icon.png')
    : path.join(process.resourcesPath, 'app.asar', 'electron', 'icon.png');
}

// ─── 키 (26.10.802~) ───
// 서버를 띄우기 전에 두 단계로 process.env 에 올린다 — 서버(server.ts · ncp.ts)는 거기서 읽는다.
//   ① secrets.cjs  팀 bat 이 setx 로 심은 평문 키를 이 PC · 이 계정만 여는 암호 파일로 옮기고 환경변수는 지운다
//   ② gateway.cjs  그 키로 만든 입장권으로 게이트웨이 출입증을 받고, 켤 때마다 키 · 주소 묶음을 받는다 —
//                  관리자가 Cloudflare 에서 값을 바꾸면 PC 는 다음 실행 때 새 값을 쓴다(팀 bat · PC 는 그대로)
// 둘 다 실패해도 예전처럼 환경변수로 돈다 — 이것 때문에 앱이 안 켜지면 안 된다.
let gateway = null;
let pcName = '';
// 이 PC 의 키 상태(값은 없다) — 키 확인 bat(F:\시댄스 '시댄스 키 확인')이 '앱이 지금 쓰는 팀' 을 보여 줄 때 읽는다.
// 환경변수에서 키가 지워진 뒤에는 그 PC 가 어느 팀으로 도는지 볼 곳이 여기와 게이트웨이 관리 화면뿐이다.
function writeKeyStatus(r) {
  try {
    const st = {
      app: app.getVersion(), at: new Date().toISOString(), pc: pcName,
      mode: (r && r.mode) || 'off',                       // gateway · cache · offline(bat 키) · revoked · off
      team: (r && r.team) || process.env.SEEDANCE_TEAM || '',
      label: (r && r.label) || process.env.SEEDANCE_TEAM_LABEL || '',
      rev: (r && r.rev) || '', switched: !!(r && r.switched), why: (r && r.why) || '',
    };
    fs.writeFileSync(path.join(app.getPath('userData'), 'key-status.json'), JSON.stringify(st, null, 1));
  } catch {}
}
async function prepareKeys() {
  const { safeStorage } = require('electron');
  const secrets = require('./secrets.cjs');
  try {
    const s = secrets.loadSecrets({
      safeStorage,
      userDataDir: app.getPath('userData'),
      migrate: !isDev,   // 개발 모드는 읽기만 — 개발자 PC 의 환경변수를 몰래 지우면 다른 스크립트가 같이 끊긴다
    });
    console.log(`[Secrets] store=${s.store} loaded=${s.loaded.length} migrated=${s.migrated.length} removed=${s.removed.length}${s.error ? ' error=' + s.error : ''}`);
  } catch (err) {
    console.error('[Secrets] skipped:', err && err.message);
  }
  // 격리 시험용 스위치 — 게이트웨이를 아예 거치지 않고 예전처럼 환경변수 키로 돈다(시험 PC 가 진짜 게이트웨이에 등록되지 않게).
  // SEEDANCE_GATEWAY_URL 을 막는 것으로는 안 된다: 옛 NCP 길(ncp.ts)도 그 주소를 쓴다.
  if (process.env.SEEDANCE_GATEWAY === 'off') { console.log('[Gateway] off (SEEDANCE_GATEWAY=off)'); writeKeyStatus({ mode: 'off' }); return { mode: 'off' }; }
  try {
    const os = require('os');
    let who = '';
    try { who = os.userInfo().username; } catch {}
    pcName = `${who ? who + '@' : ''}${os.hostname()}`.slice(0, 64);   // 관리 화면에서 어느 PC 인지
    gateway = require('./gateway.cjs').createGateway({
      vault: secrets.openVault({ safeStorage, userDataDir: app.getPath('userData') }),
      app: app.getVersion(),
      pc: pcName,
      log: (m) => console.log(m),
    });
    const r = await gateway.boot();
    console.log(`[Gateway] ${r.mode}${r.label ? ' · ' + r.label : ''}${r.rev ? ' · ' + r.rev : ''}${r.why ? ' · ' + r.why : ''}${r.switched ? ' · 팀 bat 바뀜' : ''}`);
    writeKeyStatus(r);
    // 서버가 BytePlus · R2 에서 '키가 틀렸다' 를 받으면 부른다(server.ts refreshKeys) — 설치본은 서버가 이 프로세스 안에서 돈다.
    globalThis.__seedanceGateway = { refresh: (reason) => gateway.refreshNow(reason).then((x) => { if (x && x.mode === 'gateway') writeKeyStatus(x); return x; }) };
    // 보관본으로 켠 뒤 뒤에서 받아 보니 끊겨 있었다 — 키는 이미 메모리에서 거뒀다(gateway.cjs). 알려만 준다.
    if (r.pending) r.pending.then((p) => { if (p && p.mode !== 'offline') writeKeyStatus(p); if (p && p.mode === 'revoked') notifyCut(); }).catch(() => {});
    return r;
  } catch (err) {
    console.error('[Gateway] skipped:', err && err.message);
    writeKeyStatus({ mode: 'off', why: 'error' });
    return { mode: 'off' };
  }
}

// 키가 없어 서버가 못 뜨는 경우 — 예전엔 서버가 process.exit(1) 로 앱째 조용히 꺼졌다(직원은 "안 켜져요" 밖에 못 한다).
// 무엇을 하면 되는지 말해 주고 끈다. 빈 문자열이면 문제없음.
function keysProblem(g) {
  const help = '\n\n팀 bat 을 실행한 뒤, 트레이 아이콘 → Quit 으로 앱을 완전히 끄고 시작 메뉴에서 다시 켜 주세요.';
  if (g && g.mode === 'revoked') return '이 PC 의 시댄스 출입증을 관리자가 끊었어요.\n관리자에게 문의해 주세요.';
  const why = (g && g.why) || '';
  if (!process.env.SEEDANCE_API_KEY) {
    if (why === 'network' || why === 'timeout') return '키를 받아 오지 못했어요. 인터넷 연결을 확인한 뒤 앱을 다시 켜 주세요.';
    if (/closed/.test(why)) return '새 PC 등록이 닫혀 있어요. 관리자에게 알려 주세요.';
    if (/ticket/.test(why)) return '팀 bat 의 키가 등록된 팀 키가 아니에요. 관리자에게 알려 주세요.';
    return '이 PC 에 시댄스 키가 없어요.' + help;
  }
  if (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_BUCKET) {
    return g && g.mode === 'gateway'
      ? '게이트웨이에 R2 설정이 빠져 있어요. 관리자에게 알려 주세요.'
      : 'R2 설정이 없어요.\n\nR2.bat 을 실행한 뒤, 트레이 아이콘 → Quit 으로 앱을 완전히 끄고 시작 메뉴에서 다시 켜 주세요.';
  }
  return '';
}

function notifyCut() {
  const msg = '이 PC 의 시댄스 출입증을 관리자가 끊었어요. 새 생성은 보낼 수 없습니다. 관리자에게 문의해 주세요.';
  try {
    if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Freewill Seedance 2.0', message: msg });
    else new Notification({ title: 'Freewill Seedance 2.0', body: msg }).show();
  } catch {}
}

// ─── Server (runs inside Electron process, no external Node.js needed) ───
async function startServer() {
  const g = await prepareKeys();
  if (!isDev) {
    const problem = keysProblem(g);
    if (problem) {
      dialog.showErrorBox('Freewill Seedance 2.0', problem);
      app.isQuitting = true;
      app.quit();
      return;
    }
  }
  if (isDev) {
    // Dev mode: spawn tsx for hot reload
    const { spawn } = require('child_process');
    const proc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: path.join(__dirname, '..'),
      // 백업 폴더는 아래 IPC 핸들러와 같은 곳이어야 한다(라이브러리 원본 백업을 서버가 쓴다).
      env: { ...process.env, NODE_ENV: 'development', SEEDANCE_BACKUP_DIR: BACKUP_DIR, PORT: String(PORT) },
      shell: true,
      stdio: 'pipe',
    });
    proc.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
    proc.stderr?.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));
    app.on('before-quit', () => proc.kill());
  } else {
    // Production: require server directly (no spawn, no external Node.js)
    process.chdir(process.resourcesPath);
    process.env.NODE_ENV = 'production';
    // Pin the media cache to userData so it survives auto-updates. The default
    // (process.cwd()/media-cache) lives inside resources/, which electron-updater
    // wipes on every install — that broke prompt-reuse for any reference older
    // than the most recent update.
    process.env.MEDIA_CACHE_DIR = path.join(app.getPath('userData'), 'media-cache');
    // 어셋 라이브러리 원본도 userData 에 — media-cache 와 달리 아무도 자동으로 지우지 않는 폴더다.
    process.env.ELEMENT_LIBRARY_DIR = path.join(app.getPath('userData'), 'element-library');
    // 서버가 쓰는 백업(라이브러리 원본 복사)을 IPC 백업과 같은 폴더로. 서버 혼자 두면 os.homedir()
    // 기준이라 Documents 가 OneDrive 로 옮겨진 PC 에서 두 곳으로 갈린다.
    process.env.SEEDANCE_BACKUP_DIR = BACKUP_DIR;
    process.env.PORT = String(PORT);
    try {
      require(path.join(process.resourcesPath, 'server.cjs'));
      console.log('[Server] Started in production mode, cache at', process.env.MEDIA_CACHE_DIR);
    } catch (err) {
      console.error('[Server] Failed to start:', err);
      dialog.showErrorBox('Server Error', err.message);
    }
  }
}

// ─── Window ───
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Freewill Seedance 2.0',
    icon: getIconPath(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      // 창을 최소화하거나 트레이로 숨겨도 화면의 타이머가 제 속도로 돈다(26.10.305~). 크롬은 숨은 창의
      // 타이머를 1분에 한 번까지 늦추는데, 그러면 에이전트 작업함(2초마다 들름)이 "화면 응답 없음" 이 되고
      // (2026-10-03 실제), 카드 폴링(10초)도 늦어져 트래커 보고 · NCP 보관이 밀린다.
      backgroundThrottling: false,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Auto-save downloads. Target folder = session-only override (sessionDownloadDir)
  // or the OS Downloads folder by default. The override resets to default every
  // time the app restarts (sessionDownloadDir is in-memory, never persisted).
  mainWindow.webContents.session.on('will-download', (event, item) => {
    const downloadsPath = sessionDownloadDir || app.getPath('downloads');
    const url = item.getURL();
    const pending = pendingDownloads.get(url);
    if (pending) pendingDownloads.delete(url);
    const filename = (pending && pending.filename) || item.getFilename();
    const savePath = path.join(downloadsPath, safeFileName(filename));   // 알림에는 받은 이름 그대로 — 렌더러가 그 이름으로 짝짓는다
    item.setSavePath(savePath);

    try { mainWindow?.webContents.send('download-started', { filename }); } catch {}
    item.on('updated', (_e, state) => {
      try { mainWindow?.webContents.send('download-progress', { filename, received: item.getReceivedBytes(), total: item.getTotalBytes(), state }); } catch {}
    });
    item.on('done', (_e, state) => {
      // 다 받았으면 '다 받음' 을 알리기 전에 생성 설정을 붙인다 — 알린 뒤에 붙이면 그 사이 파일을 연 사람은 설정 없는 영상을 본다.
      if (state === 'completed' && pending && pending.meta) embedSettings(savePath, pending.meta);
      // savePath rides along so the renderer can offer "폴더에서 보기" later. The
      // download folder is a session-only override, so resolving the path at click
      // time would break for anything downloaded before the folder was changed.
      try { mainWindow?.webContents.send('download-done', { filename, state, path: savePath }); } catch {}
    });
  });

  const waitForServer = () => {
    fetch(`http://localhost:${PORT}`)
      .then(() => mainWindow.loadURL(`http://localhost:${PORT}`))
      .catch(() => setTimeout(waitForServer, 500));
  };
  waitForServer();

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      tray?.displayBalloon({
        title: 'Freewill Seedance 2.0',
        content: 'Running in system tray. Double-click to reopen.',
        iconType: 'info',
      });
    }
  });

  // A renderer can die on its own — an out-of-memory kill is the realistic one here, since
  // the element library holds full-resolution images as base64 and a big collection is
  // hundreds of megabytes of decoded bitmap. Nothing watched for it, so the window stayed
  // blank or vanished while the process lived on holding the single-instance lock: the
  // app was then unopenable until Task Manager. Rebuild it instead.
  // `clean-exit` is the normal teardown during quit — leave that alone.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[Renderer] gone:', details?.reason, details?.exitCode);
    if (app.isQuitting || details?.reason === 'clean-exit') return;
    const m = lastRendererMem;
    crashLog(`renderer gone: ${details?.reason} (exit ${details?.exitCode})`
      + (m ? ` · 직전 메모리 ${m.priv || m.ws}MB, 최대 ${m.peak}MB (${Math.round((Date.now() - m.at) / 1000)}초 전 측정)` : '')
      + ' → 창을 새로 만듦');
    try { mainWindow?.destroy(); } catch { /* 이미 사라졌으면 그대로 진행 */ }
    mainWindow = null;
    createWindow();
  });

  // 마우스 옆 버튼(MB4/MB5)이 드라이버에 따라 마우스 이벤트가 아니라 앱 명령으로 온다 — 화면으로
  // 넘겨서 프로젝트 뒤로/앞으로에 쓴다(ChatArea). 마우스 이벤트로도 오면 두 번 오지만 괜찮다.
  mainWindow.on('app-command', (_e, cmd) => {
    if (cmd !== 'browser-backward' && cmd !== 'browser-forward') return;
    try { mainWindow?.webContents.send('app-command', cmd); } catch { /* 창이 닫히는 중 */ }
  });

  // 숨김(X 를 눌러 트레이로 · 트레이 메뉴) · 최소화 → 화면에 "지금 저장해"(requestFlush 주석).
  mainWindow.on('hide', () => requestFlush('hide'));
  mainWindow.on('minimize', () => requestFlush('minimize'));
  // 윈도우 종료 · 재시작 · 로그오프 직전. 시간이 거의 없지만 해 본다 — 2026-10-07 재부팅으로 그 세션의 작업이
  // 백업에 하나도 없었다(작업 기록 자체는 IDB 에 있었다).
  mainWindow.on('query-session-end', () => requestFlush('session-end'));
  mainWindow.on('session-end', () => requestFlush('session-end'));

  // 멈춤도 같이 남긴다 — 죽지는 않았는데 한참 응답이 없는 것도 "꺼졌다 켜졌다" 로 보인다.
  mainWindow.on('unresponsive', () => crashLog('window unresponsive'));
  mainWindow.on('responsive', () => crashLog('window responsive again'));

  // The page failing to load leaves a window that is present but empty, which reads as
  // "the app opened and did nothing". Retry the local server rather than sit on it.
  // -3 is ERR_ABORTED, which fires on ordinary in-app navigation.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || app.isQuitting) return;
    console.error('[Renderer] load failed:', code, desc, url);
    setTimeout(() => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.loadURL(`http://localhost:${PORT}`); }, 1000);
  });
}

// ─── "지금 저장해" (26.10.701~) ───────────────────────────────────────────────
// 작업 기록(IDB)과 문서 폴더 백업을 디바운스를 기다리지 않고 쓰라고 화면에 알린다(store.ts flushAll). 원래 화면이
// 스스로 visibilitychange 로 알았는데, backgroundThrottling:false(26.10.305~) 이후로는 오지 않는다 — 숨겨도
// 최소화해도 'visible' 그대로(실측, 이벤트 0개). 그 바람에 숨길 때 하던 백업이 2026-10-03 부터 조용히 멎어
// 있었다. 창 · 전원 이벤트는 throttling 과 상관없이 main 에 온다.
function requestFlush(why) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-flush', why); } catch { /* 창이 닫히는 중 */ }
}

// ─── 화면 프로세스가 죽은 기록 ──────────────────────────────────────────────
// 2026-09-28 "앱이 꺼졌다 켜진다" 는 렌더러가 죽고 위 핸들러가 창을 새로 만든 것이었다. 그런데 죽은
// 이유(details.reason)는 console 로만 나가서, 패키지 앱에서는 아무 데도 남지 않았다 — 원인을 정황
// (최대 5.5GB)으로만 말할 수 있었던 이유다. 이제 userData/crash.log 에 남긴다. updater.log 와 같은 모양.
const CRASH_LOG_MAX = 256 * 1024;
function crashLog(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'crash.log');
    try { if (fs.statSync(p).size > CRASH_LOG_MAX) fs.unlinkSync(p); } catch {}
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
  console.error('[Crash]', msg);
}
// 죽은 뒤에는 잴 수 없으므로 살아 있을 때 재 둔 값을 함께 남긴다(MB).
let lastRendererMem = null;
function sampleRendererMemory() {
  try {
    const pid = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getOSProcessId() : 0;
    const m = pid && app.getAppMetrics().find((p) => p.pid === pid);
    if (m && m.memory) {
      lastRendererMem = {
        at: Date.now(),
        ws: Math.round(m.memory.workingSetSize / 1024),
        peak: Math.round(m.memory.peakWorkingSetSize / 1024),
        priv: Math.round((m.memory.privateBytes || 0) / 1024),
      };
    }
  } catch {}
}
app.on('child-process-gone', (_e, d) => {
  if (!d || d.reason === 'clean-exit' || app.isQuitting) return;
  crashLog(`child gone: ${d.type}${d.name ? '/' + d.name : ''} ${d.reason} (exit ${d.exitCode})`);
});

// ─── Tray ───
function createTray() {
  let trayIcon;
  try {
    trayIcon = nativeImage.createFromPath(getIconPath()).resize({ width: 16, height: 16 });
  } catch {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('Freewill Seedance 2.0');
  refreshTrayMenu();
  tray.on('double-click', () => showOrCreateWindow());
}

// 트레이 메뉴는 업데이트 상태(확인 중 · 내려받는 중 % · 설치 준비됨)에 따라 다시 그린다(26.10.306~).
let updater = null;
function refreshTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Freewill Seedance 2.0 · v${app.getVersion()}`, enabled: false },
      { type: 'separator' },
      { label: 'Open', click: () => showOrCreateWindow() },
      ...(updater ? [updater.menuItem()] : []),
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ]));
  } catch (e) { console.warn('[Tray] menu failed:', e && e.message); }
}

// ─── The one way back to a window ────────────────────────────────────────────
// Every "bring the app up" path goes through here, and every one of them used to be
// `mainWindow?.show()` — a no-op when there is no window left.
//
// That is not hypothetical. `window-all-closed` is deliberately empty (closing hides to
// tray), so losing the window does NOT quit the app: the process stays alive holding the
// single-instance lock, every later launch quits on that lock, and the icon does nothing
// forever. The only cure was Task Manager. Reported 2026-08-13 as "the app won't open
// after updating"; the event log showed no crash of the installed build, which is exactly
// what this looks like — a live process with nothing to show.
function showOrCreateWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ─── Auto Updater ───

// 업데이트 로그를 파일로 남긴다. 예전에는 console 로만 나갔는데, 패키지된 앱의
// console 은 아무 데도 보이지 않는다 — "업데이트가 안 된다" 는 제보가 와도 확인할
// 방법이 없어서 업데이터 캐시 폴더를 뒤져야 했다. electron-log 를 새로 넣지 않는
// 것은 electron-builder.yml 의 files 가 명시 목록이라 의존성을 하나 더 붙이면
// 거기까지 같이 손봐야 하기 때문이다. 이 정도는 여기서 끝난다.
const UPDATER_LOG_MAX = 256 * 1024;
function updaterLog(level, ...args) {
  const line = `[${new Date().toISOString()}] ${level} ${args.map(a => (a && a.stack) || String(a)).join(' ')}\n`;
  try {
    const p = path.join(app.getPath('userData'), 'updater.log');
    // 무한히 자라지 않게. 넘치면 통째로 새로 시작한다 — 최근 것만 있으면 충분하다.
    try { if (fs.statSync(p).size > UPDATER_LOG_MAX) fs.unlinkSync(p); } catch {}
    fs.appendFileSync(p, line);
  } catch {}
  console.log('[Updater]', ...args);
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (...a) => updaterLog('INFO', ...a),
    warn: (...a) => updaterLog('WARN', ...a),
    error: (...a) => updaterLog('ERROR', ...a),
    debug: () => {},
  };

  // ★ 차등 다운로드를 끈다. 바뀐 블록만 받는 방식인데, 이 앱에서는 손해다.
  //   릴리스마다 app.asar(프론트엔드 + server.cjs)이 바뀌고 NSIS 가 전체를 압축하므로,
  //   소스 한 줄만 고쳐도 압축된 블록은 거의 다 달라진다. 맞는 블록이 없으니 조각내는
  //   비용만 낸다.
  //   측정(2026-09-07): 통짜 다운로드 10초(11MB/s) + 설치 21초 + 재기동 15초 = 46초인데
  //   실제 업데이트는 100초가 걸렸다. 111MB ÷ 64KB = 1,777 블록이고 range 요청 왕복이
  //   0.05초라, 조각내는 데만 수십 초가 든다. 끄면 그 시간이 사라진다.
  autoUpdater.disableDifferentialDownload = true;

  // 이벤트 처리는 updater.cjs 한 곳에서(켤 때 · 트레이 · 켜 둔 동안). 여기서는 화면에 닿는 것만 넘긴다.
  updater = createUpdater({
    autoUpdater, isDev, currentVersion: app.getVersion(),
    log: (...a) => updaterLog('INFO', ...a),
    notify: (title, body) => { try { new Notification({ title, body }).show(); } catch { /* 알림이 막혀 있어도 진행 */ } },
    // 켤 때 안내. 앞으로 벌어질 일을 전부 미리 말한다. 예전 문구('Downloading and restarting')는
    // 140MB 를 받는 동안의 침묵도, 앱이 꺼졌다 켜지는 것도 설명하지 않았다. 그래서
    // 확인을 누른 사람은 한참 기다리다 앱이 툭 꺼지는 것만 보게 된다.
    showLaunchDialog: (version) => {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트',
        message: `새 버전 v${version} 을 설치합니다.`,
        detail: '지금부터 약 140MB 를 내려받습니다(보통 1분 안팎).\n'
          + '진행률은 작업표시줄 아이콘과 창 제목에 표시됩니다.\n\n'
          + '다 받으면 앱이 스스로 꺼졌다가 자동으로 다시 켜집니다.\n'
          + '설치 창은 뜨지 않습니다 — 잠시 꺼져 있어도 정상입니다.',
        buttons: ['확인'],
      }).catch(() => {});
    },
    // 내려받는 동안 아무 표시가 없으면 멈춘 것과 구분이 안 된다. 창을 새로 만들지 않고
    // 이미 있는 두 곳에 띄운다 — 작업표시줄 아이콘의 진행 막대와 창 제목.
    setWindowProgress: (percent) => {
      const pct = Math.round(percent);
      console.log(`[Updater] ${pct}%`);
      try {
        mainWindow?.setProgressBar(Math.max(0, Math.min(1, percent / 100)));
        mainWindow?.setTitle(`업데이트 내려받는 중 ${pct}% — Freewill Seedance 2.0`);
      } catch { /* 창이 이미 닫혔으면 표시할 곳도 없다 */ }
    },
    // ★ 설치는 updater.cjs 가 quitAndInstall(true, true) 로 한다 — 조용히 설치하고 끝나면 다시 띄운다.
    // 인자 없이 부르면 안 된다. quitAndInstall() 의 기본값은 isSilent=false 이고, 이 앱의 NSIS 는
    // oneClick:false — 그래서 업데이트할 때마다 앱이 먼저 종료된 뒤 "설치 마법사 창"이 떴다. 그 창이 다른
    // 창 뒤에 가리면 사용자가 보는 것은 트레이에도 작업관리자에도 없는 사라진 앱뿐이고, 아이콘을 눌러도
    // 설치 중이라 뜨지 않는다. 2026-08-13 팀에서 "업데이트하니까 앱이 안 켜진다"로 보고된 것이 이것이다.
    // isSilent=true 면 /S 로 설치하고, isForceRunAfter=true 가 --force-run 을 붙여 설치 후 자동 실행한다.
    // 진행 막대를 끄고, 꺼지기 직전에 한 번 더 알린다 — 없앤 것은 마법사 창이지 설명이 아니다.
    beforeInstall: () => {
      app.isQuitting = true;
      try {
        mainWindow?.setProgressBar(-1);
        mainWindow?.setTitle('업데이트 설치 중 — 곧 자동으로 다시 켜집니다');
        new Notification({ title: '업데이트 설치 중', body: '앱이 잠시 꺼집니다. 설치가 끝나면 자동으로 다시 켜집니다.' }).show();
      } catch { /* 알림이 막혀 있어도 설치는 진행한다 */ }
    },
    onChange: refreshTrayMenu,
  });
  refreshTrayMenu();

  if (!isDev) {
    updater.check('launch');
    // 켜 둔 채로 일하는 PC 도 새 버전을 받게 — 3시간마다 조용히 받아 두기만 한다(다시 시작은 트레이에서 또는 끌 때).
    const t = setInterval(() => updater.check('background'), BACKGROUND_EVERY_MS);
    if (t && typeof t.unref === 'function') t.unref();
  }
}

// ─── Download folder (session-only) ───
// Holds the user-chosen download directory for the CURRENT app session only.
// null → fall back to the OS Downloads folder. Never persisted to disk, so a
// restart always returns to the default. Used by will-download + save-blob.
let sessionDownloadDir = null;

// 저장할 파일 이름 — 렌더러가 준 이름에서 폴더 부분과 윈도우가 못 쓰는 글자를 뺀다(26.10.801 검토: '..\' 가 섞이면 받는 폴더
// 밖에 쓸 수 있었고, ':' 는 NTFS 에서 숨은 스트림이 된다). 지금 이름은 태스크 ID 라 바뀌는 일이 없다 — 막는 것은 이상한 이름이다.
function safeFileName(name) {
  let s = path.basename(String(name || '').replace(/\\/g, '/'));
  s = s.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s)) s = '_' + s;
  return s.slice(-200) || 'download';
}

ipcMain.handle('get-download-dir', async () => {
  return {
    dir: sessionDownloadDir || app.getPath('downloads'),
    isDefault: !sessionDownloadDir,
  };
});

ipcMain.handle('pick-download-dir', async () => {
  if (!mainWindow) return { ok: false, error: 'window not ready' };
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '다운로드 폴더 선택',
      defaultPath: sessionDownloadDir || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    sessionDownloadDir = result.filePaths[0];
    return { ok: true, dir: sessionDownloadDir };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Write an in-memory blob (blobCache fast-path download) straight to the
// session download folder. Without this, blobCache hits would go to the
// browser's default folder via <a download>, bypassing the chosen folder.
ipcMain.handle('save-blob', async (_e, { filename, buffer, meta }) => {
  try {
    const dir = sessionDownloadDir || app.getPath('downloads');
    const savePath = path.join(dir, safeFileName(filename));
    fs.writeFileSync(savePath, Buffer.from(buffer));
    // 받은 영상이면 생성 설정을 넣는다(아래 '받은 영상에 생성 설정 넣기').
    if (meta) embedSettings(savePath, meta);
    return { ok: true, path: savePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── 받은 영상에 생성 설정 넣기 (26.10.801~) ───
// ComfyUI 가 PNG 에 워크플로를 넣듯, 앱에서 받은 영상 끝에 그 영상을 만든 설정을 넣는다 — 맨 끝 top-level free 상자
// [크기 4][free][FWSD][판 1바이트 = 2][IV 12][암호문 + 태그 16]. 모양 · 읽는 쪽은 src/lib/settings-box.ts.
// ★ 탐색기에는 아무것도 안 보인다(사용자 결정 2026-10-08 — 광고주에게 영상을 넘기면 프롬프트 · 설정이 다 보이는 건 보안상
//   안 된다). 그래서 탐색기 칸(ilst ©nam · ©cmt, Xtra 태그)은 쓰지 않고, 상자 안 JSON 도 이 앱만 아는 열쇠로 AES-256-GCM 암호화한다
//   — 메모장 · 헥스 뷰어 · 일반 메타데이터 도구로는 안 읽히고, 이 앱에 끌어다 놓아야 보인다. (앱을 뜯어 열쇠를 꺼내는 사람까지
//   막지는 못한다 — 막으려는 것은 받는 쪽이 우연히 · 손쉽게 보는 것이다.)
// moov · mdat 은 한 바이트도 안 건드리고 끝에 붙이기만 한다 — BytePlus · 구글 영상의 C2PA 증명서(AI 생성 표시)도 그대로 유효하다
// (c2patool 실측: 끝의 free 상자는 증명서 지문에서 빠지는 칸). 이미 우리 상자가 끝에 있으면(다시 받기) 그것만 바꾼다.
// top-level 상자가 처음부터 끝까지 맞아떨어지는 영상에만 손댄다 — 덜 받았거나 다른 형식이면 그대로 둔다.
const BMFF_TOP = new Set(['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'uuid', 'pnot', 'meta', 'moof', 'mfra', 'sidx', 'styp', 'pdin']);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const mkBox = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
// 열쇠는 src/lib/settings-box.ts 의 SETTINGS_KEY_HEX 와 같아야 한다(바꾸면 그 전에 받은 영상은 못 읽는다).
const SETTINGS_KEY = Buffer.from('1a124b2cd9f9effdd942e3f8dc661d9f77c6ce9ec23bbf51d881a2e210ef226a', 'hex');
const SETTINGS_BOX_VERSION = 2;   // 1 = 암호화 전 시험판(평문 JSON, 배포된 적 없음) · 2 = AES-256-GCM
function settingsBox(meta) {
  const iv = require('crypto').randomBytes(12);
  const c = require('crypto').createCipheriv('aes-256-gcm', SETTINGS_KEY, iv);
  const sealed = Buffer.concat([c.update(Buffer.from(JSON.stringify(meta), 'utf8')), c.final(), c.getAuthTag()]);   // WebCrypto 와 같은 순서(암호문 뒤에 태그)
  return mkBox('free', Buffer.from('FWSD', 'latin1'), Buffer.from([SETTINGS_BOX_VERSION]), iv, sealed);
}
// 상자 목록. 처음부터 끝까지 맞아떨어지지 않으면 null. 크기 0(파일 끝까지) 상자는 toEnd 로 표시한다.
function topBoxes(readAt, size) {
  const out = []; let pos = 0;
  while (pos < size) {
    if (pos + 8 > size || out.length > 4096) return null;
    const h = Buffer.alloc(16);
    readAt(pos, 16).copy(h);
    let len = h.readUInt32BE(0), hl = 8, toEnd = false;
    const type = h.toString('latin1', 4, 8);
    if (!BMFF_TOP.has(type)) return null;
    if (len === 1) { len = Number(h.readBigUInt64BE(8)); hl = 16; } else if (len === 0) { len = size - pos; toEnd = true; }
    if (len < hl) return null;
    out.push({ type, pos, len, hl, toEnd });
    pos += len;
  }
  return pos === size ? out : null;
}
function embedSettings(filePath, meta) {
  try {
    const fd = fs.openSync(filePath, 'r+');
    try {
      const size = fs.fstatSync(fd).size;
      const readAt = (at, n) => { const b = Buffer.alloc(n); const r = fs.readSync(fd, b, 0, n, at); return b.subarray(0, r); };
      const boxes = topBoxes(readAt, size);
      if (!boxes) { console.warn('[Settings] 영상 형식이 아니라 설정을 넣지 않음:', filePath); return false; }
      // 크기 0(파일 끝까지) 상자 뒤에 붙이면 우리 상자가 그 상자 속으로 들어가 버린다 — 그 상자가 커져 증명서도 깨지고 읽을 수도 없다.
      if (boxes.some(b => b.toEnd)) { console.warn('[Settings] 끝까지 가는 상자가 있어 설정을 넣지 않음:', filePath); return false; }
      // 끝에 이미 우리 상자가 있으면 그 자리부터 새로 쓴다(남의 free 상자는 그대로 둔다).
      let cut = size;
      for (let i = boxes.length - 1; i >= 0; i--) {
        const b = boxes[i];
        if (b.type !== 'free' || readAt(b.pos + b.hl, 4).toString('latin1') !== 'FWSD') break;
        cut = b.pos;
      }
      const out = settingsBox(meta);
      fs.ftruncateSync(fd, cut);
      fs.writeSync(fd, out, 0, out.length, cut);
      return true;
    } finally { fs.closeSync(fd); }
  } catch (e) {
    console.warn('[Settings] 설정 넣기 실패:', e && e.message);
    return false;
  }
}

// ─── IPC: direct downloads (bypass server proxy for speed) ───
const pendingDownloads = new Map(); // url → { filename, meta? } — meta 는 받은 뒤 영상 끝에 넣을 생성 설정
ipcMain.handle('download', async (_e, { url, filename, meta }) => {
  if (!mainWindow) return { ok: false, error: 'window not ready' };
  try {
    pendingDownloads.set(url, { filename, meta });
    mainWindow.webContents.downloadURL(url);
    return { ok: true };
  } catch (err) {
    pendingDownloads.delete(url);
    return { ok: false, error: err.message };
  }
});

// ─── IPC: cache management ───
ipcMain.handle('clear-cache', async () => {
  if (!mainWindow) return { ok: false, error: 'window not ready' };
  try {
    await mainWindow.webContents.session.clearCache();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-cache-size', async () => {
  if (!mainWindow) return { size: 0 };
  try {
    const size = await mainWindow.webContents.session.getCacheSize();
    return { size };
  } catch (err) {
    return { size: 0, error: err.message };
  }
});

// ─── IPC: store backup to user's Documents folder ───
// IndexedDB lives in userData/, which has historically vanished in edge cases
// (rename of app `name`, uninstall+reinstall, AppData cleaners). Mirror the
// entire persisted state to Documents/ — outside userData — so it survives any
// of those. Restore on app start if IDB is empty.
// ★ Do NOT rename this to match the new app name. Every existing user already has a
// backup sitting in this exact folder; renaming would point the restore path at an empty
// directory and quietly orphan the only copy of their data that lives outside userData.
const BACKUP_DIR = path.join(app.getPath('documents'), 'Freewill Seedance Backup');
const BACKUP_PATH = path.join(BACKUP_DIR, 'seedance-backup.json');
// ★ The library is backed up SEPARATELY, and that split is not cosmetic — it is the fix
// for a silent, total backup failure.
// The old code mirrored state+library as ONE JSON string. Once the library passed ~500MB
// that string exceeded V8's hard 512MB single-string ceiling and JSON.stringify threw
// `RangeError: Invalid string length` — synchronously, inside a setTimeout, so the
// promise .catch never saw it. Backups just stopped, with no error anywhere the user
// could see. Measured on real data: 19.4MB state + 505.9MB library = 525.3MB > 512MB.
// Split, the state file is ~19MB and can never be dragged down by the library again.
const ELEMENTS_BACKUP_PATH = path.join(BACKUP_DIR, 'seedance-elements.json');
// One-time safety net for the format change: the existing combined file is archived
// before it is first replaced by the smaller state-only one, so the switch itself can
// never be the thing that loses a library.
const LEGACY_COMBINED_PATH = path.join(BACKUP_DIR, 'seedance-backup-combined-legacy.json');
// Ceiling for auto-restoring the library at startup. Measured the hard way: a 506MB
// library sent over IPC → IDB → JSON.parse during boot crashed the renderer before the
// app could serve its first page. Restoring the work history must never depend on the
// library fitting, so anything above this is left on disk instead of attempted.
const ELEMENTS_RESTORE_MAX = 150 * 1024 * 1024;
// Same ceiling for the state file. Normally ~19MB so it never applies — it exists for the
// pre-split legacy fallback, which bundles the library and can be half a gigabyte.
const STATE_RESTORE_MAX = 150 * 1024 * 1024;
// 상태 전용 백업이 이보다 크면 IPC 로 한 덩어리를 넘기지 않는다 — 렌더러가 서버(같은 백업 폴더)에서 프로젝트를
// 하나씩 받아 붙인다(26.10.202~, server.ts state-outline). 크기 때문에 복원을 건너뛰는 일이 없다.
const STATE_SINGLE_MAX = 64 * 1024 * 1024;

function writeAtomic(target, content) {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);   // atomic: a power cut can't leave a half-written backup
}

// ★ Shrink guard. This file has TWO writers — the packaged app over IPC (here) and a
// browser at localhost:3000 over HTTP (server.ts) — and they share one path. A browser
// profile carries its OWN IndexedDB, so an empty one is a perfectly valid writer that
// replaces the whole work history with a fresh-install state. Measured 2026-08-03:
// 19.54MB of 18 projects / 503 messages became a 440-byte single test project. The
// restore-on-empty path does not save you, because it only runs when IDB is empty —
// a profile holding a tiny stale state skips it and then overwrites.
// Archive rather than refuse: legitimate shrinkage exists (deleting old projects is
// exactly what the size-limit toast tells users to do), so refusing would block the
// one recovery action we recommend. Keep the old copy, take the new one.
// Deliberately state-only. The library has its own gate (_elementsHydrated) and a
// manifest-last protocol, and its chunks shrink legitimately all the time.
const SHRINK_FLOOR = 1 * 1024 * 1024;   // under 1MB there is nothing worth preserving
const SHRINK_RATIO = 0.5;               // losing half in one write is not a normal edit
const AUTOPREV_KEEP = 3;                // rolling; each copy is ~19MB
function guardShrink(target, content) {
  try {
    if (!fs.existsSync(target)) return;
    const oldSize = fs.statSync(target).size;
    if (oldSize < SHRINK_FLOOR) return;
    if (content.length >= oldSize * SHRINK_RATIO) return;
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    // Distinct prefix so the prune below can only ever delete copies this guard made,
    // never a backup a human parked in the folder by hand.
    fs.copyFileSync(target, target.replace(/\.json$/, `.AUTOPREV-${stamp}.json`));
    console.warn(`[Backup] shrink guard: ${(oldSize / 1048576).toFixed(2)}MB → ${(content.length / 1048576).toFixed(2)}MB — previous copy kept`);
    const base = path.basename(target).replace(/\.json$/, '');
    const olds = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith(`${base}.AUTOPREV-`) && f.endsWith('.json'))
      .sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - AUTOPREV_KEEP))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {}
    }
  } catch {}
}

ipcMain.handle('backup-save', async (_e, content, kind) => {
  try {
    if (typeof content !== 'string' || content.length === 0) return { ok: false, error: 'empty content' };
    const target = kind === 'elements' ? ELEMENTS_BACKUP_PATH : BACKUP_PATH;
    if (kind !== 'elements' && fs.existsSync(BACKUP_PATH) && !fs.existsSync(LEGACY_COMBINED_PATH)) {
      // First state-only write on this machine. Whatever is there now predates the split
      // and may be the only copy of the library — move it aside instead of over it.
      try { fs.renameSync(BACKUP_PATH, LEGACY_COMBINED_PATH); } catch {}
    }
    // After the legacy rename: if that fired, BACKUP_PATH is gone and this is a no-op.
    if (kind !== 'elements') guardShrink(target, content);
    writeAtomic(target, content);
    return { ok: true, path: target, bytes: content.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── Library backup, in chunks ────────────────────────────────────────────────
// One file per chunk plus a manifest. The library outgrew every "just send the whole
// thing" approach: a single string dies at V8's 512MB limit, and shipping half a gigabyte
// through IPC in one message killed the renderer at startup. Per-chunk files mean neither
// side ever holds more than ~32MB at once, so the library can grow without limit.
const ELEMENTS_MANIFEST_PATH = path.join(BACKUP_DIR, 'seedance-elements-manifest.json');
const elementsChunkPath = (i) => path.join(BACKUP_DIR, `seedance-elements-${String(i).padStart(3, '0')}.json`);

ipcMain.handle('backup-save-elements-chunk', async (_e, index, content, total, count) => {
  try {
    if (typeof content !== 'string') return { ok: false, error: 'bad chunk' };
    writeAtomic(elementsChunkPath(index), content);
    if (index === total - 1) {
      // Manifest last — until it lands, a partial run is simply not a valid backup.
      writeAtomic(ELEMENTS_MANIFEST_PATH, JSON.stringify({ v: 2, chunks: total, count, savedAt: Date.now() }));
      // Sweep chunk files left over from a previously larger library — ALL of them, not just
      // the next 40: 26.9.3001 의 원본 옮기기는 53조각 → 1조각으로 한 번에 줄인다(server.ts 도 같다).
      try {
        for (const f of fs.readdirSync(BACKUP_DIR)) {
          const m = /^seedance-elements-(\d{3,})\.json$/.exec(f);
          if (m && Number(m[1]) >= total) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch {} }
        }
      } catch {}
      // The old single-file library backup is now redundant (~500MB reclaimed).
      try { if (fs.existsSync(ELEMENTS_BACKUP_PATH)) fs.unlinkSync(ELEMENTS_BACKUP_PATH); } catch {}
    }
    return { ok: true, bytes: content.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup-load-elements-chunk', async (_e, index) => {
  try {
    const f = elementsChunkPath(index);
    if (!fs.existsSync(f)) return { ok: false, error: 'missing' };
    return { ok: true, content: fs.readFileSync(f, 'utf8') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Returns the state blob plus, separately, the library — the caller reattaches them.
// Falls back to the archived combined file if the state file is missing, so a machine
// that never completed a new-format write still restores.
ipcMain.handle('backup-load', async () => {
  try {
    let path_ = BACKUP_PATH;
    if (!fs.existsSync(path_)) path_ = LEGACY_COMBINED_PATH;
    if (!fs.existsSync(path_)) return { ok: true, content: null };
    // ★ The legacy fallback needs the same size guard as the library.
    // A pre-split backup is state AND library in one file (~509MB here). Reading that
    // whole thing and handing it to the renderer at startup is precisely what crashed
    // the app before — the fact that it holds the work history doesn't make it safe to
    // load. Better to boot empty and say so than to die on launch every time.
    const stateSize = fs.statSync(path_).size;
    if (path_ === BACKUP_PATH && stateSize > STATE_SINGLE_MAX) {
      let elementsChunks = 0, elementsCount = 0;
      try { const man = JSON.parse(fs.readFileSync(ELEMENTS_MANIFEST_PATH, 'utf8')); if (man && man.chunks > 0) { elementsChunks = man.chunks; elementsCount = man.count || 0; } } catch {}
      return { ok: true, content: null, stateSkipped: true, pieces: true, stateBytes: stateSize, path: path_, elementsChunks, elementsCount };
    }
    if (stateSize > STATE_RESTORE_MAX) {
      console.warn(`[Backup] ${path_} is ${(stateSize / 1048576).toFixed(0)}MB — too large to load safely; skipping restore.`);
      // 상태는 못 넘겨도 어셋 목록은 조각이라 넘길 수 있다 — 클라이언트가 따로 되살린다(26.10.201~).
      let elementsChunks = 0, elementsCount = 0;
      try { const man = JSON.parse(fs.readFileSync(ELEMENTS_MANIFEST_PATH, 'utf8')); if (man && man.chunks > 0) { elementsChunks = man.chunks; elementsCount = man.count || 0; } } catch {}
      return { ok: true, content: null, stateSkipped: true, stateBytes: stateSize, path: path_, elementsChunks, elementsCount };
    }
    const content = fs.readFileSync(path_, 'utf8');
    // ★ The library is only handed over when it is SMALL ENOUGH TO SURVIVE THE TRIP.
    // Pushing a ~500MB string through IPC, then into IDB, then parsing it — all during
    // startup — kills the renderer outright: verified, the app died before it could even
    // serve a page. So its size is checked on disk first and the bytes are never read
    // into memory unless they fit. The work history (~19MB) is what must never be lost,
    // and it restores either way; the library file stays on disk for a deliberate restore.
    // Chunked library (v2) is reported as a COUNT, not content — the renderer pulls the
    // pieces one at a time. Only the old single-file form is still size-gated, because
    // that one has to arrive in a single message or not at all.
    let elementsChunks = 0, elementsCount = 0;
    try {
      if (fs.existsSync(ELEMENTS_MANIFEST_PATH)) {
        const man = JSON.parse(fs.readFileSync(ELEMENTS_MANIFEST_PATH, 'utf8'));
        if (man && man.chunks > 0) { elementsChunks = man.chunks; elementsCount = man.count || 0; }
      }
    } catch (e) {
      console.warn('[Backup] elements manifest unreadable:', e.message);
    }
    let elements = null, elementsBytes = 0, elementsSkipped = false;
    if (!elementsChunks) {
      try {
        if (fs.existsSync(ELEMENTS_BACKUP_PATH)) {
          elementsBytes = fs.statSync(ELEMENTS_BACKUP_PATH).size;
          if (elementsBytes <= ELEMENTS_RESTORE_MAX) elements = fs.readFileSync(ELEMENTS_BACKUP_PATH, 'utf8');
          else elementsSkipped = true;
        }
      } catch (e) {
        // A damaged library backup must not block restoring the work history.
        console.warn('[Backup] elements file unreadable:', e.message);
      }
    }
    return { ok: true, content, elements, elementsBytes, elementsSkipped, elementsChunks, elementsCount,
             elementsPath: ELEMENTS_BACKUP_PATH, path: path_, bytes: content.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup-info', async () => {
  try {
    if (!fs.existsSync(BACKUP_PATH)) return { exists: false, path: BACKUP_PATH };
    const stat = fs.statSync(BACKUP_PATH);
    return { exists: true, path: BACKUP_PATH, bytes: stat.size, mtime: stat.mtimeMs };
  } catch (err) {
    return { exists: false, error: err.message };
  }
});

// ─── IPC: open external URL in the system default browser ───
// Used for the credit dashboard button so the GAS web app opens in Chrome/Edge,
// not in a new Electron window. Validates http/https only to prevent abuse.
ipcMain.handle('open-external', async (_event, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { ok: false, error: 'invalid url' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── IPC: reveal a downloaded file in the OS file manager ───
// shell.showItemInFolder opens the containing folder WITH the file selected, which is
// the whole point — the user wants to see which clip this was. It fails silently when
// the file is gone (moved/renamed/deleted/emptied trash), so check first and report
// back instead, letting the UI say so rather than looking like a dead button.
// Open a DIRECTORY itself. Distinct from reveal-file, which selects a FILE inside its
// folder — pointing showItemInFolder at a directory opens the PARENT with the directory
// highlighted, which is not what "go to my download folder" means.
// No argument → the session download folder, resolved here so the renderer can't drift
// out of sync with the folder main is actually saving to.
ipcMain.handle('open-folder', async (_event, dirPath) => {
  const target = (typeof dirPath === 'string' && dirPath) ? dirPath : (sessionDownloadDir || app.getPath('downloads'));
  try {
    if (!fs.existsSync(target)) return { ok: false, reason: 'missing', path: target };
    const err = await shell.openPath(target); // returns '' on success, message on failure
    return err ? { ok: false, reason: 'error', error: err } : { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }
});

ipcMain.handle('reveal-file', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return { ok: false, reason: 'nopath' };
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' };
    shell.showItemInFolder(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'error', error: err.message };
  }
});

// ─── App Lifecycle ───
app.on('ready', () => {
  // 처음 켜는 PC 만 게이트웨이에서 키를 받을 때까지 기다린다(보관본이 있으면 바로). 창은 그동안 서버를 기다린다.
  startServer().catch((err) => console.error('[Server] start failed:', err));
  createWindow();
  createTray();
  setupAutoUpdater();
  setInterval(sampleRendererMemory, 30 * 1000);   // crash.log 에 남길 직전 메모리
  // 절전 · 화면 잠금 — 창을 띄운 채로 자리를 비우는 순간이다. 깨어나지 못하는 경우까지 생각해 그 전에 쓴다.
  powerMonitor.on('suspend', () => requestFlush('suspend'));
  powerMonitor.on('lock-screen', () => requestFlush('lock'));
});

// Launching again while an instance holds the lock must ALWAYS put a window on screen —
// creating one if the old one is gone. Before this it silently did nothing in exactly the
// case where the user is clicking the icon because they see nothing.
app.on('second-instance', () => showOrCreateWindow());

app.on('window-all-closed', () => {});
app.on('activate', () => showOrCreateWindow());
