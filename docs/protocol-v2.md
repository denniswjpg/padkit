# PadKit v0.2 vendor-HID protocol (FROZEN SPEC)

This is the authoritative wire protocol for PadKit firmware **v0.2+**. Firmware implements it;
the web config tool (WebHID) and the companion daemon (hidapi) consume it. Treat this document
as frozen — changes require a version bump in the firmware-info reply (§6).

> **Why a vendor interface?** Chromium/WebHID and Windows both block script access to *keyboard*
> HID collections, but they protect HID **per top-level collection, not per device**. Vendor
> usage pages (0xFF00–0xFFFF) are exempt. So PadKit v0.2 is a **composite HID device**: a normal
> keyboard interface (for universal keybinds) *plus* a separate vendor interface that WebHID and
> native hidapi can fully read/write on macOS, Windows, and Linux. This mirrors QMK/VIA.

## 1. USB / HID topology

PadKit v0.2 enumerates as a composite HID device (running VID:PID `1189:8890`):

| Interface | Purpose | Endpoints | Report descriptor |
|---|---|---|---|
| **IF0 — Keyboard** | Universal keybinds: emits F13–F23 (unless suppressed, §5 flag) | EP1 IN | Boot keyboard, Usage Page 0x01 / Usage 0x06 |
| **IF1 — Vendor** | LED / config / input mirror for WebHID + hidapi | EP2 IN + EP2 OUT | **Usage Page `0xFF60`, Usage `0x61`** (QMK raw-HID values) |

The vendor interface defines exactly:
- one **Output** report: 32 bytes, host → device
- one **Input** report: 32 bytes, device → host
- **No report IDs** (send/receive with report ID `0`; the 32 payload bytes are as below).

Host selection rule (critical for the daemon): open the collection whose **Usage Page ==
0xFF60**, never "the first HID path" (that is the keyboard collection and will fail on Windows).

## 2. Report framing

Every report is a fixed **32-byte** buffer. Byte 0 is a command/type code; bytes 1..31 are
payload (zero-padded). Short host writes are padded to 32 by the OS (Windows requires the full
length). Multi-byte integers are little-endian. RGB is 3 bytes `R,G,B` per LED, 6 LEDs = 18
bytes, keys ordered 0..5 = physical keys 1..6.

## 3. Output reports (host → device), byte[0] = command

| Cmd | Name | Payload | Effect |
|---|---|---|---|
| `0x01` | `SET_RGB` | `[1..18]` = 6×RGB | Live per-key colors (RAM, not saved). Overrides effects until next effect cmd. |
| `0x02` | `SET_BRIGHTNESS` | `[1]` = 0..255 | Global brightness scale (RAM). |
| `0x03` | `SET_EFFECT` | `[1]` = effect id, `[2..]` = params | Animated effect (§4). `0` = static (use SET_RGB colors). |
| `0x04` | `SET_KEY` | `[1]`=slot, `[2]`=HID modifier, `[3]`=HID keycode | Remap one control's emitted keystroke (RAM). Slots §7. |
| `0x05` | `SET_FLAGS` | `[1]` = flags byte | Config flags (§5), RAM. |
| `0x06` | `SAVE` | — | Commit current RAM config (RGB defaults, brightness, effect, keymap, flags) to DataFlash. Device replies `ACK` (§6 `0x84`). |
| `0x07` | `LOAD_DEFAULTS` | — | Reset RAM+DataFlash to factory defaults; replies `ACK`. |
| `0x08` | `GET_CONFIG` | — | Device replies with `CONFIG_DUMP` (§6 `0x82`). |
| `0x09` | `GET_INFO` | — | Device replies with `FW_INFO` (§6 `0x83`). |
| `0x0A` | `IDENTIFY` | `[1]`=slot | Blink one key white ~500 ms so the user can see which physical key a slot is. |
| `0x0B` | `SET_IDLE_DIM` | `[1]`=enable(0/1), `[2..3]`=timeout_ms/100 | Idle auto-dim behavior. |

## 4. Effect ids (for `SET_EFFECT`)

| id | name | params |
|---|---|---|
| 0 | static | — (uses SET_RGB colors) |
| 1 | breathe | `[2]`=speed, `[3..5]`=RGB |
| 2 | rainbow-cycle | `[2]`=speed |
| 3 | reactive (key lights on press) | `[2]`=fade, `[3..5]`=RGB |
| 4 | scanner/knight-rider | `[2]`=speed, `[3..5]`=RGB |

