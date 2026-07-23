# Attribution

The PadKit firmware builds on the **CH552 USB / NeoPixel software stack** by
**Stefan "wagiminator" Wagner**.

- Upstream author: Stefan Wagner
- Upstream repository / project index: https://github.com/wagiminator
  (the CH552 USB device and MacroPad Mini projects, e.g.
  `github.com/wagiminator/CH552-USB-*` and `.../CH552-MacroPad-*`)
- Upstream license: Creative Commons Attribution-ShareAlike (CC BY-SA)

We vendor the stack rather than pin a package, so builds are reproducible. We did
not record a specific upstream commit hash for this snapshot; the files match the
wagiminator CH552 stack as bundled, with the two PadKit modifications noted below.

## Files derived from wagiminator's CH552 stack

All files under `include/` originate from the upstream stack:

| File                    | Origin      | PadKit changes |
| ----------------------- | ----------- | -------------- |
| `include/ch554.h`       | wagiminator | none (verbatim) |
| `include/system.h`      | wagiminator | none (verbatim) |
| `include/gpio.h`        | wagiminator | none (verbatim) |
| `include/delay.h`       | wagiminator | none (verbatim) |
| `include/delay.c`       | wagiminator | none (verbatim) |
| `include/neo.h`         | wagiminator | none (verbatim) |
| `include/neo.c`         | wagiminator | none (verbatim) |
| `include/usb.h`         | wagiminator | none (verbatim) |
| **`include/usb_descr.h`** | wagiminator | **PATCHED** (v0.2) — composite config struct (IF0 kbd + IF1 vendor), two report descriptors, EP2 32-byte IN+OUT buffer layout, IF1 string |
| **`include/usb_descr.c`** | wagiminator | **PATCHED** (v0.2) — two-interface config descriptor + keyboard and vendor (0xFF60/0x61) report descriptors |
| **`include/usb_handler.h`** | wagiminator | **PATCHED** (v0.2) — added `HID_EP2_IN` + `EP2_IN_callback` for the vendor IN endpoint |
| **`include/usb_handler.c`** | wagiminator | **PATCHED** (v0.2) — report/HID descriptor GET dispatched by interface number |
| **`include/usb_conkbd.h`** | wagiminator | **PATCHED** (v0.2) — declared `KBD_pressRaw` / `KBD_releaseRaw` |
| **`include/usb_conkbd.c`** | wagiminator | **PATCHED** (v0.2) — added raw keycode+modifier emit for the remappable keymap |
| `include/config.h`      | wagiminator | build config edited (product string `PadKit`, IF1 string, bcdDevice 0x0200, kept VID/PID); no code logic |
| **`include/usb_hid.c`** | wagiminator | **PATCHED** — watchdog-fed `HID_sendReport()`; v0.2 replaced LED parsing with the vendor EP2 transport (`HID_sendVendor`, command latch, `HID_EP2_IN`) |
| **`include/usb_hid.h`** | wagiminator | **PATCHED** — v0.2 vendor-transport declarations (`HID_sendVendor`, `HID_cmdBuf`/`HID_cmdPending`) |

Each patched file carries an in-source `PadKit local patch vs wagiminator
upstream` comment block describing exactly what changed and why.

## PadKit-original files

| File          | Notes |
| ------------- | ----- |
| `padkit.c`    | PadKit application firmware (device behavior, key/encoder/LED engine, v0.2 vendor protocol). Written for PadKit; links the vendored stack above. |
| **`include/dataflash.c`** | PadKit-original CH552 DataFlash driver (config persistence). New in v0.2; carries a `PadKit local addition` header. Implemented per the CH552 datasheet ISP method. |
| **`include/dataflash.h`** | PadKit-original DataFlash driver interface. New in v0.2. |
| `Makefile`    | PadKit build rules for SDCC. |
| `README.md`   | PadKit firmware documentation. |

## License

Because this firmware is a derivative and combined work of the CC BY-SA stack, the
entire firmware directory is distributed under **CC BY-SA 3.0** (share-alike). See
[`LICENSE`](LICENSE).
