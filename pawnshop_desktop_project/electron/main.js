'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  protocol,
  ipcMain,
  dialog,
  shell,
  Notification,
  net
} = require('electron');
const { autoUpdater } = require('electron-updater');
const { BackupManager, verifyBackupEnvelope, listRemovableDrives, BACKUP_FOLDER_NAME } = require('./backup-manager');

const APP_SCHEME = 'pawnshop';
const APP_HOST = 'app';
const APP_ROOT = path.resolve(__dirname, '..', 'renderer');
const ICON_PATH = path.resolve(__dirname, '..', 'assets', 'app.ico');
const TRAY_ICON_PATH = path.resolve(__dirname, '..', 'assets', 'tray.png');
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'desktop-settings.json');

protocol.registerSchemesAsPrivileged([{
  scheme: APP_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, webWorker: true }
}]);

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) app.quit();

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let isQuitting = false;
let backupManager = null;
let backupTimer = null;
let usbMonitorTimer = null;
let lastUsbKeys = null;
let config = {
  schemaVersion: 1,
  usbBackupEnabled: true,
  targetUsbKey: null,
  startWithWindows: true,
  lastBackupAt: null,
  lastUsbBackupAt: null,
  dataSource: 'local',
  customBackupFolder: null
};
let updateStatus = { state: 'idle', message: 'ยังไม่ได้ตรวจสอบการอัปเดต', version: null, percent: 0 };

// ให้ข้อมูลผู้ใช้แยกจากโฟลเดอร์ติดตั้ง เพื่อให้อัปเดต/ติดตั้งทับได้โดยไม่ลบฐานข้อมูล
app.setPath('userData', path.join(app.getPath('appData'), 'PawnshopKrabiLedger'));
app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));

async function loadConfig() {
  try {
    const stored = JSON.parse(await fs.readFile(CONFIG_PATH(), 'utf8'));
    if (stored && typeof stored === 'object') config = { ...config, ...stored };
  } catch (_) {
    // ใช้ค่าตั้งต้นเมื่อเปิดครั้งแรก
  }
  await saveConfig(config);
}

