# PadKit firmware (CH552G)

Firmware for the PadKit macropad: a 6-key + rotary-knob USB HID device built on a
WCH **CH552G** (8051-core) microcontroller with a strip of 6 addressable RGB LEDs
(NeoPixel / WS2812-style). No host driver is required.

This is **v0.2**, a **composite HID device**. It keeps the v0.1 keyboard behavior
and adds a cross-platform vendor interface for configuration:

- **IF0 — boot keyboard** (endpoint EP1 IN): emits **F13–F23** exactly like v0.1,
  so a host listener can bind them as universal keybinds without stealing ordinary
  keystrokes.
- **IF1 — vendor raw-HID** (endpoint EP2 IN + OUT, **usage page `0xFF60` / usage
  `0x61`**, the QMK raw-HID values): a browser (**WebHID**) or a native daemon
  (**hidapi**) can fully read/write it on macOS, Windows and Linux to set LEDs,
  remap keys, toggle flags, and receive a mirror of every physical event. Chromium
  and Windows block keyboard collections but exempt vendor usage pages, so config
  works everywhere. This mirrors QMK/VIA.

The vendor wire protocol is frozen in [`../docs/protocol-v2.md`](../docs/protocol-v2.md);
the firmware implements it exactly. Interface IF1 defines one **32-byte Output**
report (host→device commands) and one **32-byte Input** report (device→host events
and replies), **no report IDs**.

## What v0.2 adds over v0.1

- **Separate vendor interface (IF1).** v0.1 exposed a vendor collection *inside* the
  keyboard interface (usage page 0xFF00) — the WebHID-blocked layout. v0.2 gives the
  vendor reports their own interface, endpoint pair (EP2 IN + OUT), and report
  descriptor (0xFF60/0x61).
- **DataFlash persistence.** Brightness, effect, flags, idle-dim timeout, the 6 RGB
  defaults, and the 11-slot keymap persist to the CH552's on-chip DataFlash and
  survive unplug. A 2-byte magic + version guards the image; a **blank or bad
  DataFlash falls back to factory defaults and never bricks boot**.
- **Remappable keymap.** `SET_KEY` remaps any of the 11 control slots (6 keys, knob
  CW/CCW/click, push-turn CW/CCW) to any HID keycode + modifier. Defaults are
  F13–F23.
- **Suppress flag.** Flags bit 0 (`SUPPRESS_KEYBOARD`) makes IF0 stop emitting
  keystrokes; input still flows to the daemon via the vendor `INPUT_EVENT` report,
  so the daemon can own the pad with no keystroke leakage.
- **Effects + capabilities.** Static (0) and breathe (1) are implemented; blink is
  also available. `GET_INFO` reports a capabilities bitmask so the host can
  feature-gate its UI.
- **Input mirror.** Every physical event emits an `INPUT_EVENT` (0x81) on IF1,
  *always* — independent of the suppress flag.

## Build

Requires **SDCC** (tested with 4.5.0) plus `objcopy` (binutils) and `packihx`
(ships with SDCC).

```sh
make bin      # -> padkit.bin   (the image you flash)
make hex      # -> padkit.hex
make all      # bin + hex, keep intermediates
make clean    # remove build artifacts
```

`make bin` prints a FLASH/IRAM/XRAM size summary. The v0.2 build is **6815 bytes**
of flash (v0.1 was 4985); it fits the CH552's 16 KB with wide margin.

## USB descriptor sanity check

The composite config descriptor is assembled from typed structs, so the totals are
computed by the compiler, not hand-typed. Verified against the built `padkit.bin`:

| Field | Value | Check |
| --- | --- | --- |
| `wTotalLength` | 66 | 9 (config) + 25 (IF0: itf 9 + hid 9 + ep 7) + 32 (IF1: itf 9 + hid 9 + ep 7 + ep 7) |
| `bNumInterfaces` | 2 | IF0 keyboard + IF1 vendor |
| IF0 endpoints | EP1 IN `0x81`, 16-byte, interrupt | boot keyboard |
| IF1 endpoints | EP2 IN `0x82` + EP2 OUT `0x02`, 32-byte, interrupt | vendor raw-HID |
| IF0 report descriptor | 48 bytes | keyboard, usage page 0x01 / usage 0x06, report ID 1 |
| IF1 report descriptor | 34 bytes | vendor, usage page **0xFF60** / usage **0x61**, 32-byte IN + 32-byte OUT, no report IDs |
| `bcdDevice` | 0x0200 | v2.0 |