Firmware must implement 0–1 at minimum; 2–4 are optional and reported via the capabilities
bitmask in `FW_INFO`. Unknown effect id → fall back to static, no error.

## 5. Flags byte (`SET_FLAGS` / stored in config)

| bit | name | meaning |
|---|---|---|
| 0 | `SUPPRESS_KEYBOARD` | When set, IF0 stops emitting keyboard reports; input is delivered **only** via the vendor Input report (§6 `0x81`). Lets the daemon own the pad with no keystroke leakage. Default **0** (keys work as universal binds). |
| 1 | `IDLE_DIM_ON` | Mirror of SET_IDLE_DIM enable, persisted. |
| 2–7 | reserved | must be 0 |

## 6. Input reports (device → host), byte[0] = type

| Type | Name | Payload |
|---|---|---|
| `0x81` | `INPUT_EVENT` | `[1]`=control id (§7), `[2]`=action, `[3]`=value. **Always** sent for every control event (independent of SUPPRESS_KEYBOARD, so the daemon sees input even when keystrokes are suppressed). |
| `0x82` | `CONFIG_DUMP` | `[1]`=brightness, `[2]`=effect id, `[3]`=flags, `[4..21]`=6×RGB defaults, `[22..]`=keymap summary (see §7 encoding, truncated to fit). |
| `0x83` | `FW_INFO` | `[1..2]`=firmware version (major,minor), `[3..4]`=protocol version (this doc = 2,0), `[5..8]`=capabilities bitmask (LE), `[9]`=key count (6), `[10]`=led count (6). |
| `0x84` | `ACK` | `[1]`=cmd being ack'd, `[2]`=status (0=ok, nonzero=err). |

`INPUT_EVENT` action codes: `0x01`=key down, `0x02`=key up, `0x10`=knob CW, `0x11`=knob CCW,
`0x12`=knob click, `0x20`=push-turn CW, `0x21`=push-turn CCW.

Capabilities bitmask bits: `0`=persistent config (DataFlash), `1`=keymap remap, `2`=effects>1,
`3`=idle dim, `4`=push-turn axis. Web tool/daemon should feature-gate UI on these.

## 7. Control slots & keymap encoding

Slot ids used by `SET_KEY` / `IDENTIFY` / `INPUT_EVENT` control id:

| slot | control | default keystroke |
|---|---|---|
| 0 | key 1 | F13 |
| 1 | key 2 | F14 |
| 2 | key 3 | F15 |
| 3 | key 4 | F16 |
| 4 | key 5 | F17 |
| 5 | key 6 | F18 |
| 6 | knob CCW | F19 |
| 7 | knob click | F20 |
| 8 | knob CW | F21 |
| 9 | push-turn CCW | F22 |
| 10 | push-turn CW | F23 |

`SET_KEY` payload: `modifier` is the standard HID keyboard modifier bitmask (bit0 LCtrl, bit1
LShift, bit2 LAlt, bit3 LGUI, …); `keycode` is a standard HID Keyboard/Keypad usage (page 0x07).
Setting keycode `0` disables that control's keystroke (still emits INPUT_EVENT). The device
still applies tap/hold at the host layer — the firmware only sends raw down/up.

## 8. DataFlash layout (device-side, informative)

CH552 DataFlash (128 B). Firmware persists: magic(2) · version(1) · brightness(1) · effect(1) ·
flags(1) · idle_timeout(2) · 6×RGB defaults(18) · 11×keymap entries {mod,code}(22) ≈ 48 B.
On boot, if magic matches, load; else write factory defaults. A bad/blank DataFlash must never
brick boot — always fall back to defaults.

## 9. Conformance notes for implementers

- **Firmware:** unknown command byte → ignore (optionally `ACK` with status=err). Never hang the
  USB stack on a malformed report; keep the watchdog fed (carry over the v0.1 `HID_sendReport`
  pacing fix). Emit `INPUT_EVENT` for every physical event regardless of suppress flag.
- **Web tool (WebHID):** request the device, then use the collection with usagePage `0xFF60`.
  Stream live edits via output reports; call `SAVE` only on an explicit user "Save to device".
  Read back with `GET_CONFIG` after connect to populate the UI.
- **Daemon (hidapi):** enumerate by usagePage `0xFF60`; set `SUPPRESS_KEYBOARD` when it wants
  exclusive control; consume `INPUT_EVENT` for gestures. On Windows open the vendor collection
  path, not the keyboard one.
