# PadKit WebUSB flasher — implementation notes

This documents the browser flasher in `src/flash-core.ts` + `src/isp.ts`: what the
protocol does, which lines of the reference C flasher each step mirrors, what is
covered by automated tests, and what is **unverified until a real flash on real
hardware**. Read the "First-flash watch-list" before flashing a physical pad.
The transport and state machine live in `src/flash-core.ts`; the guided page UI
that drives them lives in `src/flash-wizard.ts` (`flash.html` mounts it).

The reference/ground truth is `../flasher/isp55e0.c` (a working, patched libusb
CLI). The browser flasher is a faithful port of its byte layouts and command
sequence onto WebUSB.

---

## What the flasher does (and where it comes from)

Target: WCH CH552G (8051), flashed over its unbrickable mask-ROM bootloader
(USB `4348:55e0`, some units `1a86:55e0`, vendor-specific interface class 0xFF).
On macOS + Chrome no driver is needed.

Transport (`flash-core.ts`):

| Step | WebUSB | isp55e0.c |
|---|---|---|
| Select device | `requestDevice({filters:[{4348:55e0},{1a86:55e0}]})` | `open_usb_device` (`0x4348/0x1a86`, `0x55e0`) |
| Claim | `open()` → `selectConfiguration(1)` → `claimInterface(0)` | `libusb_claim_interface(…, 0)` |
| **Endpoint-stall fix** | `clearHalt('out',2)` + `clearHalt('in',2)` (best-effort) | `libusb_clear_halt(EP_OUT/EP_IN)` ~line 304 |
| Bulk transfer | `transferOut(2,req)` / `transferIn(2,64)` | `libusb_bulk_transfer(EP_OUT/EP_IN)` — `EP_OUT 0x02`, `EP_IN 0x82` → endpoint **2** both ways |

Endpoints are also auto-discovered from the interface descriptor, defaulting to
`2` if not found (`findEndpoints`).

Protocol sequence (`isp.ts` builds the frames; `flash-core.ts` `runFlash` orders
them — identical order to `isp55e0.c main()`):

1. **CMD_CHIP_TYPE (0xa1)** — identify. Request carries the ASCII signature
   `MCU ISP & WCH.CN`; reply gives `type`/`family`. We reject `family == 0`
   ("chip is hosed") exactly as `read_chip_type` (line 415), then match a chip
   profile. `frameChipType` / `parseChipType`.
2. **CMD_READ_CONFIG (0xa7, what=0x1f)** — read the 12 config bytes, bootloader
   version (u32 **big-endian**), and the unique chip id. `parseReadConfig`
   mirrors `struct resp_read_config` offsets. Bootloader version is gated like
   `main()` lines 977-994 (`bootloaderSupport`): 2.3.1/2.4.0 don't ACK reboot,
   2.5.0–2.9.0 do, anything else is refused.
3. **Derive the 8-byte XOR key** — `deriveXorKey`, a line-for-line port of
   `create_key` (lines 568-581): `sum = (Σ first mcuIdLen id bytes) mod 256`;
   `key[0..7] = sum`; `key[7] = (sum + chip.type) mod 256`. For CH552:
   `mcuIdLen = 4`, `type = 0x52`.
4. **CMD_SET_KEY (0xa3)** — send the fixed 30-byte zero seed (`data_len 0x1e`),
   then check the device's returned checksum equals `keyChecksum(key)` (sum of
   the 8 key bytes mod 256). Mirrors `send_key` (lines 583-606).
5. **CMD_WRITE_CONFIG (0xa8, what=0x07)** — write the config bytes back
   unchanged (CH552 sets none of `need_remove_wp`/`clear_cfg_rom_read`). isp55e0
   does not check this reply, and neither do we (`write_config`, line 441).
6. **CMD_ERASE_CODE_FLASH (0xa4)** — erase length in KiB blocks, min 8
   (`eraseLengthKiB`, mirrors lines 491-494). For the ~6.8 KB image this is 8.
7. **CMD_WRITE_CODE_FLASH (0xa5)** — the whole image is padded to an 8-byte
   boundary with `0xff` (`padFirmware`, `load_file` lines 526-538), XOR-encrypted
   **once** over the whole buffer keyed on absolute position (`xorInPlace`,
   `encrypt_or_decrypt` lines 555-563), then sent in **56-byte** chunks; each
   frame is `[offset u32 LE][_u1=0][data]`, `data_len = len + 5` (`frameFlashRw`,
   `flash_rw` lines 617-653). Return code checked per chunk.
8. **`need_last_write`** — the final empty write (`flash_rw` lines 655-668) is
   **profile-gated**. The CH552 profile does **not** set it, so it is **not**
   sent. `frameLastWrite` exists for fidelity but `runFlash` only calls it when
   `profile.needLastWrite` (false for all CH55x).
