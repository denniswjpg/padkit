// ===================================================================================
// PadKit — user configuration (CH552G 6-key + rotary-knob macropad)
// ===================================================================================
// Editable build-time config for the vendored CH552 stack. The NeoPixel pin, the
// USB VID/PID and the descriptor strings are read from here; padkit.c drives the
// full 6-key + encoder pin set directly (see its PIN_input_PU calls), so only
// PIN_NEO below is consumed by the runtime.
//
// NOTE: VID/PID 0x1189/0x8890 match the stock board this baseline was proven on.
// Change them if you assign the pad its own identifiers.

#pragma once

// Pin definitions
#define PIN_NEO             P34         // pin connected to NeoPixel data-in
#define PIN_KEY1            P11         // pin connected to key 1
#define PIN_KEY2            P17         // pin connected to key 2
#define PIN_KEY3            P16         // pin connected to key 3
#define PIN_ENC_SW          P33         // pin connected to knob switch
#define PIN_ENC_A           P31         // pin connected to knob outA
#define PIN_ENC_B           P30         // pin connected to knob outB

// NeoPixel configuration
#define NEO_GRB                         // type of pixel: NEO_GRB or NEO_RGB

// USB device descriptor
#define USB_VENDOR_ID       0x1189      // VID
#define USB_PRODUCT_ID      0x8890      // PID
#define USB_DEVICE_VERSION  0x0200      // v2.0 (BCD-format) — composite HID

// USB configuration descriptor
#define USB_MAX_POWER_mA    50          // max power in mA

// USB descriptor strings
#define MANUFACTURER_STR    'w','a','g','i','m','i','n','a','t','o','r'
#define PRODUCT_STR         'P','a','d','K','i','t'
#define SERIAL_STR          'C','H','5','5','2','x','H','I','D'
#define INTERFACE_STR       'H','I','D','-','K','e','y','b','o','a','r','d'
#define INTERFACE_STR2      'P','a','d','K','i','t',' ','C','o','n','f','i','g'
