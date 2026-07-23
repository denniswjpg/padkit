// WCH ISP protocol codec for the CH55x ROM bootloader — pure, framework-free.
// SPDX-License-Identifier: MIT
//
// This is a faithful TypeScript port of the byte layouts and command sequence
// in ../../flasher/isp55e0.c (the working, patched C flasher). Everything in
// this module is pure (no DOM, no WebUSB) so it can be unit-tested under Node;
// the WebUSB transport and UI live in flash.ts. Each function notes the
// isp55e0.c lines it mirrors.
//
// Frame layout (over USB bulk):
//   request  = [command:u8][data_len:u16 LE][ ...payload (data_len bytes) ]
//   response = [command:u8][_u0:u8][data_len:u8][_u1:u8][ ...payload ]
// (isp55e0.h struct req_hdr / struct resp_hdr)

// --- Command bytes (isp55e0.h) ---------------------------------------------
export const Cmd = {
  CHIP_TYPE: 0xa1,
  REBOOT: 0xa2,
  SET_KEY: 0xa3,
  ERASE_CODE_FLASH: 0xa4,
  WRITE_CODE_FLASH: 0xa5,
  CMP_CODE_FLASH: 0xa6,
  READ_CONFIG: 0xa7,
  WRITE_CONFIG: 0xa8,
} as const;

export const XOR_KEY_LEN = 8; // isp55e0.h
export const CHUNK_SIZE = 56; // struct req_flash_rw .data[56]
export const IDENTIFY_STRING = 'MCU ISP & WCH.CN'; // isp55e0.c read_chip_type()

// --- Chip profile (subset of ../../flasher/chips.h) ------------------------
// Only the CH55x 8-bit family (0x11) is relevant to PadKit's CH552G, but the
// whole family is listed so the flasher identifies a cousin part correctly.
// All family-0x11 parts use a 4-byte unique id and need NO trailing empty
// write (need_last_write is false — that flag is set only for CH543+/CH32).
export interface ChipProfile {
  name: string;
  family: number;
  type: number;
  codeFlashSize: number;
  mcuIdLen: number;
  needLastWrite: boolean;
}

export const PROFILES: ChipProfile[] = [
  { name: 'CH551', family: 0x11, type: 0x51, codeFlashSize: 10240, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH552', family: 0x11, type: 0x52, codeFlashSize: 14336, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH554', family: 0x11, type: 0x54, codeFlashSize: 14336, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH555', family: 0x11, type: 0x55, codeFlashSize: 61440, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH556', family: 0x11, type: 0x56, codeFlashSize: 61440, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH557', family: 0x11, type: 0x57, codeFlashSize: 61440, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH558', family: 0x11, type: 0x58, codeFlashSize: 61440, mcuIdLen: 4, needLastWrite: false },
  { name: 'CH559', family: 0x11, type: 0x59, codeFlashSize: 61440, mcuIdLen: 4, needLastWrite: false },
];

export function findProfile(family: number, type: number): ChipProfile | undefined {
  return PROFILES.find((p) => p.family === family && p.type === type);
}

// ---------------------------------------------------------------------------
// Pure crypto / layout helpers
// ---------------------------------------------------------------------------

/**
 * Derive the 8-byte XOR key exactly as isp55e0.c create_key() (lines 568-581):
 *   sum = (sum of the first mcuIdLen unique-id bytes) mod 256
 *   key[0..7] = sum;  key[7] = (key[7] + chipType) mod 256
 * The `+= type` on the last byte both binds the key to the chip and prevents
 * an all-zero key.
 */
export function deriveXorKey(id: Uint8Array, mcuIdLen: number, chipType: number): Uint8Array {
  let sum = 0;
  for (let i = 0; i < mcuIdLen; i++) sum = (sum + (id[i] ?? 0)) & 0xff;
  const key = new Uint8Array(XOR_KEY_LEN).fill(sum);
  key[7] = (key[7]! + chipType) & 0xff;
  return key;
}

/**
 * Checksum the device returns for SET_KEY: sum of the 8 key bytes, mod 256
 * (isp55e0.c send_key() lines 595-597 accumulate into a uint8_t).
 */
export function keyChecksum(key: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < XOR_KEY_LEN; i++) sum = (sum + (key[i] ?? 0)) & 0xff;
  return sum;
}

/**
 * Pad a firmware image up to an 8-byte boundary, filling the tail with 0xff
 * (isp55e0.c load_file() lines 526-538: `len = (size + 7) & ~7`, memset 0xff).
 * The 8-byte rounding is required — every flash chunk's data length must be a
 * multiple of 8 (protocol.txt).
 */
