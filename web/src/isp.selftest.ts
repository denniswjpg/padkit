// Hardware-free unit tests for the WCH ISP codec (src/isp.ts).
// Run with:  npm test   (node --experimental-strip-types src/isp.selftest.ts)
// This is the main correctness safety net for the browser flasher: it pins the
// XOR-key derivation, the 56-byte chunking, and every request frame's length
// and byte layout to what ../../flasher/isp55e0.c produces. No WebUSB / DOM.
// SPDX-License-Identifier: MIT

import {
  Cmd,
  bootloaderSupport,
  chunkPlan,
  deriveXorKey,
  eraseLengthKiB,
  findProfile,
  frame,
  frameChipType,
  frameEraseCode,
  frameFlashRw,
  frameReadConfig,
  frameReboot,
  frameSetKey,
  frameWriteConfig,
  keyChecksum,
  padFirmware,
  parseChipType,
  parseKeyChecksum,
  parseReadConfig,
  parseReturnCode,
  toHex,
  xorInPlace,
} from './isp.ts';

declare const process: { exit(code: number): never };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`  FAIL: ${name}`);
  }
}
function eq(name: string, a: unknown, b: unknown): void {
  check(`${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`, a === b);
}
function eqBytes(name: string, a: Uint8Array, b: number[]): void {
  eq(`${name} length`, a.length, b.length);
  const ok = a.length === b.length && b.every((v, i) => a[i] === v);
  check(`${name} bytes (got ${toHex(a, ' ')})`, ok);
}

// ===========================================================================
// XOR-key derivation — worked through isp55e0.c create_key() by hand.
//   id[0..3] = 5f 43 57 e4  ->  sum = 0x5f+0x43+0x57+0xe4 = 477 = 0xDD (mod 256)
//   key = [DD]*8; key[7] = (DD + type) mod 256
//   For CH552 type 0x52: key[7] = (0xDD + 0x52) = 0x12F = 0x2F (mod 256)
//   => key = DD DD DD DD DD DD DD 2F
//   keyChecksum = (7*0xDD + 0x2F) mod 256 = 1594 mod 256 = 0x3A
// ===========================================================================
{
  const id = Uint8Array.from([0x5f, 0x43, 0x57, 0xe4, 0xc2, 0x84, 0x78]); // 7 raw bytes
  const key = deriveXorKey(id, 4, 0x52); // CH552: mcuIdLen 4, type 0x52
  eqBytes('deriveXorKey CH552', key, [0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0xdd, 0x2f]);
  eq('keyChecksum CH552', keyChecksum(key), 0x3a);

  // Only the first mcuIdLen bytes participate (trailing id bytes ignored).
  const key2 = deriveXorKey(Uint8Array.from([0x01, 0x02, 0x03, 0x04, 0xff, 0xff]), 4, 0x52);
  const sum = (0x01 + 0x02 + 0x03 + 0x04) & 0xff; // 0x0a
  eqBytes('deriveXorKey trims to mcuIdLen', key2, [
    sum, sum, sum, sum, sum, sum, sum, (sum + 0x52) & 0xff,
  ]);

  // Key is never all-zero even if the id sums to 0 (the += type guarantees it).
  const key0 = deriveXorKey(Uint8Array.from([0x00, 0x00, 0x00, 0x00]), 4, 0x52);
  eqBytes('deriveXorKey nonzero when id sums to 0', key0, [0, 0, 0, 0, 0, 0, 0, 0x52]);

  // Sum wraps mod 256 (uint8_t accumulation in the C).
  const keyW = deriveXorKey(Uint8Array.from([0xff, 0xff, 0x01, 0x01]), 4, 0x00);
  const w = (0xff + 0xff + 0x01 + 0x01) & 0xff; // 0x00
  eqBytes('deriveXorKey wraps mod 256', keyW, [w, w, w, w, w, w, w, w]);
}

// ===========================================================================
// Firmware padding + XOR encryption.
// ===========================================================================
{
  // Round UP to 8 bytes, tail filled with 0xff (isp55e0.c load_file).
  const p = padFirmware(Uint8Array.from([1, 2, 3]));
  eq('padFirmware length', p.length, 8);
  eqBytes('padFirmware pads 0xff', p, [1, 2, 3, 0xff, 0xff, 0xff, 0xff, 0xff]);
  eq('padFirmware keeps multiple of 8', padFirmware(new Uint8Array(16)).length, 16);
  eq('padFirmware 6815 -> 6816', padFirmware(new Uint8Array(6815)).length, 6816);

  // Encrypting zeros yields the key repeating (protocol.txt observation).
  const key = Uint8Array.from([0xd9, 0xad, 0x23, 0xf8, 0x54, 0xfb, 0x01, 0x52]);
  const enc = xorInPlace(new Uint8Array(16), key);
  eqBytes('xor zeros -> key repeated', enc, [
    0xd9, 0xad, 0x23, 0xf8, 0x54, 0xfb, 0x01, 0x52,
    0xd9, 0xad, 0x23, 0xf8, 0x54, 0xfb, 0x01, 0x52,
  ]);
  // XOR is an involution -> encrypt then decrypt is identity, keyed on abs pos.
  const original = Uint8Array.from(Array.from({ length: 20 }, (_, i) => (i * 7) & 0xff));
  const roundtrip = xorInPlace(xorInPlace(original.slice(), key), key);
  eqBytes('xor round-trip is identity', roundtrip, Array.from(original));
}

