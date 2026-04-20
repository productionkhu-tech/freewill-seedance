const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  onDownloadStarted: (cb) => ipcRenderer.on('download-started', (_e, payload) => cb(payload)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, payload) => cb(payload)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (_e, payload) => cb(payload)),
});
