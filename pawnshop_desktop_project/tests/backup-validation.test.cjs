'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

// Mock only Electron's app version so backup format validation can run in plain Node.js.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getVersion: () => 'test-version' } };
  return originalLoad.call(this, request, parent, isMain);
};

const { validateSnapshot, verifyBackupEnvelope, BACKUP_FORMAT } = require('../electron/backup-manager.js');
Module._load = originalLoad;

const payload = {
  payloadVersion: 1,
  database: JSON.stringify({
    '2026-11-06': { months: ['มกราคม'], data: { มกราคม: [] } }
  }),
  localStorage: { pawn_krabi_master_db: '{}' },
  indexedDBSnapshots: [],
  statistics: { dayCount: 1 }
};

assert.equal(validateSnapshot(payload).dayCount, 1, 'valid database snapshot must pass');
const checksum = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
const backup = {
  format: BACKUP_FORMAT,
  formatVersion: 1,
  checksumAlgorithm: 'SHA-256',
  checksum,
  payload
};
assert.equal(verifyBackupEnvelope(backup), true, 'valid envelope must verify');

const corrupted = structuredClone(backup);
corrupted.payload.database = JSON.stringify({ 'not-a-date': { months: [], data: {} } });
assert.throws(() => verifyBackupEnvelope(corrupted), /ตรวจสอบไฟล์สำรองไม่ผ่าน/, 'modified payload must fail checksum');

const invalidStructure = structuredClone(backup);
invalidStructure.payload.database = JSON.stringify({ '2026-11-06': { months: 'not-array', data: {} } });
invalidStructure.checksum = crypto.createHash('sha256').update(JSON.stringify(invalidStructure.payload), 'utf8').digest('hex');
assert.throws(() => verifyBackupEnvelope(invalidStructure), /โครงสร้างข้อมูลวันที่/, 'invalid day schema must fail');

process.stdout.write('Backup validation tests passed.\n');
