#!/usr/bin/env python3
"""Read the PadKit scanner firmware's output -> report which pin each control is.

The scanner firmware (scanner.c) types a distinct letter (a-j) whenever a chip
pin is pulled low. This helper grabs the pad's keyboard event node(s) on Linux
and prints, per keypress, the letter, the CH552 pin it maps to, and the time
gap since the previous event -- so pressing each key / turning the knob reveals
the wiring without the letters spilling into whatever window has focus.

Usage:
    sudo ./scan-capture.py [seconds] [VID:PID]

  seconds   how long to capture (default 60)
  VID:PID   USB ids in hex, e.g. 1189:8890 (default). Override if your clone
            enumerates with different ids -- read them from `lsusb`.

You do NOT need this script: you can equally just open any text editor, press
every control, and read the letters off the screen using the map printed by the
firmware header. The script is a convenience that also shows the CH552 pin name
and prevents the letters reaching your desktop.

License: CC BY-SA 3.0.
"""
import re
import struct
import sys
import time
import fcntl
import select

EVIOCGRAB = 0x40044590
FMT = "llHHi"
SZ = struct.calcsize(FMT)

# evdev keycode -> (letter, CH552 pin) as emitted by the scanner firmware.
KEYMAP = {
    30: ("a", "P1.1"), 48: ("b", "P1.4"), 46: ("c", "P1.5"), 32: ("d", "P1.6"),
    18: ("e", "P1.7"), 33: ("f", "P3.0"), 34: ("g", "P3.1"), 35: ("h", "P3.2"),
    23: ("i", "P3.3"), 36: ("j", "P3.4"),
}


def nodes(vid, pid):
    """Find /dev/input/eventN paths for the given USB vendor/product ids."""
    found = []
    try:
        blocks = open("/proc/bus/input/devices").read().split("\n\n")
    except OSError:
        return found
    want_v = "Vendor=%04x" % vid
    want_p = "Product=%04x" % pid
    for b in blocks:
        if want_v in b and want_p in b:
            m = re.search(r"Handlers=([^\n]*)", b)
            if m:
                for t in m.group(1).split():
                    if t.startswith("event"):
                        found.append("/dev/input/" + t)
    return sorted(set(found))


def main():
    secs = 60.0
    vid, pid = 0x1189, 0x8890
    for arg in sys.argv[1:]:
        if ":" in arg:
            v, p = arg.split(":", 1)
            vid, pid = int(v, 16), int(p, 16)
        else:
            secs = float(arg)

    # The scanner just rebooted after flashing; wait up to 20s for its input
    # nodes to appear instead of racing the enumeration.
    deadline = time.time() + 20
    paths = nodes(vid, pid)
    while not paths and time.time() < deadline:
        time.sleep(1)
        paths = nodes(vid, pid)
    if not paths:
        print("scan-capture: no pad (%04x:%04x) after 20s -- scanner not "
              "enumerated? Check `lsusb` and pass the right VID:PID." % (vid, pid))
        return 3

    handles = {}
    for p in paths:
        try:
            fh = open(p, "rb", buffering=0)
        except OSError:
            continue
        try:
            fcntl.ioctl(fh.fileno(), EVIOCGRAB, 1)  # keep letters off the desktop
        except OSError:
            pass
        handles[fh.fileno()] = fh
    if not handles:
        print("scan-capture: could not open any node (need root for /dev/input?)")
        return 4

    poller = select.poll()
    for fd in handles:
        poller.register(fd, select.POLLIN)
    print("PRESS each key one at a time, then push and turn the knob both ways. "
          "Capturing %ds..." % int(secs), flush=True)
    end = time.time() + secs
    last = None
    while time.time() < end:
        for fd, _e in poller.poll(500):
            data = handles[fd].read(SZ)
            if not data or len(data) < SZ:
                continue
            _s, _u, et, code, val = struct.unpack(FMT, data)
            if et != 1 or val != 1:  # key-down only
                continue
            letter, pin = KEYMAP.get(code, ("?", "code=%d" % code))
            now = time.time()
            gap = "" if last is None else "  +%4.0fms" % ((now - last) * 1000)
            last = now
            print("  %s -> %s%s" % (letter, pin, gap), flush=True)

    for fh in handles.values():
        try:
            fcntl.ioctl(fh.fileno(), EVIOCGRAB, 0)
        except OSError:
            pass
    print("--- capture done ---", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
