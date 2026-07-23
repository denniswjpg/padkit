# PadKit Config (web)

Zero-install browser config tool for the PadKit CH552 macropad. It connects to the pad over
**WebHID**, lets you live-edit key colors, brightness, lighting effects and the per-key keymap,
then **saves to the device's own flash**. There is no backend and nothing leaves your machine —
it is a static single-page app served from GitHub Pages.

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
| `src/main.ts` | UI: connect, key grid + editor, lighting, live monitor, save/reset. |
| `src/mock.ts` / `src/selftest.ts` | Hardware-free device model + codec self-test. |
| `flash.html` / `src/flash.ts` | Firmware-flasher **stub** (WebUSB seam; see [`docs/flashing.md`](../docs/flashing.md)). |

### How the vendor collection is selected

`navigator.hid.requestDevice()` filters on `vendorId 0x1189`, `productId 0x8890`, and
`usagePage 0xFF60` / `usage 0x61`. From the granted devices, `pickVendorDevice()` opens the one
whose `collections` include `usagePage === 0xFF60` — **not** "the first HID path", which is the
keyboard collection and would fail on Windows (protocol §1/§9). Output reports are sent with
report id `0` (the vendor interface has no report IDs).

### What's stubbed

The **firmware flasher** (`flash.html`) is a placeholder. Browser flashing over WebUSB is a
planned follow-up; the page detects WebUSB and points to the CLI flow in `docs/flashing.md`.
`src/flash.ts` documents the ch55xduino-style WCH-ISP-over-WebUSB approach the real
implementation will follow.

## License

MIT — see the repository root [`LICENSE`](../LICENSE).
