<!-- SPDX-License-Identifier: MIT -->
# PadKit + coding agents (MCP)

The companion daemon ships an **MCP (Model Context Protocol) server** so a coding
agent — Claude Code, or any MCP-capable client — can drive the pad's LEDs and
react to its gestures. Use it to turn the macropad into an ambient status display
("build is red", "waiting for you") and a physical approve/deny button.

Ready-made config: [`examples/configs/agent-status-leds.yaml`](../../examples/configs/agent-status-leds.yaml).

## How it fits together

```
 coding agent  ──stdio JSON-RPC──▶  padkitd mcp  ──HTTP──▶  padkitd serve  ──USB-HID──▶  pad
   (MCP client)                     (MCP server)            (the daemon,               (LEDs / input)
                                     bridge)                 owns the device)
```

`padkitd mcp` is a thin bridge to a **running daemon** (`padkitd serve`) over its
local HTTP API. This keeps a single owner of the USB device, so the daemon's
gesture loop and the agent's LED writes never fight over the HID handle. (There is
also a `--direct` mode that opens the device itself when no daemon is running; in
that mode LED control works but gesture reads do not.)

## 1. Start the daemon

```sh
padkitd serve --config agent-status-leds.yaml
```

## 2. Register the MCP server with your agent

### Claude Code (CLI)
```sh
claude mcp add padkit -- padkitd mcp --url http://127.0.0.1:8787
```

### Generic MCP client (JSON config)
Most clients accept a server entry like:
```json
{
  "mcpServers": {
    "padkit": {
      "command": "padkitd",
      "args": ["mcp", "--url", "http://127.0.0.1:8787"]
    }
  }
}
```
Use an absolute path to `padkitd` if it isn't on the client's `PATH`. The MCP
server speaks newline-delimited JSON-RPC 2.0 on stdio (protocol `2024-11-05`);
all logging goes to stderr so stdout stays clean.

## 3. Tools exposed

| Tool | Arguments | What it does |
|---|---|---|
| `set_key_color` | `slot` 0–5, `color` `#RRGGBB`/`R,G,B` | one key's color |
| `set_all_colors` | `colors` (6 strings) | all six keys |
| `set_brightness` | `value` 0–255 | global brightness |
| `set_effect` | `effect` (static/breathe/rainbow/reactive/scanner), `rgb?`, `speed?` | animated effect |
| `flash_key` | `slot` 0–5, `color?`, `ms?` | momentary flash (signal an event) |
| `identify_key` | `slot` 0–10 | firmware IDENTIFY blink |
| `save_to_device` | — | persist LED state to the pad's flash |
| `get_last_event` | — | most recent gesture (poll to react to input) |

## A worked convention

Tell your agent to adopt an LED language and to poll for your input:

> Use the padkit MCP tools. When a build starts, `set_effect breathe rgb=#0044ff`.
> On success `set_key_color slot=0 color=#00ff00`; on failure
> `set_key_color slot=0 color=#ff0000`. When you need my approval,
> `flash_key slot=5 color=#ffcc00` and then poll `get_last_event` — if I tap key6
> (`{"kind":"tap","control":"key6"}`) treat it as "approved".

`get_last_event` returns the gesture the daemon observed, e.g.:
```json
{"event":{"control":"key6","slot":5,"kind":"tap","at":"2026-01-01T12:00:00Z","seq":42}}
```
Compare `seq` between polls to detect a *new* press rather than re-reading the
same one.

## Notes & honesty

- **Gesture delivery is poll-based** through `get_last_event`. There is also a
  server-sent-events stream at `GET /api/events/stream` on the daemon's HTTP API
  if you want push instead of poll from your own tooling.
- `--direct` mode cannot report gestures (no gesture loop); it is LED-only.
