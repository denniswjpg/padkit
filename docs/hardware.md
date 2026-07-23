# Hardware

PadKit targets a common, inexpensive class of USB macropad: a **WCH CH552G**
(8051-core USB MCU) driving **6 mechanical keys**, **1 rotary encoder with a push
switch**, and a short chain of **addressable RGB LEDs** (WS2812 / NeoPixel-style,
one per key). These are sold under many names and clone brands; electrically they
are near-identical, but **the wiring between the switches and the MCU pins varies
from batch to batch**. PadKit handles that with a configurable pin map and a
throwaway scanner firmware (below).

---

## Supported device class

| Attribute | Value |
|---|---|
| MCU | WCH **CH552G** (8051 core, hardware USB, ~16 KB code flash) |
| Package | SOP16 (10 user-accessible GPIO on the common layout) |
| Inputs | 6 mechanical key switches + 1 rotary encoder (quadrature A/B) with push switch |
| LEDs | 6 addressable RGB pixels, WS2812/NeoPixel-style, single data line |
| USB | Full-speed HID; enumerates as a boot-protocol keyboard (no driver) |
| Running VID:PID | **1189:8890** (inherited from the wagiminator/CH552 stack the firmware builds on) |
| Bootloader VID:PID | **4348:55e0** (some units report `1a86:55e0`) |

The firmware is built on Stefan Wagner's (wagiminator) CH552 USB stack
(CC-BY-SA 3.0). Any board in this class — CH552G, 6 keys + 1 encoder + a NeoPixel
chain — is a candidate, provided you can enter the ISP bootloader (P1.5 low at
power-up) to flash it.

---

## Reference pin map

The v0.1 firmware ships configured for this wiring (from `firmware/padkit.c` /
`firmware/include/config.h`):

| Function | CH552G pin |
|---|---|
| Key 1 | P1.1 |
| Key 2 | P1.7 |
| Key 3 | P1.6 |
| Key 4 | P1.5 |
| Key 5 | P1.4 |
| Key 6 | P3.2 |
| Encoder out A | P3.1 |
| Encoder out B | P3.0 |
| Encoder push switch | P3.3 |
| NeoPixel data | P3.4 |

All key/encoder inputs are configured **input-with-pull-up**; a pressed key or a
closed contact reads **LOW**. Note **P1.5 doubles as the boot-strap pin** — pulling
it low at power-up enters the ISP bootloader — but at runtime it is read as an
ordinary input, so key 4 behaves normally once the firmware is running.

---

## Clone-wiring variance

Because the same physical key can sit on a different GPIO on your board than on the
reference, a stock `padkit.bin` may report the wrong key for a given switch, or a
knob direction reversed, on some clones. Two things vary in practice:

1. **Which pin each key/knob line is on.** Fixed by editing the pin defines in
   `firmware/include/config.h` (and the `PIN_*` references in `firmware/padkit.c`)
   to match your board, then rebuilding.
2. **Encoder A/B orientation.** If the knob's two turn directions feel swapped
   (CW emits F19 instead of F21), either swap `ENC_A`/`ENC_B` in the config or just
   swap your F19/F21 bindings on the host — both are correct fixes.

The NeoPixel **chain order** can also differ, so "key 3" in the LED frame might
physically light a different pixel; logically the firmware maps colour triplet *N*
to key *N+1*, and you can reorder in the frame you send if a clone's chain is wired
differently.

---

## Mapping an unknown board: the pin scanner

To discover *your* board's wiring without a multimeter, flash the **scanner
firmware** in [`../firmware/scanner/`](../firmware/scanner/). It is a diagnostic
build (no LEDs, no layers) that configures every user-accessible GPIO as
input-with-pull-up and **types a unique letter whenever a pin is pulled low**.

Letter → CH552G pin (as emitted by the scanner):

| Letter | a | b | c | d | e | f | g | h | i | j |
|---|---|---|---|---|---|---|---|---|---|---|
| Pin | P1.1 | P1.4 | P1.5 | P1.6 | P1.7 | P3.0 | P3.1 | P3.2 | P3.3 | P3.4 |

**Procedure:**

1. Flash `firmware/scanner/scanner.bin` (same flashing steps as
   [`flashing.md`](flashing.md)).
2. Open any text field.
3. Press each of the 6 keys once, push the knob, and turn the knob both
   directions.
4. Read the letters:
   - **Six keys** → six letters, one per key press. That letter's pin is that key.
   - **Knob push** → one letter (the push-switch pin).
   - **Knob turn** → a *pair* of letters that alternate as you rotate (the encoder
     A and B pins toggling in quadrature). Turning one way makes A lead B, the other
     way B leads A.
   - Any pin that never emits a letter is unused on your board.
5. Feed the discovered mapping into `firmware/include/config.h`, rebuild
   `padkit.c`, and flash the real firmware.

On Linux you can use the helper [`../firmware/scanner/scan-capture.py`](../firmware/scanner/scan-capture.py),
which grabs the pad's input node, prints each letter with its CH552 pin name and
the time gap since the previous event, and keeps the letters from spilling into
your desktop:

```sh
sudo ./firmware/scanner/scan-capture.py 60 1189:8890
```

(You do not need the script — reading the letters off the screen with the table
above works too. If your clone enumerates with different USB IDs, read them from
`lsusb` and pass them as the second argument.)

After scanning, **flash the real firmware** — the scanner is a throwaway build with
no LED or macro function.
</content>
