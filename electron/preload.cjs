const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  download: (payload) => ipcRenderer.invoke('download', payload),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Opens the containing folder with the file selected. Returns { ok:false, reason:'missing' }
  // when the file was moved/deleted so the UI can say so instead of doing nothing.
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
  // Opens a FOLDER itself. Omit the argument to open the current download folder —
  // main resolves it, so this can't drift from where downloads actually land.
  openFolder: (dirPath) => ipcRenderer.invoke('open-folder', dirPath),
  // Electron 32+ removed File.path; webUtils.getPathForFile is the replacement.
  // Returns the absolute on-disk path of a File object so we can re-read the
  // original later if the server cache + tmpfiles URL are both gone.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  onDownloadStarted: (cb) => ipcRenderer.on('download-started', (_e, payload) => cb(payload)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, payload) => cb(payload)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (_e, payload) => cb(payload)),
  // 마우스 옆 버튼이 Windows '앱 명령'(browser-backward/forward)으로 오는 경우 — 프로젝트 뒤로/앞으로.
  // 해제 함수를 돌려준다(창이 새로 만들어질 때 겹쳐 쌓이지 않게).
  onAppCommand: (cb) => {
    const h = (_e, cmd) => cb(cmd);
    ipcRenderer.on('app-command', h);
    return () => ipcRenderer.removeListener('app-command', h);
  },
  // 창을 숨기거나 내렸다 · 절전 · 화면 잠금 · 윈도우 종료 — "지금 저장해"(26.10.701~). 화면의 visibilitychange 는
  // backgroundThrottling:false 라 오지 않아서 main 이 창 이벤트로 알려 준다(store.ts flushAll).
  onFlushRequest: (cb) => {
    const h = (_e, why) => cb(why);
    ipcRenderer.on('app-flush', h);
    return () => ipcRenderer.removeListener('app-flush', h);
  },
  // External backup mirror — Documents/Freewill Seedance Backup/seedance-backup.json
  // kind: 'state' (default, the work history — small, must never fail) | 'elements'
  backupSave: (content, kind) => ipcRenderer.invoke('backup-save', content, kind),
  // The library moves in chunks, never as one value: it is ~500MB and a single string
  // hits V8's 512MB ceiling, while a single IPC message of that size kills the renderer.
  backupSaveElementsChunk: (index, content, total, count) =>
    ipcRenderer.invoke('backup-save-elements-chunk', index, content, total, count),
  backupLoadElementsChunk: (index) => ipcRenderer.invoke('backup-load-elements-chunk', index),
  backupLoad: () => ipcRenderer.invoke('backup-load'),
  backupInfo: () => ipcRenderer.invoke('backup-info'),
  // Download folder (session-only — resets to OS Downloads on app restart)
  getDownloadDir: () => ipcRenderer.invoke('get-download-dir'),
  pickDownloadDir: () => ipcRenderer.invoke('pick-download-dir'),
  saveBlob: (payload) => ipcRenderer.invoke('save-blob', payload),
});
