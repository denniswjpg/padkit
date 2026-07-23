// PadKit firmware flasher — real WebUSB implementation. SPDX-License-Identifier: MIT
//
// Drives the CH552 WCH ISP ROM bootloader over WebUSB, porting the exact
// command sequence and byte layouts from ../../flasher/isp55e0.c. The protocol
// codec lives in ./isp.ts (pure, unit-tested); this file owns the WebUSB
// transport, the flash state machine, and the page UI.
//
// Bootloader identity: USB 4348:55e0 (some units 1a86:55e0), a vendor-specific
// (class 0xFF) interface. We claim interface 0 and use bulk endpoint number 2
// for both directions (isp55e0.h EP_OUT 0x02 / EP_IN 0x82). On macOS + Chrome
// no driver is needed.

import {
  Cmd,
  bootloaderSupport,
  chunkPlan,
  deriveXorKey,
  findProfile,
  frameChipType,
  frameEraseCode,
  frameFlashRw,
  frameLastWrite,
  frameReadConfig,
  frameReboot,
  frameSetKey,
  frameWriteConfig,
  keyChecksum,
  padFirmware,
  parseChipType,
  parseKeyChecksum,
  parseReadConfig,
  parseReturnCode,
  toHex,
  xorInPlace,
} from './isp.ts';

const FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x4348, productId: 0x55e0 },
  { vendorId: 0x1a86, productId: 0x55e0 },
];
const INTERFACE_NUMBER = 0;
const DEFAULT_ENDPOINT = 2; // isp55e0.h EP_OUT 0x02 / EP_IN 0x82
const FIRMWARE_URL = './firmware/padkit.bin';
const USB_TIMEOUT_MS = 5000; // isp55e0.h USB_TIMEOUT
const CONFIG_TOOL_URL = './index.html';
const REDIRECT_SECONDS = 8;
const POLL_INTERVAL_MS = 700;

class FlashError extends Error {}

// --- Pure device matching (unit-tested via a mock in flash.selftest.ts) -----

/** True if a USB device is the WCH CH55x ROM bootloader (4348/1a86 : 55e0). */
export function isBootloaderDevice(dev: { vendorId: number; productId: number }): boolean {
  return FILTERS.some((f) => f.vendorId === dev.vendorId && f.productId === dev.productId);
}

/** First WCH bootloader among already-authorized devices, or undefined. */
export function pickBootloader<T extends { vendorId: number; productId: number }>(
  devices: readonly T[],
): T | undefined {
  return devices.find(isBootloaderDevice);
}

// ---------------------------------------------------------------------------
// Low-level transport
// ---------------------------------------------------------------------------

interface Endpoints {
  out: number;
  in: number;
}

/** Discover bulk endpoint numbers from the claimed interface; fall back to 2. */
function findEndpoints(device: USBDevice): Endpoints {
  const eps: Endpoints = { out: DEFAULT_ENDPOINT, in: DEFAULT_ENDPOINT };
  const iface = device.configuration?.interfaces.find(
    (i) => i.interfaceNumber === INTERFACE_NUMBER,
  );
  for (const ep of iface?.alternate.endpoints ?? []) {
    if (ep.type !== 'bulk') continue;
    if (ep.direction === 'out') eps.out = ep.endpointNumber;
    else if (ep.direction === 'in') eps.in = ep.endpointNumber;
  }
  return eps;
}

