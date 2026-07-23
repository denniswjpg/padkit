# Images

Real photos of the reference board (6-key + rotary knob). Full-res JPEGs live here and render
in `docs/flashing.md` and the repo `README.md`; downscaled WebP copies for the website live in
`web/public/img/` (regenerate with `cwebp -q 82 -resize 1400 0 in.jpg -o out.webp`).

| File | Shows |
|---|---|
| `PadKit_device.jpg` | The assembled macropad, top view (6 keys + knob) |
| `PadKit_screws.jpg` | Disassembly step 1 — the four corner faceplate screws to remove |
| `PadKit_device_opened.jpg` | Disassembly step 2 — PCB lifted out, back exposed (SW2 by the U7 chip, USBC1 on the top edge) |
| `PadKit_short_pincett.jpg` | Bootloader — bridge the SW2 pads with tweezers (①) and keep holding while connecting USB-C (②) |

If you photograph a different board variant, keep the same names (or add `-variant` suffixes)
and update the captions in `docs/flashing.md` + `web/flash.html`.
