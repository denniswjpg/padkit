// ===================================================================================
// USB Descriptors and Definitions
// ===================================================================================
//
// Definition of USB descriptors and endpoint sizes and addresses.
//
// The following must be defined in config.h:
// USB_VENDOR_ID            - Vendor ID (16-bit word)
// USB_PRODUCT_ID           - Product ID (16-bit word)
// USB_DEVICE_VERSION       - Device version (16-bit BCD)
// USB_MAX_POWER_mA         - Device max power in mA
// HID_COUNTRY_CODE         - Country Code
// All string descriptors.

#pragma once
#include <stdint.h>
#include "usb.h"

// ===================================================================================
// USB Endpoint Addresses and Sizes
// ===================================================================================
// v0.2 composite HID:
//   EP0  control            (64-byte buffer, bidirectional, shared)
//   EP1  IN  keyboard       (IF0) — 16-byte max packet, 9-byte boot-kbd report
//   EP2  IN + OUT vendor    (IF1) — 32-byte raw-HID reports (host<->device)
//
// A CH55x endpoint used in BOTH directions places the OUT (receive) data at
// UEPn_DMA[0..63] and the IN (transmit) data at UEPn_DMA[64..127]; the transmit
// engine reads from a fixed +64 offset. So EP2 needs a 128-byte buffer and the
// vendor IN report is staged at EP2_IN_OFFSET. This mirrors the proven WCH /
// ch55xduino bidirectional-endpoint layout. See usb_hid.c (HID_sendVendor).
#define EP0_SIZE        64
#define EP1_SIZE        16
#define EP2_SIZE        32              // vendor report size (32 bytes, no report ID)

#define EP2_IN_OFFSET   64              // TX half of the bidirectional EP2 buffer

#define EP0_ADDR        0
#define EP1_ADDR        (EP0_ADDR + EP0_BUF_SIZE)
#define EP2_ADDR        (EP1_ADDR + EP1_BUF_SIZE)

#define EP_BUF_SIZE(x)  (x+2<64 ? x+2 : 64)

#define EP0_BUF_SIZE    EP_BUF_SIZE(EP0_SIZE)
#define EP1_BUF_SIZE    EP_BUF_SIZE(EP1_SIZE)
#define EP2_BUF_SIZE    128             // OUT [0..63] + IN [64..127]

// ===================================================================================
// Device and Configuration Descriptors
// ===================================================================================
// Composite HID: IF0 keyboard (EP1 IN) + IF1 vendor raw-HID (EP2 IN + EP2 OUT).
typedef struct _USB_CFG_DESCR_HID {
  USB_CFG_DESCR  config;
  // IF0 — boot keyboard
  USB_ITF_DESCR  interface0;
  USB_HID_DESCR  hid0;
  USB_ENDP_DESCR ep1IN;
  // IF1 — vendor raw-HID (WebHID / hidapi), usage page 0xFF60 / usage 0x61
  USB_ITF_DESCR  interface1;
  USB_HID_DESCR  hid1;
  USB_ENDP_DESCR ep2IN;
  USB_ENDP_DESCR ep2OUT;
} USB_CFG_DESCR_HID, *PUSB_CFG_DESCR_HID;
typedef USB_CFG_DESCR_HID __xdata *PXUSB_CFG_DESCR_HID;

extern __code USB_DEV_DESCR DevDescr;
extern __code USB_CFG_DESCR_HID CfgDescr;

// ===================================================================================
// HID Report Descriptors (one per interface)
// ===================================================================================
extern __code uint8_t KbdReportDescr[];       // IF0 boot keyboard
extern __code uint8_t KbdReportDescrLen;
extern __code uint8_t VendorReportDescr[];     // IF1 vendor raw-HID (0xFF60/0x61)
extern __code uint8_t VendorReportDescrLen;

// Report descriptor requests are dispatched by interface number in usb_handler.c.
#define USB_REPORT_DESCR      KbdReportDescr
#define USB_REPORT_DESCR_LEN  KbdReportDescrLen

// ===================================================================================
// String Descriptors
// ===================================================================================
extern __code uint16_t LangDescr[];
extern __code uint16_t ManufDescr[];
extern __code uint16_t ProdDescr[];
extern __code uint16_t SerDescr[];
extern __code uint16_t InterfDescr[];
extern __code uint16_t Interf2Descr[];

#define USB_STR_DESCR_i0    (uint8_t*)LangDescr
#define USB_STR_DESCR_i1    (uint8_t*)ManufDescr
#define USB_STR_DESCR_i2    (uint8_t*)ProdDescr
#define USB_STR_DESCR_i3    (uint8_t*)SerDescr
#define USB_STR_DESCR_i4    (uint8_t*)InterfDescr
#define USB_STR_DESCR_i5    (uint8_t*)Interf2Descr
#define USB_STR_DESCR_ix    (uint8_t*)SerDescr
