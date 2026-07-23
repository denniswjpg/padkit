// SPDX-License-Identifier: MIT

import type { FlashMeter } from './flash-wizard.ts';
import { createPadFigure, type PadFigure } from './pad-figure.ts';
import type { Progress } from './flash-core.ts';

const CAPS = 6;

const PHASE_TEXT: Record<Progress['phase'], string> = {
  connecting: 'Opening the pad',
  identifying: 'Reading the chip id',
  erasing: 'Erasing the old firmware',
  writing: 'Writing',
  verifying: 'Reading it back',
  rebooting: 'Restarting the pad',
  done: 'Done',
};

export function padMeter(host: HTMLElement): FlashMeter {
  const pad: PadFigure = createPadFigure({ labels: false });
  const label = document.createElement('p');
  label.className = 'pkw-bar-label';
  label.textContent = PHASE_TEXT.connecting;
  const count = document.createElement('span');
  count.className = 'pkw-count';

  const wrap = document.createElement('div');
  wrap.className = 'pkw-padmeter';
  wrap.append(pad.el, label);
  label.append(count);
  host.append(wrap);

  pad.idle(false);
  pad.clear();

  return {
    phase(p) {
      label.firstChild!.textContent = PHASE_TEXT[p];
      if (p === 'writing') pad.setState('writing');
      else if (p === 'verifying') pad.setState('verifying');
      else if (p === 'erasing') {
        pad.setState('writing');
        pad.clear();
      }
      if (p === 'rebooting') {
        pad.setState('done');
        pad.fill(CAPS);
      }
      if (p !== 'writing' && p !== 'verifying') count.textContent = '';
    },
    progress(fraction, done, total) {
      pad.fill(Math.max(1, Math.round(fraction * CAPS)));
      count.textContent = ` ${done} of ${total} blocks`;
    },
    finish(ok) {
      pad.setState(ok ? 'done' : 'error');
      pad.fill(CAPS);
      label.firstChild!.textContent = ok ? 'Written and checked' : 'Stopped';
      count.textContent = '';
    },
    reset() {
      pad.setState('idle');
      pad.clear();
      count.textContent = '';
    },
  };
}

export function chunkMeter(host: HTMLElement): FlashMeter {
  const grid = document.createElement('div');
  grid.className = 'pkw-chunks';
  const label = document.createElement('p');
  label.className = 'pkw-bar-label';
  const phaseText = document.createElement('span');
  phaseText.textContent = PHASE_TEXT.connecting;
  const count = document.createElement('span');
  count.className = 'pkw-count';
  label.append(phaseText, count);
  host.append(grid, label);

  let cells: HTMLElement[] = [];
  let mode: 'write' | 'verify' = 'write';

  const build = (total: number) => {
    if (cells.length === total) return;
    grid.replaceChildren();
    cells = Array.from({ length: total }, () => {
      const cell = document.createElement('span');
      cell.className = 'pkw-chunk';
      grid.append(cell);
      return cell;
    });
  };

  return {
    phase(p) {
      phaseText.textContent = PHASE_TEXT[p];
      if (p === 'verifying') mode = 'verify';
      if (p === 'writing') mode = 'write';
      if (p !== 'writing' && p !== 'verifying') count.textContent = '';
      grid.dataset.mode = mode;
    },
    progress(_fraction, done, total) {
      build(total);
      for (let i = 0; i < done; i++) {
        cells[i]!.dataset.state = mode === 'write' ? 'written' : 'checked';
      }
      count.textContent = ` ${done} / ${total} blocks`;
    },
    finish(ok) {
      grid.dataset.done = ok ? 'ok' : 'err';
      phaseText.textContent = ok ? 'Written and checked' : 'Stopped';
      count.textContent = '';
    },
    reset() {
      grid.replaceChildren();
      cells = [];
      delete grid.dataset.done;
      count.textContent = '';
    },
  };
}
