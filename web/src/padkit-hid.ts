// PadKit WebHID transport — host side of docs/protocol-v2.md.
// SPDX-License-Identifier: MIT
//
// Wraps a single PadKit vendor-HID collection: requests the device, opens the
// 0xFF60 collection (never the keyboard collection), sends 32-byte output
// reports and decodes the 32-byte input reports into typed callbacks.

import {
  Action,
  Cmd,
  InputType,
  REPORT_SIZE,
  USB_PRODUCT_ID,
  USB_VENDOR_ID,
  VENDOR_USAGE,
  VENDOR_USAGE_PAGE,
  decodeAck,
  decodeConfigDump,
  decodeFwInfo,
  decodeInputEvent,
  encodeGetConfig,
  encodeGetInfo,
  encodeIdentify,
  encodeLoadDefaults,
  encodeSave,
  encodeSetBrightness,
  encodeSetEffect,
  encodeSetFlags,
  encodeSetIdleDim,
  encodeSetKey,
  encodeSetRgb,
  inputReportType,
  type Ack,
  type ConfigDump,
  type FwInfo,
  type InputEvent,
  type KeyMapEntry,
  type Rgb,
} from './protocol.ts';

export type { Ack, ConfigDump, FwInfo, InputEvent, KeyMapEntry, Rgb };
export { Action, InputType };

export interface PadKitEvents {
  connect: (info: { info: FwInfo | null; config: ConfigDump | null }) => void;
  disconnect: () => void;
  input: (ev: InputEvent) => void;
  config: (cfg: ConfigDump) => void;
  info: (info: FwInfo) => void;
  ack: (ack: Ack) => void;
  error: (message: string) => void;
}

type Listener<K extends keyof PadKitEvents> = PadKitEvents[K];

/** True when the current browser exposes the WebHID API. */
export function isWebHidSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.hid;
}

export class PadKit {
  private device: HIDDevice | null = null;
  private readonly listeners: { [K in keyof PadKitEvents]: Set<Listener<K>> } = {
    connect: new Set(),
    disconnect: new Set(),
    input: new Set(),
    config: new Set(),
    info: new Set(),
    ack: new Set(),
    error: new Set(),
  };
  // Pending ACK waiters keyed by the command byte they expect.
  private ackWaiters = new Map<number, Array<(ack: Ack) => void>>();

  private readonly onInputReport = (event: HIDInputReportEvent) => {
    this.handleInputReport(event.data);
  };
  private readonly onDisconnect = (event: HIDConnectionEvent) => {
    if (this.device && event.device === this.device) {
      this.teardown();
      this.emit('disconnect');
    }
  };

  get connected(): boolean {
    return !!this.device && this.device.opened;
  }

  get deviceName(): string {
    return this.device?.productName || 'PadKit';
  }

  on<K extends keyof PadKitEvents>(event: K, cb: Listener<K>): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private emit<K extends keyof PadKitEvents>(event: K, ...args: Parameters<Listener<K>>): void {
    for (const cb of this.listeners[event]) {
      (cb as (...a: unknown[]) => void)(...args);
    }
  }

  /**
   * Prompt the user to pick a PadKit, open its vendor collection, then read
   * back FW_INFO + CONFIG so the UI can populate. Must be called from a user
   * gesture (click). Returns the info/config gathered on connect.
   */
  async connect(): Promise<{ info: FwInfo | null; config: ConfigDump | null }> {
    if (!isWebHidSupported()) {
      throw new Error('WebHID is not available in this browser. Use Chrome or Edge.');
    }
    const devices = await navigator.hid!.requestDevice({
      filters: [
        {
          vendorId: USB_VENDOR_ID,
          productId: USB_PRODUCT_ID,
          usagePage: VENDOR_USAGE_PAGE,
          usage: VENDOR_USAGE,
        },
      ],
    });

    // Critical (§1/§9): select the collection whose usagePage == 0xFF60, never
    // "the first HID path" (that is the keyboard collection and will fail).
    const device = pickVendorDevice(devices);
    if (!device) {
      throw new Error(
        'No PadKit vendor interface found. The keyboard interface cannot be used for config; ' +
          'make sure the pad runs v0.2+ firmware.',
      );
    }

    return this.initDevice(device);
  }

  /**
   * Wire an already-chosen device: open it, attach the input-report listener,
   * then read back FW_INFO + CONFIG. Shared by connect(), the silent reconnect
   * path and the offline demo (which passes a synthetic device).
   */
  private async initDevice(device: HIDDevice): Promise<{ info: FwInfo | null; config: ConfigDump | null }> {
    if (!device.opened) await device.open();
    this.device = device;
    device.addEventListener('inputreport', this.onInputReport);
    if (isWebHidSupported()) navigator.hid!.addEventListener('disconnect', this.onDisconnect);

    // Kick off the initial reads and wait briefly for the replies.
    const infoP = this.once('info', 1500);
    const configP = this.once('config', 1500);
    await this.send(encodeGetInfo());
    await this.send(encodeGetConfig());
    const [info, config] = await Promise.all([infoP, configP]);

    const payload = { info, config };
    this.emit('connect', payload);
    return payload;
  }

  /**
   * Offline demo entry point: attach a caller-provided synthetic device that
   * answers the protocol from an in-memory model, without prompting for real
   * hardware. Only used by src/demo.ts; the normal path never calls this.
   */
  connectDemo(device: HIDDevice): Promise<{ info: FwInfo | null; config: ConfigDump | null }> {
    return this.initDevice(device);
  }

