// ===================================================================================
// PadKit — PIN SCANNER firmware (temporary, for wiring discovery)
// ===================================================================================
//
// Purpose
// -------
// 6-key + rotary-knob CH552 "macropad" clones are electrically identical chips
// wired differently from batch to batch: the same key can sit on a different
// GPIO on your board than on someone else's. This throwaway firmware discovers
// YOUR board's wiring so the real firmware can be configured to match.
//
// How it works
// ------------
// It configures every user-accessible SOP16 GPIO as input-with-pullup and,
// whenever a pin is pulled LOW (a key pressed, the knob switch closed, or an
// encoder phase changing as you turn the knob), it types a UNIQUE letter for
// that pin over USB HID. Open any text field, press each of the 6 keys, push
// the knob, and turn the knob both directions — the letters that appear tell
// you exactly which chip pin sits behind each control. Feed that mapping into
// the real firmware's config.h and it becomes self-adapting to your clone.
//
// Letter -> pin:  a=P1.1  b=P1.4  c=P1.5  d=P1.6  e=P1.7
//                 f=P3.0  g=P3.1  h=P3.2  i=P3.3  j=P3.4
//
// These ten pins are the ones broken out to keys/knob on the common CH552G
// 6-key+knob layout. P1.5 also doubles as a boot strap pin, but at runtime it
// reads as an ordinary input, so it is scanned like the rest.
//
// A rotary encoder presents as TWO of these pins (out A / out B) that toggle in
// quadrature as you turn: turning one way makes A lead B, the other way B leads
// A. So the knob shows up as a pair of letters that alternate while turning,
// plus a separate letter for the push switch. Six keys => six letters that each
// appear once per press. Any pin that never emits a letter is unused on your
// board.
//
// This is a diagnostic build: no NeoPixel, no consumer-control, no layers —
// just the raw pin-to-letter map. Flash the real firmware afterwards.
//
// License: CC BY-SA 3.0. Built on Stefan Wagner's (wagiminator) CH552 USB
// MacroPad Mini stack — https://github.com/wagiminator/CH552-USB-Knob
// ===================================================================================

#include <config.h>
#include <system.h>
#include <gpio.h>
#include <delay.h>
#include <usb_conkbd.h>

void USB_interrupt(void);
void USB_ISR(void) __interrupt(INT_NO_USB) {
  USB_interrupt();
}

// Letter reported for each scanned pin (indices match the reads below).
__code uint8_t scan_letter[10] = { 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j' };

// PIN_read is a compile-time macro over a literal pin token, so we can't index
// it at runtime — read each explicitly and fold the results into bytes.
static uint8_t read_lo(void) {
  uint8_t s = 0;
  if(PIN_read(P11)) s |= 0x01;
  if(PIN_read(P14)) s |= 0x02;
  if(PIN_read(P15)) s |= 0x04;
  if(PIN_read(P16)) s |= 0x08;
  if(PIN_read(P17)) s |= 0x10;
  if(PIN_read(P30)) s |= 0x20;
  if(PIN_read(P31)) s |= 0x40;
  if(PIN_read(P32)) s |= 0x80;
  return s;  // bits 0..7 = P11,P14,P15,P16,P17,P30,P31,P32  (letters a..h)
}
static uint8_t read_hi(void) {
  uint8_t s = 0;
  if(PIN_read(P33)) s |= 0x01;
  if(PIN_read(P34)) s |= 0x02;
  return s;  // P33 (letter i), P34 (letter j)
}

void main(void) {
  uint8_t i, lo, hi, prev_lo, prev_hi, bit;

  CLK_config();
  DLY_ms(5);
  KBD_init();
  WDT_start();

  PIN_input_PU(P11); PIN_input_PU(P14); PIN_input_PU(P15); PIN_input_PU(P16);
  PIN_input_PU(P17); PIN_input_PU(P30); PIN_input_PU(P31); PIN_input_PU(P32);
  PIN_input_PU(P33); PIN_input_PU(P34);
  DLY_ms(5);

  // Seed the previous state so a pin that rests low (e.g. an encoder phase at a
  // detent) does not report at power-up — only CHANGES after this are reported.
  prev_lo = read_lo();
  prev_hi = read_hi();

  while(1) {
    lo = read_lo();
    hi = read_hi();

    // Report every high->low transition (a fresh press / phase change).
    for(i = 0; i < 8; i++) {
      bit = 1 << i;
      if(!(lo & bit) && (prev_lo & bit)) KBD_type(scan_letter[i]);
    }
    if(!(hi & 0x01) && (prev_hi & 0x01)) KBD_type(scan_letter[8]);
    if(!(hi & 0x02) && (prev_hi & 0x02)) KBD_type(scan_letter[9]);

    prev_lo = lo;
    prev_hi = hi;

    DLY_ms(8);   // debounce + let USB service
    WDT_reset();
  }
}
