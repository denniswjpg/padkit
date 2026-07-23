// SPDX-License-Identifier: MIT

import {
  Action,
  Capability,
  Cmd,
  Effect,
  Flag,
  InputType,
  REPORT_SIZE,
  decodeAck,
  decodeConfigDump,
  decodeFwInfo,
  decodeInputEvent,
  encodeSave,
  encodeSetBrightness,
  encodeSetEffect,
  encodeSetFlags,
  encodeSetIdleDim,
  encodeSetKey,
  encodeSetRgb,
  hasCapability,
  inputReportType,
  type Rgb,
} from './protocol.ts';
import { MockPadKit } from './mock.ts';

declare const process: { exit(code: number): never };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${name}`);
  }
}

function eq(name: string, a: unknown, b: unknown): void {
  check(`${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`, a === b);
}

const dev = new MockPadKit();

const framedChecks: Array<[string, Uint8Array, number]> = [
  ['SET_RGB', encodeSetRgb(Array.from({ length: 6 }, () => ({ r: 1, g: 2, b: 3 }))), Cmd.SET_RGB],
  ['SET_BRIGHTNESS', encodeSetBrightness(128), Cmd.SET_BRIGHTNESS],
  ['SET_EFFECT', encodeSetEffect(Effect.BREATHE, [10, 255, 0, 0]), Cmd.SET_EFFECT],
  ['SET_KEY', encodeSetKey(0, { modifier: 0x01, keycode: 0x04 }), Cmd.SET_KEY],
  ['SET_FLAGS', encodeSetFlags(Flag.SUPPRESS_KEYBOARD), Cmd.SET_FLAGS],
  ['SAVE', encodeSave(), Cmd.SAVE],
  ['SET_IDLE_DIM', encodeSetIdleDim(true, 30000), Cmd.SET_IDLE_DIM],
];
for (const [name, rep, cmd] of framedChecks) {
  eq(`${name} length`, rep.length, REPORT_SIZE);
  eq(`${name} cmd byte`, rep[0], cmd);
}

const colors: Rgb[] = [
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 0, b: 255 },
  { r: 10, g: 20, b: 30 },
  { r: 40, g: 50, b: 60 },
  { r: 70, g: 80, b: 90 },
];
const rgbRep = encodeSetRgb(colors);
eq('SET_RGB[1]=R0', rgbRep[1], 255);
eq('SET_RGB[3]=B0', rgbRep[3], 0);
eq('SET_RGB[16]=R5', rgbRep[16], 70);
eq('SET_RGB[18]=B5', rgbRep[18], 90);
dev.handleOutput(rgbRep);
eq('mock stored G1', dev.state.rgb[1]!.g, 255);
eq('mock stored B5', dev.state.rgb[5]!.b, 90);

const idleRep = encodeSetIdleDim(true, 30000);
eq('idle enable', idleRep[1], 1);
eq('idle lo', idleRep[2], 0x2c);
eq('idle hi', idleRep[3], 0x01);

dev.handleOutput(encodeSetBrightness(123));
dev.handleOutput(encodeSetEffect(Effect.RAINBOW));
dev.handleOutput(encodeSetFlags(Flag.IDLE_DIM_ON));

dev.handleOutput(encodeSetKey(3, { modifier: 0x04, keycode: 0x50 }));
function cmdReport(cmd: number): Uint8Array {
  const b = new Uint8Array(REPORT_SIZE);
  b[0] = cmd;
  return b;
}
const dump = dev.handleOutput(cmdReport(Cmd.GET_CONFIG));
check('GET_CONFIG returned a report', dump !== null);
if (dump) {
  const cfg = decodeConfigDump(dump);
  eq('cfg brightness', cfg.brightness, 123);
  eq('cfg effect', cfg.effect, Effect.RAINBOW);
  eq('cfg flags', cfg.flags, Flag.IDLE_DIM_ON);
  eq('cfg rgb[0].r', cfg.rgb[0]!.r, 255);
  eq('cfg keymap slot3 mod', cfg.keymap[3]!.modifier, 0x04);
  eq('cfg keymap slot3 code', cfg.keymap[3]!.keycode, 0x50);
}

const infoDump = dev.handleOutput(cmdReport(Cmd.GET_INFO));
check('GET_INFO returned a report', infoDump !== null);
if (infoDump) {
  eq('FW_INFO type', inputReportType(infoDump), InputType.FW_INFO);
  const info = decodeFwInfo(infoDump);
  eq('fw minor', info.firmware.minor, 2);
  eq('proto major', info.protocol.major, 2);
  eq('key count', info.keyCount, 6);
  eq('led count', info.ledCount, 6);
  check('cap: keymap remap', hasCapability(info.capabilities, Capability.KEYMAP_REMAP));
  check('cap: idle dim', hasCapability(info.capabilities, Capability.IDLE_DIM));
}

const ackRep = dev.handleOutput(encodeSave());
check('SAVE returned ACK', ackRep !== null);
if (ackRep) {
  eq('ACK type', inputReportType(ackRep), InputType.ACK);
  const ack = decodeAck(ackRep);
  eq('ACK cmd', ack.cmd, Cmd.SAVE);
  eq('ACK status ok', ack.status, 0);
  check('mock marked saved', dev.state.saved);
}

const unknown = new Uint8Array(REPORT_SIZE);
unknown[0] = 0x7f;
const errAck = dev.handleOutput(unknown);
check('unknown cmd returns ACK', errAck !== null);
if (errAck) eq('unknown cmd err status', decodeAck(errAck).status, 1);

const evtRep = dev.inputEvent(2, Action.KEY_DOWN, 0);
const evt = decodeInputEvent(evtRep);
eq('input control', evt.control, 2);
eq('input action', evt.action, Action.KEY_DOWN);

const clamped = encodeSetBrightness(999);
eq('brightness clamped to 255', clamped[1], 255);

console.log(`\nPadKit protocol self-test: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
