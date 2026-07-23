// SPDX-License-Identifier: MIT

export const REPORT_SIZE = 32;

export const USB_VENDOR_ID = 0x1189;
export const USB_PRODUCT_ID = 0x8890;

export const VENDOR_USAGE_PAGE = 0xff60;
export const VENDOR_USAGE = 0x61;

export const Cmd = {
  SET_RGB: 0x01,
  SET_BRIGHTNESS: 0x02,
  SET_EFFECT: 0x03,
  SET_KEY: 0x04,
  SET_FLAGS: 0x05,
  SAVE: 0x06,
  LOAD_DEFAULTS: 0x07,
  GET_CONFIG: 0x08,
  GET_INFO: 0x09,
  IDENTIFY: 0x0a,
  SET_IDLE_DIM: 0x0b,
} as const;
export type CmdValue = (typeof Cmd)[keyof typeof Cmd];

export const InputType = {
  INPUT_EVENT: 0x81,
  CONFIG_DUMP: 0x82,
  FW_INFO: 0x83,
  ACK: 0x84,
} as const;
export type InputTypeValue = (typeof InputType)[keyof typeof InputType];

export const Action = {
  KEY_DOWN: 0x01,
  KEY_UP: 0x02,
  KNOB_CW: 0x10,
  KNOB_CCW: 0x11,
  KNOB_CLICK: 0x12,
  PUSH_TURN_CW: 0x20,
  PUSH_TURN_CCW: 0x21,
} as const;
export type ActionValue = (typeof Action)[keyof typeof Action];

export const Effect = {
  STATIC: 0,
  BREATHE: 1,
  RAINBOW: 2,
  REACTIVE: 3,
  SCANNER: 4,
} as const;
export type EffectValue = (typeof Effect)[keyof typeof Effect];

export const Flag = {
  SUPPRESS_KEYBOARD: 1 << 0,
  IDLE_DIM_ON: 1 << 1,
} as const;

export const Capability = {
  PERSISTENT_CONFIG: 1 << 0,
  KEYMAP_REMAP: 1 << 1,
  EFFECTS_MULTI: 1 << 2,
  IDLE_DIM: 1 << 3,
  PUSH_TURN_AXIS: 1 << 4,
} as const;

export const SLOT_KEY_1 = 0;
export const KEY_COUNT = 6;
export const SLOT_KNOB_CCW = 6;
export const SLOT_KNOB_CLICK = 7;
export const SLOT_KNOB_CW = 8;
export const SLOT_PUSHTURN_CCW = 9;
export const SLOT_PUSHTURN_CW = 10;
export const SLOT_COUNT = 11;

export const LED_COUNT = 6;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface KeyMapEntry {
  modifier: number;
  keycode: number;
}

export interface FwInfo {
  firmware: { major: number; minor: number };
  protocol: { major: number; minor: number };
  capabilities: number;
  keyCount: number;
  ledCount: number;
}

export interface ConfigDump {
  brightness: number;
  effect: number;
  flags: number;
  rgb: Rgb[];

  keymap: KeyMapEntry[];
}

export interface InputEvent {
  control: number;
  action: ActionValue | number;
  value: number;
}

export interface Ack {
  cmd: number;
  status: number;
}

function frame(cmd: number): Uint8Array {
  const b = new Uint8Array(REPORT_SIZE);
  b[0] = cmd & 0xff;
  return b;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n))) & 0xff;
}

export function encodeSetRgb(colors: Rgb[]): Uint8Array {
  if (colors.length !== LED_COUNT) {
    throw new RangeError(`SET_RGB needs ${LED_COUNT} colors, got ${colors.length}`);
  }
  const b = frame(Cmd.SET_RGB);
  for (let i = 0; i < LED_COUNT; i++) {
    const c = colors[i]!;
    b[1 + i * 3] = clampByte(c.r);
    b[2 + i * 3] = clampByte(c.g);
    b[3 + i * 3] = clampByte(c.b);
  }
  return b;
}

