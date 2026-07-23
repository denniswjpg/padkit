// ===================================================================================
// PadKit firmware v0.2 — 6-key + rotary-knob USB macropad (CH552G), composite HID
// ===================================================================================
//
// PadKit is an open-source firmware + tooling package for a small USB HID macropad
// built around a WCH CH552G (8051-core) microcontroller: six mechanical keys, one
// rotary encoder with a push switch, and a strip of six addressable RGB LEDs
// (NeoPixel / WS2812-style).
//
// v0.2 is a COMPOSITE HID device (see docs/protocol-v2.md, the frozen spec):
//   IF0 — boot keyboard (EP1 IN): emits F13..F23 exactly like v0.1, so a host
//         listener can bind them as universal keybinds. Suppressible (flag bit0).
//   IF1 — vendor raw-HID (EP2 IN + OUT, usage page 0xFF60 / usage 0x61): a browser
//         (WebHID) or native daemon (hidapi) configures LEDs / keymap / flags and
//         mirrors every physical event, cross-platform, with no keyboard-collection
//         blocking. All config persists to on-chip DataFlash and survives unplug.
//
// -----------------------------------------------------------------------------------
// DEFAULT KEYCODE MAP (remappable at runtime via IF1 SET_KEY; slots per spec §7)
// -----------------------------------------------------------------------------------
//   Key 1..6            F13..F18   real key-down on press, key-up on release
//   Knob turn CW        F21        one event per detent (slot 8)
//   Knob turn CCW       F19        one event per detent (slot 6)
//   Knob click          F20        typed on release, only if NOT turned while held (slot 7)
//   Push-turn CW        F23        turning while pressed — second axis (slot 10)
//   Push-turn CCW       F22        turning while pressed — second axis (slot 9)
//   Every physical event ALSO emits a vendor INPUT_EVENT (0x81) on IF1, even when
//   keyboard output is suppressed (flag bit0), so the daemon always sees input.
//
// -----------------------------------------------------------------------------------
// PIN MAP (CH552G)
// -----------------------------------------------------------------------------------
//   Key1=P1.1  Key2=P1.7  Key3=P1.6  Key4=P1.5  Key5=P1.4  Key6=P3.2
//   ENC_A=P3.1 ENC_B=P3.0 ENC_SW=P3.3            NeoPixel data=P3.4
//   All key/encoder inputs use internal pull-ups; a pressed key reads LOW.
//
// Bootloader: hold the board's boot pads (or key4 / P1.5) LOW while plugging in USB
// to enter the CH55x ROM bootloader for flashing. See ../flasher/ and README.md.
// ===================================================================================

#include <config.h>
#include <system.h>
#include <gpio.h>
#include <delay.h>
#include <neo.h>
#include <usb_conkbd.h>
#include <usb_hid.h>
#include <dataflash.h>

void USB_interrupt(void);
void USB_ISR(void) __interrupt(INT_NO_USB) {
  USB_interrupt();
}

// ===================================================================================
// Protocol constants (docs/protocol-v2.md)
// ===================================================================================
#define NPX             6
#define NSLOT           11               // control slots 0..10

// Output commands (host -> device, byte[0])
#define CMD_SET_RGB        0x01
#define CMD_SET_BRIGHTNESS 0x02
#define CMD_SET_EFFECT     0x03
#define CMD_SET_KEY        0x04
#define CMD_SET_FLAGS      0x05
#define CMD_SAVE           0x06
#define CMD_LOAD_DEFAULTS  0x07
#define CMD_GET_CONFIG     0x08
#define CMD_GET_INFO       0x09
#define CMD_IDENTIFY       0x0A
#define CMD_SET_IDLE_DIM   0x0B

// Input report types (device -> host, byte[0])
#define IN_EVENT           0x81
#define IN_CONFIG_DUMP     0x82
#define IN_FW_INFO         0x83
#define IN_ACK             0x84

// INPUT_EVENT action codes
#define ACT_KEY_DOWN       0x01
#define ACT_KEY_UP         0x02
#define ACT_KNOB_CW        0x10
#define ACT_KNOB_CCW       0x11
#define ACT_KNOB_CLICK     0x12
#define ACT_PT_CW          0x20
#define ACT_PT_CCW         0x21

// Flags byte
#define FLAG_SUPPRESS      0x01           // bit0: IF0 stops emitting keystrokes
#define FLAG_IDLE_DIM      0x02           // bit1: idle auto-dim enabled

