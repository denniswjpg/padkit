# PadKit — the spec

PadKit is an open-source **firmware + tooling package** for a small USB macropad:
**6 mechanical keys + 1 rotary encoder with a push switch**, built around a
**WCH CH552G** (8051-core) microcontroller, with a strip of **6 addressable RGB
LEDs** (WS2812 / NeoPixel-style).

This file is the load-bearing document. It is written to be read equally by a
human and by a coding agent that a user points at their own setup. If you are an
AI agent asked to "wire the PadKit into my system," everything you need — the
exact keycodes, the LED report bytes, and worked binding examples — is here. Read
the [For AI agents](#for-ai-agents) section last; read the input map first.

The single most important design fact: **the pad is a plain USB keyboard that
types F13–F23.** Those function keys exist in every OS's key tables but no normal
keyboard ever sends them, so you can bind them to anything without stealing real
keystrokes — **with no driver and no software of any kind.**

---

## Contents

- [Usage tiers (what ships vs what's planned)](#usage-tiers)
- [The input map](#the-input-map) — every key/gesture → keycode
- [Binding the keys](#binding-the-keys) — macOS, Windows, Linux, Home Assistant, etc.
- [LED control protocol](#led-control-protocol) — HID reports to drive the RGB
- [Flashing & recovery](#flashing--recovery)
- [For AI agents](#for-ai-agents) — worked micro-examples
- [Roadmap / v0.2](#roadmap--v02)
- [Repository layout](#repository-layout)

---

## Usage tiers

PadKit is meant to be usable at three increasing levels of investment. **Only the
first tier ships in v0.1.** The other two are on the [roadmap](#roadmap--v02) and
are clearly labelled everywhere as *planned*, not shipped.

| Tier | What it is | Status |
|---|---|---|
| **1. Flash + bind** | Flash the firmware, then bind F13–F23 in your OS or app. No PadKit software runs on the host. | **Ships in v0.1** (firmware + `isp55e0` flasher + this spec). |
| **2. Browser config tool** | A zero-install web page (WebHID/WebUSB) to flash and to edit LEDs/keymap live. | **Roadmap (v0.2).** Feasibility confirmed; see roadmap. |
| **3. Companion daemon** | A small host service that turns pad events into actions and pushes LED state. | **Roadmap.** `daemon/` is a placeholder. |

Tier 1 is fully self-sufficient. You never need tiers 2–3 to use the pad — they
are convenience layers.

---

## The input map

The firmware presents a standard **boot-protocol USB keyboard** (no driver). Every
control maps to a function key in the **F13–F23** range.

| Control | Gesture | Key | HID usage | Event style |
|---|---|---|---|---|
| Key 1 | press / release | **F13** | `0x68` | real **key-down** on press, **key-up** on release |
| Key 2 | press / release | **F14** | `0x69` | real key-down / key-up |
| Key 3 | press / release | **F15** | `0x6A` | real key-down / key-up |
| Key 4 | press / release | **F16** | `0x6B` | real key-down / key-up |
| Key 5 | press / release | **F17** | `0x6C` | real key-down / key-up |
| Key 6 | press / release | **F18** | `0x6D` | real key-down / key-up |
| Knob | turn CW (one detent) | **F21** | `0x70` | tap (down+up), one per detent |
| Knob | turn CCW (one detent) | **F19** | `0x6E` | tap, one per detent |
| Knob | click (push) | **F20** | `0x6F` | tap, on release |
| Knob | push **and** turn CW | **F23** | `0x72` | tap, one per detent |
| Knob | push **and** turn CCW | **F22** | `0x71` | tap, one per detent |

All usages are on the **Keyboard/Keypad usage page (0x07)** — the standard USB HID
table, where F13=`0x68` runs consecutively to F23=`0x72`.

### Semantics that matter when you bind

- **Tap vs hold exists only for the six keys.** Keys 1–6 report a genuine
  key-down and a later key-up, so a host can time the interval and distinguish a
  *tap* from a *hold* (e.g. tap = action A, hold ≥ 400 ms = action B). This is a
  host-side decision — the firmware just reports the edges honestly.
- **Knob gestures are momentary taps.** Each turn detent, each click, and each
  push-turn detent is emitted as a quick down+up. There is no "held knob" key
  event; you get a discrete tap per detent. Bind them like button presses, not
  like keys you can hold.
- **Click is suppressed by a push-turn.** If you press the knob and turn it while
  pressed, you get F22/F23 for the turn and the **click (F20) is *not* emitted**
  on release. A clean press-and-release with no turn emits F20. This lets the knob
  carry two independent axes (turn = F19/F21, push-turn = F22/F23) plus a button
  (F20) without collisions.
- **CW/CCW labelling.** "CW" and "CCW" here follow the reference wiring
  (ENC_A=P3.1, ENC_B=P3.0). On a differently wired clone the two turn directions
  still map to F19 and F21 — they may just be swapped relative to physical
  rotation. If your knob feels "backwards," swap your F19/F21 bindings (or the
  encoder A/B pins). See [`docs/hardware.md`](docs/hardware.md).

---

## Binding the keys

Because the pad is an ordinary keyboard, you bind F13–F23 with whatever hotkey
mechanism you already use. **No PadKit software is involved in any of these.**
Below are concrete, correct examples per environment. Replace the actions with
your own.

### macOS — Karabiner-Elements

Karabiner is the reliable way to catch F13–F23 on macOS. Add a complex
modification (`~/.config/karabiner/assets/complex_modifications/padkit.json`):

```json
{
  "title": "PadKit",
  "rules": [
    {
      "description": "PadKit F13 → Mission Control",
      "manipulators": [
        {
          "type": "basic",
          "from": { "key_code": "f13" },
          "to": [{ "apple_vendor_keyboard_key_code": "mission_control" }]
        }
      ]
    },
    {
      "description": "PadKit knob CW/CCW → volume",
      "manipulators": [
        { "type": "basic", "from": { "key_code": "f21" },
          "to": [{ "consumer_key_code": "volume_increment" }] },
        { "type": "basic", "from": { "key_code": "f19" },
          "to": [{ "consumer_key_code": "volume_decrement" }] }
      ]
    }
  ]
}
```

Many macOS apps also let you assign F13–F19 directly in their own shortcut
settings — try that first for app-local actions.

### Windows — AutoHotkey v2

```ahk
; padkit.ahk  — run at login
#Requires AutoHotkey v2.0

F13::Run("notepad.exe")                 ; key 1 → launch an app
F14::Send("^c")                         ; key 2 → copy
F20::Send("{Media_Play_Pause}")         ; knob click → play/pause
F21::Send("{Volume_Up}")                ; knob CW  → volume up
F19::Send("{Volume_Down}")              ; knob CCW → volume down

F18:: {                                  ; key 6 → fire a webhook
    req := ComObject("WinHttp.WinHttpRequest.5.1")
    req.Open("POST", "https://example.com/hook", false)
    req.Send()
}
```

### Linux — keyd (device-level, works in X11 and Wayland)

`/etc/keyd/default.conf`:

```
[ids]
1189:8890

[main]
f13 = command(/usr/local/bin/toggle-mic)
f18 = command(curl -s -X POST https://example.com/hook)
f21 = command(pactl set-sink-volume @DEFAULT_SINK@ +5%)
f19 = command(pactl set-sink-volume @DEFAULT_SINK@ -5%)
f20 = command(playerctl play-pause)
```

`1189:8890` is the pad's USB VID:PID. If your clone enumerates with different IDs,
read them from `lsusb` and substitute. keyd's `command()` runs a shell command on
key-down.

Other Linux options: **sxhkd** (`F13` is a valid X keysym), **xbindkeys**, or any
tool that binds keysyms — F13–F23 are all standard keysyms.

### Linux — Home Assistant (`keyboard_remote`)

If the pad is plugged into your Home Assistant host, use the `keyboard_remote`
integration. It emits a `keyboard_remote_command_received` event carrying the
Linux evdev key code. The evdev codes are:

| Key | F13 | F14 | F15 | F16 | F17 | F18 | F19 | F20 | F21 | F22 | F23 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| evdev code | 183 | 184 | 185 | 186 | 187 | 188 | 189 | 190 | 191 | 192 | 193 |

```yaml
# configuration.yaml
keyboard_remote:
  - device_descriptor: "/dev/input/by-id/usb-wagiminator_MacroPad-CH552xHID-event-kbd"
    type: key_down

# automation
automation:
  - alias: PadKit key 1 toggles the desk lamp
    trigger:
      platform: event
      event_type: keyboard_remote_command_received
      event_data:
        key_code: 183          # F13
    action:
      service: light.toggle
      target: { entity_id: light.desk_lamp }
```

(The `device_descriptor` path comes from the pad's USB strings; find the exact
node with `ls /dev/input/by-id/`.)

### Anything else

Any application or automation tool that can bind a keyboard shortcut can bind
PadKit: game launchers, OBS hotkeys, IDE keymaps, `sxhkd`, `hammerspoon`,
`espanso`, browser extensions listening for `keydown` with `event.key === "F13"`,
etc. The pad is just a keyboard. If a tool can see F13, it can drive PadKit.

---

## LED control protocol

The 6 RGB LEDs are driven **from the host** over the same USB HID interface, using
a small set of **HID OUTPUT reports**. There is no separate LED device and no
driver: you write reports to the pad's HID interface (interface 0), which the
firmware receives on its interrupt-OUT endpoint (**EP2**) and renders.

Reports 3/4/5 live on a **vendor-defined usage page (0xFF00, Usage 0x01)**, so
they are scriptable from `hidraw` (Linux), `hidapi` (all OSes), and even WebHID
(the vendor page is not on the browser blocklist). Report 1 is the standard
keyboard-LED report and is also delivered automatically by the OS when Num/Caps/
Scroll Lock change.

**Wire framing:** every report begins with its **report-ID byte**. With
`hidraw`/`hidapi` you write `[id, ...payload]`. With WebHID you call
`device.sendReport(id, payloadWithoutId)`.

### Report reference

| ID | Name | Length (incl. ID) | Payload | Effect |
|---|---|---|---|---|
| **1** | Status scene | 2 | `[0x01, led-bits]` | Selects a firmware "scene" from the keyboard-LED bits, and leaves host-RGB mode. |
| **3** | Static frame | 19 | `[0x03, R1,G1,B1, … R6,G6,B6]` | Shows 6 per-key colours directly. Enters host-RGB mode; clears any effect. |
| **4** | Effect frame | 20 | `[0x04, effect, R1,G1,B1, … R6,G6,B6]` | Same as report 3 plus a firmware effect. |
| **5** | Brightness | 2 | `[0x05, brightness]` | Master brightness scaler applied to everything. |

**Report 1 — status scene.** `led-bits` is the standard keyboard-LED bitmask:

| Bit | Value | Firmware scene |
|---|---|---|
| Num Lock | `0x01` | solid green |
| Caps Lock | `0x02` | red, **breathing** |
| Scroll Lock | `0x04` | dark (all off) — used as a "locked/idle" look |
| (none set) | `0x00` | dark |

Because this *is* the keyboard-LED report, toggling Num/Caps/Scroll Lock from any
app also changes the scene — a zero-code way to get three status looks. Sending
report 1 also returns the pad from host-RGB mode back to scene mode.

**Report 3 — static frame.** 18 colour bytes = **6 pixels × (R, G, B)**, in
host-facing R,G,B order. Pixel index maps to key number: bytes 1–3 = key 1,
bytes 4–6 = key 2, …, bytes 16–18 = key 6. (Physical LED chain order can vary on
clones; logically triplet *N* is key *N+1*.) Sending this switches the pad into
host-RGB mode and shows exactly the colours you send.

**Report 4 — effect frame.** Byte 1 is the effect, then the same 18 colour bytes:

| `effect` | Meaning |
|---|---|
| `0` | static (identical to report 3) |
| `1` | breathe (triangle-wave brightness) |
| `2` | blink (square-wave on/off) |

**Report 5 — brightness.** One byte, `1`–`255`, a master multiplier over whatever
is currently shown. `0` is coerced to `1` (never fully off via this path; use a
dark frame instead).

### Rendering behaviour (firmware-side, good to know)

- **Smooth fades for free.** The shown frame continuously eases toward the newest
  target frame, so any change — scene or host-set — cross-dissolves. You do not
  animate transitions yourself; just set targets.
- **Idle dimming.** After ~5 minutes with no key/knob input, the pad dims to ~1/4
  brightness. Any activity restores full brightness. This is independent of
  report 5.
- **Press feedback.** Pressing a key briefly flashes that key's LED; it decays on
  its own. You don't need to drive this.

For the byte-level deep version (report descriptor excerpts, endpoint details,
input-report semantics), see [`docs/protocol.md`](docs/protocol.md).

---

## Flashing & recovery

Full procedure, per-OS notes, udev rule, and recovery are in
[`docs/flashing.md`](docs/flashing.md). In short:

1. **Enter the bootloader:** with the board unplugged, short the **boot pads
   (SW2 / P1.5 low)**, plug in USB while holding them, then release. The board
   enumerates as **`4348:55e0`** (WCH ISP mode).
2. **Flash:** from the `flasher/` directory,
   `./isp55e0 -f ../firmware/padkit.bin`.
3. **Linux:** install `flasher/99-wch-isp.rules` for non-root access.
   **Windows:** one-time **Zadig → WinUSB** on the `4348:55e0` device.
4. **Recovery is guaranteed.** The CH552 bootloader lives in **mask ROM** and
   cannot be overwritten. A bad flash is always recoverable — re-enter the
   bootloader and flash a good binary. **You cannot brick the chip** through the
   USB flashing path.

---

## For AI agents

If you are an agent wiring PadKit into a user's tool: **read [the input
map](#the-input-map) and [the LED protocol](#led-control-protocol), then generate
the binding or config for that tool.** The pad is a keyboard emitting F13–F23 and
an HID target for LED reports — nothing PadKit-specific has to run on the host for
tier 1. Three worked micro-examples:

### 1. Bind F13 to a shortcut

Pick the mechanism the user already has. On Linux with keyd:

```
# /etc/keyd/default.conf
[ids]
1189:8890
[main]
f13 = command(code)          # key 1 launches VS Code
```

On macOS, emit a Karabiner rule mapping `key_code: "f13"` to the target action
(see the [macOS example](#macos--karabiner-elements)). On Windows, one AutoHotkey
line: `F13::Run("code.exe")`.

### 2. Fire a webhook on F18

A tiny host listener (Linux, `python-evdev`) — no PadKit dependency, just read the
keyboard:

```python
import evdev, requests
from evdev import ecodes

dev = evdev.InputDevice("/dev/input/by-id/usb-wagiminator_MacroPad-CH552xHID-event-kbd")
for e in dev.read_loop():
    if e.type == ecodes.EV_KEY and e.value == 1:      # key-down
        if e.code == ecodes.KEY_F18:                  # 188
            requests.post("https://example.com/hook", timeout=5)
```

Or one line with keyd: `f18 = command(curl -s -X POST https://example.com/hook)`.

### 3. Set key 6 red

Write a static frame (report 3). Key 6 is the last RGB triplet (bytes 16–18);
everything else off. Python with `hidapi`:

```python
import hid
d = hid.device(); d.open(0x1189, 0x8890)
frame = [0] * 18
frame[15], frame[16], frame[17] = 255, 0, 0   # key 6 = R,G,B
d.write([0x03] + frame)                        # report id 3 + 18 colour bytes
d.close()
```

The same works from WebHID against the vendor collection (`usagePage: 0xFF00,
usage: 0x01`): `await device.sendReport(3, new Uint8Array([...frame]))`. To dim
everything to half brightness afterwards: `d.write([0x05, 128])`.

---

## Roadmap / v0.2

The following are **confirmed feasible but not shipped**. They are separated from
v0.1 deliberately — do not describe them as available today.

### Zero-install browser config tool (WebHID)

The plan is a firmware revision that adds a **QMK-style raw-HID vendor
collection** — **Usage Page `0xFF60`, Usage `0x61`, fixed 32-byte reports, no
report IDs** — carrying an Input report (button/knob mirroring), an Output report
(LED/keymap/brightness writes), and a Feature report (config read-back + a
flash-commit ack). With that collection, a web page can flash-free **read live pad
events and write configuration** cross-platform.

Why it works: **Chromium applies HID protection per top-level collection, not per
device.** The keyboard collection is withheld from script (as it should be), but a
vendor page in `0xFF00–0xFFFF` is not on the blocklist, so WebHID opens the device
and talks to the vendor collection on **macOS, Windows, Linux, and ChromeOS**.
This is exactly how QMK/VIA (usevia.app) configures keyboards over WebHID today.
The only setup friction is a **Linux udev rule** granting `hidraw` access.

> **v0.1 already ships an output-only vendor collection** (`0xFF00`/Usage `0x01`,
> report IDs 3/4/5) — enough to *write* LEDs from WebHID/hidapi as shown above.
> What v0.2 adds is the **bidirectional** `0xFF60`/`0x61` collection: input
> mirroring, config read-back, remappable keymaps, and config persisted to flash.

### WebUSB browser flasher

A branded web page can drive the CH552 ISP bootloader over **WebUSB** — the
bootloader presents a vendor-class (`0xFF`) interface that WebUSB is allowed to
claim, and the whole ISP routine is ~120–140 lines. This makes flashing
**install-free on macOS and Linux** (Linux: one udev-rule line). **Windows keeps a
one-time step:** the CH552 ROM bootloader ships no WCID/Microsoft-OS descriptors,
so Windows will not auto-bind WinUSB — the user must run **Zadig once** to set the
`4348:55e0` device to WinUSB. That is a property of the chip, not of the tool, and
is identical to today's CLI Windows requirement. The patched **`isp55e0` CLI stays
the dependable fallback** (and the primary path on Windows).

### Companion daemon

A small optional host service (`daemon/`, placeholder) that maps pad events to
actions and pushes LED state back (status colours, brightness, effects) — the tier-3
convenience layer. Not started.

---

## Repository layout

| Path | What |
|---|---|
| `AGENTS.md` | This spec. |
| `llms.txt` | Machine-readable pointer file (the emerging standard). |
| `firmware/padkit.c` | The v0.1 firmware (CH552G). Build with SDCC (`make`). |
| `firmware/padkit.bin` | Prebuilt firmware image to flash. |
| `firmware/include/` | Bundled CH552 USB/NeoPixel stack (CC-BY-SA 3.0). |
| `firmware/scanner/` | Throwaway pin-discovery firmware for mapping clone wiring. |
| `flasher/` | Patched `isp55e0` CLI flasher + udev rule (GPLv3). |
| `docs/flashing.md` | Flashing, per-OS notes, recovery. |
| `docs/hardware.md` | Supported device class, clone variance, the scanner. |
| `docs/protocol.md` | Deep HID report + input-report reference. |
| `docs/integrations/` | Per-tool binding recipes (growing). |
| `examples/configs/` | Ready-to-copy config snippets. |
| `web/` | Roadmap: browser flasher + config tool (empty). |
| `daemon/` | Roadmap: companion daemon (empty). |

Building the firmware needs **SDCC**; building the flasher needs **gcc** +
**libusb-1.0**. Neither is required to *use* a prebuilt pad — only to rebuild.
</content>