// ===========================================================================
// Erase length (KiB blocks, min 8).
// ===========================================================================
{
  eq('erase 6816 -> 8', eraseLengthKiB(6816), 8);
  eq('erase tiny -> min 8', eraseLengthKiB(100), 8);
  eq('erase 8192 -> 8', eraseLengthKiB(8192), 8);
  eq('erase 8193 -> 9', eraseLengthKiB(8193), 9);
  eq('erase 14336 -> 14', eraseLengthKiB(14336), 14);
}

// ===========================================================================
// Chunking — 56-byte split, short last chunk, all lengths multiples of 8.
// ===========================================================================
{
  const plan = chunkPlan(6816);
  eq('chunk count for 6816', plan.length, 122); // 121*56 + 40
  eq('first chunk offset', plan[0]!.offset, 0);
  eq('first chunk length', plan[0]!.length, 56);
  eq('last chunk offset', plan[121]!.offset, 6776);
  eq('last chunk length', plan[121]!.length, 40);
  const covered = plan.reduce((n, c) => n + c.length, 0);
  eq('chunks cover whole image', covered, 6816);
  check('every chunk length is a multiple of 8', plan.every((c) => c.length % 8 === 0));
  check(
    'chunks are contiguous',
    plan.every((c, i) => (i === 0 ? c.offset === 0 : c.offset === plan[i - 1]!.offset + plan[i - 1]!.length)),
  );

  // Exact multiple of 56 -> no short tail.
  const exact = chunkPlan(112);
  eq('exact multiple chunk count', exact.length, 2);
  eq('exact last chunk length', exact[1]!.length, 56);
}

// ===========================================================================
// Request frame builders — headers, lengths and byte layout.
// ===========================================================================
{
  // Generic frame header: [cmd][len_lo][len_hi].
  eqBytes('frame header LE', frame(0xa5, [0xde, 0xad]), [0xa5, 0x02, 0x00, 0xde, 0xad]);

  // CHIP_TYPE: type=0,family=0 then "MCU ISP & WCH.CN"; data_len 0x12.
  const ct = frameChipType();
  eq('chipType total length', ct.length, 21);
  eqBytes('chipType header', ct.subarray(0, 5), [0xa1, 0x12, 0x00, 0x00, 0x00]);
  eq('chipType ident string', new TextDecoder().decode(ct.subarray(5)), 'MCU ISP & WCH.CN');

  // READ_CONFIG: exactly the protocol.txt request.
  eqBytes('readConfig', frameReadConfig(), [0xa7, 0x02, 0x00, 0x1f, 0x00]);

  // SET_KEY: 30 zero seed bytes, data_len 0x1e.
  const sk = frameSetKey();
  eq('setKey total length', sk.length, 33);
  eqBytes('setKey header', sk.subarray(0, 3), [0xa3, 0x1e, 0x00]);
  check('setKey seed all zero', sk.subarray(3).every((b) => b === 0));

  // WRITE_CONFIG: what=0x07 + 12 config bytes; data_len 0x0e.
  const cfg = Uint8Array.from([
    0xff, 0xff, 0xff, 0xff, 0x23, 0x00, 0x00, 0x00, 0x47, 0x52, 0x00, 0x50,
  ]);
  const wc = frameWriteConfig(cfg);
  eq('writeConfig length', wc.length, 17);
  eqBytes('writeConfig header', wc.subarray(0, 5), [0xa8, 0x0e, 0x00, 0x07, 0x00]);
  eqBytes('writeConfig payload', wc.subarray(5), Array.from(cfg));

  // ERASE_CODE_FLASH: KiB length (u16) + 2 reserved; data_len 0x04.
  eqBytes('eraseCode 6816', frameEraseCode(6816), [0xa4, 0x04, 0x00, 0x08, 0x00, 0x00, 0x00]);

  // FLASH_RW: [offset u32 LE][_u1=0][data]; data_len = len + 5.
  const data56 = new Uint8Array(56).fill(0xab);
  const fr = frameFlashRw(Cmd.WRITE_CODE_FLASH, 0x0102, data56);
  eq('flashRw total length', fr.length, 3 + 5 + 56); // 64
  // [0]cmd [1..2]data_len LE [3..6]offset u32 LE [7]_u1(=0) [8..]data
  eqBytes('flashRw header+offset+u1', fr.subarray(0, 8), [
    0xa5, 0x3d, 0x00, 0x02, 0x01, 0x00, 0x00, 0x00, // data_len 0x3d(61), offset 0x00000102 LE, _u1=0
  ]);
  eq('flashRw _u1 is zero', fr[7], 0x00);
  eq('flashRw first data byte', fr[8], 0xab);

  // CMP uses the same layout with command 0xa6.
  eq('flashRw cmp command', frameFlashRw(Cmd.CMP_CODE_FLASH, 0, new Uint8Array(8))[0], 0xa6);

  // A short (40-byte) final chunk -> data_len = 45 = 0x2d.
  const frShort = frameFlashRw(Cmd.WRITE_CODE_FLASH, 6776, new Uint8Array(40));
  eqBytes('flashRw short header', frShort.subarray(0, 3), [0xa5, 0x2d, 0x00]);
  eqBytes('flashRw short offset LE', frShort.subarray(3, 7), [0x78, 0x1a, 0x00, 0x00]); // 6776 = 0x1a78

  // REBOOT: exactly [a2 01 00 01].
  eqBytes('reboot', frameReboot(), [0xa2, 0x01, 0x00, 0x01]);
}

