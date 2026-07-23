<!-- SPDX-License-Identifier: MIT -->
# PadKit + Home Assistant

Two directions, both handled by the companion daemon:

1. **Pad → Home Assistant** — a key/knob fires an HTTP **webhook** or REST service call.
2. **Home Assistant → Pad** — HA drives the pad's **LEDs** by POSTing to the daemon's local endpoint.

Ready-made config: [`examples/configs/home-assistant.yaml`](../../examples/configs/home-assistant.yaml).

## 1. Pad → Home Assistant (webhooks)

The `webhook` action backend makes an HTTP request when a gesture fires. Point it
at an HA **webhook trigger** (no auth) or the **REST API** (bearer token).

```yaml
bindings:
  key1:
    tap:  { type: webhook, method: POST, url: "http://homeassistant.local:8123/api/webhook/padkit_key1" }
    hold: { type: webhook, method: POST, url: "http://homeassistant.local:8123/api/webhook/padkit_key1_hold" }
```

In Home Assistant, add an automation with a **Webhook** trigger:

```yaml
# configuration via UI: Settings → Automations → New → Trigger: Webhook
alias: PadKit key1
trigger:
  - platform: webhook
    webhook_id: padkit_key1
    allowed_methods: [POST]
    local_only: true
action:
  - service: light.toggle
    target: { entity_id: light.desk }
```

To call a service directly (skip the automation) use the REST API with a
long-lived access token (Profile → Long-lived access tokens):

```yaml
  key4:
    tap:
      type: webhook
      method: POST
      url: "http://homeassistant.local:8123/api/services/scene/turn_on"
      headers:
        Authorization: "Bearer YOUR_LONG_LIVED_TOKEN"
        Content-Type: "application/json"
      body: '{"entity_id":"scene.movie_time"}'
```

The knob works the same way — bind `knob_cw` / `knob_ccw` to
`light.turn_on` with `brightness_step_pct`.

## 2. Home Assistant → Pad (LED feedback)

The daemon exposes a loopback HTTP endpoint that sets LEDs "from an event". Use
HA's `rest_command` to push state onto the pad:

```yaml
# HA configuration.yaml
rest_command:
  padkit_key1_green:
    url: "http://DAEMON_HOST:8787/api/led/key"
    method: POST
    content_type: "application/json"
    payload: '{"slot":0,"color":"#00ff00"}'
  padkit_alert:
    url: "http://DAEMON_HOST:8787/api/led"
    method: POST
    content_type: "application/json"
    payload: '{"slot":5,"color":"#ff0000","flash":true,"flash_ms":400}'
```

`DAEMON_HOST` is the machine running `padkitd`. By default the daemon binds to
`127.0.0.1` only; if HA runs on another host, set `server.http_addr` to a LAN
address (and firewall it appropriately — there is no auth on the local API).

### LED endpoint reference

| Endpoint | Body | Effect |
|---|---|---|
| `POST /api/led/key` | `{"slot":0-5,"color":"#RRGGBB"}` | one key color |
| `POST /api/led/all` | `{"colors":["#..",...6]}` | all six keys |
| `POST /api/led/brightness` | `{"value":0-255}` | brightness |
| `POST /api/led/effect` | `{"effect":"breathe","rgb":"#00f","speed":128}` | animated effect |
| `POST /api/led/flash` | `{"slot":0-5,"color":"#..","ms":300}` | momentary flash |
| `POST /api/led` | full LED action JSON | generic "led from event" |
| `POST /api/led/save` | — | persist to the pad's flash |

## Making the pad a dedicated HA controller

Set `suppress_keyboard: true` so the pad stops emitting F13–F23 and delivers
input only to the daemon (via the vendor interface) — no stray keystrokes reach
whatever app has focus.