Endpoint buffer RAM (below `XRAM_LOC` 0x100 = 256 B): EP0 `[0..63]`, EP1 `[64..81]`,
EP2 `[82..209]` (128 B: OUT low half `[0..63]`, IN high half `[64..127]`, per the
CH55x bidirectional-endpoint layout). Total 210 B < 256 B — no overlap with
variables.

## Flash

The board is programmed through the CH55x ROM bootloader using the flasher in
[`../flasher/`](../flasher/) (`isp55e0`):

1. Enter the bootloader: hold the board's **boot pads** (or **key 4 / P1.5**) LOW
   while plugging in USB. The chip then enumerates as `4348:55e0`.
2. Flash: `isp55e0 -f padkit.bin` on the host the pad is plugged into.

## Pin map (CH552G)

| Function        | Pin  | Function        | Pin  |
| --------------- | ---- | --------------- | ---- |
| Key 1           | P1.1 | Key 5           | P1.4 |
| Key 2           | P1.7 | Key 6           | P3.2 |
| Key 3           | P1.6 | Encoder A       | P3.1 |
| Key 4           | P1.5 | Encoder B       | P3.0 |
| Encoder switch  | P3.3 | NeoPixel data   | P3.4 |

All key and encoder inputs use internal pull-ups; a pressed key / closed contact
reads **LOW**.

## Control slots & default keymap

| Slot | Control | Default | INPUT_EVENT action |
| ---- | ------- | ------- | ------------------ |
| 0–5  | Key 1–6 | F13–F18 | `0x01` down / `0x02` up |
| 6    | Knob CCW | F19 | `0x11` |
| 7    | Knob click | F20 | `0x12` |
| 8    | Knob CW | F21 | `0x10` |
| 9    | Push-turn CCW | F22 | `0x21` |
| 10   | Push-turn CW | F23 | `0x20` |

Keys report real down/up (tap vs hold is decided host-side). Knob detents,
click and push-turn are typed (down+up). `SET_KEY` remaps any slot; setting keycode
0 disables the keystroke while still emitting `INPUT_EVENT`.

## Hardware-unverified in this build

This firmware was written to compile cleanly and be correct by construction, but it
was **not flashed to or tested on real CH552 hardware in this build**. When you
flash it, watch these specifically:

1. **Composite enumeration.** Two HID interfaces on one CH552 device (IF0 keyboard
   on EP1 IN; IF1 vendor on EP2 IN + EP2 OUT). Confirm the OS lists **both**
   collections and that WebHID/hidapi can open the **0xFF60** collection. The EP2
   bidirectional buffer uses the CH55x convention (OUT at buffer `[0..63]`, IN at
   `[64..127]`); if vendor IN reports never arrive, this offset is the first thing
   to check.
2. **DataFlash writes.** `include/dataflash.c` implements the CH552 ISP byte
   read/write (safe-mode unlock + `ROM_CTRL`) per the datasheet and matches
   known-good SDKs, but the exact byte-address mapping (`addr << 1` into
   `DATA_FLASH_ADDR`) and the safe-mode sequence are **untested here**. Verify that
   `SAVE` survives an unplug and that a **blank** chip boots to defaults (the magic
   check should handle it — confirm it does).
3. **Keystroke timing / raw keymap.** `KBD_pressRaw`/`KBD_releaseRaw` emit arbitrary
   keycodes+modifiers; the default F13–F23 path is unchanged from v0.1 but now flows
   through these functions.
4. **Idle-dim timing.** The `SET_IDLE_DIM` timeout is converted to loop passes using
   an approximate ~5 ms/loop estimate (the same basis as v0.1's fixed timer). The
   real wall-clock timeout depends on actual loop time and should be sanity-checked.
5. **`INPUT_EVENT` under load / suppress.** Confirm events still arrive on IF1 when
   the suppress flag is set (keyboard silent, vendor mirror live), and that a burst
   of input doesn't stall (the watchdog-fed send bail-out should prevent hangs).

No hardware compromises were required: EP1 (keyboard IN) + EP2 (vendor IN+OUT) fit
the CH552 endpoint budget and the 16 KB flash, and DataFlash provides the 48-byte
persistent config store the protocol needs.

## Vendored CH552 stack and local patches

Everything in [`include/`](include/) except `dataflash.[ch]` is Stefan
"wagiminator" Wagner's CH552 USB/NeoPixel stack (CC-BY-SA). Each file PadKit
modified carries a clearly marked `PadKit local patch vs wagiminator upstream`
comment block; `include/dataflash.[ch]` is a PadKit-original addition and carries a
`PadKit local addition` header. See [`ATTRIBUTION.md`](ATTRIBUTION.md) for the full
per-file list and [`LICENSE`](LICENSE) for terms.
