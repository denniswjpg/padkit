<!-- SPDX-License-Identifier: MIT -->
# PadKit + desktop ChatGPT / Claude apps

**Short version: the desktop ChatGPT and Claude apps are not scriptable, so PadKit
can't "press a button in the app" through a clean API. Two honest options exist —
keystroke focus, or talk to the model's HTTP API directly.**

## Why there's no direct integration

The desktop chat apps (OpenAI's ChatGPT app, Anthropic's Claude app) expose no
local automation surface — no local IPC, no plugin/extension host you can drive
from an external process, no documented "send this prompt" endpoint. Unlike a
coding agent that speaks **MCP** (see
[mcp-coding-agents.md](./mcp-coding-agents.md)), a chat *app* window is just a GUI.
So PadKit cannot make the app do something in a first-class, reliable way.

## Option A — keystroke focus (best-effort)

Bind a key to a `keystroke` action that types into the focused chat window. This
only works when that window has focus, and keystroke injection is best-effort per
OS (see the daemon README). Useful for "insert my standard prompt" or submitting
with Enter, not for headless control.

```yaml
bindings:
  key1:
    tap: { type: keystroke, text: "Summarize the errors above and propose a fix.\n" }
  key2:
    tap: { type: keystroke, keys: "ctrl+enter" }   # some apps: send
```

Caveats: the target window must be focused; some apps intercept or remap shortcuts;
Wayland/macOS may require extra permissions (xdotool/wtype on Linux, Accessibility
on macOS).

## Option B — call the model API directly (robust)

If your goal is "press a key, get a model response", skip the GUI and use a
`webhook` action against the provider's HTTP API (or, better, a tiny local script
via a `shell` action that formats the request and does something with the reply).
This is deterministic and scriptable.

```yaml
bindings:
  key3:
    tap:
      type: webhook
      method: POST
      url: "https://api.anthropic.com/v1/messages"
      headers:
        x-api-key: "YOUR_API_KEY"
        anthropic-version: "2023-06-01"
        content-type: "application/json"
      body: '{"model":"claude-sonnet-4-5","max_tokens":256,"messages":[{"role":"user","content":"Give me a standup summary."}]}'
```

For anything beyond fire-and-forget, use a `shell` action that runs your own
script — it can call the API, parse the JSON, and drop the answer into a file,
notification, or clipboard. That keeps credentials and response handling in your
code rather than in the pad config.

## Recommendation

- Want an agent that reacts to the pad and lights it up? Use **MCP** with a coding
  agent — that's the first-class path.
- Want a key to *do an LLM call*? Use the **API directly** (Option B).
- Only use **keystroke** (Option A) for lightweight "type into whatever's focused"
  cases, and treat it as best-effort.