export function padFirmware(bytes: Uint8Array): Uint8Array {
  const len = (bytes.length + 7) & ~7;
  const out = new Uint8Array(len).fill(0xff);
  out.set(bytes);
  return out;
}

/**
 * XOR the whole buffer in place with the repeating 8-byte key, keyed on the
 * ABSOLUTE byte position (isp55e0.c encrypt_or_decrypt() lines 555-563:
 * `buf[i] ^= xor_key[i % XOR_KEY_LEN]`). isp55e0 encrypts the entire image
 * once up front and reuses it for both WRITE and CMP, so we do the same.
 */
export function xorInPlace(buf: Uint8Array, key: Uint8Array): Uint8Array {
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % XOR_KEY_LEN]!;
  return buf;
}

/**
 * Code-flash erase length in KiB blocks, min 8 (isp55e0.c erase_code_flash()
 * lines 491-494): `((fwLen + 1023) & ~1023) / 1024`, floored to 8.
 */
export function eraseLengthKiB(fwLen: number): number {
  let length = ((fwLen + 1023) & ~1023) / 1024;
  if (length < 8) length = 8;
  return length;
}

export interface Chunk {
  offset: number;
  length: number;
}

/**
 * Split a padded image into <=56-byte chunks (isp55e0.c flash_rw() lines
 * 626-653). The final chunk may be shorter but — because the image is padded
 * to 8 bytes — its length is always a multiple of 8.
 */
export function chunkPlan(totalLen: number, size = CHUNK_SIZE): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 0; offset < totalLen; offset += size) {
    chunks.push({ offset, length: Math.min(size, totalLen - offset) });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Request frame builders. Each returns the exact bytes to write to EP_OUT.
// ---------------------------------------------------------------------------

/** Prepend the 3-byte request header [command][len_lo][len_hi] to a payload. */
export function frame(command: number, payload: Uint8Array | number[] = []): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const out = new Uint8Array(3 + body.length);
  out[0] = command & 0xff;
  out[1] = body.length & 0xff;
  out[2] = (body.length >> 8) & 0xff;
  out.set(body, 3);
  return out;
}

/** CMD_CHIP_TYPE (0xa1): type/family bytes (ignored by ROM) + ident string. */
export function frameChipType(): Uint8Array {
  const s = IDENTIFY_STRING;
  const payload = new Uint8Array(2 + s.length); // type=0, family=0, then string
  for (let i = 0; i < s.length; i++) payload[2 + i] = s.charCodeAt(i);
  return frame(Cmd.CHIP_TYPE, payload);
}

/** CMD_READ_CONFIG (0xa7): `what = 0x1f` -> id + bootloader version + cfg. */
export function frameReadConfig(): Uint8Array {
  return frame(Cmd.READ_CONFIG, [0x1f, 0x00]);
}

/** CMD_WRITE_CONFIG (0xa8): `what = 0x07` + the 12 config bytes read back. */
export function frameWriteConfig(config: Uint8Array): Uint8Array {
  const payload = new Uint8Array(2 + 12);
  payload[0] = 0x07;
  payload[1] = 0x00;
  payload.set(config.subarray(0, 12), 2);
  return frame(Cmd.WRITE_CONFIG, payload);
}

/**
 * CMD_SET_KEY (0xa3): isp55e0.c send_key() transmits a fixed 30-byte
 * zero-filled seed (data_len 0x1e). With a zero seed the ROM's derived key
 * equals create_key()'s, and it replies with keyChecksum(key).
 */
export function frameSetKey(): Uint8Array {
  return frame(Cmd.SET_KEY, new Uint8Array(30));
}

/** CMD_ERASE_CODE_FLASH (0xa4): length in KiB (u16) + 2 reserved bytes. */
export function frameEraseCode(fwLen: number): Uint8Array {
  const kib = eraseLengthKiB(fwLen);
  return frame(Cmd.ERASE_CODE_FLASH, [kib & 0xff, (kib >> 8) & 0xff, 0, 0]);
}

/**
 * CMD_WRITE_CODE_FLASH (0xa5) / CMD_CMP_CODE_FLASH (0xa6) via flash_rw():
 * payload = [offset:u32 LE][_u1=0][ ...encrypted data ]; data_len = len + 5.
 * `data` must already be XOR-encrypted (see xorInPlace).
 */
