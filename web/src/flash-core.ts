// SPDX-License-Identifier: MIT

import {
  Cmd,
  bootloaderSupport,
  chunkPlan,
  deriveXorKey,
  findProfile,
  frameChipType,
  frameEraseCode,
  frameFlashRw,
  frameLastWrite,
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

export const FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x4348, productId: 0x55e0 },
  { vendorId: 0x1a86, productId: 0x55e0 },
];
export const INTERFACE_NUMBER = 0;
const DEFAULT_ENDPOINT = 2;
const FIRMWARE_URL = './firmware/padkit.bin';
const USB_TIMEOUT_MS = 5000;
export const POLL_INTERVAL_MS = 700;

export class FlashError extends Error {}

export function isBootloaderDevice(dev: { vendorId: number; productId: number }): boolean {
  return FILTERS.some((f) => f.vendorId === dev.vendorId && f.productId === dev.productId);
}

export function pickBootloader<T extends { vendorId: number; productId: number }>(
  devices: readonly T[],
): T | undefined {
  return devices.find(isBootloaderDevice);
}

interface Endpoints {
  out: number;
  in: number;
}

function findEndpoints(device: USBDevice): Endpoints {
  const eps: Endpoints = { out: DEFAULT_ENDPOINT, in: DEFAULT_ENDPOINT };
  const iface = device.configuration?.interfaces.find(
    (i) => i.interfaceNumber === INTERFACE_NUMBER,
  );
  for (const ep of iface?.alternate.endpoints ?? []) {
    if (ep.type !== 'bulk') continue;
    if (ep.direction === 'out') eps.out = ep.endpointNumber;
    else if (ep.direction === 'in') eps.in = ep.endpointNumber;
  }
  return eps;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new FlashError(`Timed out ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function transfer(
  device: USBDevice,
  eps: Endpoints,
  req: Uint8Array,
  expectResponse = true,
): Promise<Uint8Array> {
  const out = await withTimeout(device.transferOut(eps.out, req), USB_TIMEOUT_MS, 'sending request');
  if (out.status !== 'ok') throw new FlashError(`USB write failed (${out.status})`);
  if (!expectResponse) return new Uint8Array(0);
  const inRes = await withTimeout(device.transferIn(eps.in, 64), USB_TIMEOUT_MS, 'reading reply');
  if (inRes.status === 'stall') {
    await device.clearHalt('in', eps.in).catch(() => {});
    throw new FlashError('Device stalled the reply endpoint');
  }
  if (!inRes.data) throw new FlashError('Empty reply from device');
  return new Uint8Array(inRes.data.buffer, inRes.data.byteOffset, inRes.data.byteLength);
}

export interface Progress {
  phase: 'connecting' | 'identifying' | 'erasing' | 'writing' | 'verifying' | 'rebooting' | 'done';
  done?: number;
  total?: number;
  message?: string;
}

type OnProgress = (p: Progress) => void;

export async function runFlash(
  device: USBDevice,
  firmware: Uint8Array,
  onProgress: OnProgress,
): Promise<{ chipName: string; bootloader: string; chipId: string; chunks: number }> {
  onProgress({ phase: 'connecting', message: 'Opening device…' });
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(INTERFACE_NUMBER);

  const eps = findEndpoints(device);
  await device.clearHalt('out', eps.out).catch(() => {});
  await device.clearHalt('in', eps.in).catch(() => {});

  onProgress({ phase: 'identifying', message: 'Identifying chip…' });
  const typeResp = await transfer(device, eps, frameChipType());
  if ((typeResp[0] ?? 0) !== Cmd.CHIP_TYPE) {
    throw new FlashError('Unexpected reply to chip-type query (is this the WCH bootloader?)');
  }
  const { type, family } = parseChipType(typeResp);
  if (family === 0) {

    throw new FlashError('The chip did not return a WCH signature. Unplug it and redo the SW2 short.');
  }
  const profile = findProfile(family, type);
  if (!profile) {
    throw new FlashError(
      `Unsupported chip family 0x${family.toString(16)} type 0x${type.toString(16)}.`,
    );
  }

  const cfgResp = await transfer(device, eps, frameReadConfig());
  const { config, bootloaderVersion, id } = parseReadConfig(cfgResp);
  const support = bootloaderSupport(bootloaderVersion);
  const chipId = toHex(id.subarray(0, profile.mcuIdLen), '-');

  const padded = padFirmware(firmware);
  if (padded.length > profile.codeFlashSize) {
    throw new FlashError(
      `Firmware (${padded.length} B) does not fit ${profile.name} code flash (${profile.codeFlashSize} B).`,
    );
  }

  const key = deriveXorKey(id, profile.mcuIdLen, profile.type);
  const encrypted = xorInPlace(padded.slice(), key);
  const chunks = chunkPlan(encrypted.length);

  const sendKey = async () => {
    const resp = await transfer(device, eps, frameSetKey());
    if (parseKeyChecksum(resp) !== keyChecksum(key)) {
      throw new FlashError('Device rejected the encryption key.');
    }
  };

  await sendKey();
  await transfer(device, eps, frameWriteConfig(config));

  onProgress({ phase: 'erasing', message: 'Erasing code flash…' });
  const eraseResp = await transfer(device, eps, frameEraseCode(padded.length));
  if (parseReturnCode(eraseResp) !== 0) throw new FlashError('Device refused to erase code flash.');

  onProgress({ phase: 'writing', done: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const resp = await transfer(
      device,
      eps,
      frameFlashRw(Cmd.WRITE_CODE_FLASH, c.offset, encrypted.subarray(c.offset, c.offset + c.length)),
    );
    if (parseReturnCode(resp) !== 0) {
      throw new FlashError(`Write failed at offset ${c.offset}.`);
    }
    onProgress({ phase: 'writing', done: i + 1, total: chunks.length });
  }
  if (profile.needLastWrite) {

    const resp = await transfer(device, eps, frameLastWrite(padded.length));
    if (parseReturnCode(resp) !== 0) throw new FlashError('Final padding write failed.');
  }

  await sendKey();
  onProgress({ phase: 'verifying', done: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const resp = await transfer(
      device,
      eps,
      frameFlashRw(Cmd.CMP_CODE_FLASH, c.offset, encrypted.subarray(c.offset, c.offset + c.length)),
    );
    if (parseReturnCode(resp) !== 0) {
      throw new FlashError(`Verify mismatch at offset ${c.offset}.`);
    }
    onProgress({ phase: 'verifying', done: i + 1, total: chunks.length });
  }

  onProgress({ phase: 'rebooting', message: 'Rebooting…' });
  await transfer(device, eps, frameReboot(), false);
  if (support.waitRebootResp) {
    await withTimeout(device.transferIn(eps.in, 64), 600, 'reboot ack').catch(() => {});
  }

  onProgress({ phase: 'done' });
  return {
    chipName: profile.name,
    bootloader: `${support.major}.${support.minor}.${support.patch}`,
    chipId,
    chunks: chunks.length,
  };
}

export interface FirmwareInfo {
  bytes: Uint8Array;
  length: number;
  sha256: string;
}

export async function loadFirmware(): Promise<FirmwareInfo> {
  const res = await fetch(FIRMWARE_URL, { cache: 'no-store' });
  if (!res.ok) throw new FlashError(`Could not load firmware (${res.status} ${res.statusText}).`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let sha256 = '';
  try {
    if (crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      sha256 = toHex(new Uint8Array(digest));
    }
  } catch {
    sha256 = '';
  }
  return { bytes, length: bytes.length, sha256 };
}

export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';

  if (name === 'NotFoundError' || /No device selected|no device chosen/i.test(msg)) {
    return 'No pad was picked. Bridge SW2 while you plug the cable in, then choose PadKit from the list your browser shows.';
  }
  if (/access denied|SecurityError/i.test(name + msg)) {
    return 'The browser blocked access to the device. On Windows the bootloader needs the WinUSB driver, which is a one-time Zadig step. On macOS this should not happen, so unplug the pad and redo the SW2 short.';
  }
  if (/claim|Unable to claim|already in use|InvalidStateError/i.test(name + msg)) {
    return 'Another program is holding the pad. Close any other tab or tool using it, redo the SW2 short, and try again.';
  }
  if (/transfer|stall|Timed out|USB write|reply/i.test(msg)) {
    return `${msg}. Unplug the pad, bridge SW2 while you plug it back in, and flash again. The bootloader is in read-only ROM, so a failed flash is always recoverable.`;
  }
  return msg;
}