// Capabilities bitmask reported in FW_INFO
//   bit0 persistent config, bit1 keymap remap, bit2 effects>1, bit3 idle dim,
//   bit4 push-turn axis
#define CAPS               0x0000001FUL

#define FW_VER_MAJOR       0
#define FW_VER_MINOR       2
#define PROTO_VER_MAJOR    2
#define PROTO_VER_MINOR    0

// Default HID keyboard usages F13..F23 (page 0x07)
#define HID_F13            0x68           // F14=0x69 ... F23=0x72

// ===================================================================================
// Persistent config (mirror of the DataFlash image, spec §8)
// ===================================================================================
#define CFG_MAGIC0         0x50          // 'P'
#define CFG_MAGIC1         0x4B          // 'K'
#define CFG_VER            0x02
#define CFG_LEN            48            // 2+1+1+1+1+2+18+22

uint8_t  g_brightness;                    // 0..255 master scale
uint8_t  g_effect;                        // 0 static, 1 breathe, 2 blink
uint8_t  g_flags;                         // FLAG_* bits
uint16_t g_idle_timeout;                  // idle-dim timeout, ms/100
__xdata uint8_t g_rgb[18];                // 6 x RGB base colors
__xdata uint8_t g_keymap[22];             // 11 x {modifier, keycode}
uint16_t g_idle_thresh;                   // derived: idle-dim threshold in loops

__xdata uint8_t dfbuf[CFG_LEN];           // DataFlash (de)serialize scratch
__xdata uint8_t vout[32];                 // vendor INPUT report scratch
__xdata uint8_t cmd[32];                  // command snapshot copied out of the ISR latch

// ===================================================================================
// LED engine state
// ===================================================================================
__xdata uint8_t flash[NPX];               // per-key press feedback, fades
__xdata uint8_t cur[18];                  // currently shown frame (fades toward tgt)
__xdata uint8_t tgt[18];                  // target frame
uint8_t  kmask = 0x3F;                     // last key states, bit=1 released (6 keys)
__xdata uint8_t lockout[7];               // per-control debounce (loop passes)
__bit    sw_down = 0, sw_rot = 0;          // knob switch state; rotated-while-down
uint8_t  enc_prev = 3, tick = 0;
int8_t   enc_acc = 0;
uint16_t idle = 0;                         // loops since last input
uint8_t  ident_slot = 0xFF;                // IDENTIFY target slot (0xFF = none)
uint16_t ident_ticks = 0;                  // IDENTIFY remaining LED passes
__code int8_t QDEC[16] = {0,-1,1,0, 1,0,0,-1, -1,0,0,1, 0,1,-1,0};

// ===================================================================================
// Config helpers
// ===================================================================================
static void cfg_recompute(void) {
  uint8_t i;
  uint32_t t = (uint32_t)g_idle_timeout * 20UL;   // ms/100 -> ~5ms loops (timeout*100/5)
  g_idle_thresh = (t > 0xFFFFUL) ? 0xFFFF : (uint16_t)t;
  for(i = 0; i < 18; i++) tgt[i] = g_rgb[i];      // static base follows stored colors
}

static void cfg_defaults(void) {
  uint8_t i;
  g_brightness   = 255;
  g_effect       = 0;
  g_flags        = FLAG_IDLE_DIM;                 // suppress off, idle-dim on
  g_idle_timeout = 3000;                          // 300000 ms ~= 5 min (matches v0.1)
  for(i = 0; i < 18; i++) g_rgb[i] = 0;           // LEDs off until host sets colors
  for(i = 0; i < NSLOT; i++) {
    g_keymap[i*2]   = 0;                          // no modifier
    g_keymap[i*2+1] = HID_F13 + i;                // F13..F23
  }
}

static void cfg_serialize(void) {
  uint8_t i;
  dfbuf[0] = CFG_MAGIC0; dfbuf[1] = CFG_MAGIC1; dfbuf[2] = CFG_VER;
  dfbuf[3] = g_brightness; dfbuf[4] = g_effect; dfbuf[5] = g_flags;
  dfbuf[6] = (uint8_t)(g_idle_timeout & 0xFF);
  dfbuf[7] = (uint8_t)(g_idle_timeout >> 8);
  for(i = 0; i < 18; i++) dfbuf[8 + i]  = g_rgb[i];
  for(i = 0; i < 22; i++) dfbuf[26 + i] = g_keymap[i];
}

