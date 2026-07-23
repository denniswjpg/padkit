// SPDX-License-Identifier: MIT

import {
  Cmd,
  deriveXorKey,
  keyChecksum,
  padFirmware,
  toHex,
  xorInPlace,
} from './isp.ts';
import { isBootloaderDevice, pickBootloader, runFlash, type Progress } from './flash-core.ts';

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

const CHIP_TYPE = 0x52;
const CHIP_FAMILY = 0x11;
const MCU_ID = Uint8Array.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
const KEY = deriveXorKey(MCU_ID, 4, CHIP_TYPE);
const CODE_FLASH_SIZE = 14336;

class MockBootloader {
  readonly vendorId = 0x4348;
  readonly productId = 0x55e0;
  opened = false;
  configuration: USBConfiguration | null = null;
  readonly configurations: USBConfiguration[] = [];
  flash = new Uint8Array(CODE_FLASH_SIZE).fill(0xff);
  cmpMismatch = false;
  sawReboot = false;
  rebootReadAttempts = 0;
  log: number[] = [];
  private pending: Uint8Array | null = null;

  private readonly mockConfig: USBConfiguration = {
    configurationValue: 1,
    interfaces: [
      {
        interfaceNumber: 0,
        claimed: false,
        alternates: [],
        alternate: {
          alternateSetting: 0,
          interfaceClass: 0xff,
          interfaceSubclass: 0,
          interfaceProtocol: 0,
          endpoints: [
            { endpointNumber: 2, direction: 'out', type: 'bulk', packetSize: 64 },
            { endpointNumber: 2, direction: 'in', type: 'bulk', packetSize: 64 },
          ],
        },
      },
    ],
  };

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  async selectConfiguration(): Promise<void> {
    this.configuration = this.mockConfig;
  }
  async claimInterface(): Promise<void> {}
  async releaseInterface(): Promise<void> {}
  async clearHalt(): Promise<void> {}

  async transferOut(_ep: number, data: Uint8Array): Promise<USBOutTransferResult> {
    const cmd = data[0]!;
    this.log.push(cmd);
    this.pending = this.handle(data);
    return { bytesWritten: data.length, status: 'ok' };
  }

  async transferIn(_ep: number, _length: number): Promise<USBInTransferResult> {
    if (this.sawReboot) {

      this.rebootReadAttempts++;
      throw new Error('device disconnected');
    }
    const resp = this.pending ?? new Uint8Array(6);
    this.pending = null;
    const copy = resp.slice();
    return { data: new DataView(copy.buffer), status: 'ok' };
  }

  private resp(cmd: number, payload: number[]): Uint8Array {
    return Uint8Array.from([cmd, 0x00, payload.length, 0x00, ...payload]);
  }

  private handle(req: Uint8Array): Uint8Array {
    const cmd = req[0]!;
    switch (cmd) {
      case Cmd.CHIP_TYPE:
        return this.resp(cmd, [CHIP_TYPE, CHIP_FAMILY]);
      case Cmd.READ_CONFIG: {
        const config = [0xff, 0xff, 0xff, 0xff, 0x23, 0x00, 0x00, 0x00, 0x47, 0x52, 0x00, 0x50];
        const bvBE = [0x00, 0x02, 0x05, 0x00];
        const checksum = 0x00;
        return this.resp(cmd, [0x1f, 0x00, ...config, ...bvBE, ...Array.from(MCU_ID), checksum]);
      }
      case Cmd.SET_KEY:
        return this.resp(cmd, [keyChecksum(KEY), 0x00]);
      case Cmd.WRITE_CONFIG:
        return this.resp(cmd, [0x00, 0x00]);
      case Cmd.ERASE_CODE_FLASH:
        this.flash.fill(0xff);
        return this.resp(cmd, [0x00, 0x00]);
      case Cmd.WRITE_CODE_FLASH: {
        const offset = req[3]! | (req[4]! << 8) | (req[5]! << 16) | (req[6]! << 24);
        const chunk = req.subarray(8);
        this.flash.set(chunk, offset);
        return this.resp(cmd, [0x00, 0x00]);
      }
      case Cmd.CMP_CODE_FLASH: {
        const offset = req[3]! | (req[4]! << 8) | (req[5]! << 16) | (req[6]! << 24);
        const chunk = req.subarray(8);
        for (let i = 0; i < chunk.length; i++) {
          if (this.flash[offset + i] !== chunk[i]) this.cmpMismatch = true;
        }
        return this.resp(cmd, [this.cmpMismatch ? 0x01 : 0x00, 0x00]);
      }
      case Cmd.REBOOT:
        this.sawReboot = true;
        return this.resp(cmd, [0x00, 0x00]);
      default:
        return this.resp(cmd, [0xff, 0x00]);
    }
  }
}

