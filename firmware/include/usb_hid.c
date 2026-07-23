// ===================================================================================
// USB HID Functions for CH551, CH552 and CH554
// ===================================================================================
//
// /* PadKit local patch vs wagiminator upstream (CH552 stack)
//  * ---------------------------------------------------------------------------
//  * This file carries PadKit's functional patches to the upstream HID transport.
//  * The matching declarations live in usb_hid.h (also patched).
//  *
//  * PATCH 1 — HID_sendReport(): watchdog-fed busy-wait with a hard bail-out.
//  *   Upstream spins on HID_EP1_writeBusyFlag with a bare `while(...);` loop.
//  *   With the hardware watchdog enabled and a burst of input events, any pause
//  *   in the host's EP1 polling let that loop run past the watchdog period and
//  *   reset the chip mid-use (USB re-enumeration = multi-second outage). The fix
//  *   feeds the watchdog inside the wait, paces it (~50us), and gives up after a
//  *   bounded time (~400ms) by dropping the report instead of hanging forever if
//  *   the host has genuinely stopped listening (suspend/unplug).
//  *
//  * PATCH 2 — composite EP2 vendor transport (NEW in v0.2).
//  *   HID_setup()/HID_reset() now bring EP2 up bidirectionally (IN + OUT) for the
//  *   vendor interface. HID_sendVendor() ships a 32-byte INPUT report from the
//  *   +64 transmit half of the EP2 buffer (same watchdog-fed pacing as PATCH 1).
//  *   HID_EP2_OUT() latches the 32-byte host command for the main loop instead of
//  *   the old inline LED parsing, so DataFlash writes / reply sends stay out of
//  *   the ISR. HID_EP2_IN() clears the vendor TX busy flag.
//  * ---------------------------------------------------------------------------
//  */

#include "ch554.h"
#include "usb.h"
#include "usb_hid.h"
#include "usb_descr.h"
#include "usb_handler.h"
#include "system.h"
#include "delay.h"

// ===================================================================================
// Variables and Defines
// ===================================================================================

volatile __bit HID_EP1_writeBusyFlag = 0;                  // EP1 (keyboard IN) busy
volatile __bit HID_EP2_writeBusyFlag = 0;                  // EP2 (vendor IN) busy

volatile uint8_t HID_cmdPending = 0;                       // main-loop command flag
__xdata uint8_t  HID_cmdBuf[32];                           // latest vendor command

// ===================================================================================
// Front End Functions
// ===================================================================================

// Setup USB HID
void HID_init(void) {
  USB_init();
  UEP1_T_LEN  = 0;
  UEP2_T_LEN  = 0;
}

// Send HID keyboard report (EP1 IN). See PATCH 1.
void HID_sendReport(__xdata uint8_t* buf, uint8_t len) {
  uint8_t i;
  uint16_t guard = 0;
  while(HID_EP1_writeBusyFlag) {
    WDT_reset();
    DLY_us(50);
    if(++guard > 8000) return;                              // ~400ms: give up
  }
  for(i=0; i<len; i++) EP1_buffer[i] = buf[i];             // copy report to EP1 buffer
  UEP1_T_LEN = len;                                        // set length to upload
  HID_EP1_writeBusyFlag = 1;                               // set busy flag
  UEP1_CTRL = UEP1_CTRL & ~MASK_UEP_T_RES | UEP_T_RES_ACK; // upload data and respond ACK
}

// Send a 32-byte vendor INPUT report (EP2 IN). The transmit data lives in the
// upper half (offset EP2_IN_OFFSET) of EP2's bidirectional buffer. Called from
// the main loop (never the ISR). Same watchdog-fed wait + bail-out as PATCH 1.
void HID_sendVendor(__xdata uint8_t* buf) {
  uint8_t i;
  uint16_t guard = 0;
  while(HID_EP2_writeBusyFlag) {
    WDT_reset();
    DLY_us(50);
    if(++guard > 8000) return;                              // ~400ms: give up
  }
  for(i=0; i<32; i++) EP2_buffer[EP2_IN_OFFSET + i] = buf[i];
  UEP2_T_LEN = 32;
  HID_EP2_writeBusyFlag = 1;
  UEP2_CTRL = UEP2_CTRL & ~MASK_UEP_T_RES | UEP_T_RES_ACK;  // upload, respond ACK (TX bits only)
}

// ===================================================================================
// HID-Specific USB Handler Functions
// ===================================================================================

// Setup HID endpoints: EP1 IN (keyboard), EP2 IN+OUT (vendor).
void HID_setup(void) {
  UEP1_DMA    = EP1_ADDR;                   // EP1 data transfer address
  UEP2_DMA    = EP2_ADDR;                   // EP2 data transfer address (OUT low / IN high)
  UEP1_CTRL   = bUEP_AUTO_TOG               // EP1 auto flip
              | UEP_T_RES_NAK;              // EP1 IN returns NAK until armed
  UEP2_CTRL   = bUEP_AUTO_TOG               // EP2 auto flip
              | UEP_T_RES_NAK               // EP2 IN returns NAK until armed
              | UEP_R_RES_ACK;              // EP2 OUT accepts (ACK)
  UEP4_1_MOD  = bUEP1_TX_EN;                // EP1 TX enable
  UEP2_3_MOD  = bUEP2_RX_EN | bUEP2_TX_EN;  // EP2 RX + TX enable (bidirectional)
}

// Reset HID parameters
void HID_reset(void) {
  UEP1_CTRL = bUEP_AUTO_TOG | UEP_T_RES_NAK;
  UEP2_CTRL = bUEP_AUTO_TOG | UEP_T_RES_NAK | UEP_R_RES_ACK;
  HID_EP1_writeBusyFlag = 0;
  HID_EP2_writeBusyFlag = 0;
  HID_cmdPending = 0;
}

// Endpoint 1 IN handler (keyboard report sent to host)
void HID_EP1_IN(void) {
  UEP1_T_LEN = 0;                                           // no data to send anymore
  UEP1_CTRL = UEP1_CTRL & ~MASK_UEP_T_RES | UEP_T_RES_NAK;  // default NAK
  HID_EP1_writeBusyFlag = 0;                                // clear busy flag
}

// Endpoint 2 IN handler (vendor report sent to host)
void HID_EP2_IN(void) {
  UEP2_T_LEN = 0;
  UEP2_CTRL = UEP2_CTRL & ~MASK_UEP_T_RES | UEP_T_RES_NAK;  // re-arm NAK (TX bits only)
  HID_EP2_writeBusyFlag = 0;
}

// Endpoint 2 OUT handler (vendor command received from host). Latch the raw
// 32-byte report for the main loop; do no protocol work in the ISR.
void HID_EP2_OUT(void) {
  uint8_t len = USB_RX_LEN;
  uint8_t i;
  if(len > 32) len = 32;
  for(i = 0; i < len; i++) HID_cmdBuf[i] = EP2_buffer[i];   // OUT data in low half
  for(; i < 32; i++)       HID_cmdBuf[i] = 0;               // zero-pad short writes
  HID_cmdPending = 1;
}
