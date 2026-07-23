// SPDX-License-Identifier: MIT

import { createPadFigure, PAD_KEY_COLORS } from './pad-figure.ts';

function initHeroPad(): void {
  const host = document.getElementById('hero-pad');
  const hint = document.getElementById('press-hint');
  if (!host) return;

  let touched = false;
  let resetTimer = 0;
  const pad = createPadFigure({
    labels: true,
    interactive: true,
    onPress(index) {
      touched = true;
      if (!hint) return;
      hint.textContent = `Key ${index + 1} sends ${PAD_KEY_COLORS[index]!.label}`;
      hint.classList.add('is-live');
      window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        hint.textContent = touched
          ? 'Every key is yours to recolour and rebind'
          : 'Press F13 to F18, or click a key';
        hint.classList.remove('is-live');
      }, 1900);
    },
  });
  pad.el.dataset.interactive = 'true';
  host.append(pad.el);
}

function initReveal(): void {
  const items = [...document.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (!items.length) return;

  document.documentElement.classList.add('reveal-ready');

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }

  const seen = new Map<Element, number>();
  for (const el of items) {
    const parent = el.parentElement ?? document.body;
    const n = seen.get(parent) ?? 0;
    if (!el.style.getPropertyValue('--i')) el.style.setProperty('--i', String(n));
    seen.set(parent, n + 1);
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.12 },
  );
  items.forEach((el) => io.observe(el));
}

function initCopyPrompt(): void {
  const copyBtn = document.getElementById('copy-prompt');
  const note = document.getElementById('copy-note');
  const promptEl = document.getElementById('agent-prompt');
  copyBtn?.addEventListener('click', async () => {
    const text = promptEl?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    try {
      await navigator.clipboard.writeText(text);
      if (note) note.textContent = 'Copied. Paste it to your agent.';
    } catch {
      if (note) note.textContent = 'Your browser blocked the clipboard. Select the text and copy it.';
    }
    window.setTimeout(() => {
      if (note) note.textContent = '';
    }, 4000);
  });
}

export function initLanding(): void {
  initHeroPad();
  initReveal();
  initCopyPrompt();
}
