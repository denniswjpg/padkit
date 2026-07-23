// Offline demo mode. SPDX-License-Identifier: MIT
//
// Wires the in-memory MockPadKit (src/mock.ts) into the real UI so the tool can
// be previewed with NO hardware attached — triggered by `?demo=1` or `#demo`.
// It fabricates a minimal HIDDevice that answers the 32-byte protocol from the
// mock, hands it to PadKit.connectDemo(), then emits a trickle of synthetic
// INPUT_EVENTs so the live monitor shows activity. None of this touches the
// normal (real-hardware) code path.

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

/** A pleasant, distinct per-key palette for the 3×2 cap grid. */
const DEMO_COLORS: Rgb[] = [
  { r: 0xff, g: 0x54, b: 0x70 }, // coral
  { r: 0xff, g: 0x9f, b: 0x1c }, // amber
  { r: 0xff, g: 0xd2, b: 0x3f }, // gold
  { r: 0x38, g: 0xd9, b: 0xa9 }, // teal
  { r: 0x4d, g: 0xab, b: 0xf7 }, // sky
  { r: 0xb1, g: 0x97, b: 0xfc }, // violet
];

type InputListener = (ev: { data: DataView }) => void;

/**
 * A stand-in for a WebHID HIDDevice backed by MockPadKit. Implements just the
 * surface PadKit touches: open/close, sendReport, collections, and the
 * inputreport listener. Replies are delivered asynchronously to mimic hardware.
 */
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

  /** Push a device→host report to PadKit's inputreport handler. */
  deliver(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    setTimeout(() => {
      for (const cb of this.inputListeners) cb({ data: view });
    }, 0);
  }
}

// A short scripted sequence of physical events for the live monitor.
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

/**
 * Boot the demo against the app's PadKit instance. Populates the mock with a
 * colorful config, connects, then loops the synthetic input script.
 */
export async function startDemo(pad: PadKit): Promise<void> {
  const mock = new MockPadKit();
  for (let i = 0; i < KEY_COUNT; i++) mock.state.rgb[i] = DEMO_COLORS[i]!;
  mock.state.brightness = 220;
  mock.state.effect = 0; // STATIC — shows the per-key colors
  mock.state.saved = true;

  const device = new DemoHidDevice(mock);
  await pad.connectDemo(device as unknown as HIDDevice);

  // Trickle synthetic events into the live monitor.
  let i = 0;
  const step = () => {
    const ev = SCRIPT[i % SCRIPT.length]!;
    device.deliver(mock.inputEvent(ev.control, ev.action));
    i++;
  };
  step();
  demoTimer = setInterval(step, 1100);
}

/** True when the URL asks for demo mode. */
export function isDemoRequested(): boolean {
  try {
    const p = new URLSearchParams(location.search);
    return p.get('demo') === '1' || location.hash.replace('#', '') === 'demo';
  } catch {
    return false;
  }
}

/** Stop the synthetic event loop (used by tests / teardown). */
export function stopDemo(): void {
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = undefined;
}
