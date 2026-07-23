# HID protocol reference

The byte-level version of PadKit's USB interface: how the pad reports input
(F13–F23) and how the host drives the RGB LEDs. This extends the summary in
[`../AGENTS.md`](../AGENTS.md); if the two ever disagree, the firmware source
(`firmware/padkit.c` and `firmware/include/usb_descr.c`) is authoritative.

---

## USB interface overview

- **One HID interface (interface 0)**, boot subclass, keyboard protocol — so the
  OS binds it as a keyboard with no driver.
- **Two interrupt endpoints:**
  - **EP1 IN** — reports from pad → host (keystrokes and consumer events).
  - **EP2 OUT** — control reports from host → pad (LED reports; also the standard
    keyboard-LED report).
- Running device **VID:PID 1189:8890**. USB 1.1, full speed.

The single HID report descriptor declares three top-level collections:

| Collection | Usage page / usage | Report IDs | Direction |
|---|---|---|---|
| Keyboard | Generic Desktop (0x01) / Keyboard (0x06) | **1** | IN (keys) + OUT (LED bits) |
| Consumer control | Consumer (0x0C) / Consumer Control (0x01) | **2** | IN |
| Vendor | **Vendor-defined (0xFF00)** / Usage 0x01 | **3, 4, 5** | OUT |

Report IDs are used, so **every report on the wire begins with its report-ID
byte.** With `hidraw`/`hidapi` you write/read `[id, ...payload]`; with WebHID the
ID is a separate argument (`sendReport(id, payload)`).

---

## Input reports (pad → host)

### Keys 1–6 — report ID 1 (keyboard)

Standard boot-keyboard report: `[0x01, modifiers, reserved, k1, k2, k3, k4, k5,
k6]`, where `k1..k6` is the array of currently-pressed HID keycodes. Keys 1–6 emit
**F13–F18** and use **real press/release**: a key appears in the array on press
(key-down) and is removed on release (key-up). This is what lets a host measure how
long a key is held and distinguish **tap vs hold** — a purely host-side decision.

### Knob & push-turn — typed function keys

The encoder and its push switch are reported as the *same* keyboard report, but as
**momentary taps** (a quick key-down immediately followed by key-up), not sustained
presses:

| Gesture | Key | Notes |
|---|---|---|
| Turn CW, one detent | **F21** | one tap per detent |
| Turn CCW, one detent | **F19** | one tap per detent |
| Click (push, no turn) | **F20** | tap on release |
| Push-turn CW, one detent | **F23** | one tap per detent |
| Push-turn CCW, one detent | **F22** | one tap per detent |

Firmware detail (from `padkit.c`): the encoder is decoded with a non-blocking
quadrature state machine that accumulates transitions and emits a single tap when
the knob returns to its detent rest position. The push switch tracks a "rotated
while pressed" flag — if you turn while pressed, each detent emits F22/F23 and the
flag suppresses the F20 click that would otherwise fire on release. A clean
press/release with no rotation emits F20.

Because these are taps, there is **no hold semantics for knob gestures** — bind
them like discrete button presses.

### Consumer control — report ID 2

The descriptor declares a consumer-control input collection (report ID 2). The
v0.1 firmware does not emit consumer usages for the six keys (they are function
keys on report 1); the collection is present in the descriptor for compatibility
and future use.

### HID usage IDs (Keyboard/Keypad page 0x07)

| Key | F13 | F14 | F15 | F16 | F17 | F18 | F19 | F20 | F21 | F22 | F23 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Usage | 0x68 | 0x69 | 0x6A | 0x6B | 0x6C | 0x6D | 0x6E | 0x6F | 0x70 | 0x71 | 0x72 |
| Linux evdev | 183 | 184 | 185 | 186 | 187 | 188 | 189 | 190 | 191 | 192 | 193 |

---

## Output reports (host → pad): LED control

The host drives the 6 RGB LEDs by writing HID **OUTPUT** reports, received by the
firmware on **EP2 OUT** and parsed by report ID. Reports 3/4/5 belong to the vendor
collection (usage page 0xFF00), which is why they are scriptable from `hidraw`,
`hidapi`, and WebHID. Report 1 is the keyboard-LED report and is *also* delivered
automatically by the OS when Num/Caps/Scroll Lock state changes.

The firmware's parse rules (from `firmware/include/usb_hid.c`, `HID_EP2_OUT`) are
length-and-first-byte dispatched:

