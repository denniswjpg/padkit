// SPDX-License-Identifier: MIT

import {
  FILTERS,
  INTERFACE_NUMBER,
  POLL_INTERVAL_MS,
  friendlyError,
  loadFirmware,
  pickBootloader,
  runFlash,
  type FirmwareInfo,
  type Progress,
} from './flash-core.ts';

export interface WizardOptions {

  configUrl?: string;

  photos?: { src: string; caption: string }[];

  meter?: (host: HTMLElement) => FlashMeter;
}

export interface FlashMeter {

  phase(phase: Progress['phase']): void;

  progress(fraction: number, done: number, total: number): void;

  finish(ok: boolean): void;
  reset(): void;
}

const GRANT_KEY = 'padkit.flasher.granted';

function isPreview(): boolean {
  const q = new URLSearchParams(location.search);
  return q.get('preview') === '1' || location.hash === '#preview';
}

async function simulateFlash(onProgress: (p: Progress) => void): Promise<void> {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const total = 122;
  onProgress({ phase: 'connecting' });
  await wait(420);
  onProgress({ phase: 'identifying' });
  await wait(520);
  onProgress({ phase: 'erasing' });
  await wait(700);
  for (let i = 1; i <= total; i++) {
    onProgress({ phase: 'writing', done: i, total });
    await wait(14);
  }
  for (let i = 1; i <= total; i++) {
    onProgress({ phase: 'verifying', done: i, total });
    await wait(11);
  }
  onProgress({ phase: 'rebooting' });
  await wait(600);
  onProgress({ phase: 'done' });
}

