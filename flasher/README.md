# PadKit Flasher (isp55e0)

A small command-line USB ISP flasher for the **CH552G** microcontroller used in
the PadKit macropad. It talks the WinChipHead (WCH) ISP bootloader protocol over
USB and writes a raw firmware binary to the chip's code flash.

This is a lightly patched fork of **[frank-zago/isp55e0](https://github.com/frank-zago/isp55e0)**,
a mature, properly licensed ISP tool for the WCH CH55x / CH57x / CH32Fx families.
It is the reliable, cross-platform fallback for flashing PadKit (a browser
WebUSB flasher is planned as a convenience layer for a later phase, but this CLI
remains the dependable path — and the primary path on Windows).

## License

GPLv3, unchanged from upstream. The full text is in [`COPYING`](./COPYING).
The two PadKit patches described below are contributed under the same license.
Credit for the tool itself goes to Frank Zago and the isp55e0 contributors.

## What changed vs. upstream

Two small, targeted fixes were needed to flash the CH552G reliably. Both are in
`isp55e0.c`:

1. **Clear the halt on both bulk endpoints after claiming the interface.**
   The CH552 mask-ROM bootloader can enumerate with its bulk endpoints in a
   halted/stalled state (observed after repeated probing/replugging), which makes
   the very first bulk transfer to the bootloader fail with `EIO`. Right after
   `libusb_claim_interface`, the tool now calls `libusb_clear_halt` on `EP_OUT`
   (0x02) and `EP_IN` (0x82). Clearing the halt is a no-op when the endpoints are
   already healthy and rescues the session when they are not.

2. **Make a missing reboot ACK non-fatal.**
   The CH552 v2.50 ROM bootloader flashes and verifies correctly but never
   acknowledges the final `CMD_REBOOT`, so the reply read times out. The firmware
   has already been written and verified by that point, so the tool now emits a
   harmless warning ("unplug/replug to boot the new firmware") and exits
   successfully instead of erroring out. (Bootloaders that *do* answer, e.g.
   2.8.0, are still validated as before.)

## Build

Requires `gcc` and the libusb-1.0 development package.

- Debian / Ubuntu: `sudo apt install build-essential libusb-1.0-0-dev`
- Fedora / RHEL: `sudo dnf install gcc libusb1-devel`

Then:

```sh
make
```

This produces the `isp55e0` binary in this directory.

## Usage

Put the board in bootloader mode (see below), then flash a raw binary. Flashing
also reads the firmware back to verify it:

```sh
./isp55e0 -f ../firmware/padkit.bin
```

Other handy commands:

```sh
./isp55e0            # query the device (confirms the bootloader is detected)
./isp55e0 -c fw.bin  # verify flash against a binary without writing
./isp55e0 --help     # full option list
```

If you have an iHex file instead of a raw binary, convert it first:

```sh
objcopy -I ihex -O binary firmware.hex firmware.bin
```

## Entering the bootloader (SW2)

The CH552 exposes its ISP bootloader by pulling **P1.5 low at power-up**. On the
PadKit board this is broken out to the **SW2** pads:

1. Unplug the macropad.
2. Short the two **SW2** pads (a tweezer, jumper, or a fitted button all work)
   and keep them shorted.
3. Plug the USB cable in while still shorting SW2.
4. Release SW2.

The board now enumerates as USB **`4348:55e0`** (WCH ISP mode) and `isp55e0`
can talk to it. You can confirm with `lsusb | grep 4348:55e0`.

## Linux: udev rule for non-root access

By default only root may talk to the bootloader device. Install the included
rule so a normal user can flash:

```sh
sudo cp 99-wch-isp.rules /etc/udev/rules.d/99-wch-isp.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Replug the board afterwards. The rule grants access to the `4348:55e0`
(ROM bootloader) and `1a86:55e0` VID:PID pairs.

## Windows: one-time driver swap

The CH552 ROM bootloader does not ship WCID descriptors, so Windows will not
auto-bind it to a libusb-compatible driver. Do this once:

1. Enter the bootloader (SW2 procedure above) so `4348:55e0` appears in Device
   Manager.
2. Run **[Zadig](https://zadig.akeo.ie/)**, select the `4348:55e0` device, and
   install the **WinUSB** driver for it.

After that, `isp55e0` works on Windows just like on Linux. This swap only affects
the bootloader device, not normal USB HID operation of the finished macropad.

## Unbrickable by design

The CH552's bootloader lives in **mask ROM** — it cannot be overwritten by a
firmware flash. A bad or half-written app image can therefore always be
recovered: just re-enter the bootloader (short SW2, replug) and flash a good
binary again. There is no way to brick the chip through the USB flashing path.

## Files

| File | Purpose |
|------|---------|
| `isp55e0.c` / `isp55e0.h` | The flasher (patched — see above). |
| `chips.h` | Per-chip parameters (generated from WCH config). |
| `compat-err.h` | `err()`/`errx()` shims for non-BSD libc. |
| `version.h` | Package version string. |
| `Makefile` | `make` to build, `make clean` to remove build products. |
| `parse_wcfg.py` | Regenerates `chips.h` from a WCH config dump (`make chips`). |
| `protocol.txt` | Notes on the WCH ISP wire protocol. |
| `99-wch-isp.rules` | Linux udev rule for non-root flashing. |
| `COPYING` | GPLv3 license text. |
