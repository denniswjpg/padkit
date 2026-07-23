// ===================================================================================
// USB Descriptors — PadKit v0.2 composite HID
// ===================================================================================
//
// /* PadKit local patch vs wagiminator upstream (CH552 stack)
//  * ---------------------------------------------------------------------------
//  * Upstream shipped a SINGLE HID interface that carried the keyboard, a consumer
//  * collection AND a vendor collection (usage page 0xFF00) together. That layout
//  * is exactly what Chromium/WebHID and Windows block, because they gate HID
//  * access per top-level collection and a vendor collection *inside* a keyboard
//  * interface is still reached through the (blocked) keyboard device path.
//  *
//  * PadKit v0.2 splits this into a proper COMPOSITE device:
//  *   IF0 — boot keyboard (EP1 IN), usage page 0x01 / usage 0x06
//  *   IF1 — vendor raw-HID (EP2 IN + EP2 OUT), usage page 0xFF60 / usage 0x61
//  *         (the QMK "raw-HID" values), one 32-byte IN + one 32-byte OUT, no
//  *         report IDs. WebHID and native hidapi can fully read/write IF1 on
//  *         macOS, Windows and Linux by selecting the 0xFF60 collection.
//  * See docs/protocol-v2.md for the wire protocol IF1 carries.
//  * ---------------------------------------------------------------------------
//  */

#include "config.h"
#include "usb_descr.h"

// ===================================================================================
// Device Descriptor
// ===================================================================================
__code USB_DEV_DESCR DevDescr = {
  .bLength            = sizeof(DevDescr),       // size of the descriptor in bytes: 18
  .bDescriptorType    = USB_DESCR_TYP_DEVICE,   // device descriptor: 0x01
  .bcdUSB             = 0x0110,                 // USB specification: USB 1.1
  .bDeviceClass       = 0,                      // interface will define class
  .bDeviceSubClass    = 0,                      // unused
  .bDeviceProtocol    = 0,                      // unused
  .bMaxPacketSize0    = EP0_SIZE,               // maximum packet size for Endpoint 0
  .idVendor           = USB_VENDOR_ID,          // VID
  .idProduct          = USB_PRODUCT_ID,         // PID
  .bcdDevice          = USB_DEVICE_VERSION,     // device version
  .iManufacturer      = 1,                      // index of Manufacturer String Descr
  .iProduct           = 2,                      // index of Product String Descriptor
  .iSerialNumber      = 3,                      // index of Serial Number String Descr
  .bNumConfigurations = 1                       // number of possible configurations
};

