<!-- SPDX-License-Identifier: MIT -->
# PadKit companion daemon (`padkitd`)

A single cross-platform Go binary that reads the PadKit macropad over its
**vendor-HID interface** and runs user-configured actions — **keystrokes, shell
commands, HTTP webhooks, and LED control** — plus an **MCP server** so coding
agents can drive the pad's LEDs and react to its gestures, and a small **local web
UI** for editing the action map.

This is Tier 3 of PadKit. It talks the frozen
[protocol v2](../docs/protocol-v2.md) and needs firmware v0.2+ (the composite
device with the `0xFF60` vendor interface).

- **Actions**: map any key (tap/hold) or the knob / click / push-turn to a
  `keystroke`, `shell`, `webhook`, or `led` action.
- **MCP server**: `set_key_color`, `set_all_colors`, `set_brightness`,
  `set_effect`, `flash_key`, `identify_key`, `save_to_device`, `get_last_event`.
- **Local HTTP API + web UI** at `http://127.0.0.1:8787` — also the "LED from an
  external event" endpoint (Home Assistant, scripts, etc.).
- **Hot-reload**: edit the config file and the daemon reloads it live.

## Contents
- [Build](#build)
- [Run](#run)
- [Configure](#configure)
- [Action backends](#action-backends)
- [MCP registration](#mcp-registration)
- [Web UI + HTTP API](#web-ui--http-api)
- [Per-OS notes](#per-os-notes)
- [Install as a service](#install-as-a-service)
- [Architecture](#architecture)

## Build

Requires **Go 1.24+** and a **C toolchain** (gcc/clang) — the HID layer uses cgo.
It does **not** need any system HID/udev/libusb development packages: the HID
binding ([`github.com/karalabe/hid`](https://github.com/karalabe/hid)) vendors
both **hidapi** and **libusb** as C sources.

```sh
cd daemon
go build -o padkitd ./cmd/padkitd
# optimized:
go build -trimpath -ldflags="-s -w" -o padkitd ./cmd/padkitd
```

Cross-compiling needs a cross C toolchain because of cgo (e.g. mingw-w64 for
Windows, an osxcross/clang for macOS). On the native platform the plain build
above is all you need.

Run the tests (no hardware required — the HID layer is behind an interface with a
mock):

```sh
go test ./...
go vet ./...
```

## Run

```sh
# Normal run against the real pad:
padkitd serve

# Explicit config path:
padkitd serve --config ./config.yaml

# No hardware? Run against a mock device (web UI + API work; no real I/O):
padkitd serve --mock

# Log level:
padkitd serve --log debug
```

On first run `padkitd` writes a starter config to the OS config dir if none
exists (see below) and prints where. Stop with Ctrl-C (clean shutdown).

## Configure

Config is YAML. Default locations (auto-selected; override with `--config` or
`$PADKIT_CONFIG`):

| OS | Path |
|---|---|
| Linux | `~/.config/padkit/config.yaml` |
| macOS | `~/Library/Application Support/padkit/config.yaml` |
| Windows | `%AppData%\padkit\config.yaml` |

A fully commented example is [`config.yaml`](./config.yaml). Ready-made configs
live in [`../examples/configs/`](../examples/configs/): **Home Assistant**,
**agent status LEDs**, and a **dev workflow**.

```yaml
device:
  vid: 0x1189
  pid: 0x8890
  usage_page: 0xFF60        # ALWAYS the vendor collection, never the keyboard one
  suppress_keyboard: false  # true = daemon owns the pad, no F13–F23 leakage

server:
  http_addr: "127.0.0.1:8787"
  web_ui: true

gestures:
  hold_ms: 400              # tap-vs-hold threshold for the six keys

bindings:
  key1:                     # the six keys support tap/hold
    tap:  { type: shell, command: "make test" }
    hold: { type: led, led: { slot: 0, color: "#ff0000", flash: true } }
  knob_cw:                  # momentary controls take a single bare action
    type: led
    led: { brightness: 255 }
```

**Control names**: `key1`…`key6`, `knob_cw`, `knob_ccw`, `knob_click`,
`pushturn_cw`, `pushturn_ccw`. Only `key1`…`key6` support `tap`/`hold`; the rest
are momentary and take a single action. A key with a single bare action treats it
as the **tap** action.

**Tap vs. hold** is timed host-side: press-and-release under `hold_ms` → `tap`;
crossing `hold_ms` while held → `hold` (fires once, at the threshold). The knob,
click, and push-turn are momentary.

Editing the file (or saving from the web UI) hot-reloads it live. A config that
fails to parse is rejected and the previous one is kept.

## Action backends

| Type | Fields | Notes |
|---|---|---|
| `shell` | `command` (via OS shell) or `command`+`args` (exec directly) | solid, cross-platform |
| `webhook` | `method`, `url`, `headers`, `body` | HTTP; the Home Assistant / API path |
| `led` | `led:` block (see below) | drives the pad's LEDs |
| `keystroke` | `keys: "ctrl+shift+p"` or `text: "literal\n"` | **best-effort per OS** — see [per-OS notes](#per-os-notes) |

`led` block fields (each present field emits one output report, in a stable
order): `brightness` (0–255), `effect` (`static`/`breathe`/`rainbow`/`reactive`/
`scanner`, `effect_rgb`, `effect_speed`), `all_colors` (6 colors),
`slot`+`color` (one key), `flash`+`slot`+`color`+`flash_ms`, `save` (persist to
device flash). Colors are `#RRGGBB` or `R,G,B`.

## MCP registration

The daemon can run as an **MCP stdio server** so a coding agent can control the
pad. Full guide: [`../docs/integrations/mcp-coding-agents.md`](../docs/integrations/mcp-coding-agents.md).

```sh
# 1. Run the daemon (owns the device):
padkitd serve

# 2. Register the bridge with your agent, e.g. Claude Code:
claude mcp add padkit -- padkitd mcp --url http://127.0.0.1:8787
```

Generic MCP client config:
```json
{ "mcpServers": { "padkit": { "command": "padkitd", "args": ["mcp", "--url", "http://127.0.0.1:8787"] } } }
```

`padkitd mcp` bridges to the running daemon's HTTP API, so the daemon stays the
single owner of the USB device. `padkitd mcp --direct` opens the device itself
when no daemon is running (LED control only; no gesture reads). Protocol:
newline-delimited JSON-RPC 2.0, MCP revision `2024-11-05`. All logs go to stderr.

## Web UI + HTTP API

`http://127.0.0.1:8787` serves a small page to edit the action map, drive LEDs,
and watch live gestures. The same API is the integration surface:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` / `GET /api/info` | health / device info |
| `GET,PUT /api/config` | read / write the raw config YAML (PUT validates + hot-reloads) |
| `GET /api/events/last` | most recent gesture |
| `GET /api/events/stream` | Server-Sent-Events gesture stream |
| `POST /api/led/{key,all,brightness,effect,flash,identify,save}` | LED control |
| `POST /api/led` | generic "LED from event" (full LED-action JSON) |

The server binds to loopback by default and has **no auth** — only expose it on a
LAN address behind your own firewall if you need remote LED pushes.

## Per-OS notes

### Linux
Install the **udev rule** once so your user can open the vendor interface without
root:
```sh
sudo cp service/99-padkit.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# then replug the pad
```
Keystroke injection shells out to **`xdotool`** (X11) or **`wtype`**/**`ydotool`**
(Wayland) if present — it's best-effort. Shell/webhook/LED need none of that.

### macOS
No driver or rule needed for a vendor-HID collection. Keystroke actions use
`osascript` (System Events) and require granting **Accessibility** permission to
the daemon (or the terminal that launched it) in System Settings → Privacy &
Security → Accessibility.

### Windows
No driver needed. The one thing that matters: the daemon opens the HID collection
whose **usage page is `0xFF60`**, never the keyboard collection — `padkitd` does
this automatically by enumerating and filtering on usage page. Keystroke actions
use PowerShell `SendKeys` (best-effort, targets the focused window). See
[`service/windows-service.md`](./service/windows-service.md) to run at login or as
a service.

> **Keystroke injection is best-effort on every OS.** It depends on external tools
> / permissions and targets the focused window. The **shell**, **webhook**, and
> **led** backends are the robust, fully-supported paths.

## Install as a service

- **Linux (systemd user unit)**: [`service/padkitd.service`](./service/padkitd.service)
- **macOS (launchd agent)**: [`service/com.padkit.padkitd.plist`](./service/com.padkit.padkitd.plist)
- **Windows**: [`service/windows-service.md`](./service/windows-service.md)

## Architecture

```
cmd/padkitd            CLI: `serve` (daemon) and `mcp` (stdio bridge/direct)
internal/protocol      frozen v2 wire format: report builders + input parser (pure, tested)
internal/hid           Device interface + MockDevice (no cgo) + karalabe adapter (cgo)
internal/gestures      tap/hold state machine (injectable clock, tested)
internal/config        YAML schema, control-name mapping, hot-reload parsing (tested)
internal/ledctl        high-level LED ops over the device (color parsing, shadow frame)
internal/actions       action dispatcher: keystroke / shell / webhook / led
internal/events        in-process gesture pub/sub (SSE + last-event)
internal/webui         local HTTP API + embedded config UI
internal/mcp           minimal MCP stdio server + HTTP/direct backends
internal/app           wires it all: open device, gesture loop, actions, HTTP, watcher
```

The HID transport is behind an interface with a `MockDevice`, so the gesture,
action, config, and LED logic are all unit-tested without hardware.
