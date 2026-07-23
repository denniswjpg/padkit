// SPDX-License-Identifier: MIT

import { MockPadKit } from './mock.ts';
import { PadKit } from './padkit-hid.ts';
import {
  Action,
  KEY_COUNT,
  SLOT_KNOB_CCW,
  SLOT_KNOB_CLICK,
  SLOT_KNOB_CW,
  VENDOR_USAGE,
  VENDOR_USAGE_PAGE,
  type Rgb,
} from './protocol.ts';

const DEMO_COLORS: Rgb[] = [
  { r: 0xff, g: 0x54, b: 0x70 },
  { r: 0xff, g: 0x9f, b: 0x1c },
  { r: 0xff, g: 0xd2, b: 0x3f },
  { r: 0x38, g: 0xd9, b: 0xa9 },
  { r: 0x4d, g: 0xab, b: 0xf7 },
  { r: 0xb1, g: 0x97, b: 0xfc },
];

type InputListener = (ev: { data: DataView }) => void;

class DemoHidDevice {
  opened = false;
  readonly productName = 'PadKit';
  readonly collections = [{ usagePage: VENDOR_USAGE_PAGE, usage: VENDOR_USAGE }];
  private readonly inputListeners = new Set<InputListener>();

  constructor(private readonly mock: MockPadKit) {}

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }

  addEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    if (type === 'inputreport') this.inputListeners.add(cb as unknown as InputListener);
  }
  removeEventListener(type: string, cb: EventListenerOrEventListenerObject): void {
    if (type === 'inputreport') this.inputListeners.delete(cb as unknown as InputListener);
  }

  async sendReport(_reportId: number, data: Uint8Array): Promise<void> {
    const reply = this.mock.handleOutput(data);
    if (reply) this.deliver(reply);
  }

  deliver(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    setTimeout(() => {
      for (const cb of this.inputListeners) cb({ data: view });
    }, 0);
  }
}

const SCRIPT: { control: number; action: number }[] = [
  { control: 0, action: Action.KEY_DOWN },
  { control: 0, action: Action.KEY_UP },
  { control: SLOT_KNOB_CW, action: Action.KNOB_CW },
  { control: 4, action: Action.KEY_DOWN },
  { control: 4, action: Action.KEY_UP },
  { control: SLOT_KNOB_CLICK, action: Action.KNOB_CLICK },
  { control: 2, action: Action.KEY_DOWN },
  { control: 2, action: Action.KEY_UP },
  { control: SLOT_KNOB_CCW, action: Action.KNOB_CCW },
];

let demoTimer: ReturnType<typeof setInterval> | undefined;

export async function startDemo(pad: PadKit): Promise<void> {
  const mock = new MockPadKit();
  for (let i = 0; i < KEY_COUNT; i++) mock.state.rgb[i] = DEMO_COLORS[i]!;
  mock.state.brightness = 220;
  mock.state.effect = 0;
  mock.state.saved = true;

  const device = new DemoHidDevice(mock);
  await pad.connectDemo(device as unknown as HIDDevice);

  let i = 0;
  const step = () => {
    const ev = SCRIPT[i % SCRIPT.length]!;
    device.deliver(mock.inputEvent(ev.control, ev.action));
    i++;
  };
  step();
  demoTimer = setInterval(step, 1100);
}

export function isDemoRequested(): boolean {
  try {
    const p = new URLSearchParams(location.search);
    return p.get('demo') === '1' || location.hash.replace('#', '') === 'demo';
  } catch {
    return false;
  }
}

export function stopDemo(): void {
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = undefined;
}
