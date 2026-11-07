'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pawnDesktop', Object.freeze({
  getSettings: () => ipcRenderer.invoke('app:get-settings'),
  listUsbDrives: () => ipcRenderer.invoke('usb:list'),
  saveUsbTarget: (driveKey) => ipcRenderer.invoke('usb:save-target', driveKey),
  setUsbBackupEnabled: (enabled) => ipcRenderer.invoke('usb:set-enabled', Boolean(enabled)),
  runBackupNow: () => ipcRenderer.invoke('backup:run-now'),
  getBackupStatus: () => ipcRenderer.invoke('backup:get-status'),
  openSettings: () => ipcRenderer.invoke('app:open-settings'),
  importLegacy: () => ipcRenderer.invoke('legacy:import'),
  selectAndRestoreBackup: () => ipcRenderer.invoke('backup:select-and-restore'),
  setStartWithWindows: (enabled) => ipcRenderer.invoke('app:set-startup', Boolean(enabled)),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  listBackups: () => ipcRenderer.invoke('data:list-backups'),
  setDataSource: (source) => ipcRenderer.invoke('data:set-source', source),
  pickBackupFolder: () => ipcRenderer.invoke('data:pick-folder'),
  clearBackupFolder: () => ipcRenderer.invoke('data:clear-folder'),
  restoreBackupFile: (filePath) => ipcRenderer.invoke('data:restore-file', filePath),
  restoreLatestBackup: () => ipcRenderer.invoke('data:restore-latest'),
  notifyDataChanged: () => ipcRenderer.send('data:changed'),
  onBackupStatus: (callback) => subscribe('backup:status', callback),
  onUpdateStatus: (callback) => subscribe('update:status', callback)
}));
