<!-- SPDX-License-Identifier: MIT -->
# Running padkitd as a Windows service / at login

Windows needs **no driver** for the PadKit vendor-HID interface — it is a
standard HID collection and hidapi opens it directly. The one thing that matters
on Windows: the daemon opens the collection whose **usage page is `0xFF60`**, not
the keyboard collection. padkitd does this automatically (it enumerates and
filters by usage page), so there is nothing to configure.

You have two easy options to keep it running.

## Option A — run at login (simplest)

1. Build or download `padkitd.exe`.
2. Press `Win+R`, type `shell:startup`, Enter.
3. Create a shortcut in that folder pointing at:
   ```
   C:\path\to\padkitd.exe serve
   ```
It now starts each time you log in. The local UI is at <http://127.0.0.1:8787>.

## Option B — a real background service

Windows has no built-in "run this exe as a service" wrapper, so use one of:

### Using NSSM (Non-Sucking Service Manager)
```powershell
nssm install PadKitDaemon "C:\path\to\padkitd.exe" "serve"
nssm set PadKitDaemon AppEnvironmentExtra PADKIT_CONFIG=C:\Users\you\AppData\Roaming\padkit\config.yaml
nssm start PadKitDaemon
```

### Using the built-in Task Scheduler
Create a task that runs `padkitd.exe serve` **At log on**, with *Run whether user
is logged on or not* unchecked (HID access needs an interactive session for
`uaccess`-style device permissions on some setups).

## Keystroke actions on Windows

Keystroke injection shells out to PowerShell `SendKeys`. It is best-effort and
targets the foreground window. Shell, webhook, and LED actions are the robust
paths (see `daemon/README.md`).