export function frameFlashRw(command: number, offset: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(5 + data.length);
  payload[0] = offset & 0xff;
  payload[1] = (offset >>> 8) & 0xff;
  payload[2] = (offset >>> 16) & 0xff;
  payload[3] = (offset >>> 24) & 0xff;
  payload[4] = 0; // _u1 — isp55e0 leaves this zero
  payload.set(data, 5);
  return frame(command, payload);
}

/**
 * Final empty write for chips whose profile sets need_last_write
 * (isp55e0.c flash_rw() lines 655-668). CH55x does NOT need this; kept for
 * fidelity so the sequence is correct if a need_last_write part is ever seen.
 */
export function frameLastWrite(fwLen: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = fwLen & 0xff;
  payload[1] = (fwLen >>> 8) & 0xff;
  payload[2] = (fwLen >>> 16) & 0xff;
  payload[3] = (fwLen >>> 24) & 0xff;
  payload[4] = 0;
  return frame(Cmd.WRITE_CODE_FLASH, payload);
}

/** CMD_REBOOT (0xa2): option = 0x01 (isp55e0.c reboot_device()). */
export function frameReboot(): Uint8Array {
  return frame(Cmd.REBOOT, [0x01]);
}

// ---------------------------------------------------------------------------
// Response parsers. `resp` is the raw bytes read from EP_IN (4-byte resp_hdr
// then payload).
// ---------------------------------------------------------------------------

export interface ChipTypeResp {
  type: number;
  family: number;
}

/** Parse CMD_CHIP_TYPE reply. resp[4]=type, resp[5]=family (isp55e0.h). */
export function parseChipType(resp: Uint8Array): ChipTypeResp {
  return { type: resp[4] ?? 0, family: resp[5] ?? 0 };
}

export interface ReadConfigResp {
  config: Uint8Array; // 12 bytes
  bootloaderVersion: number; // e.g. 0x020500 for 2.5.0
  id: Uint8Array; // 7 raw id bytes (profile.mcuIdLen are used for the key)
}

/**
 * Parse CMD_READ_CONFIG reply (isp55e0.h struct resp_read_config):
 * [0..3]hdr [4..5]what [6..17]config[12] [18..21]bootloader_version(u32 BE)
 * [22..28]id[7] [29]id_checksum.
 */
export function parseReadConfig(resp: Uint8Array): ReadConfigResp {
  const config = resp.slice(6, 18);
  const bv =
    ((resp[18] ?? 0) << 24) |
    ((resp[19] ?? 0) << 16) |
    ((resp[20] ?? 0) << 8) |
    (resp[21] ?? 0);
  const id = resp.slice(22, 29);
  return { config, bootloaderVersion: bv >>> 0, id };
}

/** Little-endian u16 return_code at resp[4..5] (erase/write/cmp/config). */
export function parseReturnCode(resp: Uint8Array): number {
  return ((resp[4] ?? 0) | ((resp[5] ?? 0) << 8)) & 0xffff;
}

/** SET_KEY reply checksum at resp[4..5] (isp55e0.h struct resp_set_key). */
export function parseKeyChecksum(resp: Uint8Array): number {
  return ((resp[4] ?? 0) | ((resp[5] ?? 0) << 8)) & 0xffff;
}

export interface BootloaderSupport {
  major: number;
  minor: number;
  patch: number;
  /** true if this ROM ACKs CMD_REBOOT (2.5.0+); 2.5.0 in practice may not. */
  waitRebootResp: boolean;
}

/**
 * Gate on bootloader version exactly like isp55e0.c main() (lines 977-994):
 * 2.3.1 / 2.4.0 do not ACK reboot; 2.5.0..2.9.0 do; anything else is refused.
 * Throws on an unsupported bootloader.
 */
export function bootloaderSupport(bv: number): BootloaderSupport {
  const v = bv & 0xffffff;
  const major = (v >> 16) & 0xff;
  const minor = (v >> 8) & 0xff;
  const patch = v & 0xff;
  let waitRebootResp: boolean;
  switch (v) {
    case 0x020301:
    case 0x020400:
      waitRebootResp = false;
      break;
    case 0x020500:
    case 0x020600:
    case 0x020700:
    case 0x020800:
    case 0x020900:
      waitRebootResp = true;
      break;
    default:
      throw new Error(
        `Unsupported bootloader version ${major}.${minor}.${patch} (0x${v
          .toString(16)
          .padStart(6, '0')})`,
      );
  }
  return { major, minor, patch, waitRebootResp };
}

/** Short hex helper for logging ids/hashes. */
export function toHex(bytes: Uint8Array, sep = ''): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(sep);
}