async function saveConfig(nextConfig) {
  config = { ...config, ...nextConfig, schemaVersion: 1 };
  await fs.mkdir(path.dirname(CONFIG_PATH()), { recursive: true });
  const temp = `${CONFIG_PATH()}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), 'utf8');
  await fs.rename(temp, CONFIG_PATH());
  return { ...config };
}

function sendToSettings(channel, payload) {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(channel, payload);
}

function sendBackupStatus(status) {
  sendToSettings('backup:status', status);
  if (tray) {
    const tooltip = status.state === 'success'
      ? 'สถานธนานุบาลกระบี่ · สำรอง USB แล้ว'
      : 'สถานธนานุบาลกระบี่ · ' + String(status.message || '').slice(0, 80);
    try { tray.setToolTip(tooltip); } catch (_) {}
  }
}

backupManager = new BackupManager({
  getWindow: () => mainWindow,
  getConfig: () => config,
  saveConfig,
  emitStatus: sendBackupStatus
});

function sendUpdateStatus(next) {
  updateStatus = { ...updateStatus, ...next };
  sendToSettings('update:status', updateStatus);
}

function loadUpdateConfig() {
  try {
    return require('./update-config.json');
  } catch (_) {
    return null;
  }
}

function updateConfigIsReady(updateConfig) {
  return Boolean(updateConfig && updateConfig.provider === 'github' && updateConfig.owner &&
    updateConfig.repo && !String(updateConfig.owner).startsWith('REPLACE_') && !String(updateConfig.repo).startsWith('REPLACE_'));
}

function initializeAutoUpdater() {
  const updateConfig = loadUpdateConfig();
  if (!updateConfigIsReady(updateConfig)) {
    sendUpdateStatus({ state: 'not-configured', message: 'ระบบอัปเดตพร้อมแล้ว แต่ต้องตั้งค่า GitHub Releases ก่อนเปิดใช้' });
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  // electron-builder สร้าง resources/app-update.yml จาก publish config ตอนแพ็กโปรแกรม
  // ไม่เรียก setFeedURL ซ้ำ เพื่อให้ updater ใช้ feed ที่ฝังมากับ installer

  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking', message: 'กำลังตรวจสอบเวอร์ชันใหม่…' }));
  autoUpdater.on('update-available', info => {
    sendUpdateStatus({ state: 'available', message: `พบเวอร์ชัน ${info.version} กำลังดาวน์โหลด`, version: info.version, percent: 0 });
    if (Notification.isSupported()) new Notification({ title: 'มีโปรแกรมเวอร์ชันใหม่', body: `กำลังดาวน์โหลดเวอร์ชัน ${info.version}` }).show();
  });
  autoUpdater.on('update-not-available', info => sendUpdateStatus({ state: 'current', message: 'โปรแกรมเป็นเวอร์ชันล่าสุดแล้ว', version: info?.version || app.getVersion(), percent: 100 }));
  autoUpdater.on('download-progress', progress => sendUpdateStatus({
    state: 'downloading', message: `กำลังดาวน์โหลด ${Math.round(progress.percent)}%`, percent: Math.round(progress.percent)
  }));
  autoUpdater.on('update-downloaded', info => {
    sendUpdateStatus({ state: 'downloaded', message: `ดาวน์โหลดเวอร์ชัน ${info.version} เสร็จแล้ว พร้อมติดตั้งเมื่อสั่งเริ่มโปรแกรมใหม่`, version: info.version, percent: 100 });
    if (Notification.isSupported()) new Notification({ title: 'ดาวน์โหลดอัปเดตเสร็จแล้ว', body: 'เปิดหน้าตั้งค่าโปรแกรมเพื่อเริ่มติดตั้งเวอร์ชันใหม่' }).show();
  });
  autoUpdater.on('error', error => sendUpdateStatus({ state: 'error', message: `ตรวจสอบอัปเดตไม่สำเร็จ: ${error.message}` }));
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    return { ok: false, state: 'development', message: 'โหมดทดสอบ: การตรวจสอบอัปเดตใช้ได้หลังติดตั้งโปรแกรมที่ Build แล้ว' };
  }
  const updateConfig = loadUpdateConfig();
  if (!updateConfigIsReady(updateConfig)) {
    const result = { ok: false, state: 'not-configured', message: 'ต้องเชื่อมโปรเจกต์กับ GitHub Releases ก่อน จึงจะตรวจสอบอัปเดตออนไลน์ได้' };
    sendUpdateStatus(result);
    return result;
  }
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true, ...updateStatus };
  } catch (error) {
    const result = { ok: false, state: 'error', message: error.message };
    sendUpdateStatus(result);
    return result;
  }
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 720,
    minWidth: 620,
    minHeight: 600,
    title: 'ตั้งค่าโปรแกรม · สถานธนานุบาลเทศบาลเมืองกระบี่',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  settingsWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/settings.html`);
  settingsWindow.on('closed', () => { settingsWindow = null; });
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  return settingsWindow;
}

function createMainWindow({ show = true } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (show) { mainWindow.show(); mainWindow.focus(); }
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 980,
    minHeight: 680,
    show: false,
    title: 'สถานธนานุบาลเทศบาลเมืองกระบี่',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: '#f1f5f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  });

  mainWindow.loadURL(`${APP_SCHEME}://${APP_HOST}/index.html`);
  mainWindow.once('ready-to-show', () => {
    if (show) mainWindow.show();
  });
  mainWindow.on('close', event => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${APP_SCHEME}://${APP_HOST}/`)) event.preventDefault();
  });
  mainWindow.webContents.on('did-finish-load', () => {
    setTimeout(() => scheduleBackup('app-start'), 5000);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process terminated:', details);
  });
  return mainWindow;
}

async function ensureMainLedgerUnlocked() {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow({ show: true });
  mainWindow.show();
  mainWindow.focus();
  if (mainWindow.webContents.isLoading()) {
    await new Promise(resolve => mainWindow.webContents.once('did-finish-load', resolve));
  }
  try {
    return await mainWindow.webContents.executeJavaScript(
      "Boolean(document.getElementById('app-container') && document.getElementById('app-container').style.display === 'flex')",
      true
    );
  } catch (_) {
    return false;
  }
}