  /** Reconnect silently to an already-granted device (no picker), if present. */
  async tryReconnectGranted(): Promise<boolean> {
    if (!isWebHidSupported()) return false;
    const granted = await navigator.hid!.getDevices();
    const device = pickVendorDevice(granted);
    if (!device) return false;
    await this.initDevice(device);
    return true;
  }

  async disconnect(): Promise<void> {
    const dev = this.device;
    this.teardown();
    if (dev && dev.opened) {
      try {
        await dev.close();
      } catch {
        /* ignore */
      }
    }
    this.emit('disconnect');
  }

  private teardown(): void {
    if (this.device) this.device.removeEventListener('inputreport', this.onInputReport);
    if (isWebHidSupported()) navigator.hid!.removeEventListener('disconnect', this.onDisconnect);
    this.device = null;
    for (const waiters of this.ackWaiters.values()) waiters.length = 0;
    this.ackWaiters.clear();
  }

  private handleInputReport(data: DataView): void {
    switch (inputReportType(data)) {
      case InputType.INPUT_EVENT:
        this.emit('input', decodeInputEvent(data));
        break;
      case InputType.CONFIG_DUMP:
        this.emit('config', decodeConfigDump(data));
        break;
      case InputType.FW_INFO:
        this.emit('info', decodeFwInfo(data));
        break;
      case InputType.ACK: {
        const ack = decodeAck(data);
        this.emit('ack', ack);
        const waiters = this.ackWaiters.get(ack.cmd);
        if (waiters && waiters.length) {
          const resolve = waiters.shift()!;
          resolve(ack);
        }
        break;
      }
      default:
        // Unknown type byte: ignore (forward-compatible per §9).
        break;
    }
  }

  /** Resolve on the next event of `name`, or null after `timeoutMs`. */
  private once<K extends 'info' | 'config'>(
    name: K,
    timeoutMs: number,
  ): Promise<Parameters<PadKitEvents[K]>[0] | null> {
    return new Promise((resolve) => {
      const off = this.on(name, ((value: Parameters<PadKitEvents[K]>[0]) => {
        clearTimeout(timer);
        off();
        resolve(value);
      }) as PadKitEvents[K]);
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  /** Send a raw 32-byte output report (report id 0, no report id byte). */
  async send(report: Uint8Array): Promise<void> {
    if (!this.device) throw new Error('Not connected');
    // Copy into a fresh ArrayBuffer-backed view: guarantees the OS-required
    // full 32-byte length and a plain (non-shared) buffer for sendReport.
    const buf = new Uint8Array(REPORT_SIZE);
    buf.set(report.subarray(0, REPORT_SIZE));
    await this.device.sendReport(0, buf);
  }

  // --- High-level commands (§3) ------------------------------------------

  setRgb(colors: Rgb[]): Promise<void> {
    return this.send(encodeSetRgb(colors));
  }

  setBrightness(value: number): Promise<void> {
    return this.send(encodeSetBrightness(value));
  }

  setEffect(effectId: number, params: number[] = []): Promise<void> {
    return this.send(encodeSetEffect(effectId, params));
  }

  setKey(slot: number, entry: KeyMapEntry): Promise<void> {
    return this.send(encodeSetKey(slot, entry));
  }

  setFlags(flags: number): Promise<void> {
    return this.send(encodeSetFlags(flags));
  }

  identify(slot: number): Promise<void> {
    return this.send(encodeIdentify(slot));
  }

  setIdleDim(enable: boolean, timeoutMs: number): Promise<void> {
    return this.send(encodeSetIdleDim(enable, timeoutMs));
  }

  getConfig(): Promise<void> {
    return this.send(encodeGetConfig());
  }

  getInfo(): Promise<void> {
    return this.send(encodeGetInfo());
  }

  /** SAVE (0x06) and wait for the ACK. Rejects on timeout or error status. */
  async save(timeoutMs = 2000): Promise<Ack> {
    const ackP = this.waitAck(Cmd.SAVE, timeoutMs);
    await this.send(encodeSave());
    return ackP;
  }

  /** LOAD_DEFAULTS (0x07) and wait for the ACK, then re-read config. */
  async loadDefaults(timeoutMs = 2000): Promise<Ack> {
    const ackP = this.waitAck(Cmd.LOAD_DEFAULTS, timeoutMs);
    await this.send(encodeLoadDefaults());
    const ack = await ackP;
    await this.getConfig();
    return ack;
  }

  private waitAck(cmd: number, timeoutMs: number): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const list = this.ackWaiters.get(cmd) ?? [];
      const wrapped = (ack: Ack) => {
        clearTimeout(timer);
        if (ack.status === 0) resolve(ack);
        else reject(new Error(`Device reported error (status ${ack.status})`));
      };
      list.push(wrapped);
      this.ackWaiters.set(cmd, list);
      const timer = setTimeout(() => {
        const arr = this.ackWaiters.get(cmd);
        if (arr) {
          const idx = arr.indexOf(wrapped);
          if (idx >= 0) arr.splice(idx, 1);
        }
        reject(new Error('Timed out waiting for device ACK'));
      }, timeoutMs);
    });
  }
}

/** Choose the HIDDevice exposing the 0xFF60 vendor collection. */
export function pickVendorDevice(devices: HIDDevice[]): HIDDevice | null {
  for (const d of devices) {
    if (d.collections.some((c) => c.usagePage === VENDOR_USAGE_PAGE)) return d;
  }
  // Fallback: some platforms report a single collection view; match by usage.
  for (const d of devices) {
    if (d.collections.some((c) => c.usage === VENDOR_USAGE)) return d;
  }
  return devices.length === 1 ? (devices[0] ?? null) : null;
}
