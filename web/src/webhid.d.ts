// Minimal ambient declarations for the subset of WebHID this app uses.
// WebHID is a WICG spec not present in TypeScript's default lib.dom, so we
// declare only what padkit-hid.ts touches. Kept small on purpose (auditable,
// zero external @types dependency).
// SPDX-License-Identifier: MIT

interface HIDCollectionInfo {
  usagePage: number;
  usage: number;
  reportIds?: number[];
}

interface HIDDeviceFilter {
  vendorId?: number;
  productId?: number;
  usagePage?: number;
  usage?: number;
}

interface HIDDeviceRequestOptions {
  filters: HIDDeviceFilter[];
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice;
  readonly reportId: number;
  readonly data: DataView;
}

interface HIDDeviceEventMap {
  inputreport: HIDInputReportEvent;
}

interface HIDDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: HIDCollectionInfo[];
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HIDDeviceEventMap>(
    type: K,
    listener: (this: HIDDevice, ev: HIDDeviceEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice;
}

interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>;
  requestDevice(options: HIDDeviceRequestOptions): Promise<HIDDevice[]>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (ev: HIDConnectionEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (ev: HIDConnectionEvent) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
}

interface Navigator {
  readonly hid?: HID;
}
