const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');

// ─── Single Instance Lock ───
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) { app.quit(); return; }

let mainWindow = null;
let tray = null;
let serverProcess = null;
let hiddenToTrayOnce = false; // only show tray notification once
const PORT = 3000;
const isDev = !app.isPackaged;

function getIconPath() {
  return isDev
    ? path.join(__dirname, 'icon.png')
    : path.join(process.resourcesPath, 'app.asar', 'electron', 'icon.png');
}

// ─── Server ───
function startServer() {
  const serverPath = isDev
    ? path.join(__dirname, '..', 'server.ts')
    : path.join(process.resourcesPath, 'server.cjs');

  const cmd = isDev ? 'npx' : 'node';
  const args = isDev ? ['tsx', serverPath] : [serverPath];

  serverProcess = spawn(cmd, args, {
    cwd: isDev ? path.join(__dirname, '..') : process.resourcesPath,
    env: { ...process.env, NODE_ENV: isDev ? 'development' : 'production' },
    shell: true,
    stdio: 'pipe',
  });

  serverProcess.stdout?.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
  serverProcess.stderr?.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));
  serverProcess.on('error', (err) => console.error('[Server] Failed to start:', err));
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Wait for server to be ready
  const waitForServer = () => {
    fetch(`http://localhost:${PORT}`)
      .then(() => mainWindow.loadURL(`http://localhost:${PORT}`))
      .catch(() => setTimeout(waitForServer, 500));
  };
  waitForServer();

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();

      // Show tray notification only the first time
      if (!hiddenToTrayOnce) {
        hiddenToTrayOnce = true;
        new Notification({
          title: 'Freewill Seedance 2.0',
          body: '트레이에서 실행 중입니다. 더블클릭하여 다시 열 수 있습니다.',
          icon: getIconPath(),
        }).show();
      }
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

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Freewill Seedance 2.0', enabled: false },
    { type: 'separator' },
    {
      label: '창 열기',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    },
  ]);

  tray.setToolTip('Freewill Seedance 2.0');
  tray.setContextMenu(contextMenu);

  // Double-click tray icon → show window
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ─── Auto Updater ───
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 알림',
      message: `새 버전이 있습니다! (v${info.version})`,
      detail: '백그라운드에서 다운로드를 시작합니다.',
      buttons: ['업데이트', '나중에'],
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '업데이트 준비 완료',
      message: '업데이트가 다운로드되었습니다. 지금 재시작하시겠습니까?',
      buttons: ['재시작', '나중에'],
    }).then(({ response }) => {
      if (response === 0) {
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
      }
    });
  });

  autoUpdater.on('error', (err) => console.error('[Updater] Error:', err));

  if (!isDev) {
    autoUpdater.checkForUpdates().catch(() => {});
  }
}

// ─── App Lifecycle ───
app.on('ready', () => {
  startServer();
  createWindow();
  createTray();
  setupAutoUpdater();
});

// EXE 두 번째 실행 시 → 기존 창 포커스
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

// 창 닫혀도 앱 종료 안 함 (트레이 유지)
app.on('window-all-closed', () => {});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});
