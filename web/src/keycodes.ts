// HID Keyboard/Keypad usage codes (Usage Page 0x07) and modifier bits, with
// human-friendly labels for the shortcut picker. SET_KEY (§7) takes a modifier
// bitmask + one of these keycodes; keycode 0 disables the keystroke.
// SPDX-License-Identifier: MIT

export interface KeycodeOption {
  code: number;
  label: string;
}

export interface KeycodeGroup {
  group: string;
  options: KeycodeOption[];
}

// Modifier bits (standard HID keyboard modifier byte). We expose the left-side
// modifiers, which cover the vast majority of shortcuts.
export const MODIFIERS: { bit: number; label: string; short: string }[] = [
  { bit: 1 << 0, label: 'Ctrl', short: 'Ctrl' },
  { bit: 1 << 1, label: 'Shift', short: 'Shift' },
  { bit: 1 << 2, label: 'Alt', short: 'Alt' },
  { bit: 1 << 3, label: 'Meta (Win/Cmd)', short: 'Meta' },
];

function range(startCode: number, chars: string): KeycodeOption[] {
  return [...chars].map((ch, i) => ({ code: startCode + i, label: ch }));
}

export const KEYCODE_GROUPS: KeycodeGroup[] = [
  {
    group: 'Function (recommended — no OS conflicts)',
    options: [
      ...Array.from({ length: 12 }, (_, i) => ({ code: 0x68 + i, label: `F${13 + i}` })), // F13..F24
      ...Array.from({ length: 12 }, (_, i) => ({ code: 0x3a + i, label: `F${1 + i}` })), // F1..F12
    ],
  },
  {
    group: 'Letters',
    options: range(0x04, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'),
  },
  {
    group: 'Digits',
    options: [
      ...range(0x1e, '123456789'),
      { code: 0x27, label: '0' },
    ],
  },
  {
    group: 'Editing & whitespace',
    options: [
      { code: 0x28, label: 'Enter' },
      { code: 0x29, label: 'Esc' },
      { code: 0x2a, label: 'Backspace' },
      { code: 0x2b, label: 'Tab' },
      { code: 0x2c, label: 'Space' },
      { code: 0x4c, label: 'Delete' },
      { code: 0x49, label: 'Insert' },
    ],
  },
  {
    group: 'Navigation',
    options: [
      { code: 0x4f, label: 'Right' },
      { code: 0x50, label: 'Left' },
      { code: 0x51, label: 'Down' },
      { code: 0x52, label: 'Up' },
      { code: 0x4a, label: 'Home' },
      { code: 0x4d, label: 'End' },
      { code: 0x4b, label: 'Page Up' },
      { code: 0x4e, label: 'Page Down' },
    ],
  },
  {
    group: 'Symbols',
    options: [
      { code: 0x2d, label: '- _' },
      { code: 0x2e, label: '= +' },
      { code: 0x2f, label: '[ {' },
      { code: 0x30, label: '] }' },
      { code: 0x31, label: '\\ |' },
      { code: 0x33, label: '; :' },
      { code: 0x34, label: "' \"" },
      { code: 0x35, label: '` ~' },
      { code: 0x36, label: ', <' },
      { code: 0x37, label: '. >' },
      { code: 0x38, label: '/ ?' },
    ],
  },
  {
    group: 'System',
    options: [
      { code: 0x46, label: 'PrintScreen' },
      { code: 0x47, label: 'ScrollLock' },
      { code: 0x48, label: 'Pause' },
      { code: 0x39, label: 'CapsLock' },
    ],
  },
];

const CODE_LABEL = new Map<number, string>();
for (const g of KEYCODE_GROUPS) for (const o of g.options) CODE_LABEL.set(o.code, o.label);

/** Human-readable label for a keycode (0 = "Disabled"). */
export function keycodeLabel(code: number): string {
  if (code === 0) return 'Disabled';
  return CODE_LABEL.get(code) ?? `0x${code.toString(16).padStart(2, '0')}`;
}

/** "Ctrl+Shift+K" style label for a modifier bitmask + keycode. */
export function shortcutLabel(modifier: number, keycode: number): string {
  const parts: string[] = [];
  for (const m of MODIFIERS) if (modifier & m.bit) parts.push(m.short);
  if (keycode === 0) {
    return parts.length ? parts.join('+') + '+(none)' : 'Disabled';
  }
  parts.push(keycodeLabel(keycode));
  return parts.join('+');
}
