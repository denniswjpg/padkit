# PadKit (web)

The PadKit site on GitHub Pages. Three static pages, no backend, nothing leaves your machine:

- `index.html`, a landing page that explains the project, with an interactive pad you can drive
  from the real F13 to F18 keys.
- `flash.html`, a guided WebUSB firmware flasher for the CH552 ROM bootloader.
- `config.html`, a WebHID config tool that live-edits key colors, brightness, lighting effects
  and the per-key keymap, then **saves to the device's own flash**.

It speaks the host side of the frozen [`docs/protocol-v2.md`](../docs/protocol-v2.md) vendor-HID
protocol: 32-byte reports on the vendor collection (Usage Page `0xFF60`, Usage `0x61`), never the
keyboard collection.

## Browser support

WebHID is required, so this works in **Google Chrome** and **Microsoft Edge** on desktop
(macOS, Windows, Linux), over `https://` or `localhost`. Firefox and Safari do not implement
WebHID; the app detects this and shows a clear notice instead of failing silently.

## Develop

```sh
npm install
npm run dev        # Vite dev server (open the printed http://localhost URL in Chrome/Edge)
```

## Build (for GitHub Pages)

```sh
npm run build      # typechecks (tsc --noEmit) then emits dist/
npm run preview    # serve the built dist/ locally to sanity-check
```

`vite.config.ts` sets `base: './'` (relative), so the built `dist/` works at any path — a project
Pages site (`https://<user>.github.io/<repo>/…`), a custom domain root, or a subfolder — with no
reconfiguration. `dist/` is git-ignored (root `.gitignore`); publish it via your Pages workflow.

## Test

```sh
npm test           # node --experimental-strip-types src/selftest.ts
```

Because there is no hardware in CI, the protocol codec is exercised against an in-memory device
model ([`src/mock.ts`](src/mock.ts)): [`src/selftest.ts`](src/selftest.ts) encodes each command,
feeds it to the mock, and asserts the decoders read back exactly what was written (report
framing, little-endian idle-dim timeout, RGB layout, config round-trip, FW_INFO capability bits,
SAVE→ACK, unknown-command error ACK, byte clamping).

## Layout

| Path | What |
|---|---|
| `src/protocol.ts` | Pure, DOM-free codec for the 32-byte reports (the auditable core). |
| `src/padkit-hid.ts` | WebHID transport: device request, `0xFF60` collection selection, typed events, ACK waiting. |
| `src/keycodes.ts` | HID keyboard usage codes + modifier bits with friendly labels for the shortcut picker. |
| `src/main.ts` | Config tool: connect, key grid + editor, lighting, live monitor, save/reset. |
| `src/mock.ts` / `src/selftest.ts` | Hardware-free device model + codec self-test. |
| `index.html` / `landing.ts` | Landing page and the interactive pad hero. |
| `flash.html` / `flash-entry.ts` | Guided flasher page; mounts the wizard. |
| `src/flash-core.ts` | WebUSB transport + flash state machine (`runFlash`), ported from `../flasher/isp55e0.c`. |
| `src/isp.ts` | Pure WCH-ISP codec for the CH55x ROM bootloader. |
| `src/flash-wizard.ts` / `src/meters.ts` | Guided three-step flashing UI + progress visuals. |
| `src/pad-figure.ts` | The macropad drawn in CSS (hero and flash progress display). |
| `theme.css` / `src/dark-shell.css` / `src/base.css` / `src/motion.css` | Styling and motion. |

### How the vendor collection is selected

`navigator.hid.requestDevice()` filters on `vendorId 0x1189`, `productId 0x8890`, and
`usagePage 0xFF60` / `usage 0x61`. From the granted devices, `pickVendorDevice()` opens the one
whose `collections` include `usagePage === 0xFF60` — **not** "the first HID path", which is the
keyboard collection and would fail on Windows (protocol §1/§9). Output reports are sent with
report id `0` (the vendor interface has no report IDs).

### Firmware flashing

The **firmware flasher** (`flash.html`) drives the CH552 ROM bootloader over WebUSB, erasing,
writing and verifying the embedded `firmware/padkit.bin`. `src/flash-core.ts` owns the transport
and state machine; `src/flash-wizard.ts` owns the guided UI. Add `?preview=1` to walk the whole
flow against a simulated pad with no hardware. Implementation notes and the mapping to the
reference C flasher are in [`FLASHER_NOTES.md`](FLASHER_NOTES.md).

## License

MIT — see the repository root [`LICENSE`](../LICENSE).