// ===========================================================================
// Response parsers.
// ===========================================================================
{
  // CHIP_TYPE reply for CH552: a1 00 02 00 52 11.
  const ctResp = Uint8Array.from([0xa1, 0x00, 0x02, 0x00, 0x52, 0x11]);
  const parsed = parseChipType(ctResp);
  eq('parseChipType type', parsed.type, 0x52);
  eq('parseChipType family', parsed.family, 0x11);
  const prof = findProfile(parsed.family, parsed.type);
  eq('findProfile -> CH552', prof?.name, 'CH552');
  eq('CH552 mcuIdLen', prof?.mcuIdLen, 4);
  eq('CH552 needLastWrite false', prof?.needLastWrite, false);
  eq('CH552 code flash size', prof?.codeFlashSize, 14336);

  // READ_CONFIG reply from protocol.txt (CH579, 2.8.0 bootloader).
  const cfgResp = Uint8Array.from([
    0xa7, 0x00, 0x1a, 0x00, 0x1f, 0x00, 0xff, 0xff, 0xff, 0xff, 0x23, 0x00, 0x00, 0x00, 0x47, 0x52,
    0x00, 0x50, 0x00, 0x02, 0x08, 0x00, 0x5f, 0x43, 0x57, 0xe4, 0xc2, 0x84, 0x78, 0xac,
  ]);
  const rc = parseReadConfig(cfgResp);
  eqBytes('parseReadConfig config', rc.config, [
    0xff, 0xff, 0xff, 0xff, 0x23, 0x00, 0x00, 0x00, 0x47, 0x52, 0x00, 0x50,
  ]);
  eq('parseReadConfig bootloader BE', rc.bootloaderVersion, 0x00020800);
  eqBytes('parseReadConfig id (7 bytes)', rc.id, [0x5f, 0x43, 0x57, 0xe4, 0xc2, 0x84, 0x78]);

  // return_code / key_checksum little-endian at bytes [4..5].
  eq('parseReturnCode ok', parseReturnCode(Uint8Array.from([0xa4, 0x00, 0x02, 0x00, 0x00, 0x00])), 0);
  eq('parseReturnCode err', parseReturnCode(Uint8Array.from([0xa4, 0x00, 0x02, 0x00, 0x05, 0x00])), 5);
  eq('parseKeyChecksum', parseKeyChecksum(Uint8Array.from([0xa3, 0x00, 0x02, 0x00, 0x3a, 0x00])), 0x3a);
}

// ===========================================================================
// Bootloader version gating (isp55e0.c main lines 977-994).
// ===========================================================================
{
  eq('2.4.0 does not wait reboot ack', bootloaderSupport(0x020400).waitRebootResp, false);
  const b25 = bootloaderSupport(0x020500);
  eq('2.5.0 major', b25.major, 2);
  eq('2.5.0 minor', b25.minor, 5);
  eq('2.5.0 patch', b25.patch, 0);
  eq('2.5.0 waits reboot ack', b25.waitRebootResp, true);
  eq('2.8.0 waits reboot ack', bootloaderSupport(0x020800).waitRebootResp, true);
  let threw = false;
  try {
    bootloaderSupport(0x030000);
  } catch {
    threw = true;
  }
  check('unsupported bootloader throws', threw);
}

// ===========================================================================
// End-to-end shape for the real PadKit image size (6815 bytes).
// ===========================================================================
{
  const fw = new Uint8Array(6815);
  for (let i = 0; i < fw.length; i++) fw[i] = (i * 31 + 7) & 0xff;
  const padded = padFirmware(fw);
  eq('padded padkit size', padded.length, 6816);
  const key = deriveXorKey(Uint8Array.from([0x11, 0x22, 0x33, 0x44]), 4, 0x52);
  const enc = xorInPlace(padded.slice(), key);
  const plan = chunkPlan(enc.length);
  eq('padkit chunk count', plan.length, 122);
  // Reassemble the encrypted chunks and decrypt -> must equal the padded image.
  const reassembled = new Uint8Array(enc.length);
  for (const c of plan) reassembled.set(enc.subarray(c.offset, c.offset + c.length), c.offset);
  xorInPlace(reassembled, key);
  check('reassembled+decrypted equals padded image', reassembled.every((b, i) => b === padded[i]));
  eq('padkit erase length', eraseLengthKiB(padded.length), 8);
}

console.log(`\nPadKit ISP codec self-test: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