function createTray() {
  if (tray) return;
  let icon = nativeImage.createFromPath(TRAY_ICON_PATH);
  if (icon.isEmpty()) icon = nativeImage.createFromPath(ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip('สถานธนานุบาลเทศบาลเมืองกระบี่ · ทำงานเบื้องหลัง');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'เปิดโปรแกรมบัญชี', click: () => createMainWindow({ show: true }) },
    { label: 'ตั้งค่า USB / สำรองข้อมูล', click: () => createSettingsWindow() },
    { label: 'สำรองข้อมูลทันที', click: () => backupManager.performBackup('tray-manual') },
    { label: 'ตรวจสอบเวอร์ชันใหม่', click: () => checkForUpdates() },
    { type: 'separator' },
    { label: 'ออกจากโปรแกรมทั้งหมด', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => createMainWindow({ show: true }));
}

function scheduleBackup(reason = 'data-changed') {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupManager.performBackup(reason).catch(error => console.error('Scheduled backup failed:', error));
  }, 3500);
}

function startUsbMonitor() {
  if (usbMonitorTimer) clearInterval(usbMonitorTimer);
  const scan = async () => {
    const drives = await listRemovableDrives();
    const keys = new Set(drives.map(drive => drive.key));
    const selectedKey = config.targetUsbKey;
    if (selectedKey && config.usbBackupEnabled && keys.has(selectedKey)) {
      const justArrived = lastUsbKeys === null || !lastUsbKeys.has(selectedKey);
      if (justArrived) scheduleBackup('usb-inserted');
    }
    lastUsbKeys = keys;
  };
  scan().catch(() => {});
  usbMonitorTimer = setInterval(() => scan().catch(() => {}), 10000);
}

function registerProtocolHandler() {
  protocol.handle(APP_SCHEME, async request => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || 'index.html';
    const filePath = path.resolve(APP_ROOT, relative);
    if (!filePath.startsWith(APP_ROOT + path.sep) && filePath !== path.join(APP_ROOT, 'index.html')) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch (_) {
      return new Response('Not found', { status: 404 });
    }
  });
}

const BACKUP_FILE_RE = /^pawnshop_backup_\d{4}-\d{2}-\d{2}\.json$/i;

