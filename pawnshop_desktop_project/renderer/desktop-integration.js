/* Desktop integration layer. The original ledger functions remain intact. */
(() => {
  'use strict';

  const DB_NAME = 'pawn_krabi_reliable_storage';
  const STORE_NAME = 'snapshots';
  let notifyTimer = null;

  function readIndexedDbSnapshots() {
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(DB_NAME, 1);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onerror = () => reject(request.error || new Error('เปิดฐานข้อมูลสำรองไม่ได้'));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.close();
          resolve([]);
          return;
        }
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const getRequest = transaction.objectStore(STORE_NAME).getAll();
        getRequest.onsuccess = () => {
          const rows = Array.isArray(getRequest.result) ? getRequest.result : [];
          database.close();
          resolve(rows);
        };
        getRequest.onerror = () => {
          database.close();
          reject(getRequest.error || new Error('อ่านฐานข้อมูลสำรองไม่ได้'));
        };
      };
    });
  }

  window.pawnDesktopExportSnapshot = async function () {
    const local = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith('pawn_krabi_')) local[key] = localStorage.getItem(key);
    }

    // ใช้ตัวแปร db จากไฟล์ต้นฉบับโดยตรง เพื่อให้ได้ข้อมูลล่าสุด ไม่พึ่ง snapshot ที่อาจยังรอ timer บันทึก
    const liveDatabase = (typeof db !== 'undefined' && db && typeof db === 'object' && !Array.isArray(db)) ? db : {};
    const databaseText = JSON.stringify(liveDatabase);
    const databaseCopy = JSON.parse(databaseText);
    const snapshots = await readIndexedDbSnapshots();

    return {
      payloadVersion: 1,
      exportedAt: new Date().toISOString(),
      selectedDate: (typeof currentDate !== 'undefined' ? currentDate : ''),
      localStorage: local,
      database: databaseText,
      indexedDBSnapshots: snapshots,
      statistics: {
        dayCount: Object.keys(databaseCopy).filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key)).length,
        monthCount: Object.values(databaseCopy).reduce((total, day) => total + (Array.isArray(day?.months) ? day.months.length : 0), 0),
        databaseBytes: new TextEncoder().encode(databaseText).length
      }
    };
  };

  window.pawnDesktopRestoreBackup = async function (backup) {
    if (!backup || backup.format !== 'pawnshop-krabi-desktop-backup' || !backup.payload || backup.payload.payloadVersion !== 1) {
      throw new Error('รูปแบบไฟล์สำรองโปรแกรมไม่ถูกต้อง');
    }
    const restoredDb = JSON.parse(backup.payload.database || '{}');
    if (!restoredDb || typeof restoredDb !== 'object' || Array.isArray(restoredDb)) {
      throw new Error('โครงสร้างฐานข้อมูลในไฟล์สำรองไม่ถูกต้อง');
    }
    for (const [dateKey, day] of Object.entries(restoredDb)) {
      if ((dateKey !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) || !day || typeof day !== 'object' ||
          !Array.isArray(day.months) || !day.data || typeof day.data !== 'object') {
        throw new Error('พบข้อมูลวันที่หรือโครงสร้างฐานข้อมูลไม่ถูกต้อง');
      }
    }

    // เก็บจุดกู้คืนใน IndexedDB ก่อนแทนที่ข้อมูลปัจจุบัน
    if (typeof savePreImportRecoverySnapshot === 'function' && typeof db !== 'undefined') {
      await savePreImportRecoverySnapshot(db);
    }

    db = restoredDb;
    const savedAt = String(Date.now());
    const restoredLocal = backup.payload.localStorage && typeof backup.payload.localStorage === 'object'
      ? backup.payload.localStorage : {};

    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith('pawn_krabi_')) localStorage.removeItem(key);
    }
    for (const [key, value] of Object.entries(restoredLocal)) {
      if (key.startsWith('pawn_krabi_') && typeof value === 'string') localStorage.setItem(key, value);
    }
    localStorage.setItem('pawn_krabi_master_db', JSON.stringify(db));
    localStorage.setItem('pawn_krabi_saved_at', savedAt);
    localStorage.setItem('pawn_krabi_last_backup', new Date().toISOString());
    if (backup.payload.selectedDate) {
      currentDate = backup.payload.selectedDate;
      localStorage.setItem('pawn_krabi_selected_date', currentDate);
    }

    // เขียน snapshot หลักชุดใหม่ โดยไม่ลบจุดกู้คืนที่เพิ่งสร้างไว้
    const idb = await openReliableDatabase();
    await new Promise((resolve, reject) => {
      const transaction = idb.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ id: 'main', savedAt: Number(savedAt), data: JSON.stringify(db) });
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('บันทึกฐานข้อมูลสำรองหลังคืนค่าไม่สำเร็จ'));
      transaction.onabort = () => reject(transaction.error || new Error('การคืนค่าฐานข้อมูลถูกยกเลิก'));
    });

    if (typeof renderTable === 'function') {
      if (typeof currentDate === 'string' && currentDate) {
        const dateInput = document.getElementById('doc-date');
        if (dateInput) dateInput.value = currentDate;
        if (typeof updateHeaderInfo === 'function') updateHeaderInfo(currentDate);
        if (typeof getCurrentDayData === 'function') getCurrentDayData();
      }
      renderTable();
    }
    if (typeof showToast === 'function') showToast('กู้คืนข้อมูลจากไฟล์สำรองโปรแกรมสำเร็จ');
    if (typeof setSaveIndicator === 'function') setSaveIndicator('saved', 'กู้คืนข้อมูลแล้ว · บันทึกในเครื่องเรียบร้อย');
    return { dayCount: Object.keys(db).length };
  };

  window.pawnDesktopImportLegacyData = async function (legacyDatabase) {
    if (typeof importJSON !== 'function') throw new Error('ไม่พบฟังก์ชันนำเข้าข้อมูลเดิม');
    const file = new File([JSON.stringify(legacyDatabase)], 'ข้อมูลเดิมจากเว็บ.json', { type: 'application/json' });
    const fakeInput = { files: [file], value: '' };
    await importJSON({ target: fakeInput });
  };

  window.pawnDesktopReady = true;

  // ส่งสัญญาณหลังการบันทึกทุกครั้งแบบหน่วงเวลา ไม่สร้างไฟล์สำรองซ้ำถี่เกินไป
  try {
    if (typeof saveDB === 'function' && !window.__pawnDesktopSaveWrapped) {
      const originalSaveDB = saveDB;
      saveDB = function (...args) {
        const result = originalSaveDB.apply(this, args);
        if (result && window.pawnDesktop?.notifyDataChanged) {
          if (notifyTimer) clearTimeout(notifyTimer);
          notifyTimer = setTimeout(() => window.pawnDesktop.notifyDataChanged(), 1500);
        }
        return result;
      };
      window.__pawnDesktopSaveWrapped = true;
    }
  } catch (error) {
    console.warn('Desktop save hook could not be installed:', error);
  }

  function addDesktopSettingsButton() {
    if (document.getElementById('pawn-desktop-settings-button')) return;
    const button = document.createElement('button');
    button.id = 'pawn-desktop-settings-button';
    button.type = 'button';
    button.textContent = 'ตั้งค่าโปรแกรม / USB';
    button.title = 'จัดการการสำรองข้อมูล USB และการอัปเดตโปรแกรม';
    button.addEventListener('click', () => window.pawnDesktop?.openSettings());

    const placeButton = () => {
      const app = document.getElementById('app-container');
      const isUnlocked = app && app.style.display === 'flex';
      if (isUnlocked) {
        const toolbar = document.querySelector('header .flex.items-center.gap-2');
        if (toolbar && button.parentElement !== toolbar) toolbar.appendChild(button);
        Object.assign(button.style, {
          position: 'static', margin: '0', zIndex: 'auto', border: '1px solid #34d399',
          borderRadius: '10px', padding: '7px 11px', background: '#065f46', color: '#ffffff',
          fontFamily: 'Sarabun, sans-serif', fontSize: '12px', fontWeight: '700',
          boxShadow: 'none', cursor: 'pointer', whiteSpace: 'nowrap'
        });
      } else {
        if (button.parentElement !== document.body) document.body.appendChild(button);
        Object.assign(button.style, {
          position: 'fixed', top: '10px', right: '10px', zIndex: '10000', margin: '0',
          border: '1px solid #047857', borderRadius: '999px', padding: '7px 12px',
          background: '#065f46', color: '#ffffff', fontFamily: 'Sarabun, sans-serif',
          fontSize: '12px', fontWeight: '700', boxShadow: '0 3px 12px rgba(0,0,0,.18)', cursor: 'pointer'
        });
      }
    };

    document.body.appendChild(button);
    placeButton();
    const app = document.getElementById('app-container');
    if (app && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(placeButton);
      observer.observe(app, { attributes: true, attributeFilter: ['class', 'style'] });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(addDesktopSettingsButton, 500);
  });
})();
