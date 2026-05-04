const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  download: (payload) => ipcRenderer.invoke('download', payload),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  onDownloadStarted: (cb) => ipcRenderer.on('download-started', (_e, payload) => cb(payload)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_e, payload) => cb(payload)),
  onDownloadDone: (cb) => ipcRenderer.on('download-done', (_e, payload) => cb(payload)),
});