static void cfg_deserialize(void) {
  uint8_t i;
  g_brightness   = dfbuf[3];
  g_effect       = dfbuf[4];
  g_flags        = dfbuf[5];
  g_idle_timeout = (uint16_t)dfbuf[6] | ((uint16_t)dfbuf[7] << 8);
  for(i = 0; i < 18; i++) g_rgb[i]    = dfbuf[8 + i];
  for(i = 0; i < 22; i++) g_keymap[i] = dfbuf[26 + i];
}

static void cfg_save(void) {
  uint8_t i;
  cfg_serialize();
  for(i = 0; i < CFG_LEN; i++) { DF_write(i, dfbuf[i]); WDT_reset(); }
}

static void cfg_load(void) {
  uint8_t i;
  for(i = 0; i < CFG_LEN; i++) dfbuf[i] = DF_read(i);
  if(dfbuf[0] == CFG_MAGIC0 && dfbuf[1] == CFG_MAGIC1 && dfbuf[2] == CFG_VER) {
    cfg_deserialize();                            // valid image -> load it
  } else {
    cfg_defaults();                               // blank/bad flash -> factory + persist
    cfg_save();
  }
  cfg_recompute();
}

// ===================================================================================
// Vendor IF1 senders
// ===================================================================================
static void send_input(uint8_t id, uint8_t action, uint8_t value) {
  uint8_t i;
  for(i = 0; i < 32; i++) vout[i] = 0;
  vout[0] = IN_EVENT; vout[1] = id; vout[2] = action; vout[3] = value;
  HID_sendVendor(vout);
}

static void send_ack(uint8_t which, uint8_t status) {
  uint8_t i;
  for(i = 0; i < 32; i++) vout[i] = 0;
  vout[0] = IN_ACK; vout[1] = which; vout[2] = status;
  HID_sendVendor(vout);
}

static void send_config_dump(void) {
  uint8_t i;
  for(i = 0; i < 32; i++) vout[i] = 0;
  vout[0] = IN_CONFIG_DUMP;
  vout[1] = g_brightness;
  vout[2] = g_effect;
  vout[3] = g_flags;
  for(i = 0; i < 18; i++) vout[4 + i] = g_rgb[i];
  // Keymap summary: keycodes of slots 0..9 (10 bytes, bytes 22..31). Truncated to
  // fit the 32-byte report per spec §6; the full keymap is tracked host-side.
  for(i = 0; i < 10; i++) vout[22 + i] = g_keymap[i*2 + 1];
  HID_sendVendor(vout);
}

static void send_fw_info(void) {
  uint8_t i;
  for(i = 0; i < 32; i++) vout[i] = 0;
  vout[0] = IN_FW_INFO;
  vout[1] = FW_VER_MAJOR;   vout[2] = FW_VER_MINOR;
  vout[3] = PROTO_VER_MAJOR; vout[4] = PROTO_VER_MINOR;
  vout[5] = (uint8_t)(CAPS & 0xFF);
  vout[6] = (uint8_t)((CAPS >> 8) & 0xFF);
  vout[7] = (uint8_t)((CAPS >> 16) & 0xFF);
  vout[8] = (uint8_t)((CAPS >> 24) & 0xFF);
  vout[9] = NPX;            // key count
  vout[10] = NPX;           // led count
  HID_sendVendor(vout);
}

// ===================================================================================
// Keystroke emission (respects the SUPPRESS flag; keymap-driven)
// ===================================================================================
static void kbd_down(uint8_t slot) {
  uint8_t mod = g_keymap[slot*2], code = g_keymap[slot*2 + 1];
  if(g_flags & FLAG_SUPPRESS) return;
  if(!mod && !code) return;                       // disabled control
  KBD_pressRaw(mod, code);
}
static void kbd_up(uint8_t slot) {
  uint8_t mod = g_keymap[slot*2], code = g_keymap[slot*2 + 1];
  if(g_flags & FLAG_SUPPRESS) return;
  if(!mod && !code) return;
  KBD_releaseRaw(mod, code);
}
static void kbd_tap(uint8_t slot) { kbd_down(slot); kbd_up(slot); }

