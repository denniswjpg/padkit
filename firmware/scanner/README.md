# PadKit wiring scanner

A throwaway CH552 firmware that reveals **how your specific 6-key + knob clone is
wired**, so the real PadKit firmware can be configured to match it.

These "macropad" boards all use the same CH552G chip but vendors route the six
keys and the rotary encoder to **different GPIO pins from batch to batch**. There
is no single correct pin map. Rather than guess, you flash this scanner, press
every control while watching the letters it types, and read your board's wiring
straight off the screen. Then you plug that mapping into the real firmware's
`config.h` and it works on your clone.

## What it does

The scanner (`scanner.c`) configures every user-accessible SOP16 GPIO as
**input-with-pull-up** and watches for high->low transitions. Whenever a pin is
pulled low — a key pressed, the knob switch closed, or an encoder phase changing
as you rotate — it types a **unique letter over USB HID** for that pin:

| Letter | CH552 pin | | Letter | CH552 pin |
|--------|-----------|-|--------|-----------|
| `a`    | P1.1      | | `f`    | P3.0      |
| `b`    | P1.4      | | `g`    | P3.1      |
| `c`    | P1.5      | | `h`    | P3.2      |
| `d`    | P1.6      | | `i`    | P3.3      |
| `e`    | P1.7      | | `j`    | P3.4      |

These ten pins are the ones broken out to keys/knob on the common CH552G
6-key+knob layout. (P1.5 doubles as a boot-strap pin but reads as a normal input
at runtime, so it is scanned like the rest.) Any pin that never emits a letter
is simply unused on your board.

Only **changes after power-up** are reported: the firmware seeds the previous
pin state at boot, so an encoder phase that happens to rest low at a detent does
not fire spuriously — you only see letters for controls you actually actuate.

## Build

Requires [SDCC](https://sdcc.sourceforge.net/) (`sdcc`, `packihx`) and `objcopy`.

```sh
make bin        # produces scanner.bin (~3 KB)
```

The bundled `include/` tree is Stefan Wagner's (wagiminator) CH552 USB/HID stack;
`make bin` compiles it together with `scanner.c`.

## Flash

Same procedure as the main firmware. Put the pad into its ROM bootloader (bridge
the **SW2** pads on the PCB while plugging in USB — it then enumerates as USB id
`4348:55e0`), remove the bridge, and flash:

```sh
isp55e0 -f scanner.bin        # the PadKit flasher (../../flasher)
# or, if you have WCH's tool / chprog:
make flash
```

Flashing the scanner is non-destructive to your board — when you are done you
just flash the real firmware over it the same way.

## Read your wiring

1. Open any text field (a terminal, a note, an editor).
2. Press the **six keys one at a time**. Each emits one letter → note
   `key → letter → pin`. Follow the physical order you want in the real
   firmware (e.g. top-left→right, then bottom-left→right).
3. **Push the knob** once → that letter/pin is the encoder **switch**.
4. **Turn the knob** slowly. A rotary encoder is two pins (out A / out B) in
   quadrature, so you will see **two letters alternate** while turning — those
   two pins are the encoder channels. Turning one direction makes A lead B and
   the other makes B lead A; the real firmware uses the lead order to tell CW
   from CCW, so you only need to know **which two pins** the knob uses.

You now have: 6 key pins, 1 encoder-switch pin, 2 encoder-channel pins. Put them
into the real firmware's `config.h` (`PIN_KEY1..6`, `PIN_ENC_SW`, `PIN_ENC_A`,
`PIN_ENC_B`) and rebuild. The firmware is now adapted to your clone.

### Optional: capture helper (Linux)

`scan-capture.py` grabs the pad's evdev node(s) and prints each keypress as
`letter -> CH552 pin` with timing, and keeps the letters from spilling into your
desktop. It is purely a convenience — reading letters off a text field works
just as well.

```sh
sudo ./scan-capture.py 60            # capture 60s, default USB id 1189:8890
sudo ./scan-capture.py 60 1189:8890  # override VID:PID if your clone differs (see `lsusb`)
```

It maps evdev keycodes back through the same `letter → pin` table the firmware
uses, so its output is directly the wiring you record.

## License / attribution

Firmware is **CC BY-SA 3.0**, built on Stefan Wagner's (wagiminator) CH552
USB MacroPad Mini stack: <https://github.com/wagiminator/CH552-USB-Knob>. The
`include/` tree is his USB/HID/NeoPixel code, unmodified.
