const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  download: (payload) => ipcRenderer.invoke('download', payload),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // Electron 32+ removed File.path; webUtils.getPathForFile is the replacement.
  // Returns the absolute on-disk path of a File object so we can re-read the
  // original later if the server cache + tmpfiles URL are both gone.
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ''; } catch { return ''; }
  },
  onDownloadStarted: (cb) => ipcRenderer.on('download-started', (_e, payload) => cb(payload)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, payload) => cb(payload)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (_e, payload) => cb(payload)),
});