// ===================================================================================
// Command processing (main-loop context, out of the ISR)
// ===================================================================================
static void process_cmd(void) {
  uint8_t c = cmd[0];
  uint8_t i;
  switch(c) {

    case CMD_SET_RGB:                               // [1..18] = 6xRGB, RAM
      for(i = 0; i < 18; i++) g_rgb[i] = cmd[1 + i];
      g_effect = 0;                                 // live colors override effect
      cfg_recompute();
      break;

    case CMD_SET_BRIGHTNESS:                        // [1] = 0..255
      g_brightness = cmd[1];
      break;

    case CMD_SET_EFFECT:                            // [1]=id, params follow
      g_effect = cmd[1];
      if(g_effect == 1) {                           // breathe: [3..5]=RGB base color
        for(i = 0; i < NPX; i++) {
          g_rgb[i*3]   = cmd[3];
          g_rgb[i*3+1] = cmd[4];
          g_rgb[i*3+2] = cmd[5];
        }
        cfg_recompute();
      }
      break;

    case CMD_SET_KEY:                               // [1]=slot,[2]=mod,[3]=code
      if(cmd[1] < NSLOT) {
        g_keymap[cmd[1]*2]     = cmd[2];
        g_keymap[cmd[1]*2 + 1] = cmd[3];
      }
      break;

    case CMD_SET_FLAGS:                             // [1]=flags
      g_flags = cmd[1];
      if(g_flags & FLAG_SUPPRESS) KBD_releaseAll(); // drop any held keys cleanly
      break;

    case CMD_SAVE:                                  // persist RAM config -> DataFlash
      cfg_save();
      send_ack(CMD_SAVE, 0);
      break;

    case CMD_LOAD_DEFAULTS:                         // factory reset RAM + DataFlash
      cfg_defaults();
      cfg_save();
      cfg_recompute();
      send_ack(CMD_LOAD_DEFAULTS, 0);
      break;

    case CMD_GET_CONFIG:
      send_config_dump();
      break;

    case CMD_GET_INFO:
      send_fw_info();
      break;

    case CMD_IDENTIFY:                              // [1]=slot -> blink white ~500ms
      ident_slot  = cmd[1];
      ident_ticks = 25;                             // ~25 LED passes (~500ms @ ~20ms)
      break;

    case CMD_SET_IDLE_DIM:                          // [1]=enable,[2..3]=timeout ms/100
      if(cmd[1]) g_flags |= FLAG_IDLE_DIM; else g_flags &= (uint8_t)~FLAG_IDLE_DIM;
      g_idle_timeout = (uint16_t)cmd[2] | ((uint16_t)cmd[3] << 8);
      if(g_idle_timeout == 0) g_idle_timeout = 1;   // avoid instant dim
      cfg_recompute();
      break;

    default:                                        // unknown command -> ACK error
      send_ack(c, 1);
      break;
  }
}

// ===================================================================================
// LED rendering
// ===================================================================================
// Move the shown frame 1/4 of the way toward the target each pass for smooth fades.
static uint8_t fade_step(void) {
  uint8_t i, changed = 0;
  for(i = 0; i < 18; i++) {
    uint8_t c = cur[i], t = tgt[i];
    if(c == t) continue;
    changed = 1;
    if(c < t) { uint8_t d = (t - c) >> 2; cur[i] = c + (d ? d : 1); }
    else      { uint8_t d = (c - t) >> 2; cur[i] = c - (d ? d : 1); }
  }
  return changed;
}

// Output the shown frame: effect wave, master brightness, idle dim, then the
// press-feedback (white) and IDENTIFY (white) overlays at the last stage.
static void render_out(void) {
  uint8_t i, j = 0, wave = 255;
  uint8_t eff = g_effect;
  if(eff == 1) {                                    // breathe: triangle wave
    wave = (tick & 0x80) ? (uint8_t)((255 - tick) << 1) : (uint8_t)(tick << 1);
    if(wave < 40) wave = 40;
  } else if(eff == 2) {                             // blink: square
    wave = (tick & 0x40) ? 255 : 0;
  }
  EA = 0;
  for(i = 0; i < NPX; i++, j += 3) {
    uint16_t r = cur[j], g = cur[j+1], b = cur[j+2];
    uint8_t f = flash[i];
    uint8_t ident = (ident_ticks && (ident_slot == i ||
                     (ident_slot >= NPX && ident_slot < NSLOT))) ? 1 : 0;
    r = (r * wave) >> 8; g = (g * wave) >> 8; b = (b * wave) >> 8;
    r = (r * g_brightness) >> 8; g = (g * g_brightness) >> 8; b = (b * g_brightness) >> 8;
    if((g_flags & FLAG_IDLE_DIM) && idle >= g_idle_thresh) { r >>= 2; g >>= 2; b >>= 2; }
    if(f) {                                         // press feedback (white) overlay
      if(f > r) r = f; if(f > g) g = f; if(f > b) b = f;
    }
    if(ident) { r = 255; g = 255; b = 255; }        // IDENTIFY overlay (steady white)
    NEO_writeColor((uint8_t)r, (uint8_t)g, (uint8_t)b);
  }
  EA = 1;
  NEO_latch();
}