/** Reject if a bulk transfer hangs (the ROM occasionally wedges an endpoint). */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new FlashError(`Timed out ${what}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * Send a request, read the reply (isp55e0.c transfer(), USB branch). Validates
 * the OUT/IN transfer status and returns the response bytes. `expectResponse`
 * is false only for the reboot, which the CH552 v2.50 ROM never ACKs.
 */
async function transfer(
  device: USBDevice,
  eps: Endpoints,
  req: Uint8Array,
  expectResponse = true,
): Promise<Uint8Array> {
  const out = await withTimeout(device.transferOut(eps.out, req), USB_TIMEOUT_MS, 'sending request');
  if (out.status !== 'ok') throw new FlashError(`USB write failed (${out.status})`);
  if (!expectResponse) return new Uint8Array(0);
  const inRes = await withTimeout(device.transferIn(eps.in, 64), USB_TIMEOUT_MS, 'reading reply');
  if (inRes.status === 'stall') {
    await device.clearHalt('in', eps.in).catch(() => {});
    throw new FlashError('Device stalled the reply endpoint');
  }
  if (!inRes.data) throw new FlashError('Empty reply from device');
  return new Uint8Array(inRes.data.buffer, inRes.data.byteOffset, inRes.data.byteLength);
}

// ---------------------------------------------------------------------------
// Flash state machine (mirrors isp55e0.c main() ordering)
// ---------------------------------------------------------------------------

export interface Progress {
  phase: 'connecting' | 'identifying' | 'erasing' | 'writing' | 'verifying' | 'rebooting' | 'done';
  done?: number;
  total?: number;
  message?: string;
}

type OnProgress = (p: Progress) => void;

async function runFlash(
  device: USBDevice,
  firmware: Uint8Array,
  onProgress: OnProgress,
): Promise<{ chipName: string; bootloader: string; chipId: string; chunks: number }> {
  onProgress({ phase: 'connecting', message: 'Opening device…' });
  if (!device.opened) await device.open();
  if (device.configuration === null) await device.selectConfiguration(1);
  await device.claimInterface(INTERFACE_NUMBER);

  // Endpoint-stall fix (isp55e0.c open_usb_device() ~line 304): the CH552 ROM
  // can come up with its bulk endpoints halted, so clear both. Harmless when
  // they are already fine; best-effort (never fatal).
  const eps = findEndpoints(device);
  await device.clearHalt('out', eps.out).catch(() => {});
  await device.clearHalt('in', eps.in).catch(() => {});

  // --- Identify chip (CMD_CHIP_TYPE) ---
  onProgress({ phase: 'identifying', message: 'Identifying chip…' });
  const typeResp = await transfer(device, eps, frameChipType());
  if ((typeResp[0] ?? 0) !== Cmd.CHIP_TYPE) {
    throw new FlashError('Unexpected reply to chip-type query (is this the WCH bootloader?)');
  }
  const { type, family } = parseChipType(typeResp);
  if (family === 0) {
    // isp55e0.c: family 0 means the chip is hosed / no WCH signature.
    throw new FlashError('Chip did not return a WCH signature — reset or power-cycle it.');
  }
  const profile = findProfile(family, type);
  if (!profile) {
    throw new FlashError(
      `Unsupported chip family 0x${family.toString(16)} type 0x${type.toString(16)}.`,
    );
  }

  // --- Read config (unique id, bootloader version) ---
  const cfgResp = await transfer(device, eps, frameReadConfig());
  const { config, bootloaderVersion, id } = parseReadConfig(cfgResp);
  const support = bootloaderSupport(bootloaderVersion); // throws on unsupported
  const chipId = toHex(id.subarray(0, profile.mcuIdLen), '-');

  // Firmware must fit the code flash (isp55e0.c load_file()).
  const padded = padFirmware(firmware);
  if (padded.length > profile.codeFlashSize) {
    throw new FlashError(
      `Firmware (${padded.length} B) does not fit ${profile.name} code flash (${profile.codeFlashSize} B).`,
    );
  }

  // --- Derive + encrypt (isp55e0.c create_key + encrypt_or_decrypt) ---
  const key = deriveXorKey(id, profile.mcuIdLen, profile.type);
  const encrypted = xorInPlace(padded.slice(), key); // encrypt the whole image once
  const chunks = chunkPlan(encrypted.length);

  const sendKey = async () => {
    const resp = await transfer(device, eps, frameSetKey());
    if (parseKeyChecksum(resp) !== keyChecksum(key)) {
      throw new FlashError('Device rejected the encryption key.');
    }
  };

  // --- Program (send_key -> write_config -> erase -> write) ---
  await sendKey();
  await transfer(device, eps, frameWriteConfig(config)); // isp55e0 does not check this reply

  onProgress({ phase: 'erasing', message: 'Erasing code flash…' });
  const eraseResp = await transfer(device, eps, frameEraseCode(padded.length));
  if (parseReturnCode(eraseResp) !== 0) throw new FlashError('Device refused to erase code flash.');

  onProgress({ phase: 'writing', done: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const resp = await transfer(
      device,
      eps,
      frameFlashRw(Cmd.WRITE_CODE_FLASH, c.offset, encrypted.subarray(c.offset, c.offset + c.length)),
    );
    if (parseReturnCode(resp) !== 0) {
      throw new FlashError(`Write failed at offset ${c.offset}.`);
    }
    onProgress({ phase: 'writing', done: i + 1, total: chunks.length });
  }
  if (profile.needLastWrite) {
    // CH55x does NOT set this; present for protocol fidelity only.
    const resp = await transfer(device, eps, frameLastWrite(padded.length));
    if (parseReturnCode(resp) !== 0) throw new FlashError('Final padding write failed.');
  }

  // --- Verify (send_key again -> CMP each chunk) ---
  await sendKey();
  onProgress({ phase: 'verifying', done: 0, total: chunks.length });
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const resp = await transfer(
      device,
      eps,
      frameFlashRw(Cmd.CMP_CODE_FLASH, c.offset, encrypted.subarray(c.offset, c.offset + c.length)),
    );
    if (parseReturnCode(resp) !== 0) {
      throw new FlashError(`Verify mismatch at offset ${c.offset}.`);
    }
    onProgress({ phase: 'verifying', done: i + 1, total: chunks.length });
  }

  // --- Reboot (isp55e0.c reboot_device(), patched ~line 826) ---
  // The CH552 v2.50 ROM flashes+verifies fine but NEVER ACKs CMD_REBOOT. Fire
  // it and do not require a reply — a missing reboot ACK is success. We attempt
  // a best-effort read only when the ROM version is one that acks, and swallow
  // any error/timeout regardless.
  onProgress({ phase: 'rebooting', message: 'Rebooting…' });
  await transfer(device, eps, frameReboot(), false);
  if (support.waitRebootResp) {
    await withTimeout(device.transferIn(eps.in, 64), 600, 'reboot ack').catch(() => {});
  }

  onProgress({ phase: 'done' });
  return {
    chipName: profile.name,
    bootloader: `${support.major}.${support.minor}.${support.patch}`,
    chipId,
    chunks: chunks.length,
  };
}

// ---------------------------------------------------------------------------
// Firmware loading + fingerprint
// ---------------------------------------------------------------------------

interface FirmwareInfo {
  bytes: Uint8Array;
  length: number;
  sha256: string; // full hex, may be '' if unavailable
}

async function loadFirmware(): Promise<FirmwareInfo> {
  const res = await fetch(FIRMWARE_URL, { cache: 'no-store' });
  if (!res.ok) throw new FlashError(`Could not load firmware (${res.status} ${res.statusText}).`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let sha256 = '';
  try {
    if (crypto?.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buf);
      sha256 = toHex(new Uint8Array(digest));
    }
  } catch {
    sha256 = '';
  }
  return { bytes, length: bytes.length, sha256 };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

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

function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : '';
  // navigator.usb.requestDevice throws NotFoundError when the user picks nothing.
  if (name === 'NotFoundError' || /No device selected|no device chosen/i.test(msg)) {
    return 'No device was selected. Put the pad in bootloader mode (hold SW2 while plugging in USB), then pick it from the chooser.';
  }
  if (/access denied|SecurityError/i.test(name + msg)) {
    return 'The browser blocked access to the device. On Windows the bootloader needs the WinUSB driver (one-time Zadig step); on macOS this should not happen — try re-plugging in bootloader mode.';
  }
  if (/claim|Unable to claim|already in use|InvalidStateError/i.test(name + msg)) {
    return 'Could not claim the device. Close any other tab or program using it, re-enter bootloader mode (SW2 while plugging in), and try again.';
  }
  if (/transfer|stall|Timed out|USB write|reply/i.test(msg)) {
    return `${msg} — unplug the pad, re-enter bootloader mode (hold SW2 while plugging in USB), and flash again. The CH552 is unbrickable over USB, so a failed flash is always recoverable.`;
  }
  return msg;
}

function mountUi(root: HTMLElement): void {
  const usb = navigator.usb;

  // --- Bootloader-mode reminder + timing warning (always visible) ---
  const reminder = el(
    'div',
    { class: 'banner', style: 'margin:0 0 1rem;background:var(--accent-weak);border:1px solid color-mix(in srgb, var(--accent) 35%, transparent)' },
    el('strong', {}, 'Put the pad in bootloader mode first.'),
    ' Bridge the ',
    el('b', {}, 'SW2'),
    ' pads and keep holding while you plug in USB-C, then release — the pad enumerates as ',
    el('code', {}, '4348:55e0'),
    '. ',
    el(
      'b',
      { style: 'color:var(--warn)' },
      'This window is short (a few seconds):',
    ),
    ' the moment you are in bootloader mode, promptly click the button below and pick the device. If the chooser is empty or the device vanished, just redo the SW2 short and try again — the CH552 is unbrickable, so retries are free.',
  );

  // --- Firmware fingerprint ---
  const fwLine = el('p', { class: 'gated-note', style: 'margin:0 0 1rem;font-style:normal' }, 'Loading firmware…');

  // --- Buttons ---
  const btn = el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, 'Connect & flash');
  const waitBtn = el('button', { class: 'btn btn-lg', type: 'button' }, 'Wait for bootloader & auto-flash');
  const cancelWaitBtn = el('button', { class: 'btn', type: 'button', hidden: '' }, 'Cancel');

  // Guidance line directly under the buttons.
  const hint = el('p', { class: 'gated-note', style: 'margin:0.15rem 0 0' }, '');

  // --- Status + progress ---
  const status = el('p', { class: 'card-sub', style: 'margin:1rem 0 0.5rem', role: 'status', 'aria-live': 'polite' }, '');
  const barWrap = el('div', { class: 'flash-bar', hidden: '' });
  const barFill = el('div', { class: 'flash-bar-fill' });
  barWrap.append(barFill);
  const result = el('div', { class: 'flash-result', hidden: '' });

  let firmware: FirmwareInfo | null = null;
  let busy = false;
  let waiting = false;
  let detected: USBDevice | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;

  const setStatus = (text: string) => {
    status.textContent = text;
  };
  const setBar = (done: number, total: number) => {
    barWrap.hidden = false;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    barFill.style.width = `${pct}%`;
  };

  const onProgress: OnProgress = (p) => {
    switch (p.phase) {
      case 'connecting':
      case 'identifying':
      case 'erasing':
      case 'rebooting':
        setStatus(p.message ?? '');
        break;
      case 'writing':
        setStatus(`Writing… chunk ${p.done}/${p.total}`);
        setBar(p.done ?? 0, p.total ?? 1);
        break;
      case 'verifying':
        setStatus(`Verifying… chunk ${p.done}/${p.total}`);
        setBar(p.done ?? 0, p.total ?? 1);
        break;
      case 'done':
        break;
    }
  };

  const showError = (title: string, detail: string) => {
    stopCountdown();
    result.hidden = false;
    result.className = 'flash-result flash-err';
    result.replaceChildren(el('strong', {}, title), el('div', { style: 'margin-top:0.35rem' }, detail));
  };

  const stopCountdown = () => {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  // Rich success panel: what happened + how to boot the new app + a CTA to the
  // config tool, with an optional cancelable auto-redirect.
  const showSuccess = (summary: string) => {
    result.hidden = false;
    result.className = 'flash-result flash-ok';

    const cta = el(
      'a',
      { class: 'btn btn-primary btn-lg', href: CONFIG_TOOL_URL, style: 'text-decoration:none' },
      'Open the config tool →',
    );
    const count = el('span', {}, String(REDIRECT_SECONDS));
    const cancel = el('button', { class: 'btn btn-sm', type: 'button' }, 'Stay here');
    const redirectLine = el(
      'p',
      { class: 'gated-note', style: 'margin:0.75rem 0 0;font-style:normal' },
      'Opening the config tool in ',
      count,
      's… ',
      cancel,
    );

    let remaining = REDIRECT_SECONDS;
    stopCountdown();
    cancel.addEventListener('click', () => {
      stopCountdown();
      redirectLine.remove();
    });
    countdownTimer = setInterval(() => {
      remaining -= 1;
      count.textContent = String(remaining);
      if (remaining <= 0) {
        stopCountdown();
        window.location.assign(CONFIG_TOOL_URL);
      }
    }, 1000);

    result.replaceChildren(
      el('strong', { style: 'font-size:1.1rem' }, '✓ Firmware flashed'),
      el(
        'div',
        { style: 'margin-top:0.35rem' },
        'Now ',
        el('b', {}, 'unplug and replug the pad normally (no SW2)'),
        ' so it boots the new firmware — it will enumerate as ',
        el('code', {}, '1189:8890'),
        '.',
      ),
      el('div', { class: 'gated-note', style: 'margin-top:0.35rem;font-style:normal' }, summary),
      el('div', { style: 'margin-top:0.9rem' }, cta),
      redirectLine,
    );
  };

  // Enable/disable buttons based on state.
  const syncButtons = () => {
    const ready = !!usb && !!firmware && !busy;
    btn.disabled = !ready || waiting;
    waitBtn.hidden = waiting;
    waitBtn.disabled = !ready;
    cancelWaitBtn.hidden = !waiting;
    btn.textContent = detected ? 'Flash detected pad' : 'Connect & flash';
  };

  const flashDevice = async (device: USBDevice) => {
    if (busy || !usb || !firmware) return;
    busy = true;
    waiting = false;
    stopPolling();
    stopCountdown();
    result.hidden = true;
    barWrap.hidden = true;
    barFill.style.width = '0%';
    syncButtons();
    setStatus('Starting…');
    try {
      const info = await runFlash(device, firmware.bytes, onProgress);
      setStatus('');
      showSuccess(
        `${info.chipName} · bootloader ${info.bootloader} · id ${info.chipId} · ${info.chunks} chunks written and verified.`,
      );
    } catch (err) {
      setStatus('');
      showError('Flash failed.', friendlyError(err));
    } finally {
      if (device.opened) {
        await device.releaseInterface(INTERFACE_NUMBER).catch(() => {});
        await device.close().catch(() => {});
      }
      busy = false;
      await refreshDetected();
      syncButtons();
    }
  };

  // First-time / explicit path: use the detected device if present (no chooser),
  // otherwise pop the requestDevice chooser (needs this user gesture).
  const connectAndFlash = async () => {
    if (busy || !usb || !firmware) return;
    if (detected) {
      await flashDevice(detected);
      return;
    }
    result.hidden = true;
    setStatus('Requesting device…');
    try {
      const device = await usb.requestDevice({ filters: FILTERS });
      await flashDevice(device);
    } catch (err) {
      setStatus('');
      showError('No device selected.', friendlyError(err));
    }
  };

  // Poll getDevices() as a fallback to the connect event while waiting.
  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const refreshDetected = async (): Promise<void> => {
    if (!usb) return;
    try {
      detected = pickBootloader(await usb.getDevices()) ?? null;
    } catch {
      detected = null;
    }
  };

  // Waiting mode: arm first, then enter bootloader mode; auto-flash the instant
  // an authorized bootloader device appears. Removes the timing race entirely
  // on repeat flashes (Chrome remembers the grant from the first requestDevice).
  const armWaiting = async () => {
    if (busy || !usb || !firmware || waiting) return;
    // If it is already here, just flash now.
    await refreshDetected();
    if (detected) {
      await flashDevice(detected);
      return;
    }
    waiting = true;
    result.hidden = true;
    syncButtons();
    setStatus('Waiting for bootloader… enter bootloader mode now (SW2, then plug in USB-C).');
    stopPolling();
    pollTimer = setInterval(() => {
      if (busy || !waiting) return;
      void (async () => {
        await refreshDetected();
        if (detected && waiting && !busy) {
          await flashDevice(detected);
        }
      })();
    }, POLL_INTERVAL_MS);
  };

  const cancelWaiting = () => {
    waiting = false;
    stopPolling();
    setStatus('');
    syncButtons();
  };

  btn.addEventListener('click', () => void connectAndFlash());
  waitBtn.addEventListener('click', () => void armWaiting());
  cancelWaitBtn.addEventListener('click', () => cancelWaiting());

  // React to hot-plug so state stays correct if the short bootloader window
  // opens/closes on its own.
  const onConnect = (ev: USBConnectionEvent) => {
    if (!isBootloaderDevice(ev.device)) return;
    detected = ev.device;
    if (waiting && !busy) {
      void flashDevice(ev.device);
    } else {
      syncButtons();
      if (!busy) setStatus('Bootloader detected — click “Flash detected pad”.');
    }
  };
  const onDisconnect = (ev: USBConnectionEvent) => {
    if (!isBootloaderDevice(ev.device)) return;
    if (detected === ev.device) detected = null;
    if (!busy) syncButtons();
  };
  usb?.addEventListener('connect', onConnect);
  usb?.addEventListener('disconnect', onDisconnect);

  const controls = el(
    'div',
    { style: 'display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center' },
    btn,
    waitBtn,
    cancelWaitBtn,
  );

  root.append(reminder, fwLine, controls, hint, status, barWrap, result);

  // Feature-detect WebUSB.
  if (!usb) {
    btn.disabled = true;
    waitBtn.disabled = true;
    fwLine.textContent = '';
    showError(
      'This browser does not support WebUSB.',
      'Use desktop Chrome, Edge, or another Chromium browser (not Safari or Firefox) to flash from the browser. You can also flash from the command line with the isp55e0 tool (see below).',
    );
    return;
  }

  hint.replaceChildren(
    el('b', {}, 'First flash:'),
    ' use ',
    el('b', {}, 'Connect & flash'),
    ' and pick the pad. ',
    el('b', {}, 'After that,'),
    ' Chrome remembers it — you can click ',
    el('b', {}, 'Wait for bootloader & auto-flash'),
    ' first, then enter bootloader mode, and it flashes automatically.',
  );

  btn.disabled = true;
  waitBtn.disabled = true;

  // Load + fingerprint the embedded firmware, then see if a pad is already here.
  void loadFirmware()
    .then(async (info) => {
      firmware = info;
      const short = info.sha256 ? info.sha256.slice(0, 12) : 'unavailable';
      fwLine.replaceChildren(
        'Firmware: ',
        el('b', {}, `${info.length.toLocaleString()} bytes`),
        ' · SHA-256 ',
        el('code', {}, short),
      );
      await refreshDetected();
      syncButtons();
      if (detected) {
        setStatus('Bootloader already detected — click “Flash detected pad” to flash now.');
      }
    })
    .catch((err) => {
      firmware = null;
      syncButtons();
      fwLine.textContent = '';
      showError('Could not load firmware.', friendlyError(err));
    });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function probe(): void {
  const note = document.getElementById('webusb-probe');
  if (note) {
    note.textContent = navigator.usb
      ? 'Your browser supports WebUSB — you can flash right here.'
      : 'This browser does not expose WebUSB; use desktop Chrome/Edge, or the isp55e0 CLI below.';
  }
  const root = document.getElementById('flasher-root');
  if (root instanceof HTMLElement) mountUi(root);
}

// Bootstrap only in a real browser; guarded so runFlash can be imported and
// exercised against a mock device under Node (see src/flash.selftest.ts).
if (typeof document !== 'undefined' && typeof navigator !== 'undefined') {
  probe();
}

export { runFlash };
