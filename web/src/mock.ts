// SPDX-License-Identifier: MIT

import {
  Capability,
  Cmd,
  InputType,
  KEY_COUNT,
  LED_COUNT,
  REPORT_SIZE,
  SLOT_COUNT,
  type Rgb,
} from './protocol.ts';

export interface MockState {
  brightness: number;
  effect: number;
  flags: number;
  rgb: Rgb[];
  keymap: { modifier: number; keycode: number }[];
  idleDim: boolean;
  idleTimeoutUnits: number;
  saved: boolean;
}

function defaultState(): MockState {
  const rgb: Rgb[] = Array.from({ length: LED_COUNT }, () => ({ r: 0, g: 0, b: 40 }));

  const keymap = Array.from({ length: SLOT_COUNT }, (_, i) => ({ modifier: 0, keycode: 0x68 + i }));
  return {
    brightness: 200,
    effect: 0,
    flags: 0,
    rgb,
    keymap,
    idleDim: false,
    idleTimeoutUnits: 0,
    saved: true,
  };
}

const MOCK_CAPS =
  Capability.PERSISTENT_CONFIG |
  Capability.KEYMAP_REMAP |
  Capability.EFFECTS_MULTI |
  Capability.IDLE_DIM |
  Capability.PUSH_TURN_AXIS;

export class MockPadKit {
  state: MockState = defaultState();

  handleOutput(report: Uint8Array): Uint8Array | null {
    const cmd = report[0];
    switch (cmd) {
      case Cmd.SET_RGB:
        for (let i = 0; i < LED_COUNT; i++) {
          this.state.rgb[i] = {
            r: report[1 + i * 3]!,
            g: report[2 + i * 3]!,
            b: report[3 + i * 3]!,
          };
        }
        this.state.saved = false;
        return null;
      case Cmd.SET_BRIGHTNESS:
        this.state.brightness = report[1]!;
        this.state.saved = false;
        return null;
      case Cmd.SET_EFFECT:
        this.state.effect = report[1]!;
        this.state.saved = false;
        return null;
      case Cmd.SET_KEY: {
        const slot = report[1]!;
        if (slot < this.state.keymap.length) {
          this.state.keymap[slot] = { modifier: report[2]!, keycode: report[3]! };
        }
        this.state.saved = false;
        return null;
      }
      case Cmd.SET_FLAGS:
        this.state.flags = report[1]!;
        this.state.saved = false;
        return null;
      case Cmd.SET_IDLE_DIM:
        this.state.idleDim = report[1] === 1;
        this.state.idleTimeoutUnits = report[2]! | (report[3]! << 8);
        this.state.saved = false;
        return null;
      case Cmd.IDENTIFY:
        return null;
      case Cmd.SAVE:
        this.state.saved = true;
        return this.ack(Cmd.SAVE, 0);
      case Cmd.LOAD_DEFAULTS:
        this.state = defaultState();
        return this.ack(Cmd.LOAD_DEFAULTS, 0);
      case Cmd.GET_CONFIG:
        return this.configDump();
      case Cmd.GET_INFO:
        return this.fwInfo();
      default:
        return this.ack(cmd ?? 0, 1);
    }
  }

  inputEvent(control: number, action: number, value = 0): Uint8Array {
    const b = new Uint8Array(REPORT_SIZE);
    b[0] = InputType.INPUT_EVENT;
    b[1] = control;
    b[2] = action;
    b[3] = value;
    return b;
  }

  private ack(cmd: number, status: number): Uint8Array {
    const b = new Uint8Array(REPORT_SIZE);
    b[0] = InputType.ACK;
    b[1] = cmd;
    b[2] = status;
    return b;
  }

  private fwInfo(): Uint8Array {
    const b = new Uint8Array(REPORT_SIZE);
    b[0] = InputType.FW_INFO;
    b[1] = 0;
    b[2] = 2;
    b[3] = 2;
    b[4] = 0;
    b[5] = MOCK_CAPS & 0xff;
    b[6] = (MOCK_CAPS >> 8) & 0xff;
    b[7] = (MOCK_CAPS >> 16) & 0xff;
    b[8] = (MOCK_CAPS >> 24) & 0xff;
    b[9] = KEY_COUNT;
    b[10] = LED_COUNT;
    return b;
  }

  private configDump(): Uint8Array {
    const b = new Uint8Array(REPORT_SIZE);
    b[0] = InputType.CONFIG_DUMP;
    b[1] = this.state.brightness;
    b[2] = this.state.effect;
    b[3] = this.state.flags;
    for (let i = 0; i < LED_COUNT; i++) {
      b[4 + i * 3] = this.state.rgb[i]!.r;
      b[5 + i * 3] = this.state.rgb[i]!.g;
      b[6 + i * 3] = this.state.rgb[i]!.b;
    }

    let o = 22;
    for (let i = 0; i < this.state.keymap.length && o + 1 < REPORT_SIZE; i++, o += 2) {
      b[o] = this.state.keymap[i]!.modifier;
      b[o + 1] = this.state.keymap[i]!.keycode;
    }
    return b;
  }
}