const firmware = new Uint8Array(6815);
for (let i = 0; i < firmware.length; i++) firmware[i] = (i * 91 + 13) & 0xff;

const dev = new MockBootloader();
const phases: Progress[] = [];

const result = await runFlash(dev as unknown as USBDevice, firmware, (p) => phases.push(p));

eq('chipName', result.chipName, 'CH552');
eq('bootloader', result.bootloader, '2.5.0');
eq('chipId', result.chipId, '11-22-33-44');
eq('chunks', result.chunks, 122);

const firstOf = (c: number) => dev.log.indexOf(c);
check('SET_KEY before ERASE', firstOf(Cmd.SET_KEY) < firstOf(Cmd.ERASE_CODE_FLASH));
check('WRITE_CONFIG after first SET_KEY', firstOf(Cmd.WRITE_CONFIG) > firstOf(Cmd.SET_KEY));
check('ERASE before first WRITE', firstOf(Cmd.ERASE_CODE_FLASH) < firstOf(Cmd.WRITE_CODE_FLASH));
check('WRITE before CMP', firstOf(Cmd.WRITE_CODE_FLASH) < firstOf(Cmd.CMP_CODE_FLASH));
check('REBOOT is last', dev.log[dev.log.length - 1] === Cmd.REBOOT);
eq('SET_KEY sent twice (flash + verify)', dev.log.filter((c) => c === Cmd.SET_KEY).length, 2);
eq('122 write commands', dev.log.filter((c) => c === Cmd.WRITE_CODE_FLASH).length, 122);
eq('122 compare commands', dev.log.filter((c) => c === Cmd.CMP_CODE_FLASH).length, 122);
eq('exactly one reboot', dev.log.filter((c) => c === Cmd.REBOOT).length, 1);

const padded = padFirmware(firmware);
const decrypted = xorInPlace(dev.flash.subarray(0, padded.length).slice(), KEY);
check('flashed image (decrypted) matches padded firmware', decrypted.every((b, i) => b === padded[i]));
check('no compare mismatch', !dev.cmpMismatch);

check('reboot ack read was attempted and swallowed', dev.rebootReadAttempts >= 1);

check('progress reached writing total', phases.some((p) => p.phase === 'writing' && p.done === 122));
check('progress reached verifying total', phases.some((p) => p.phase === 'verifying' && p.done === 122));
check('progress ended done', phases.some((p) => p.phase === 'done'));

check('key derivation stable', toHex(KEY) === toHex(deriveXorKey(MCU_ID, 4, CHIP_TYPE)));

{
  const boot4348 = { vendorId: 0x4348, productId: 0x55e0 };
  const boot1a86 = { vendorId: 0x1a86, productId: 0x55e0 };
  const appHid = { vendorId: 0x1189, productId: 0x8890 };
  const other = { vendorId: 0x1234, productId: 0x5678 };

  check('isBootloaderDevice 4348:55e0', isBootloaderDevice(boot4348));
  check('isBootloaderDevice 1a86:55e0', isBootloaderDevice(boot1a86));
  check('isBootloaderDevice rejects app HID 1189:8890', !isBootloaderDevice(appHid));
  check('isBootloaderDevice rejects same PID wrong VID', !isBootloaderDevice({ vendorId: 0x9999, productId: 0x55e0 }));
  check('isBootloaderDevice rejects unrelated', !isBootloaderDevice(other));

  eq('pickBootloader none present', pickBootloader([appHid, other]), undefined);
  eq('pickBootloader empty list', pickBootloader([]), undefined);
  check('pickBootloader finds the bootloader among others', pickBootloader([appHid, boot4348, other]) === boot4348);
  check('pickBootloader returns first bootloader', pickBootloader([boot1a86, boot4348]) === boot1a86);
}

console.log(`\nPadKit flasher integration self-test: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
