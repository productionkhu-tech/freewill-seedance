const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, Notification, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ─── Single Instance Lock ───
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); return; }

let mainWindow = null;
let tray = null;
let hiddenToTrayOnce = false;
const PORT = 3000;
const isDev = !app.isPackaged;

function getIconPath() {
  return isDev
    ? path.join(__dirname, 'icon.png')
    : path.join(process.resourcesPath, 'app.asar', 'electron', 'icon.png');
}

// ─── Server (runs inside Electron process, no external Node.js needed) ───
function startServer() {
  if (isDev) {
    // Dev mode: spawn tsx for hot reload
    const { spawn } = require('child_process');
    const proc = spawn('npx', ['tsx', 'server.ts'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, NODE_ENV: 'development' },
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
    const customName = pendingDownloads.get(url);
    if (customName) pendingDownloads.delete(url);
    const filename = customName || item.getFilename();
    const savePath = path.join(downloadsPath, filename);
    item.setSavePath(savePath);

    try { mainWindow?.webContents.send('download-started', { filename }); } catch {}
    item.on('updated', (_e, state) => {
      try { mainWindow?.webContents.send('download-progress', { filename, received: item.getReceivedBytes(), total: item.getTotalBytes(), state }); } catch {}
    });
    item.on('done', (_e, state) => {
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
}

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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Freewill Seedance 2.0', enabled: false },
    { type: 'separator' },
    { label: 'Open', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ─── Auto Updater ───
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Available',
      message: `New version available: v${info.version}`,
      detail: 'Downloading and restarting...',
      buttons: ['OK'],
    });
    autoUpdater.downloadUpdate();
  });

  autoUpdater.on('update-downloaded', () => {
    app.isQuitting = true;
    autoUpdater.quitAndInstall();
  });

  autoUpdater.on('error', (err) => console.error('[Updater]', err));

  if (!isDev) autoUpdater.checkForUpdates().catch(() => {});
}

// ─── Download folder (session-only) ───
// Holds the user-chosen download directory for the CURRENT app session only.
// null → fall back to the OS Downloads folder. Never persisted to disk, so a
// restart always returns to the default. Used by will-download + save-blob.
let sessionDownloadDir = null;

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
ipcMain.handle('save-blob', async (_e, { filename, buffer }) => {
  try {
    const dir = sessionDownloadDir || app.getPath('downloads');
    const savePath = path.join(dir, filename);
    fs.writeFileSync(savePath, Buffer.from(buffer));
    return { ok: true, path: savePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── IPC: direct downloads (bypass server proxy for speed) ───
const pendingDownloads = new Map(); // url → custom filename
ipcMain.handle('download', async (_e, { url, filename }) => {
  if (!mainWindow) return { ok: false, error: 'window not ready' };
  try {
    pendingDownloads.set(url, filename);
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
      // Sweep chunk files left over from a previously larger library.
      for (let i = total; i < total + 40; i++) {
        try { if (fs.existsSync(elementsChunkPath(i))) fs.unlinkSync(elementsChunkPath(i)); } catch {}
      }
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
    if (stateSize > STATE_RESTORE_MAX) {
      console.warn(`[Backup] ${path_} is ${(stateSize / 1048576).toFixed(0)}MB — too large to load safely; skipping restore.`);
      return { ok: true, content: null, stateSkipped: true, stateBytes: stateSize, path: path_ };
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
  startServer();
  createWindow();
  createTray();
  setupAutoUpdater();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('window-all-closed', () => {});
app.on('activate', () => { if (!mainWindow) createWindow(); else mainWindow.show(); });