#define TOUCH() do { idle = 0; } while(0)

// One key: 20ms lockout after any edge, real press/release + INPUT_EVENT, feedback.
#define KEY_STEP(PORTPIN, IDX) do { \
    if(lockout[IDX]) { lockout[IDX]--; } \
    else { \
      uint8_t nw = PIN_read(PORTPIN) ? 1 : 0; \
      if(nw != ((kmask >> (IDX)) & 1)) { \
        lockout[IDX] = 10; \
        if(!nw) { kbd_down(IDX); flash[IDX] = 160; send_input(IDX, ACT_KEY_DOWN, 1); } \
        else    { kbd_up(IDX); send_input(IDX, ACT_KEY_UP, 0); } \
        kmask = nw ? (kmask | (1 << (IDX))) : (kmask & (uint8_t)~(1 << (IDX))); \
        TOUCH(); \
      } \
    } \
  } while(0)

// ===================================================================================
// Main
// ===================================================================================
void main(void) {
  uint8_t ab, i;

  CLK_config();
  DLY_ms(5);
  NEO_init();
  KBD_init();
  WDT_start();

  PIN_input_PU(P11); PIN_input_PU(P17); PIN_input_PU(P16);
  PIN_input_PU(P15); PIN_input_PU(P14); PIN_input_PU(P32);
  PIN_input_PU(P31); PIN_input_PU(P30); PIN_input_PU(P33);
  DLY_ms(5);

  cfg_load();                                       // DataFlash or factory defaults
  for(i = 0; i < 18; i++) cur[i] = 0;               // fade up from black
  render_out();

  while(1) {
    // --- vendor commands from IF1 (parsed out of the ISR) ---
    if(HID_cmdPending) {
      EA = 0;
      for(i = 0; i < 32; i++) cmd[i] = HID_cmdBuf[i];
      HID_cmdPending = 0;
      EA = 1;
      process_cmd();
    }

    // --- keys: down/up with per-key debounce ---
    KEY_STEP(P11, 0); KEY_STEP(P17, 1); KEY_STEP(P16, 2);
    KEY_STEP(P15, 3); KEY_STEP(P14, 4); KEY_STEP(P32, 5);

    // --- knob switch: click on release ONLY if no push-turn happened ---
    if(lockout[6]) { lockout[6]--; }
    else {
      uint8_t nw = PIN_read(P33) ? 1 : 0;
      if(!nw && !sw_down)    { sw_down = 1; sw_rot = 0; lockout[6] = 10; TOUCH(); }
      else if(nw && sw_down) {
        sw_down = 0; lockout[6] = 10;
        if(!sw_rot) { kbd_tap(7); send_input(7, ACT_KNOB_CLICK, 1); }
        TOUCH();
      }
    }

    // --- encoder: quadrature transition decode, never blocks ---
    ab = (PIN_read(P31) ? 2 : 0) | (PIN_read(P30) ? 1 : 0);
    if(ab != enc_prev) {
      enc_acc += QDEC[(enc_prev << 2) | ab];
      enc_prev = ab;
      if(ab == 3 && enc_acc != 0) {                 // back at detent rest
        if(sw_down) {                               // push-turn (second axis)
          sw_rot = 1;
          if(enc_acc > 0) { kbd_tap(10); send_input(10, ACT_PT_CW, 1); }
          else            { kbd_tap(9);  send_input(9,  ACT_PT_CCW, 1); }
        } else {
          if(enc_acc > 0) { kbd_tap(8);  send_input(8, ACT_KNOB_CW, 1); }
          else            { kbd_tap(6);  send_input(6, ACT_KNOB_CCW, 1); }
        }
        enc_acc = 0;
        TOUCH();
      }
    }

    // --- LED engine every 4th pass (~20ms) ---
    tick++;
    if(idle < 0xFFFF) idle++;
    if((tick & 0x03) == 0) {
      for(i = 0; i < 18; i++) tgt[i] = g_rgb[i];    // follow stored/effect base colors
      for(i = 0; i < NPX; i++)
        if(flash[i]) flash[i] = (flash[i] > 20) ? flash[i] - 20 : 0;
      if(ident_ticks) ident_ticks--;
      fade_step();
      render_out();
    }

    DLY_ms(1);
    WDT_reset();
  }
}
