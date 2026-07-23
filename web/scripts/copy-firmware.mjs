// SPDX-License-Identifier: MIT

import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../firmware/padkit.bin');
const destDir = resolve(here, '../public/firmware');
const dest = resolve(destDir, 'padkit.bin');

try {
  const { size } = statSync(src);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(src, dest);
  const sha = createHash('sha256').update(readFileSync(dest)).digest('hex');
  console.log(`[copy-firmware] ${src} -> ${dest}`);
  console.log(`[copy-firmware] ${size} bytes, sha256 ${sha.slice(0, 16)}…`);
} catch (err) {
  console.error(`[copy-firmware] FAILED: ${err instanceof Error ? err.message : err}`);
  console.error('[copy-firmware] Expected the firmware at firmware/padkit.bin (repo root).');
  process.exit(1);
}