// รวมรายการไฟล์สำรองที่โปรแกรมรู้จัก (USB ที่เลือก / โฟลเดอร์ที่ผู้ใช้เลือก / จุดกู้คืนในเครื่อง)
async function listBackupFiles() {
  const folders = [];
  try {
    const drives = await listRemovableDrives();
    const drive = drives.find(item => item.key === config.targetUsbKey);
    if (drive) folders.push({ label: `USB ${drive.driveLetter || ''}`.trim(), kind: 'usb', dir: path.join(drive.root, BACKUP_FOLDER_NAME) });
  } catch (_) {}
  if (config.customBackupFolder) folders.push({ label: 'โฟลเดอร์ที่เลือก', kind: 'custom', dir: config.customBackupFolder });
  folders.push({ label: 'ในเครื่อง (สำรองอัตโนมัติ)', kind: 'local', dir: path.join(app.getPath('userData'), 'recovery-backups') });
  const files = [];
  for (const folder of folders) {
    let entries = [];
    try { entries = await fs.readdir(folder.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !BACKUP_FILE_RE.test(entry.name)) continue;
      const full = path.join(folder.dir, entry.name);
      try {
        const stat = await fs.stat(full);
        files.push({ source: folder.label, kind: folder.kind, name: entry.name, path: full, mtime: stat.mtimeMs, size: stat.size });
      } catch (_) {}
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return { folders: folders.map(({ label, kind, dir }) => ({ label, kind, dir })), files: files.slice(0, 30) };
}

async function restoreBackupFile(filePath) {
  const unlocked = await ensureMainLedgerUnlocked();
  if (!unlocked) return { requiresLogin: true };
  const known = await listBackupFiles();
  const item = known.files.find(file => file.path === filePath);
  if (!item) return { ok: false, message: 'ไม่พบไฟล์สำรองนี้ในรายการที่โปรแกรมรู้จัก' };
  let content;
  try { content = JSON.parse(await fs.readFile(item.path, 'utf8')); }
  catch (_) { return { ok: false, message: 'ไฟล์สำรองเสียหายหรืออ่านไม่ได้' }; }
  try { verifyBackupEnvelope(content); }
  catch (error) { return { ok: false, message: `ไฟล์สำรองไม่ผ่านการตรวจสอบ: ${error.message}` }; }
  const confirmResult = await dialog.showMessageBox(mainWindow, {
    type: 'warning', buttons: ['ยกเลิก', 'กู้คืนข้อมูล'], defaultId: 0, cancelId: 0, noLink: true,
    title: 'ยืนยันการกู้คืนข้อมูล',
    message: 'ต้องการแทนที่ข้อมูลปัจจุบันด้วยข้อมูลจากไฟล์สำรองนี้หรือไม่?',
    detail: `แหล่งที่มา: ${item.source}\nไฟล์: ${item.name}\nวันที่สำรอง: ${content.createdAt || '-'}\n\nระบบจะสร้างจุดกู้คืนข้อมูลปัจจุบันไว้ก่อนเริ่มกู้คืน`
  });
  if (confirmResult.response !== 1) return { canceled: true };
  const restored = await backupManager.restoreFromEnvelope(content);
  return { ok: true, dayCount: restored?.dayCount || 0, source: item.source, name: item.name };
}

function setupIpc() {
  ipcMain.handle('app:get-settings', async () => {
    const drives = await listRemovableDrives();
    return {
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      config: { ...config },
      drives,
      backupStatus: backupManager.status(),
      updateStatus: { ...updateStatus },
      userDataPath: app.getPath('userData')
    };
  });
  ipcMain.handle('usb:list', () => listRemovableDrives());
  ipcMain.handle('usb:save-target', async (_event, driveKey) => {
    const drives = await listRemovableDrives();
    const selected = drives.find(drive => drive.key === driveKey);
    if (!selected) return { ok: false, message: 'ไม่พบ USB ที่เลือก กรุณาถอดแล้วเสียบใหม่' };
    await saveConfig({ targetUsbKey: selected.key, targetUsbLabel: selected.displayName, usbBackupEnabled: true });
    scheduleBackup('usb-selected');
    return { ok: true, selected };
  });
  ipcMain.handle('usb:set-enabled', async (_event, enabled) => {
    await saveConfig({ usbBackupEnabled: Boolean(enabled) });
    if (enabled) scheduleBackup('usb-enabled');
    return { ok: true, enabled: config.usbBackupEnabled };
  });
  ipcMain.handle('backup:run-now', () => backupManager.performBackup('manual'));
  ipcMain.handle('backup:get-status', () => backupManager.status());
  ipcMain.handle('data:list-backups', () => listBackupFiles());
  ipcMain.handle('data:set-source', async (_event, source) => {
    if (source !== 'local' && source !== 'usb-ask') return { ok: false, message: 'ค่าไม่ถูกต้อง' };
    await saveConfig({ dataSource: source });
    return { ok: true, dataSource: config.dataSource };
  });
  ipcMain.handle('data:pick-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: 'เลือกโฟลเดอร์ที่เก็บไฟล์สำรอง', properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    await saveConfig({ customBackupFolder: result.filePaths[0] });
    return { ok: true, folder: result.filePaths[0] };
  });
  ipcMain.handle('data:clear-folder', async () => { await saveConfig({ customBackupFolder: null }); return { ok: true }; });
  ipcMain.handle('data:restore-file', (_event, filePath) => restoreBackupFile(String(filePath || '')));
  ipcMain.handle('data:restore-latest', async () => {
    const known = await listBackupFiles();
    const latest = known.files.find(file => file.kind !== 'local') || known.files[0];
    if (!latest) return { ok: false, none: true };
    return restoreBackupFile(latest.path);
  });
  ipcMain.handle('app:open-settings', () => { createSettingsWindow(); return true; });
  ipcMain.handle('legacy:import', async () => {
    const unlocked = await ensureMainLedgerUnlocked();
    if (!unlocked) return { ok: false, requiresLogin: true, message: 'กรุณาปลดล็อกหน้าบัญชีก่อนนำเข้าข้อมูล' };
    await mainWindow.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('import-file');
      if (input) input.click();
      else alert('ไม่พบช่องนำเข้าข้อมูล JSON');
    })()`);
    return { ok: true };
  });
  ipcMain.handle('backup:select-and-restore', async () => {
    const unlocked = await ensureMainLedgerUnlocked();
    if (!unlocked) return { requiresLogin: true };
    const result = await dialog.showOpenDialog(settingsWindow || mainWindow, {
      title: 'เลือกไฟล์สำรองเพื่อกู้คืน',
      properties: ['openFile'],
      filters: [{ name: 'ไฟล์สำรอง JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    let content;
    try { content = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8')); }
    catch (_) { throw new Error('ไฟล์ JSON เสียหายหรืออ่านไม่ได้'); }

    if (content && content.format === 'pawnshop-krabi-desktop-backup') {
      verifyBackupEnvelope(content);
      const confirmResult = await dialog.showMessageBox(settingsWindow || mainWindow, {
        type: 'warning',
        buttons: ['ยกเลิก', 'กู้คืนข้อมูล'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: 'ยืนยันการกู้คืนข้อมูล',
        message: 'ต้องการแทนที่ข้อมูลปัจจุบันด้วยข้อมูลจากไฟล์สำรองนี้หรือไม่?',
        detail: `ไฟล์: ${path.basename(result.filePaths[0])}\nวันที่สำรอง: ${content.createdAt || '-'}\n\nระบบจะสร้างจุดกู้คืนข้อมูลปัจจุบันไว้ก่อนเริ่มกู้คืน`
      });
      if (confirmResult.response !== 1) return { canceled: true };
      const restored = await backupManager.restoreFromEnvelope(content);
      return { ok: true, type: 'desktop', dayCount: restored?.dayCount || 0 };
    }
    // รองรับ JSON แบบเดิมที่ส่งออกจากหน้าเว็บ v4 โดยใช้ฟังก์ชัน importJSON ต้นฉบับ
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      if (!mainWindow || mainWindow.isDestroyed()) createMainWindow({ show: true });
      mainWindow.show();
      mainWindow.focus();
      const safeJson = JSON.stringify(content);
      const imported = await mainWindow.webContents.executeJavaScript(
        `(async () => window.pawnDesktopImportLegacyData(JSON.parse(${JSON.stringify(safeJson)})))()`, true
      );
      return { ok: true, type: 'legacy', imported };
    }
    throw new Error('รูปแบบไฟล์ไม่รองรับ');
  });
  ipcMain.handle('app:set-startup', async (_event, enabled) => {
    const openAtLogin = Boolean(enabled);
    app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: ['--hidden-to-tray'] });
    await saveConfig({ startWithWindows: openAtLogin });
    return { ok: true, enabled: openAtLogin };
  });
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:install', () => {
    if (updateStatus.state !== 'downloaded') return { ok: false, message: 'ยังไม่มีไฟล์อัปเดตที่ดาวน์โหลดเสร็จแล้ว' };
    isQuitting = true;
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  ipcMain.on('data:changed', () => scheduleBackup('data-changed'));
}

app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else createMainWindow({ show: true });
});

app.whenReady().then(async () => {
  await loadConfig();
  backupManager.setStatus({
    lastBackupAt: config.lastBackupAt || null,
    lastUsbBackupAt: config.lastUsbBackupAt || null,
    message: config.lastUsbBackupAt ? `สำรอง USB ล่าสุด ${new Date(config.lastUsbBackupAt).toLocaleString('th-TH')}` : 'กำลังรอการสำรองข้อมูลครั้งแรก'
  });
  registerProtocolHandler();
  setupIpc();
  const loginSettings = app.getLoginItemSettings();
  const launchedHidden = process.argv.includes('--hidden-to-tray') || loginSettings.wasOpenedAtLogin;
  createMainWindow({ show: !launchedHidden });
  createTray();

  if (config.startWithWindows) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath, args: ['--hidden-to-tray'] });
  }

  startUsbMonitor();
  initializeAutoUpdater();
  setTimeout(() => checkForUpdates().catch(() => {}), 10000);
});

app.on('activate', () => createMainWindow({ show: true }));
app.on('before-quit', () => {
  isQuitting = true;
  if (usbMonitorTimer) clearInterval(usbMonitorTimer);
  if (backupTimer) clearTimeout(backupTimer);
});
app.on('window-all-closed', () => {
  // ทำงานผ่าน system tray ต่อไป เพื่อรอตรวจจับ USB และสำรองข้อมูลอัตโนมัติ
});
