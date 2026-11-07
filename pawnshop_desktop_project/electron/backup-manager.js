'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');
const { listRemovableDrives } = require('./usb-monitor');

const BACKUP_FORMAT = 'pawnshop-krabi-desktop-backup';
const RETENTION_COUNT = 30;
const BACKUP_FOLDER_NAME = 'Pawnshop Krabi Backup';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function dayStamp(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tempPath, filePath);
  } finally {
    try { await fs.unlink(tempPath); } catch (_) {}
  }
}

async function pruneBackups(folderPath) {
  let entries = [];
  try { entries = await fs.readdir(folderPath, { withFileTypes: true }); } catch (_) { return; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^pawnshop_backup_\d{4}-\d{2}-\d{2}\.json$/i.test(entry.name)) continue;
    const fullPath = path.join(folderPath, entry.name);
    try {
      const stat = await fs.stat(fullPath);
      candidates.push({ fullPath, mtime: stat.mtimeMs });
    } catch (_) {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const item of candidates.slice(RETENTION_COUNT)) {
    try { await fs.unlink(item.fullPath); } catch (_) {}
  }
}

function validateSnapshot(payload) {
  if (!payload || payload.payloadVersion !== 1 || typeof payload.database !== 'string') {
    throw new Error('ข้อมูลสำรองจากหน้าบัญชีไม่สมบูรณ์');
  }
  const database = JSON.parse(payload.database);
  if (!database || typeof database !== 'object' || Array.isArray(database)) {
    throw new Error('ฐานข้อมูลสำรองมีรูปแบบไม่ถูกต้อง');
  }
  for (const [dateKey, day] of Object.entries(database)) {
    if ((dateKey !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) || !day || typeof day !== 'object' ||
        !Array.isArray(day.months) || !day.data || typeof day.data !== 'object') {
      throw new Error(`โครงสร้างข้อมูลวันที่ ${dateKey || '(ว่าง)'} ไม่ถูกต้อง`);
    }
  }
  return {
    dayCount: Object.keys(database).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)).length,
    database
  };
}

function buildBackupEnvelope(payload, reason) {
  const payloadString = JSON.stringify(payload);
  return {
    format: BACKUP_FORMAT,
    formatVersion: 1,
    appVersion: app.getVersion(),
    createdAt: new Date().toISOString(),
    reason: String(reason || 'automatic'),
    checksumAlgorithm: 'SHA-256',
    checksum: sha256(payloadString),
    payload
  };
}

function verifyBackupEnvelope(backup) {
  if (!backup || backup.format !== BACKUP_FORMAT || backup.formatVersion !== 1 || !backup.payload) {
    throw new Error('ไม่ใช่ไฟล์สำรองของโปรแกรมนี้');
  }
  if (backup.checksumAlgorithm !== 'SHA-256' || typeof backup.checksum !== 'string') {
    throw new Error('ไฟล์สำรองไม่มีข้อมูลตรวจสอบความถูกต้อง');
  }
  const actual = sha256(JSON.stringify(backup.payload));
  if (actual !== backup.checksum) throw new Error('ตรวจสอบไฟล์สำรองไม่ผ่าน ไฟล์อาจเสียหายหรือถูกแก้ไข');
  validateSnapshot(backup.payload);
  return true;
}

class BackupManager {
  constructor({ getWindow, getConfig, saveConfig, emitStatus }) {
    this.getWindow = getWindow;
    this.getConfig = getConfig;
    this.saveConfig = saveConfig;
    this.emitStatus = emitStatus;
    this.running = false;
    this.pendingReason = null;
    this.lastStatus = {
      state: 'idle',
      message: 'ยังไม่มีการสำรองข้อมูล',
      lastBackupAt: null,
      lastUsbBackupAt: null,
      localPath: null,
      usbPath: null,
      dayCount: null
    };
  }

  status() { return { ...this.lastStatus }; }

  setStatus(next) {
    this.lastStatus = { ...this.lastStatus, ...next };
    if (this.emitStatus) this.emitStatus(this.status());
  }

  async captureSnapshot() {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new Error('หน้าต่างข้อมูลยังไม่พร้อม');
    let snapshot = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        snapshot = await win.webContents.executeJavaScript(
          'typeof window.pawnDesktopExportSnapshot === "function" ? window.pawnDesktopExportSnapshot() : null', true
        );
        if (snapshot && snapshot.database) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    if (!snapshot) throw new Error('ยังอ่านฐานข้อมูลจากหน้าจอไม่สำเร็จ กรุณาปลดล็อกโปรแกรมก่อน');
    const validation = validateSnapshot(snapshot);
    return { snapshot, validation };
  }

  async findTargetDrive() {
    const config = this.getConfig();
    if (!config.usbBackupEnabled || !config.targetUsbKey) return null;
    const drives = await listRemovableDrives();
    return drives.find(drive => drive.key === config.targetUsbKey) || null;
  }