// ===================================================================================
// Configuration Descriptor  (2 interfaces)
// ===================================================================================
// wTotalLength / bNumInterfaces are computed from the struct so they stay correct.
__code USB_CFG_DESCR_HID CfgDescr = {

  // Configuration Descriptor
  .config = {
    .bLength            = sizeof(USB_CFG_DESCR),  // 9
    .bDescriptorType    = USB_DESCR_TYP_CONFIG,   // 0x02
    .wTotalLength       = sizeof(CfgDescr),       // 66 bytes (see sanity check in README)
    .bNumInterfaces     = 2,                      // IF0 keyboard + IF1 vendor
    .bConfigurationValue= 1,
    .iConfiguration     = 0,
    .bmAttributes       = 0x80,                   // bus powered, no remote wakeup
    .MaxPower           = USB_MAX_POWER_mA / 2    // in 2mA units
  },

  // -------- IF0: boot keyboard --------
  .interface0 = {
    .bLength            = sizeof(USB_ITF_DESCR),  // 9
    .bDescriptorType    = USB_DESCR_TYP_INTERF,   // 0x04
    .bInterfaceNumber   = 0,
    .bAlternateSetting  = 0,
    .bNumEndpoints      = 1,                      // EP1 IN only
    .bInterfaceClass    = USB_DEV_CLASS_HID,      // 0x03
    .bInterfaceSubClass = 1,                      // boot interface
    .bInterfaceProtocol = 1,                      // keyboard
    .iInterface         = 4
  },
  .hid0 = {
    .bLength            = sizeof(USB_HID_DESCR),  // 9
    .bDescriptorType    = USB_DESCR_TYP_HID,      // 0x21
    .bcdHID             = 0x0110,
    .bCountryCode       = 33,                     // US
    .bNumDescriptors    = 1,
    .bDescriptorTypeX   = 34,                     // report descriptor
    .wDescriptorLength  = sizeof(KbdReportDescr)
  },
  .ep1IN = {
    .bLength            = sizeof(USB_ENDP_DESCR), // 7
    .bDescriptorType    = USB_DESCR_TYP_ENDP,     // 0x05
    .bEndpointAddress   = USB_ENDP_ADDR_EP1_IN,   // 0x81
    .bmAttributes       = USB_ENDP_TYPE_INTER,    // interrupt
    .wMaxPacketSize     = EP1_SIZE,
    .bInterval          = 10
  },

  // -------- IF1: vendor raw-HID --------
  .interface1 = {
    .bLength            = sizeof(USB_ITF_DESCR),  // 9
    .bDescriptorType    = USB_DESCR_TYP_INTERF,
    .bInterfaceNumber   = 1,
    .bAlternateSetting  = 0,
    .bNumEndpoints      = 2,                      // EP2 IN + EP2 OUT
    .bInterfaceClass    = USB_DEV_CLASS_HID,      // 0x03
    .bInterfaceSubClass = 0,                      // not a boot interface
    .bInterfaceProtocol = 0,
    .iInterface         = 5
  },
  .hid1 = {
    .bLength            = sizeof(USB_HID_DESCR),
    .bDescriptorType    = USB_DESCR_TYP_HID,
    .bcdHID             = 0x0110,
    .bCountryCode       = 0,
    .bNumDescriptors    = 1,
    .bDescriptorTypeX   = 34,                     // report descriptor
    .wDescriptorLength  = sizeof(VendorReportDescr)
  },
  .ep2IN = {
    .bLength            = sizeof(USB_ENDP_DESCR),
    .bDescriptorType    = USB_DESCR_TYP_ENDP,
    .bEndpointAddress   = USB_ENDP_ADDR_EP2_IN,   // 0x82
    .bmAttributes       = USB_ENDP_TYPE_INTER,
    .wMaxPacketSize     = EP2_SIZE,               // 32
    .bInterval          = 1                       // poll fast for input mirror
  },
  .ep2OUT = {
    .bLength            = sizeof(USB_ENDP_DESCR),
    .bDescriptorType    = USB_DESCR_TYP_ENDP,
    .bEndpointAddress   = USB_ENDP_ADDR_EP2_OUT,  // 0x02
    .bmAttributes       = USB_ENDP_TYPE_INTER,
    .wMaxPacketSize     = EP2_SIZE,               // 32
    .bInterval          = 1
  }
};

// ===================================================================================
// IF0 — HID Report Descriptor: boot keyboard (emits F13..F23)
// ===================================================================================
// Report ID 1, 8-byte boot-compatible payload (modifier + reserved + 6 keycodes),
// matching the KBD_report layout in usb_conkbd.c. No LED-output collection: v0.2
// no longer uses keyboard-LED bits as a control channel (that moved to IF1).
__code uint8_t KbdReportDescr[] = {
    0x05, 0x01,                    // USAGE_PAGE (Generic Desktop)
    0x09, 0x06,                    // USAGE (Keyboard)
    0xa1, 0x01,                    // COLLECTION (Application)
    0x85, 0x01,                    //   REPORT_ID (1)
    0x05, 0x07,                    //   USAGE_PAGE (Keyboard)
    0x19, 0xe0,                    //   USAGE_MINIMUM (Keyboard LeftControl)
    0x29, 0xe7,                    //   USAGE_MAXIMUM (Keyboard Right GUI)
    0x15, 0x00,                    //   LOGICAL_MINIMUM (0)
    0x25, 0x01,                    //   LOGICAL_MAXIMUM (1)
    0x95, 0x08,                    //   REPORT_COUNT (8)
    0x75, 0x01,                    //   REPORT_SIZE (1)
    0x81, 0x02,                    //   INPUT (Data,Var,Abs)   -- modifier byte
    0x95, 0x01,                    //   REPORT_COUNT (1)
    0x75, 0x08,                    //   REPORT_SIZE (8)
    0x81, 0x03,                    //   INPUT (Cnst,Var,Abs)   -- reserved byte
    0x95, 0x06,                    //   REPORT_COUNT (6)
    0x75, 0x08,                    //   REPORT_SIZE (8)
    0x15, 0x00,                    //   LOGICAL_MINIMUM (0)
    0x26, 0xff, 0x00,              //   LOGICAL_MAXIMUM (255)
    0x05, 0x07,                    //   USAGE_PAGE (Keyboard)
    0x19, 0x00,                    //   USAGE_MINIMUM (0)
    0x29, 0xe7,                    //   USAGE_MAXIMUM (Keyboard Right GUI)
    0x81, 0x00,                    //   INPUT (Data,Ary,Abs)   -- 6 keycodes
    0xc0                           // END_COLLECTION
};
__code uint8_t KbdReportDescrLen = sizeof(KbdReportDescr);