9. **CMD_CMP_CODE_FLASH (0xa6)** — `send_key` again (isp55e0 re-sends the key
   before verify), then re-send the same encrypted chunks; the ROM compares
   in-place (flash can't be read back when protected). Return code checked.
10. **CMD_REBOOT (0xa2, option=0x01)** — **fire and do not require a reply.**
    The CH552 v2.50 ROM flashes+verifies fine but never ACKs reboot (patched at
    `reboot_device` ~line 826). We `transferOut` the reboot and, only for ROMs
    that are supposed to ACK, attempt one best-effort `transferIn` with a 600 ms
    timeout whose error/timeout is swallowed. A missing reboot reply is
    **success**, not an error. A power cycle boots the new firmware regardless.

---

## Firmware embedding

`../firmware/padkit.bin` (the single source of truth) is copied to
`public/firmware/padkit.bin` by `scripts/copy-firmware.mjs`, run automatically as
the npm `prebuild` (and `predev`) step. Vite then ships it to
`dist/firmware/padkit.bin`. The page `fetch('./firmware/padkit.bin')`es it at
flash time (same-origin, CSP-clean on GitHub Pages). No base64 blob is embedded,
so **the shipped firmware can never drift** from `firmware/padkit.bin` — whatever
the build sees is what the browser flashes. `public/firmware/` is gitignored
(generated). The UI shows the loaded byte length + a SHA-256 prefix so the user
can confirm the image before flashing.

---

## Tested vs. unverified

**Covered by `npm test` (157 assertions, no hardware):**

- `src/isp.selftest.ts` — pure protocol codec: XOR-key derivation (worked
  through the C arithmetic by hand: id `5f 43 57 e4`, type `0x52` → key
  `dd dd dd dd dd dd dd 2f`, checksum `0x3a`), key non-zero guarantee and mod-256
  wrap; 8-byte padding with `0xff` tail; XOR encrypt = involution and zeros→key;
  erase length (min 8, KiB rounding); **56-byte chunking** (122 chunks for the
  6816-byte padded image, last chunk 40 bytes, contiguous, all lengths multiples
  of 8); every request frame's command byte, `data_len`, and byte layout; every
  response parser (using the `protocol.txt` capture as a fixture); bootloader
  version gating.
- `src/flash.selftest.ts` — drives the real `runFlash` against an in-memory mock
  bootloader: asserts command **ordering** (set_key → write_config → erase →
  writes → set_key → compares → reboot), that SET_KEY is sent twice, 122
  write + 122 compare commands, that the bytes landing in mock "flash" decrypt
  back to the exact padded image, that the compare step matches, that the reboot
  no-ACK is tolerated, and that progress reaches the write/verify totals + done.

**Confirmed on real hardware (MacBook + Chrome):** a full flash succeeded — the
pad rebooted into v0.2 and the WebHID config tool then read inputs, drove LEDs,
and remapped keys. The **`deriveXorKey` round-trip is correct on silicon** (the
biggest prior unknown), and `requestDevice`/`claimInterface(0)`/the bulk
transfers/the silent reboot all work as ported.

**Still NOT independently verified here:**

- The `getDevices()` auto-detect and waiting-mode reconnect against a real
  second flash (the device-matching logic is unit-tested with mocks; the live
  `connect`/`disconnect` event timing is exercised only in the browser).
- `clearHalt` on a *genuinely* stalled endpoint (belt-and-suspenders; the flash
  succeeds without needing it).
- Windows (needs the one-time Zadig → WinUSB step; out of scope for the macOS
  tester).

## Reconnect UX (kills the short-bootloader-window race)

The CH552 only stays enumerated as `4348:55e0` for a few seconds before it boots
the app. `flash-core.ts` handles this three ways:

- **Timing guidance** in the reminder banner + a hint line under the buttons.
- **`getDevices()` auto-detect** — on load (and after each flash) we call
  `navigator.usb.getDevices()` and `pickBootloader(...)`; if a previously-granted
  bootloader is already present the primary button becomes “Flash detected pad”
  and flashes with no chooser.
- **Waiting mode** — “Wait for bootloader & auto-flash” arms a poll of
  `getDevices()` (every 700 ms) plus a `connect`-event listener; the moment an
  authorized bootloader device appears it auto-starts the flash. Click first,
  *then* enter bootloader mode — no race. `disconnect` clears the detected state.

First-time flashing still needs the `requestDevice()` chooser from a user gesture
(no prior grant ⇒ `getDevices()`/`connect` can't see the device yet).

---

## First-flash watch-list (top 3)

1. **Bootloader mode is a physical prerequisite.** Bridge SW2 and hold it while
   plugging in USB-C, then release. If the pad isn't in ISP mode it enumerates
   as the normal HID keyboard (`1189:8890`), won't appear in the WebUSB chooser
   (filters only match `*:55e0`), and "No device selected" is shown. This is the
   #1 cause of a non-flash — it is not a bug.
2. **Verify the key round-trip on the very first flash.** If SET_KEY returns
   "Device rejected the encryption key," the ROM's key derivation differs from
   `deriveXorKey` for this unit (e.g. it uses a different `mcuIdLen`, or the ROM
   folds the SET_KEY seed in differently than the zero-seed assumption). Cross-
   check by flashing the same pad with the CLI `../flasher/isp55e0 -f
   ../firmware/padkit.bin -d` (debug) and comparing the id bytes / key. The chip
   is unbrickable over USB, so a rejected key costs nothing but a retry.
3. **A silent reboot is success.** After "Flash complete," the pad will **not**
   re-enumerate on its own reliably (v2.50 doesn't ACK reboot). Physically
   unplug and replug (normally, without SW2) — it should come up as the PadKit
   HID keyboard running the new firmware. Don't interpret the missing reboot
   reply, or the device disappearing from the chooser, as a failure. If a
   transfer error interrupts mid-write, just re-enter bootloader mode and flash
   again — a half-written image is fully recoverable.