  async performBackup(reason = 'automatic') {
    if (this.running) {
      this.pendingReason = reason;
      return { ok: false, busy: true, message: 'กำลังสำรองข้อมูลอยู่' };
    }
    this.running = true;
    this.setStatus({ state: 'working', message: 'กำลังตรวจสอบและสำรองข้อมูล…' });
    try {
      const { snapshot, validation } = await this.captureSnapshot();
      const envelope = buildBackupEnvelope(snapshot, reason);
      const content = `${JSON.stringify(envelope, null, 2)}\n`;
      const fileName = `pawnshop_backup_${dayStamp()}.json`;

      const localDirectory = path.join(app.getPath('userData'), 'recovery-backups');
      const localPath = path.join(localDirectory, fileName);
      await writeAtomic(localPath, content);
      // ตรวจไฟล์ที่เขียนจริงอีกครั้ง ก่อนรายงานว่าสำเร็จ
      const localRead = JSON.parse(await fs.readFile(localPath, 'utf8'));
      verifyBackupEnvelope(localRead);
      await pruneBackups(localDirectory);

      let usbPath = null;
      let usbMessage = 'สำรองข้อมูลไว้ในเครื่องแล้ว';
      let usbWarning = null;
      try {
        const targetDrive = await this.findTargetDrive();
        if (targetDrive) {
          const usbFolder = path.join(targetDrive.root, BACKUP_FOLDER_NAME);
          const destination = path.join(usbFolder, fileName);
          await writeAtomic(destination, content);
          const usbRead = JSON.parse(await fs.readFile(destination, 'utf8'));
          verifyBackupEnvelope(usbRead);
          await pruneBackups(usbFolder);
          usbPath = destination;
          usbMessage = `สำรองในเครื่องและ USB ${targetDrive.driveLetter} สำเร็จ`;
        } else if (this.getConfig().usbBackupEnabled && this.getConfig().targetUsbKey) {
          usbMessage = 'สำรองในเครื่องแล้ว · ยังไม่พบ USB ที่เลือก จะคัดลอกให้อัตโนมัติเมื่อเสียบ';
        } else if (!this.getConfig().targetUsbKey) {
          usbMessage = 'สำรองในเครื่องแล้ว · ยังไม่ได้เลือก USB เป้าหมาย';
        }
      } catch (error) {
        usbWarning = error.message;
        usbMessage = `สำรองในเครื่องสำเร็จ แต่คัดลอก USB ไม่สำเร็จ: ${error.message}`;
      }

      const now = new Date().toISOString();
      const nextStatus = {
        state: usbPath ? 'success' : 'local-only',
        message: usbMessage,
        lastBackupAt: now,
        localPath,
        usbPath,
        dayCount: validation.dayCount,
        usbWarning
      };
      if (usbPath) nextStatus.lastUsbBackupAt = now;
      this.setStatus(nextStatus);

      const config = this.getConfig();
      config.lastBackupAt = now;
      if (usbPath) config.lastUsbBackupAt = now;
      await this.saveConfig(config);
      return { ok: true, ...nextStatus };
    } catch (error) {
      this.setStatus({ state: 'error', message: `สำรองข้อมูลไม่สำเร็จ: ${error.message}` });
      return { ok: false, message: error.message };
    } finally {
      this.running = false;
      if (this.pendingReason) {
        const nextReason = this.pendingReason;
        this.pendingReason = null;
        setTimeout(() => this.performBackup(nextReason), 1200);
      }
    }
  }

  async restoreFromEnvelope(backup) {
    verifyBackupEnvelope(backup);
    const win = this.getWindow();
    if (!win || win.isDestroyed()) throw new Error('หน้าต่างโปรแกรมยังไม่พร้อม');

    // สร้างไฟล์กู้คืนก่อนแทนที่ข้อมูล เป็น fallback เพิ่มจาก pre_import ใน IndexedDB
    const { snapshot } = await this.captureSnapshot();
    const localSafety = buildBackupEnvelope(snapshot, 'before-restore');
    const safetyDirectory = path.join(app.getPath('userData'), 'recovery-backups');
    const safetyName = `before_restore_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await writeAtomic(path.join(safetyDirectory, safetyName), `${JSON.stringify(localSafety, null, 2)}\n`);

    const scriptArg = JSON.stringify(backup).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await win.webContents.executeJavaScript(
      `(async () => window.pawnDesktopRestoreBackup(JSON.parse('${scriptArg}')))()`, true
    );
    return result;
  }
}

module.exports = {
  BackupManager,
  BACKUP_FORMAT,
  verifyBackupEnvelope,
  validateSnapshot,
  listRemovableDrives,
  BACKUP_FOLDER_NAME,
  RETENTION_COUNT
};
