// SPDX-License-Identifier: MIT

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

export const XOR_KEY_LEN = 8;
export const CHUNK_SIZE = 56;
export const IDENTIFY_STRING = 'MCU ISP & WCH.CN';

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

export function deriveXorKey(id: Uint8Array, mcuIdLen: number, chipType: number): Uint8Array {
  let sum = 0;
  for (let i = 0; i < mcuIdLen; i++) sum = (sum + (id[i] ?? 0)) & 0xff;
  const key = new Uint8Array(XOR_KEY_LEN).fill(sum);
  key[7] = (key[7]! + chipType) & 0xff;
  return key;
}

export function keyChecksum(key: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < XOR_KEY_LEN; i++) sum = (sum + (key[i] ?? 0)) & 0xff;
  return sum;
}

export function padFirmware(bytes: Uint8Array): Uint8Array {
  const len = (bytes.length + 7) & ~7;
  const out = new Uint8Array(len).fill(0xff);
  out.set(bytes);
  return out;
}

export function xorInPlace(buf: Uint8Array, key: Uint8Array): Uint8Array {
  for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % XOR_KEY_LEN]!;
  return buf;
}

export function eraseLengthKiB(fwLen: number): number {
  let length = ((fwLen + 1023) & ~1023) / 1024;
  if (length < 8) length = 8;
  return length;
}

export interface Chunk {
  offset: number;
  length: number;
}

export function chunkPlan(totalLen: number, size = CHUNK_SIZE): Chunk[] {
  const chunks: Chunk[] = [];
  for (let offset = 0; offset < totalLen; offset += size) {
    chunks.push({ offset, length: Math.min(size, totalLen - offset) });
  }
  return chunks;
}

export function frame(command: number, payload: Uint8Array | number[] = []): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : Uint8Array.from(payload);
  const out = new Uint8Array(3 + body.length);
  out[0] = command & 0xff;
  out[1] = body.length & 0xff;
  out[2] = (body.length >> 8) & 0xff;
  out.set(body, 3);
  return out;
}

export function frameChipType(): Uint8Array {
  const s = IDENTIFY_STRING;
  const payload = new Uint8Array(2 + s.length);
  for (let i = 0; i < s.length; i++) payload[2 + i] = s.charCodeAt(i);
  return frame(Cmd.CHIP_TYPE, payload);
}

export function frameReadConfig(): Uint8Array {
  return frame(Cmd.READ_CONFIG, [0x1f, 0x00]);
}

export function frameWriteConfig(config: Uint8Array): Uint8Array {
  const payload = new Uint8Array(2 + 12);
  payload[0] = 0x07;
  payload[1] = 0x00;
  payload.set(config.subarray(0, 12), 2);
  return frame(Cmd.WRITE_CONFIG, payload);
}

export function frameSetKey(): Uint8Array {
  return frame(Cmd.SET_KEY, new Uint8Array(30));
}

export function frameEraseCode(fwLen: number): Uint8Array {
  const kib = eraseLengthKiB(fwLen);
  return frame(Cmd.ERASE_CODE_FLASH, [kib & 0xff, (kib >> 8) & 0xff, 0, 0]);
}

export function frameFlashRw(command: number, offset: number, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(5 + data.length);
  payload[0] = offset & 0xff;
  payload[1] = (offset >>> 8) & 0xff;
  payload[2] = (offset >>> 16) & 0xff;
  payload[3] = (offset >>> 24) & 0xff;
  payload[4] = 0;
  payload.set(data, 5);
  return frame(command, payload);
}

export function frameLastWrite(fwLen: number): Uint8Array {
  const payload = new Uint8Array(5);
  payload[0] = fwLen & 0xff;
  payload[1] = (fwLen >>> 8) & 0xff;
  payload[2] = (fwLen >>> 16) & 0xff;
  payload[3] = (fwLen >>> 24) & 0xff;
  payload[4] = 0;
  return frame(Cmd.WRITE_CODE_FLASH, payload);
}

export function frameReboot(): Uint8Array {
  return frame(Cmd.REBOOT, [0x01]);
}

export interface ChipTypeResp {
  type: number;
  family: number;
}

export function parseChipType(resp: Uint8Array): ChipTypeResp {
  return { type: resp[4] ?? 0, family: resp[5] ?? 0 };
}

export interface ReadConfigResp {
  config: Uint8Array;
  bootloaderVersion: number;
  id: Uint8Array;
}

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

export function parseReturnCode(resp: Uint8Array): number {
  return ((resp[4] ?? 0) | ((resp[5] ?? 0) << 8)) & 0xffff;
}

export function parseKeyChecksum(resp: Uint8Array): number {
  return ((resp[4] ?? 0) | ((resp[5] ?? 0) << 8)) & 0xffff;
}

export interface BootloaderSupport {
  major: number;
  minor: number;
  patch: number;

  waitRebootResp: boolean;
}

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

export function toHex(bytes: Uint8Array, sep = ''): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(sep);
}
