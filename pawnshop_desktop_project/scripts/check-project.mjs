import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const required = [
  'electron/main.js', 'electron/preload.js', 'electron/backup-manager.js', 'electron/usb-monitor.js',
  'renderer/index.html', 'renderer/desktop-integration.js', 'renderer/settings.html', 'renderer/settings.js',
  'package.json', 'electron/update-config.json', 'source/pawnshop_local_v4_original.html', 'tests/backup-validation.test.cjs'
];
let failed = false;
for (const relative of required) {
  try { await access(resolve(root, relative)); process.stdout.write(`OK  ${relative}\n`); }
  catch { process.stderr.write(`MISSING  ${relative}\n`); failed = true; }
}
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const jsFiles = [
  'electron/main.js', 'electron/preload.js', 'electron/backup-manager.js', 'electron/usb-monitor.js',
  'renderer/desktop-integration.js', 'renderer/settings.js', 'scripts/vendor-assets.mjs',
  'scripts/configure-release.mjs', 'scripts/check-project.mjs'
];
for (const relative of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', resolve(root, relative)], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(`SYNTAX ERROR  ${relative}\n${result.stderr}`);
    failed = true;
  } else process.stdout.write(`JS syntax OK  ${relative}\n`);
}

const originalHtml = await readFile(resolve(root, 'source/pawnshop_local_v4_original.html'), 'utf8');
const packagedHtml = await readFile(resolve(root, 'renderer/index.html'), 'utf8');
const functionPattern = /\b(?:async\s+)?function\s+([\w$]+)\s*\(/g;
const originalFunctions = new Set([...originalHtml.matchAll(functionPattern)].map(match => match[1]));
const packagedFunctions = new Set([...packagedHtml.matchAll(functionPattern)].map(match => match[1]));
const missingFunctions = [...originalFunctions].filter(name => !packagedFunctions.has(name));
if (missingFunctions.length) {
  process.stderr.write(`Original functions missing from desktop renderer: ${missingFunctions.join(', ')}\n`);
  failed = true;
} else {
  process.stdout.write(`Original functions preserved  ${originalFunctions.size}/${originalFunctions.size}\n`);
}

const testResult = spawnSync(process.execPath, [resolve(root, 'tests/backup-validation.test.cjs')], { encoding: 'utf8' });
if (testResult.status !== 0) {
  process.stderr.write(`Backup validation tests failed\n${testResult.stderr}`);
  failed = true;
} else {
  process.stdout.write(testResult.stdout);
}

const html = await readFile(resolve(root, 'renderer/index.html'), 'utf8');
for (const requiredText of ['pawn_krabi_master_db', 'pawn_krabi_reliable_storage', 'desktop-integration.js', 'pdf.min.js', 'tailwind.js']) {
  if (!html.includes(requiredText)) {
    process.stderr.write(`HTML CHECK FAILED  missing ${requiredText}\n`);
    failed = true;
  }
}
if (packageJson.build?.nsis?.deleteAppDataOnUninstall !== false) {
  process.stderr.write('WARNING: NSIS uninstall data-preservation setting should be false.\n');
}
if (failed) process.exit(1);
process.stdout.write('Project structure and syntax checks passed. This does not replace a Windows runtime test.\n');
