// SPDX-License-Identifier: MIT

export interface PadColors {
  hex: string;
  label: string;
}

export const PAD_KEY_COLORS: PadColors[] = [
  { hex: '#ff5470', label: 'F13' },
  { hex: '#ff9f1c', label: 'F14' },
  { hex: '#ffd23f', label: 'F15' },
  { hex: '#38d9a9', label: 'F16' },
  { hex: '#4dabf7', label: 'F17' },
  { hex: '#b197fc', label: 'F18' },
];

export interface PadFigure {
  el: HTMLElement;

  hit(index: number): void;

  fill(count: number): void;

  clear(): void;

  idle(on: boolean): void;
  setState(state: 'idle' | 'writing' | 'verifying' | 'done' | 'error'): void;
  destroy(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  for (const c of children) node.append(c);
  return node;
}

export interface PadFigureOptions {

  labels?: boolean;

  interactive?: boolean;

  onPress?: (index: number) => void;
}

export function createPadFigure(opts: PadFigureOptions = {}): PadFigure {
  const caps: HTMLElement[] = [];
  const grid = el('div', 'pad-grid');

  for (let i = 0; i < 6; i++) {
    const spec = PAD_KEY_COLORS[i]!;
    const cap = el('button', 'pad-cap');
    cap.type = 'button';
    cap.style.setProperty('--cap', spec.hex);
    cap.setAttribute('aria-label', `Key ${i + 1}, sends ${spec.label}`);
    cap.append(el('span', 'pad-cap-glow'));
    if (opts.labels) cap.append(el('span', 'pad-cap-label', spec.label));
    if (!opts.interactive) cap.tabIndex = -1;
    caps.push(cap);
    grid.append(cap);
  }

  const knobRing = el('span', 'pad-knob-ring');
  const knob = el('div', 'pad-knob', knobRing, el('span', 'pad-knob-mark'));
  knob.setAttribute('role', 'img');
  knob.setAttribute('aria-label', 'Rotary knob: turn for F19 and F21, press for F20');

  const board = el('div', 'pad-board', grid, el('div', 'pad-knob-well', knob));
  const root = el('div', 'pad-figure', board);

  let hitTimers: ReturnType<typeof setTimeout>[] = [];

  const hit = (index: number) => {
    const cap = caps[index];
    if (!cap) return;
    cap.classList.remove('is-hit');

    void cap.offsetWidth;
    cap.classList.add('is-hit');
    const t = setTimeout(() => cap.classList.remove('is-hit'), 460);
    hitTimers.push(t);
  };

  const fill = (count: number) => {
    caps.forEach((cap, i) => cap.classList.toggle('is-on', i < count));
  };

  const clear = () => fill(0);

  const idle = (on: boolean) => root.classList.toggle('is-idle', on);

  const setState = (state: 'idle' | 'writing' | 'verifying' | 'done' | 'error') => {
    root.dataset.state = state;
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    const m = /^F(1[3-8])$/.exec(ev.key);
    if (!m) return;
    const index = Number(m[1]) - 13;
    ev.preventDefault();
    hit(index);
    opts.onPress?.(index);
  };

  if (opts.interactive) {
    caps.forEach((cap, i) =>
      cap.addEventListener('click', () => {
        hit(i);
        opts.onPress?.(i);
      }),
    );
    window.addEventListener('keydown', onKeyDown);
    knob.addEventListener('click', () => {
      knob.classList.remove('is-turned');
      void knob.offsetWidth;
      knob.classList.add('is-turned');
    });
  }

  idle(true);
  setState('idle');

  return {
    el: root,
    hit,
    fill,
    clear,
    idle,
    setState,
    destroy() {
      hitTimers.forEach(clearTimeout);
      hitTimers = [];
      if (opts.interactive) window.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}
