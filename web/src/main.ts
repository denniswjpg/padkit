// PadKit Config — UI entry point. SPDX-License-Identifier: MIT
// Framework-free: builds the DOM directly and drives the WebHID transport.

import {
  PadKit,
  isWebHidSupported,
  type ConfigDump,
  type FwInfo,
  type InputEvent,
  type Rgb,
} from './padkit-hid.ts';
import {
  Action,
  Capability,
  Effect,
  Flag,
  KEY_COUNT,
  SLOT_COUNT,
  SLOT_KNOB_CCW,
  SLOT_KNOB_CLICK,
  SLOT_KNOB_CW,
  SLOT_PUSHTURN_CCW,
  SLOT_PUSHTURN_CW,
  hasCapability,
} from './protocol.ts';
import { KEYCODE_GROUPS, MODIFIERS, shortcutLabel } from './keycodes.ts';
import { isDemoRequested, startDemo } from './demo.ts';

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}
function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`missing #${id}`);
  return n as T;
}

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function toHex(c: Rgb): string {
  const h = (n: number) => n.toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}
function fromHex(hex: string): Rgb {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

// ---------------------------------------------------------------------------
// Control metadata
// ---------------------------------------------------------------------------

interface ControlMeta {
  slot: number;
  name: string;
  isKey: boolean; // has an addressable LED
  cap?: number; // capability required, if any
}
const CONTROLS: ControlMeta[] = [
  { slot: 0, name: 'Key 1', isKey: true },
  { slot: 1, name: 'Key 2', isKey: true },
  { slot: 2, name: 'Key 3', isKey: true },
  { slot: 3, name: 'Key 4', isKey: true },
  { slot: 4, name: 'Key 5', isKey: true },
  { slot: 5, name: 'Key 6', isKey: true },
  { slot: SLOT_KNOB_CCW, name: 'Knob · turn left', isKey: false },
  { slot: SLOT_KNOB_CLICK, name: 'Knob · click', isKey: false },
  { slot: SLOT_KNOB_CW, name: 'Knob · turn right', isKey: false },
  { slot: SLOT_PUSHTURN_CCW, name: 'Push + turn left', isKey: false, cap: Capability.PUSH_TURN_AXIS },
  { slot: SLOT_PUSHTURN_CW, name: 'Push + turn right', isKey: false, cap: Capability.PUSH_TURN_AXIS },
];
function meta(slot: number): ControlMeta {
  return CONTROLS.find((c) => c.slot === slot)!;
}

const ACTION_LABEL: Record<number, string> = {
  [Action.KEY_DOWN]: 'down',
  [Action.KEY_UP]: 'up',
  [Action.KNOB_CW]: 'turn right',
  [Action.KNOB_CCW]: 'turn left',
  [Action.KNOB_CLICK]: 'click',
  [Action.PUSH_TURN_CW]: 'push-turn right',
  [Action.PUSH_TURN_CCW]: 'push-turn left',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  info: FwInfo | null;
  caps: number;
  brightness: number;
  effect: number;
  effectSpeed: number;
  effectColor: Rgb;
  flags: number;
  rgb: Rgb[]; // 6
  keymap: { modifier: number; keycode: number }[]; // 11
  idleDim: boolean;
  idleTimeoutMs: number;
  selected: number | null;
  dirty: boolean;
}

function defaultKeymap() {
  // Factory defaults per protocol §7: slots 0..10 -> F13..F23 (0x68..0x72).
  return Array.from({ length: SLOT_COUNT }, (_, i) => ({ modifier: 0, keycode: 0x68 + i }));
}

const state: State = {
  info: null,
  caps: 0,
  brightness: 200,
  effect: Effect.STATIC,
  effectSpeed: 128,
  effectColor: { r: 60, g: 120, b: 255 },
  flags: 0,
  rgb: Array.from({ length: KEY_COUNT }, () => ({ r: 0, g: 0, b: 40 })),
  keymap: defaultKeymap(),
  idleDim: false,
  idleTimeoutMs: 30000,
  selected: null,
  dirty: false,
};

const pad = new PadKit();

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function initTheme() {
  const saved = localStorage.getItem('padkit-theme');
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.setAttribute('data-theme', saved);
  }
  $('theme-toggle').addEventListener('click', () => {
    const cur =
      document.documentElement.getAttribute('data-theme') ??
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('padkit-theme', next);
  });
}

