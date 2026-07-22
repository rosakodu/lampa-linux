const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ElectronBridge', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getTorrServerStatus: () => ipcRenderer.invoke('get-torrserver-status'),
  restartTorrServer: () => ipcRenderer.invoke('restart-torrserver'),
  playExternal: (videoUrl, playerPath) => ipcRenderer.invoke('play-external', videoUrl, playerPath)
});