export function encodeSetBrightness(value: number): Uint8Array {
  const b = frame(Cmd.SET_BRIGHTNESS);
  b[1] = clampByte(value);
  return b;
}

export function encodeSetEffect(effectId: number, params: number[] = []): Uint8Array {
  const b = frame(Cmd.SET_EFFECT);
  b[1] = effectId & 0xff;
  for (let i = 0; i < params.length && 2 + i < REPORT_SIZE; i++) {
    b[2 + i] = clampByte(params[i]!);
  }
  return b;
}

export function encodeSetKey(slot: number, entry: KeyMapEntry): Uint8Array {
  const b = frame(Cmd.SET_KEY);
  b[1] = slot & 0xff;
  b[2] = entry.modifier & 0xff;
  b[3] = entry.keycode & 0xff;
  return b;
}

export function encodeSetFlags(flags: number): Uint8Array {
  const b = frame(Cmd.SET_FLAGS);
  b[1] = flags & 0xff;
  return b;
}

export function encodeSave(): Uint8Array {
  return frame(Cmd.SAVE);
}

export function encodeLoadDefaults(): Uint8Array {
  return frame(Cmd.LOAD_DEFAULTS);
}

export function encodeGetConfig(): Uint8Array {
  return frame(Cmd.GET_CONFIG);
}

export function encodeGetInfo(): Uint8Array {
  return frame(Cmd.GET_INFO);
}

export function encodeIdentify(slot: number): Uint8Array {
  const b = frame(Cmd.IDENTIFY);
  b[1] = slot & 0xff;
  return b;
}

export function encodeSetIdleDim(enable: boolean, timeoutMs: number): Uint8Array {
  const b = frame(Cmd.SET_IDLE_DIM);
  b[1] = enable ? 1 : 0;
  const units = Math.max(0, Math.min(0xffff, Math.round(timeoutMs / 100)));
  b[2] = units & 0xff;
  b[3] = (units >> 8) & 0xff;
  return b;
}

function asBytes(data: DataView | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export function inputReportType(data: DataView | Uint8Array): number {
  return asBytes(data)[0] ?? 0;
}

export function decodeInputEvent(data: DataView | Uint8Array): InputEvent {
  const b = asBytes(data);
  return { control: b[1] ?? 0, action: b[2] ?? 0, value: b[3] ?? 0 };
}

export function decodeFwInfo(data: DataView | Uint8Array): FwInfo {
  const b = asBytes(data);
  const caps =
    (b[5] ?? 0) | ((b[6] ?? 0) << 8) | ((b[7] ?? 0) << 16) | ((b[8] ?? 0) << 24);
  return {
    firmware: { major: b[1] ?? 0, minor: b[2] ?? 0 },
    protocol: { major: b[3] ?? 0, minor: b[4] ?? 0 },
    capabilities: caps >>> 0,
    keyCount: b[9] ?? 0,
    ledCount: b[10] ?? 0,
  };
}

export function decodeConfigDump(data: DataView | Uint8Array): ConfigDump {
  const b = asBytes(data);
  const rgb: Rgb[] = [];
  for (let i = 0; i < LED_COUNT; i++) {
    const o = 4 + i * 3;
    rgb.push({ r: b[o] ?? 0, g: b[o + 1] ?? 0, b: b[o + 2] ?? 0 });
  }

  const keymap: KeyMapEntry[] = [];
  for (let o = 22; o + 1 < REPORT_SIZE; o += 2) {
    keymap.push({ modifier: b[o] ?? 0, keycode: b[o + 1] ?? 0 });
  }
  return {
    brightness: b[1] ?? 0,
    effect: b[2] ?? 0,
    flags: b[3] ?? 0,
    rgb,
    keymap,
  };
}

export function decodeAck(data: DataView | Uint8Array): Ack {
  const b = asBytes(data);
  return { cmd: b[1] ?? 0, status: b[2] ?? 0 };
}

export function hasCapability(caps: number, bit: number): boolean {
  return (caps & bit) !== 0;
}
