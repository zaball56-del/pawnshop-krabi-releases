import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const vendorDir = resolve(root, 'renderer', 'vendor');
await mkdir(vendorDir, { recursive: true });

const assets = [
  { name: 'tailwind.js', url: 'https://cdn.tailwindcss.com' },
  { name: 'pdf.min.js', url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' },
  { name: 'pdf.worker.min.js', url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' }
];

for (const asset of assets) {
  const target = resolve(vendorDir, asset.name);
  try {
    const existing = await stat(target);
    if (existing.size > 1000) {
      process.stdout.write(`Using existing ${asset.name} (${existing.size} bytes)\n`);
      continue;
    }
  } catch (_) {}

  process.stdout.write(`Downloading ${asset.name}…\n`);
  const response = await fetch(asset.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${asset.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000) throw new Error(`Downloaded asset is unexpectedly small: ${asset.name}`);
  await writeFile(target, bytes);
  process.stdout.write(`Saved ${asset.name}: ${bytes.length} bytes\n`);
}
