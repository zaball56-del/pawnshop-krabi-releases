'use strict';

const $ = id => document.getElementById(id);
let lastSettings = null;

function setStatus(element, message, state = '') {
  element.textContent = message || '';
  element.className = `status${state ? ` ${state}` : ''}`;
}

function formatDate(value) {
  if (!value) return 'ยังไม่มี';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('th-TH');
}

function renderDrives(drives, selectedKey) {
  const select = $('usb-drive');
  select.replaceChildren();
  if (selectedKey && !drives.some(drive => drive.key === selectedKey)) {
    const missing = document.createElement('option');
    missing.value = selectedKey;
    missing.textContent = 'USB เดิมที่เลือกไว้ (ยังไม่ได้เสียบ)';
    select.appendChild(missing);
  }
  if (!drives.length) {
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'ไม่พบ USB แบบ Removable — เสียบ USB แล้วกดค้นหาอีกครั้ง';
    select.appendChild(none);
  } else {
    for (const drive of drives) {
      const option = document.createElement('option');
      option.value = drive.key;
      const freeGb = drive.freeSpace ? (drive.freeSpace / (1024 ** 3)).toFixed(1) : '?';
      option.textContent = `${drive.displayName} · ว่าง ${freeGb} GB`;
      select.appendChild(option);
    }
  }
  if (selectedKey) select.value = selectedKey;
  else if (drives.length) select.value = drives[0].key;
}

function renderBackupStatus(status = {}) {
  const parts = [status.message || 'ยังไม่มีสถานะ'];
  if (status.dayCount !== null && status.dayCount !== undefined) parts.push(`จำนวนวันที่อยู่ในฐานข้อมูล: ${status.dayCount} วัน`);
  if (status.lastBackupAt) parts.push(`สำรองในเครื่องล่าสุด: ${formatDate(status.lastBackupAt)}`);
  if (status.lastUsbBackupAt) parts.push(`สำรอง USB ล่าสุด: ${formatDate(status.lastUsbBackupAt)}`);
  if (status.localPath) parts.push(`สำเนาในเครื่อง: ${status.localPath}`);
  if (status.usbPath) parts.push(`สำเนา USB: ${status.usbPath}`);
  const kind = status.state === 'success' ? 'success' : status.state === 'error' ? 'error' : status.state === 'local-only' ? 'pending' : '';
  setStatus($('backup-status'), parts.join('\n'), kind);
}

function renderUpdateStatus(status = {}) {
  setStatus($('update-status'), status.message || 'ยังไม่ได้ตรวจสอบการอัปเดต', status.state === 'error' ? 'error' : status.state === 'downloaded' ? 'success' : '');
  $('install-update').disabled = status.state !== 'downloaded';
  if (status.state === 'downloading') $('install-update').textContent = `กำลังดาวน์โหลด ${status.percent || 0}%`;
  else $('install-update').textContent = 'เริ่มติดตั้งอัปเดต';
}

async function refresh() {
  try {
    const settings = await window.pawnDesktop.getSettings();
    lastSettings = settings;
    $('app-version').textContent = `เวอร์ชัน ${settings.appVersion}${settings.isPackaged ? '' : ' · โหมดทดสอบ'}`;
    $('usb-enabled').checked = Boolean(settings.config.usbBackupEnabled);
    $('startup-enabled').checked = Boolean(settings.config.startWithWindows);
    $('data-path').textContent = settings.userDataPath;
    renderDrives(settings.drives || [], settings.config.targetUsbKey || '');
    renderBackupStatus(settings.backupStatus || {});
    renderUpdateStatus(settings.updateStatus || {});
  } catch (error) {
    setStatus($('backup-status'), `อ่านค่าตั้งค่าไม่สำเร็จ: ${error.message}`, 'error');
  }
}

$('refresh-drives').addEventListener('click', async () => {
  $('refresh-drives').disabled = true;
  try {
    const drives = await window.pawnDesktop.listUsbDrives();
    renderDrives(drives, $('usb-drive').value || lastSettings?.config?.targetUsbKey || '');
  } catch (error) {
    setStatus($('backup-status'), `ค้นหา USB ไม่สำเร็จ: ${error.message}`, 'error');
  } finally {
    $('refresh-drives').disabled = false;
  }
});

