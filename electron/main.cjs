const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, Notification, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

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
    try {
      require(path.join(process.resourcesPath, 'server.cjs'));
      console.log('[Server] Started in production mode');
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
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