function hasStoredGrant(): boolean {
  try {
    return localStorage.getItem(GRANT_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberGrant(): void {
  try {
    localStorage.setItem(GRANT_KEY, '1');
  } catch {

  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function b(text: string): HTMLElement {
  return el('b', {}, text);
}

function code(text: string): HTMLElement {
  return el('code', {}, text);
}

const PHASE_LABEL: Record<Progress['phase'], string> = {
  connecting: 'Opening the pad',
  identifying: 'Reading the chip',
  erasing: 'Erasing',
  writing: 'Writing firmware',
  verifying: 'Verifying',
  rebooting: 'Restarting',
  done: 'Done',
};

function defaultMeter(host: HTMLElement): FlashMeter {
  const fill = el('div', { class: 'pkw-bar-fill' });
  const bar = el('div', { class: 'pkw-bar' }, fill);
  const label = el('p', { class: 'pkw-bar-label' }, 'Starting');
  host.append(bar, label);
  return {
    phase(p) {
      label.textContent = PHASE_LABEL[p];
      if (p === 'connecting' || p === 'identifying' || p === 'erasing') fill.style.width = '6%';
    },
    progress(f) {
      fill.style.width = `${Math.round(f * 100)}%`;
    },
    finish(ok) {
      fill.style.width = '100%';
      bar.dataset.done = ok ? 'ok' : 'err';
    },
    reset() {
      fill.style.width = '0%';
      delete bar.dataset.done;
      label.textContent = 'Starting';
    },
  };
}

type Step = 'prepare' | 'catch' | 'flashing' | 'done' | 'error' | 'unsupported';

export function mountWizard(root: HTMLElement, opts: WizardOptions = {}): void {
  const preview = isPreview();
  const usb = preview ? undefined : navigator.usb;
  const configUrl = opts.configUrl ?? './config.html';
  const photos = opts.photos ?? [];

  const eyebrow = el('p', { class: 'pkw-eyebrow' });
  const title = el('h2', { class: 'pkw-title' });
  const body = el('div', { class: 'pkw-body' });
  const slot = el('div', { class: 'pkw-slot' });
  const actions = el('div', { class: 'pkw-actions' });
  const panel = el(
    'div',
    { class: 'pkw-panel' },
    el('div', { class: 'pkw-head' }, eyebrow, title, body),
    slot,
    actions,
  );
  const live = el('p', { class: 'pkw-live', role: 'status', 'aria-live': 'polite' });
  root.replaceChildren(panel, live);
  root.classList.add('pkw');

  let step: Step = 'prepare';
  let firmware: FirmwareInfo | null = null;
  let firmwareError = '';
  let detected: USBDevice | null = null;
  let watching = false;
  let busy = false;
  let lastError = '';
  let result = '';
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let meter: FlashMeter | null = null;
  let meterHost: HTMLElement | null = null;

  const setLive = (text: string) => {
    live.textContent = text;
  };

  const primary = (label: string, onClick: () => void) => {
    const btn = el('button', { class: 'pkw-btn pkw-btn-primary', type: 'button' }, label);
    btn.addEventListener('click', onClick);
    return btn;
  };
  const secondary = (label: string, onClick: () => void) => {
    const btn = el('button', { class: 'pkw-btn pkw-btn-quiet', type: 'button' }, label);
    btn.addEventListener('click', onClick);
    return btn;
  };

  const stopWatching = () => {
    watching = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const refreshDetected = async () => {
    if (!usb) return;
    try {
      detected = pickBootloader(await usb.getDevices()) ?? null;
    } catch {
      detected = null;
    }
  };

  const startWatching = () => {
    if (!usb || watching) return;
    watching = true;
    pollTimer = setInterval(() => {
      if (busy || !watching) return;
      void (async () => {
        await refreshDetected();
        if (detected && watching && !busy) void flash(detected);
      })();
    }, POLL_INTERVAL_MS);
  };

  const onProgress = (p: Progress) => {
    meter?.phase(p.phase);
    if ((p.phase === 'writing' || p.phase === 'verifying') && p.total) {
      meter?.progress((p.done ?? 0) / p.total, p.done ?? 0, p.total);
    }
    if (p.phase !== 'done') setLive(PHASE_LABEL[p.phase]);
  };

  const previewFlash = async () => {
    if (busy) return;
    busy = true;
    stopWatching();
    step = 'flashing';
    render();
    await simulateFlash(onProgress);
    result = 'CH552, bootloader 2.5.0, chip id 00-00-00-00. 122 blocks written and read back. This was a preview, no pad was touched.';
    meter?.finish(true);
    step = 'done';
    busy = false;
    render();
  };

  const flash = async (device: USBDevice) => {
    if (busy || !firmware) return;
    busy = true;
    stopWatching();
    step = 'flashing';
    render();
    try {
      const info = await runFlash(device, firmware.bytes, onProgress);
      rememberGrant();
      result = `${info.chipName}, bootloader ${info.bootloader}, chip id ${info.chipId}. ${info.chunks} blocks written and read back.`;
      meter?.finish(true);
      step = 'done';
    } catch (err) {
      lastError = friendlyError(err);
      meter?.finish(false);
      step = 'error';
    } finally {
      if (device.opened) {
        await device.releaseInterface(INTERFACE_NUMBER).catch(() => {});
        await device.close().catch(() => {});
      }
      busy = false;
      detected = null;
      render();
    }
  };

  const chooseAndFlash = async () => {
    if (!usb || busy || !firmware) return;
    setLive('Waiting for you to pick the pad');
    try {
      const device = await usb.requestDevice({ filters: FILTERS });
      rememberGrant();
      await flash(device);
    } catch (err) {
      lastError = friendlyError(err);
      step = 'error';
      render();
    }
  };

  const renderPrepare = () => {
    eyebrow.textContent = 'Step 1 of 3';
    title.textContent = 'Open the pad and find SW2';
    body.replaceChildren(
      el(
        'p',
        {},
        'The CH552 only accepts new firmware from its built-in bootloader, and the only way in is the ',
        b('SW2'),
        ' pads on the back of the board. You need a small screwdriver and tweezers.',
      ),
    );

    const list = el(
      'ol',
      { class: 'pkw-steps' },
      el('li', {}, 'Undo the four screws in the corners of the faceplate.'),
      el('li', {}, 'Lift the board out. SW2 is on the back, right next to the ', code('U7'), ' chip.'),
      el(
        'li',
        {},
        'Keep the tweezers handy. In the next step you bridge SW2 while the cable goes in.',
      ),
    );

    slot.replaceChildren(list);
    if (photos.length) {
      const figures = photos.map((p, i) =>
        el(
          'figure',
          { class: 'pkw-figure' },
          el('img', { src: p.src, alt: p.caption, loading: 'lazy', decoding: 'async' }),
          el('figcaption', {}, `${i + 1}. ${p.caption}`),
        ),
      );
      slot.append(el('div', { class: 'pkw-figures' }, ...figures));
    }

    actions.replaceChildren(
      primary('The board is open', () => {
        step = 'catch';
        render();
      }),
      secondary('I have done this before', () => {
        rememberGrant();
        step = 'catch';
        render();
      }),
    );
  };

  const renderCatch = () => {
    eyebrow.textContent = 'Step 2 of 3';
    actions.replaceChildren();
    slot.replaceChildren();

    if (preview) {
      title.textContent = 'Preview mode';
      body.replaceChildren(
        el(
          'p',
          {},
          'No pad is involved. This runs the same screens against a fake one so you can see what flashing looks like end to end.',
        ),
      );
      actions.replaceChildren(
        primary('Run the preview flash', () => void previewFlash()),
        secondary('Back to the steps', () => {
          step = 'prepare';
          render();
        }),
      );
      return;
    }

    if (!firmware) {
      title.textContent = 'Loading the firmware';
      body.replaceChildren(
        el('p', {}, firmwareError || 'Fetching the PadKit firmware image from this site.'),
      );
      if (firmwareError) {
        actions.replaceChildren(primary('Try again', () => void bootFirmware()));
      }
      return;
    }

    if (detected) {
      title.textContent = 'Your pad is in bootloader mode';
      body.replaceChildren(
        el('p', {}, 'The browser can see it. Flashing takes a few seconds and nothing else on your machine is touched.'),
      );
      slot.replaceChildren(el('div', { class: 'pkw-ready' }, 'Ready to flash'));
      actions.replaceChildren(primary('Flash it now', () => void flash(detected!)));
      setLive('Pad detected and ready to flash');
      return;
    }

    if (hasStoredGrant()) {

      title.textContent = 'Put the pad into bootloader mode';
      body.replaceChildren(
        el(
          'p',
          {},
          'Bridge the ',
          b('SW2'),
          ' pads with tweezers, plug in the USB-C cable while you hold them, then let go. Flashing starts on its own the moment the pad appears.',
        ),
      );
      slot.replaceChildren(
        el(
          'div',
          { class: 'pkw-listen' },
          el('span', { class: 'pkw-pulse', 'aria-hidden': 'true' }),
          el('span', {}, 'Listening for the bootloader'),
        ),
      );
      actions.replaceChildren(
        secondary('Pick the pad myself instead', () => void chooseAndFlash()),
        secondary('Back', () => {
          stopWatching();
          step = 'prepare';
          render();
        }),
      );
      startWatching();
      setLive('Listening for the pad');
      return;
    }

    title.textContent = 'Bridge SW2, plug in, then pick the pad';
    body.replaceChildren(
      el(
        'p',
        {},
        'Bridge the ',
        b('SW2'),
        ' pads with tweezers, plug in the USB-C cable while you hold them, then let go. The pad shows up as ',
        code('4348:55e0'),
        '.',
      ),
      el(
        'p',
        {},
        b('Do the next bit quickly.'),
        ' The pad stays in bootloader mode for a few seconds only. Press the button and pick PadKit from the list your browser shows.',
      ),
    );
    slot.replaceChildren(
      el(
        'p',
        { class: 'pkw-note' },
        'This is the only time you have to hurry. Your browser remembers the pad afterwards, so every later flash waits for you.',
      ),
    );
    actions.replaceChildren(
      primary('Pick the pad', () => void chooseAndFlash()),
      secondary('Back', () => {
        step = 'prepare';
        render();
      }),
    );
    startWatching();
  };

  const renderFlashing = () => {
    eyebrow.textContent = 'Step 3 of 3';
    title.textContent = 'Flashing';
    body.replaceChildren(
      el('p', {}, 'This takes a few seconds. Leave the cable in and keep this tab in front.'),
    );
    meterHost = el('div', { class: 'pkw-meter' });
    slot.replaceChildren(meterHost);
    actions.replaceChildren();
    meter = opts.meter ? opts.meter(meterHost) : defaultMeter(meterHost);
  };

  const renderDone = () => {
    eyebrow.textContent = 'Done';
    title.textContent = 'Firmware is on the pad';
    body.replaceChildren(
      el(
        'p',
        {},
        'Unplug the pad and plug it back in ',
        b('without touching SW2'),
        '. It comes back as a normal keyboard and sends F13 to F23.',
      ),
    );

    slot.replaceChildren(...(meterHost ? [meterHost] : []), el('p', { class: 'pkw-note' }, result));
    const a = el('a', { class: 'pkw-btn pkw-btn-primary', href: configUrl }, 'Set up colours and keys');
    actions.replaceChildren(
      a,
      secondary('Flash again', () => {
        step = 'catch';
        render();
      }),
    );
    setLive('Firmware flashed');
  };

  const renderError = () => {
    eyebrow.textContent = 'That did not work';
    title.textContent = 'The flash stopped';
    body.replaceChildren(
      el('p', {}, lastError),
      el(
        'p',
        { class: 'pkw-note' },
        'The bootloader lives in read-only ROM, so the pad cannot be bricked by a failed flash. Redo the SW2 short and try again as often as you like.',
      ),
    );
    slot.replaceChildren(...(meterHost ? [meterHost] : []));
    actions.replaceChildren(
      primary('Try again', () => {
        lastError = '';
        meterHost = null;
        step = 'catch';
        render();
      }),
      secondary('Show the steps again', () => {
        lastError = '';
        step = 'prepare';
        render();
      }),
    );
    setLive('Flashing stopped');
  };

  const renderUnsupported = () => {
    eyebrow.textContent = 'Wrong browser';
    title.textContent = 'This browser cannot reach USB devices';
    body.replaceChildren(
      el(
        'p',
        {},
        'Browser flashing needs WebUSB, which today means desktop Chrome, Edge, or another Chromium browser. Safari and Firefox do not have it.',
      ),
      el(
        'p',
        {},
        'You can also flash from a terminal with the ',
        code('isp55e0'),
        ' tool in the repository, which works everywhere.',
      ),
    );
    slot.replaceChildren();
    actions.replaceChildren();
  };

  function render(): void {
    root.dataset.step = step;
    if (step === 'prepare') renderPrepare();
    else if (step === 'catch') renderCatch();
    else if (step === 'flashing') renderFlashing();
    else if (step === 'done') renderDone();
    else if (step === 'error') renderError();
    else renderUnsupported();
  }

  if (usb) {
    usb.addEventListener('connect', (ev: USBConnectionEvent) => {
      if (!pickBootloader([ev.device])) return;
      detected = ev.device;
      if (watching && !busy) void flash(ev.device);
      else if (!busy && step === 'catch') render();
    });
    usb.addEventListener('disconnect', (ev: USBConnectionEvent) => {
      if (detected === ev.device) detected = null;
      if (!busy && step === 'catch') render();
    });
  }

  async function bootFirmware(): Promise<void> {
    firmwareError = '';
    try {
      firmware = await loadFirmware();
      const line = document.querySelector<HTMLElement>('[data-firmware-line]');
      if (line) {
        line.replaceChildren(
          `${firmware.length.toLocaleString('en-GB')} bytes`,
          el('span', { class: 'pkw-sep' }, '/'),
          `SHA-256 ${firmware.sha256 ? firmware.sha256.slice(0, 12) : 'unavailable'}`,
        );
      }
    } catch (err) {
      firmware = null;
      firmwareError = friendlyError(err);
    }
    if (step === 'catch') render();
  }

  if (!usb && !preview) {
    step = 'unsupported';
    render();
    return;
  }

  if (preview) {
    const line = document.querySelector<HTMLElement>('[data-firmware-line]');
    if (line) line.textContent = 'not loaded, this is a preview';
    render();
    return;
  }

  if (hasStoredGrant()) step = 'catch';

  void refreshDetected().then(() => {
    if (detected) step = 'catch';
    render();
  });
  void bootFirmware();
  render();
}