$('save-usb').addEventListener('click', async () => {
  const key = $('usb-drive').value;
  if (!key) {
    setStatus($('backup-status'), 'กรุณาเสียบ USB แล้วเลือกไดรฟ์ก่อน', 'pending');
    return;
  }
  $('save-usb').disabled = true;
  try {
    const result = await window.pawnDesktop.saveUsbTarget(key);
    if (!result.ok) throw new Error(result.message);
    $('usb-enabled').checked = true;
    setStatus($('backup-status'), `เลือก ${result.selected.displayName} แล้ว กำลังสร้างไฟล์สำรองชุดแรก`, 'success');
    setTimeout(refresh, 4500);
  } catch (error) {
    setStatus($('backup-status'), error.message, 'error');
  } finally {
    $('save-usb').disabled = false;
  }
});

$('usb-enabled').addEventListener('change', async event => {
  const result = await window.pawnDesktop.setUsbBackupEnabled(event.target.checked);
  if (!result.ok) setStatus($('backup-status'), 'เปลี่ยนสถานะระบบสำรอง USB ไม่สำเร็จ', 'error');
  else setStatus($('backup-status'), event.target.checked ? 'เปิดระบบสำรอง USB แล้ว' : 'ปิดระบบสำรอง USB แล้ว', 'success');
});

$('backup-now').addEventListener('click', async () => {
  $('backup-now').disabled = true;
  setStatus($('backup-status'), 'กำลังอ่านข้อมูล ตรวจสอบ และเขียนไฟล์สำรอง…');
  try {
    const result = await window.pawnDesktop.runBackupNow();
    renderBackupStatus(result);
    if (!result.ok) setStatus($('backup-status'), result.message || 'สำรองข้อมูลไม่สำเร็จ', 'error');
  } catch (error) {
    setStatus($('backup-status'), `สำรองข้อมูลไม่สำเร็จ: ${error.message}`, 'error');
  } finally {
    $('backup-now').disabled = false;
  }
});

$('restore-backup').addEventListener('click', async () => {
  try {
    const result = await window.pawnDesktop.selectAndRestoreBackup();
    if (result?.requiresLogin) {
      setStatus($('backup-status'), 'กรุณาไปที่หน้าบัญชี ปลดล็อกด้วย PIN ก่อน แล้วกลับมากดกู้คืนอีกครั้ง', 'pending');
      return;
    }
    if (result?.canceled) return;
    if (result?.ok) {
      setStatus($('backup-status'), result.type === 'desktop'
        ? `กู้คืนข้อมูลสำเร็จ (${result.dayCount} วัน)`
        : 'ส่งข้อมูลเดิมเข้าโปรแกรมแล้ว กรุณาตรวจสอบหน้าบัญชี', 'success');
      setTimeout(refresh, 1500);
    }
  } catch (error) {
    setStatus($('backup-status'), `กู้คืนไม่สำเร็จ: ${error.message}`, 'error');
  }
});

$('import-legacy').addEventListener('click', async () => {
  $('legacy-status').textContent = 'เปิดหน้าบัญชีเพื่อเลือกไฟล์ JSON…';
  try {
    const result = await window.pawnDesktop.importLegacy();
    $('legacy-status').textContent = result?.requiresLogin
      ? 'กรุณาไปที่หน้าบัญชี ปลดล็อกด้วย PIN ก่อน แล้วกลับมากดปุ่มนี้อีกครั้ง'
      : 'เลือกไฟล์สำรองจากเว็บเดิมในหน้าบัญชี จากนั้นยืนยันการนำเข้า';
  } catch (error) {
    $('legacy-status').textContent = `เปิดตัวเลือกไฟล์ไม่สำเร็จ: ${error.message}`;
  }
});

$('startup-enabled').addEventListener('change', async event => {
  try {
    await window.pawnDesktop.setStartWithWindows(event.target.checked);
  } catch (error) {
    event.target.checked = !event.target.checked;
    setStatus($('backup-status'), `ตั้งค่าเริ่มพร้อม Windows ไม่สำเร็จ: ${error.message}`, 'error');
  }
});

$('check-updates').addEventListener('click', async () => {
  $('check-updates').disabled = true;
  try {
    const result = await window.pawnDesktop.checkForUpdates();
    renderUpdateStatus(result);
  } catch (error) {
    renderUpdateStatus({ state: 'error', message: error.message });
  } finally {
    $('check-updates').disabled = false;
  }
});

$('install-update').addEventListener('click', async () => {
  const result = await window.pawnDesktop.installUpdate();
  if (!result.ok) renderUpdateStatus({ state: 'error', message: result.message });
});

window.pawnDesktop.onBackupStatus(renderBackupStatus);
window.pawnDesktop.onUpdateStatus(renderUpdateStatus);
refresh();
setInterval(() => window.pawnDesktop.getBackupStatus().then(renderBackupStatus).catch(() => {}), 15000);