// ===================================================================================
// IF1 — HID Report Descriptor: vendor raw-HID (QMK-style, usage page 0xFF60)
// ===================================================================================
// One 32-byte Input report (device->host) and one 32-byte Output report
// (host->device), NO report IDs. Host selects this collection by usage page
// 0xFF60 (never "the first HID path"). See docs/protocol-v2.md.
__code uint8_t VendorReportDescr[] = {
    0x06, 0x60, 0xff,              // USAGE_PAGE (Vendor Defined 0xFF60)
    0x09, 0x61,                    // USAGE (0x61)
    0xa1, 0x01,                    // COLLECTION (Application)
    0x09, 0x62,                    //   USAGE (0x62) — data in
    0x15, 0x00,                    //   LOGICAL_MINIMUM (0)
    0x26, 0xff, 0x00,              //   LOGICAL_MAXIMUM (255)
    0x95, 0x20,                    //   REPORT_COUNT (32)
    0x75, 0x08,                    //   REPORT_SIZE (8)
    0x81, 0x02,                    //   INPUT (Data,Var,Abs)
    0x09, 0x63,                    //   USAGE (0x63) — data out
    0x15, 0x00,                    //   LOGICAL_MINIMUM (0)
    0x26, 0xff, 0x00,              //   LOGICAL_MAXIMUM (255)
    0x95, 0x20,                    //   REPORT_COUNT (32)
    0x75, 0x08,                    //   REPORT_SIZE (8)
    0x91, 0x02,                    //   OUTPUT (Data,Var,Abs)
    0xc0                           // END_COLLECTION
};
__code uint8_t VendorReportDescrLen = sizeof(VendorReportDescr);

// ===================================================================================
// String Descriptors
// ===================================================================================

// Language Descriptor (Index 0)
__code uint16_t LangDescr[] = {
  ((uint16_t)USB_DESCR_TYP_STRING << 8) | sizeof(LangDescr), 0x0409 };  // US English

// Manufacturer String Descriptor (Index 1)
__code uint16_t ManufDescr[] = {
  ((uint16_t)USB_DESCR_TYP_STRING << 8) | sizeof(ManufDescr), MANUFACTURER_STR };

// Product String Descriptor (Index 2)
__code uint16_t ProdDescr[] = {
  ((uint16_t)USB_DESCR_TYP_STRING << 8) | sizeof(ProdDescr), PRODUCT_STR };

// Serial String Descriptor (Index 3)
__code uint16_t SerDescr[] = {
  ((uint16_t)USB_DESCR_TYP_STRING << 8) | sizeof(SerDescr), SERIAL_STR };

// Interface String Descriptor — IF0 keyboard (Index 4)
__code uint16_t InterfDescr[] = {
  ((uint16_t)USB_DESCR_TYP_STRING << 8) | sizeof(InterfDescr), INTERFACE_STR };

// Interface String Descriptor — IF1 vendor (Index 5)
__code uint16_t Interf2Descr[] = {
  ((uint16_t)USB_DESCR_TYP_STRING << 8) | sizeof(Interf2Descr), INTERFACE_STR2 };