| First byte | Min length | Interpreted as |
|---|---|---|
| `3` | 19 | Static frame: 18 colour bytes follow. |
| `4` | 20 | Effect frame: 1 effect byte + 18 colour bytes. |
| `5` | 2 | Brightness: 1 byte. |
| `1` | 2 | Status scene: 1 LED-bits byte; leaves host-RGB mode. |
| other | 1 | Treated as a bare LED-bits byte (host stacks that send the keyboard-LED report without a report-ID prefix). |

### Report ID 1 — status scene

```
byte 0 : 0x01           (report ID)
byte 1 : led-bits       standard keyboard-LED bitmask
```

| led-bits | Bit | Firmware scene |
|---|---|---|
| `0x01` | Num Lock | solid green (RGB ≈ 0,70,0) |
| `0x02` | Caps Lock | red (RGB ≈ 160,0,0), **breathing** |
| `0x04` | Scroll Lock | dark / all off ("locked/idle" look) |
| `0x00` | — | dark |

Priority when several bits are set: Scroll → Caps → Num. Sending report 1 returns
the pad from host-RGB mode to scene mode. Because this is the OS keyboard-LED
report, toggling Num/Caps/Scroll Lock from any application changes the scene with
no custom code at all.

### Report ID 3 — static frame

```
byte 0     : 0x03                  (report ID)
bytes 1-18 : R1 G1 B1  R2 G2 B2  …  R6 G6 B6
```

18 colour bytes = **6 pixels × (R, G, B)** in host-facing order. Triplet index maps
to key number: bytes 1–3 = key 1 … bytes 16–18 = key 6. Writing this switches the
pad into **host-RGB mode**, clears any active effect, and shows exactly the colours
sent. (The NeoPixel WS2812 GRB wire order is handled internally by the firmware —
you always send R,G,B. Physical chain order can differ on clones; see
[`hardware.md`](hardware.md).)

### Report ID 4 — effect frame

```
byte 0     : 0x04                  (report ID)
byte 1     : effect                0=static  1=breathe  2=blink
bytes 2-19 : R1 G1 B1  …  R6 G6 B6
```

Same 18 colour bytes as report 3, preceded by an effect selector. `breathe` is a
triangle-wave brightness envelope; `blink` is a square-wave on/off. Also enters
host-RGB mode.

### Report ID 5 — brightness

```
byte 0 : 0x05                      (report ID)
byte 1 : brightness                1..255, master multiplier over the shown frame
```

Applied on top of whatever is currently displayed (scene or host-set). A value of
`0` is coerced to `1`; to go fully dark, send a dark frame (report 3 of all zeros)
rather than brightness 0.

---

## Rendering pipeline (firmware-side)

Understanding the render loop helps you avoid fighting it:

1. **Target vs shown frame.** The host sets a *target* frame (via a scene or a
   host-RGB report). The *shown* frame eases ~¼ of the remaining distance toward
   the target on each ~20 ms LED tick, so **every change cross-dissolves smoothly**
   — you set targets, not transitions.
2. **Effect stage.** If an effect is active (breathe/blink, or the Caps scene's
   breathe), a global wave scales the shown frame.
3. **Master brightness.** Report 5's value scales everything.
4. **Idle dimming.** After ~5 minutes with no key/knob input the output is dimmed
   to ~¼; any input restores it. Independent of report 5.
5. **Press feedback overlay.** A key press briefly brightens that key's pixel
   (white in normal scenes, red in the locked/Scroll scene); it decays on its own.
   You do not drive this.

Consequences for host code: send a target and let the pad animate; do not stream
frames to fake a fade. If you need an instant hard change, send the same frame —
the ease still applies but converges within a few ticks. Do not rely on brightness
0 meaning "off"; and remember the Scroll-Lock ("locked") scene and a dark host
frame both look off, so if you use darkness as a status, make sure your host is the
only thing setting it.

---

## Endpoint / transport notes

- **LED reports go to EP2 OUT** (interrupt OUT). Most host HID APIs abstract this:
  a `hidraw` write, a `hid_write()` (hidapi), or a WebHID `sendReport()` to the
  device's output report reaches EP2. You do not address the endpoint directly.
- **Report length.** Send the full declared length including the report-ID byte
  (19 bytes for report 3, 20 for report 4, 2 for reports 1/5). Some OSes pad short
  writes; sending the exact length is safest.
- **WebHID targeting.** Filter the device by the vendor collection
  (`usagePage: 0xFF00, usage: 0x01`) to write reports 3/4/5. The keyboard
  collection is withheld from script by the browser (by design) — that does not
  block the vendor collection on the same device.
</content>
