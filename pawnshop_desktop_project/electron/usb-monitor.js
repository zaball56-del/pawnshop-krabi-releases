'use strict';

const { execFile } = require('node:child_process');
const path = require('node:path');

function makeDriveKey(item) {
  const serial = String(item.volumeSerialNumber || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
  if (serial) return `serial:${serial}`;
  const label = String(item.volumeName || '').trim().toLowerCase().replace(/[^a-z0-9ก-๙_-]/gi, '_');
  return `label:${label || 'usb'}:size:${Number(item.size || 0)}`;
}

function listRemovableDrives() {
  if (process.platform !== 'win32') return Promise.resolve([]);

  const command = [
    "$ErrorActionPreference='Stop';",
    "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=2' | ForEach-Object {",
    "  [PSCustomObject]@{ driveLetter=$_.DeviceID; volumeName=$_.VolumeName; volumeSerialNumber=$_.VolumeSerialNumber; size=[int64]$_.Size; freeSpace=[int64]$_.FreeSpace }",
    "} | ConvertTo-Json -Compress"
  ].join(' ');

  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      windowsHide: true,
      timeout: 12000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout) => {
      if (error || !stdout || !stdout.trim()) return resolve([]);
      try {
        const parsed = JSON.parse(stdout.trim());
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const drives = rows
          .filter(row => row && /^[A-Z]:$/i.test(String(row.driveLetter || '')))
          .map(row => {
            const driveLetter = String(row.driveLetter).toUpperCase();
            const volumeName = String(row.volumeName || '').trim();
            const volumeSerialNumber = String(row.volumeSerialNumber || '').trim();
            const size = Number(row.size || 0);
            const freeSpace = Number(row.freeSpace || 0);
            return {
              key: makeDriveKey({ volumeName, volumeSerialNumber, size }),
              driveLetter,
              root: `${driveLetter}\\`,
              volumeName,
              volumeSerialNumber,
              size,
              freeSpace,
              displayName: `${driveLetter} ${volumeName ? `(${volumeName})` : '(USB Drive)'}`
            };
          });
        resolve(drives);
      } catch (_) {
        resolve([]);
      }
    });
  });
}

module.exports = { listRemovableDrives };