// ---------------------------------------------------------------------------
// Toast + dirty
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;
function toast(msg: string, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = isErr ? 'toast toast-err' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

function markDirty() {
  state.dirty = true;
  renderDirty();
}
function renderDirty() {
  const d = $('dirty');
  d.className = state.dirty ? 'dirty dirty-dirty' : 'dirty dirty-clean';
  d.querySelector('.dirty-text')!.textContent = state.dirty ? 'Unsaved' : 'Saved';
}

// ---------------------------------------------------------------------------
// Connection flow
// ---------------------------------------------------------------------------

function setConnUi(connected: boolean) {
  const chip = $('conn-chip');
  const btn = $<HTMLButtonElement>('connect-btn');
  if (connected) {
    const v = state.info ? `v${state.info.firmware.major}.${state.info.firmware.minor}` : '';
    chip.textContent = `Connected · ${pad.deviceName} ${v}`.trim();
    chip.className = 'chip chip-ok';
    btn.textContent = 'Disconnect';
    $('hero').hidden = true;
    $('app').hidden = false;
    $('savebar').hidden = false;
  } else {
    chip.textContent = 'Not connected';
    chip.className = 'chip chip-idle';
    btn.textContent = 'Connect';
    $('hero').hidden = false;
    $('app').hidden = true;
    $('savebar').hidden = true;
  }
}

function applyConfig(cfg: ConfigDump | null) {
  if (!cfg) return;
  state.brightness = cfg.brightness;
  state.effect = cfg.effect;
  state.flags = cfg.flags;
  state.idleDim = (cfg.flags & Flag.IDLE_DIM_ON) !== 0;
  for (let i = 0; i < KEY_COUNT; i++) if (cfg.rgb[i]) state.rgb[i] = cfg.rgb[i]!;
  // CONFIG_DUMP carries a truncated keymap summary (slots from 0 up). Overlay
  // whatever the device reported onto the factory defaults.
  state.keymap = defaultKeymap();
  cfg.keymap.forEach((entry, i) => {
    if (i < state.keymap.length && (entry.keycode !== 0 || entry.modifier !== 0)) {
      state.keymap[i] = entry;
    }
  });
}

async function connect() {
  try {
    const { info, config } = await pad.connect();
    state.info = info;
    state.caps = info?.capabilities ?? 0;
    applyConfig(config);
    state.selected = null;
    state.dirty = false;
    renderAll();
    setConnUi(true);
    renderDirty();
    if (!info) toast('Connected, but the pad did not report firmware info', true);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A user cancelling the chooser is not an error worth shouting about.
    if (!/no device selected|cancel/i.test(msg)) toast(msg, true);
  }
}

async function disconnect() {
  await pad.disconnect();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderAll() {
  renderKeys();
  renderKnob();
  renderEditor();
  renderLighting();
}

function capOK(bit: number): boolean {
  // If we never got FW_INFO, don't hard-block features (assume present).
  if (state.info === null) return true;
  return hasCapability(state.caps, bit);
}

function bindLabel(slot: number): string {
  const k = state.keymap[slot]!;
  return shortcutLabel(k.modifier, k.keycode);
}

function renderKeys() {
  const grid = $('keygrid');
  grid.innerHTML = '';
  for (let slot = 0; slot < KEY_COUNT; slot++) {
    const m = meta(slot);
    const cap = el('button', {
      class: 'keycap',
      type: 'button',
      'aria-pressed': state.selected === slot ? 'true' : 'false',
      'aria-label': `${m.name}, color and shortcut`,
      'data-slot': slot,
      onclick: () => selectControl(slot),
    });
    cap.append(
      el('span', { class: 'kc-name', text: m.name }),
      el('span', { class: 'swatch', style: `background:${toHex(state.rgb[slot]!)}` }),
      el('span', { class: 'kc-bind', text: bindLabel(slot) }),
    );
    grid.append(cap);
  }
}

function renderKnob() {
  const col = $('knobcol');
  col.innerHTML = '';
  for (const m of CONTROLS.filter((c) => !c.isKey)) {
    if (m.cap && !capOK(m.cap)) continue; // hide push-turn if unsupported
    const btn = el('button', {
      class: 'knobctl',
      type: 'button',
      'aria-pressed': state.selected === m.slot ? 'true' : 'false',
      'data-slot': m.slot,
      onclick: () => selectControl(m.slot),
    });
    btn.append(
      el('span', { class: 'kn-name', text: m.name }),
      el('span', { class: 'kn-bind', text: bindLabel(m.slot) }),
    );
    col.append(btn);
  }
}

function selectControl(slot: number) {
  state.selected = state.selected === slot ? null : slot;
  renderKeys();
  renderKnob();
  renderEditor();
}

function buildKeycodeSelect(current: number, onChange: (code: number) => void): HTMLSelectElement {
  const sel = el('select', { 'aria-label': 'Key to send' });
  sel.append(el('option', { value: '0', text: '— None (disabled) —' }));
  for (const grp of KEYCODE_GROUPS) {
    const og = document.createElement('optgroup');
    og.label = grp.group;
    for (const o of grp.options) {
      const opt = el('option', { value: String(o.code), text: o.label });
      if (o.code === current) opt.selected = true;
      og.append(opt);
    }
    sel.append(og);
  }
  if (current === 0) (sel.querySelector('option[value="0"]') as HTMLOptionElement).selected = true;
  sel.addEventListener('change', () => onChange(parseInt(sel.value, 10)));
  return sel;
}

function renderEditor() {
  const box = $('editor');
  box.innerHTML = '';
  if (state.selected === null) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const slot = state.selected;
  const m = meta(slot);

  const head = el('div', { class: 'editor-head' });
  head.append(el('h3', { text: m.name }));
  const headBtns = el('div', { class: 'row' });
  if (m.isKey) {
    headBtns.append(
      el('button', {
        class: 'btn btn-ghost btn-sm',
        type: 'button',
        text: 'Identify',
        title: 'Blink this physical key',
        onclick: () => pad.identify(slot).catch((e) => toast(String(e.message ?? e), true)),
      }),
    );
  }
  headBtns.append(
    el('button', {
      class: 'btn btn-ghost btn-sm',
      type: 'button',
      text: 'Close',
      onclick: () => selectControl(slot),
    }),
  );
  head.append(headBtns);
  box.append(head);

  // Color (keys only — knob controls have no LED).
  if (m.isKey) {
    const field = el('div', { class: 'field' });
    field.append(el('span', { class: 'field-label', text: 'Cap color' }));
    const row = el('div', { class: 'row' });
    const color = el('input', {
      type: 'color',
      value: toHex(state.rgb[slot]!),
      'aria-label': 'Cap color',
    }) as HTMLInputElement;
    color.addEventListener('input', () => {
      state.rgb[slot] = fromHex(color.value);
      renderKeys();
      pad.setRgb(state.rgb).catch(() => {});
      markDirty();
    });
    row.append(color, el('span', { class: 'gated-note', text: 'Live preview — updates the pad instantly.' }));
    field.append(row);
    box.append(field);
  }

  // Shortcut (gated on keymap-remap capability).
  const scField = el('div', { class: 'field' });
  scField.append(el('span', { class: 'field-label', text: 'Sends' }));
  if (!capOK(Capability.KEYMAP_REMAP)) {
    scField.append(
      el('span', { class: 'gated-note', text: 'This firmware build does not support remapping keys.' }),
    );
  } else {
    const cur = state.keymap[slot]!;
    const preview = el('span', { class: 'preview-pill', text: shortcutLabel(cur.modifier, cur.keycode) });

    const modrow = el('div', { class: 'modrow' });
    for (const mod of MODIFIERS) {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      cb.checked = (cur.modifier & mod.bit) !== 0;
      cb.addEventListener('change', () => {
        if (cb.checked) state.keymap[slot]!.modifier |= mod.bit;
        else state.keymap[slot]!.modifier &= ~mod.bit;
        pushKey(slot, preview);
      });
      modrow.append(el('label', { class: 'mod-check' }, [cb, mod.label]));
    }

    const sel = buildKeycodeSelect(cur.keycode, (code) => {
      state.keymap[slot]!.keycode = code;
      pushKey(slot, preview);
    });

    scField.append(
      modrow,
      el('div', { class: 'row' }, [sel, preview]),
    );
  }
  box.append(scField);
}

function pushKey(slot: number, preview: HTMLElement) {
  const k = state.keymap[slot]!;
  preview.textContent = shortcutLabel(k.modifier, k.keycode);
  renderKeys();
  renderKnob();
  pad.setKey(slot, k).catch(() => {});
  markDirty();
}

// ---------------------------------------------------------------------------
// Lighting section
// ---------------------------------------------------------------------------

function effectParams(): number[] {
  const c = state.effectColor;
  switch (state.effect) {
    case Effect.BREATHE:
    case Effect.SCANNER:
      return [state.effectSpeed, c.r, c.g, c.b];
    case Effect.REACTIVE:
      return [state.effectSpeed, c.r, c.g, c.b]; // [2]=fade reuses speed slider
    case Effect.RAINBOW:
      return [state.effectSpeed];
    default:
      return [];
  }
}
function pushEffect() {
  pad.setEffect(state.effect, effectParams()).catch(() => {});
  markDirty();
}

function renderLighting() {
  const box = $('lighting');
  box.innerHTML = '';

  // Brightness
  {
    const field = el('div', { class: 'field' });
    field.append(el('label', { for: 'brightness', text: 'Brightness' }));
    const row = el('div', { class: 'row' });
    const tag = el('span', { class: 'value-tag', text: String(state.brightness) });
    const range = el('input', {
      type: 'range',
      id: 'brightness',
      min: '0',
      max: '255',
      value: String(state.brightness),
    }) as HTMLInputElement;
    range.addEventListener('input', () => {
      state.brightness = parseInt(range.value, 10);
      tag.textContent = range.value;
      pad.setBrightness(state.brightness).catch(() => {});
      markDirty();
    });
    row.append(range, tag);
    field.append(row);
    box.append(field);
  }

  // Effect
  {
    const field = el('div', { class: 'field' });
    field.append(el('label', { for: 'effect', text: 'Effect' }));
    const multi = capOK(Capability.EFFECTS_MULTI);
    const opts: [number, string][] = [
      [Effect.STATIC, 'Static (per-key colors)'],
      [Effect.BREATHE, 'Breathe'],
      [Effect.RAINBOW, 'Rainbow cycle'],
      [Effect.REACTIVE, 'Reactive (light on press)'],
      [Effect.SCANNER, 'Scanner'],
    ];
    const sel = el('select', { id: 'effect', 'aria-label': 'Lighting effect' }) as HTMLSelectElement;
    for (const [id, label] of opts) {
      const gated = id > Effect.BREATHE && !multi;
      const opt = el('option', { value: String(id), text: gated ? `${label} (unsupported)` : label });
      if (gated) opt.disabled = true;
      if (id === state.effect) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener('change', () => {
      state.effect = parseInt(sel.value, 10);
      renderLighting();
      pushEffect();
    });
    const row = el('div', { class: 'row' }, [sel]);

    // Animated effects expose speed + color params.
    if (state.effect !== Effect.STATIC) {
      if (state.effect !== Effect.RAINBOW) {
        const color = el('input', {
          type: 'color',
          value: toHex(state.effectColor),
          'aria-label': 'Effect color',
          title: 'Effect color',
        }) as HTMLInputElement;
        color.addEventListener('input', () => {
          state.effectColor = fromHex(color.value);
          pushEffect();
        });
        row.append(color);
      }
      const speed = el('input', {
        type: 'range',
        min: '0',
        max: '255',
        value: String(state.effectSpeed),
        'aria-label': 'Effect speed',
        title: 'Speed',
      }) as HTMLInputElement;
      speed.addEventListener('input', () => {
        state.effectSpeed = parseInt(speed.value, 10);
        pushEffect();
      });
      row.append(speed);
    }
    field.append(row);
    if (!multi) field.append(el('span', { class: 'gated-note', text: 'This firmware supports static and breathe only.' }));
    box.append(field);
  }

  // Idle dim (gated)
  if (capOK(Capability.IDLE_DIM)) {
    const field = el('div', { class: 'field' });
    field.append(el('span', { class: 'field-label', text: 'Idle dimming' }));
    const toggleWrap = el('label', { class: 'toggle' });
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = state.idleDim;
    const secTag = el('span', { class: 'value-tag', text: `${Math.round(state.idleTimeoutMs / 1000)}s` });
    const secRange = el('input', {
      type: 'range',
      min: '5',
      max: '300',
      value: String(Math.round(state.idleTimeoutMs / 1000)),
      'aria-label': 'Idle timeout in seconds',
    }) as HTMLInputElement;
    const pushIdle = () => {
      pad.setIdleDim(state.idleDim, state.idleTimeoutMs).catch(() => {});
      markDirty();
    };
    cb.addEventListener('change', () => {
      state.idleDim = cb.checked;
      pushIdle();
    });
    secRange.addEventListener('input', () => {
      state.idleTimeoutMs = parseInt(secRange.value, 10) * 1000;
      secTag.textContent = `${secRange.value}s`;
      if (state.idleDim) pushIdle();
    });
    toggleWrap.append(cb, 'Dim the LEDs after inactivity');
    field.append(toggleWrap, el('div', { class: 'row' }, [secRange, secTag]));
    box.append(field);
  }

  // Advanced: suppress keyboard flag
  {
    const field = el('div', { class: 'field' });
    field.append(el('span', { class: 'field-label', text: 'Advanced' }));
    const toggleWrap = el('label', { class: 'toggle' });
    const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = (state.flags & Flag.SUPPRESS_KEYBOARD) !== 0;
    cb.addEventListener('change', () => {
      if (cb.checked) state.flags |= Flag.SUPPRESS_KEYBOARD;
      else state.flags &= ~Flag.SUPPRESS_KEYBOARD;
      pad.setFlags(state.flags).catch(() => {});
      markDirty();
    });
    toggleWrap.append(cb, 'Suppress keyboard output (input still reported here)');
    field.append(toggleWrap);
    box.append(field);
  }
}

// ---------------------------------------------------------------------------
// Live monitor
// ---------------------------------------------------------------------------

const MAX_LOG = 60;
function logEvent(ev: InputEvent) {
  const log = $('monitor-log');
  const empty = log.querySelector('.ml-empty');
  if (empty) empty.remove();
  const m = CONTROLS.find((c) => c.slot === ev.control);
  const name = m ? m.name : `slot ${ev.control}`;
  const action = ACTION_LABEL[ev.action] ?? `0x${ev.action.toString(16)}`;
  const time = new Date().toLocaleTimeString(undefined, { hour12: false });
  const li = el('li', {}, [
    el('span', { class: 'ml-time', text: time }),
    el('span', { text: `${name} · ${action}` }),
  ]);
  log.prepend(li);
  while (log.children.length > MAX_LOG) log.lastElementChild?.remove();
  pulse(ev.control);
}

function pulse(slot: number) {
  const node = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (!node) return;
  node.classList.remove('hit');
  void node.offsetWidth; // reflow so the animation restarts
  node.classList.add('hit');
}

function resetMonitor() {
  const log = $('monitor-log');
  log.innerHTML = '';
  log.append(el('li', { class: 'ml-empty', text: 'Press a key or turn the knob…' }));
}

// ---------------------------------------------------------------------------
// Save / reset
// ---------------------------------------------------------------------------

async function save() {
  if (!capOK(Capability.PERSISTENT_CONFIG)) {
    toast('This firmware cannot save config to flash', true);
    return;
  }
  const btn = $<HTMLButtonElement>('save-btn');
  btn.disabled = true;
  try {
    await pad.save();
    state.dirty = false;
    renderDirty();
    toast('Saved to device');
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Save failed', true);
  } finally {
    btn.disabled = false;
  }
}

async function reset() {
  if (!confirm('Reset the pad to factory defaults? This overwrites saved config.')) return;
  const btn = $<HTMLButtonElement>('reset-btn');
  btn.disabled = true;
  try {
    await pad.loadDefaults();
    // loadDefaults re-requests CONFIG_DUMP; the config listener repopulates.
    toast('Reset to defaults');
    state.dirty = false;
    renderDirty();
  } catch (err) {
    toast(err instanceof Error ? err.message : 'Reset failed', true);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

function main() {
  initTheme();
  resetMonitor();

  const demo = isDemoRequested();
  if (!demo && !isWebHidSupported()) {
    $('unsupported').hidden = false;
    $<HTMLButtonElement>('connect-btn').disabled = true;
    $<HTMLButtonElement>('hero-connect').disabled = true;
  }

  const connectBtn = $<HTMLButtonElement>('connect-btn');
  connectBtn.addEventListener('click', () => {
    if (pad.connected) disconnect();
    else connect();
  });
  $('hero-connect').addEventListener('click', connect);
  $('save-btn').addEventListener('click', save);
  $('reset-btn').addEventListener('click', reset);
  $('monitor-clear').addEventListener('click', resetMonitor);

  pad.on('input', logEvent);
  pad.on('info', (info) => {
    state.info = info;
    state.caps = info.capabilities;
    if (pad.connected) {
      renderAll();
      setConnUi(true);
    }
  });
  pad.on('config', (cfg) => {
    // Fired on connect and after LOAD_DEFAULTS.
    applyConfig(cfg);
    if (pad.connected) renderAll();
  });
  pad.on('connect', () => {
    setConnUi(true);
    renderDirty();
  });
  pad.on('disconnect', () => {
    setConnUi(false);
    resetMonitor();
    toast('Device disconnected');
  });
  pad.on('error', (m) => toast(m, true));

  // Offline demo mode (`?demo=1` / `#demo`): wire the in-memory mock device
  // into the same UI so the tool can be previewed with no hardware. The
  // info/config/connect listeners above populate state exactly as for a real
  // pad; we then open a key so the color + shortcut editor is on show.
  if (demo) {
    startDemo(pad)
      .then(() => selectControl(0))
      .catch((e) => toast(String(e?.message ?? e), true));
    return;
  }

  // Offer a silent reconnect if the user already granted a device. State is
  // populated by the info/config/connect listeners above.
  pad.tryReconnectGranted().catch(() => {});
}

main();
