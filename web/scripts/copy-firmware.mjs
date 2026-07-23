// Copy the canonical firmware image into public/ so the built site embeds it.
// SPDX-License-Identifier: MIT
//
// Runs as an npm `prebuild`/`predev` step. The firmware lives at
// ../../firmware/padkit.bin (the single source of truth, produced by the SDCC
// build). Copying it at build time — instead of hand-embedding a base64 blob —
// means the flasher can never ship a stale image: whatever is in firmware/ is
// what the browser flashes.

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
