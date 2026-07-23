// ===================================================================================
// PadKit DataFlash (persistent config) helper for CH552 — implementation
// ===================================================================================
//
// /* PadKit local addition (not part of the wagiminator upstream stack)
//  * ---------------------------------------------------------------------------
//  * CH552 DataFlash access via the on-chip ISP path (CH552 datasheet, "Data
//  * Flash" section):
//  *   - ROM_ADDR points into DATA_FLASH_ADDR (0xC000). The 128 user bytes sit at
//  *     even ROM addresses, so a byte index is applied as (addr << 1) — the same
//  *     mapping the WCH SDK / ch55xduino use, proven on CH552 hardware.
//  *   - Writing requires unlocking the flash in "safe mode": the paired
//  *     SAFE_MOD = 0x55; 0xAA sequence, then set bDATA_WE in GLOBAL_CFG, perform
//  *     the ROM_CMD_WRITE, and re-lock.
//  * Interrupts are disabled around each write so a USB IRQ can't disturb the ISP
//  * state machine. Reads are non-destructive and need no unlock.
//  *
//  * HARDWARE-UNVERIFIED: the byte-mapping and safe-mode unlock are per datasheet
//  * and match known-good SDKs, but this build was not flashed/tested on silicon.
//  * ---------------------------------------------------------------------------
//  */

#include "ch554.h"
#include "dataflash.h"

uint8_t DF_read(uint8_t addr) {
  ROM_ADDR_H = (uint8_t)(DATA_FLASH_ADDR >> 8);   // 0xC0
  ROM_ADDR_L = (uint8_t)(addr << 1);              // byte index -> even ROM address
  ROM_CTRL   = ROM_CMD_READ;
  return ROM_DATA_L;
}

void DF_write(uint8_t addr, uint8_t dat) {
  EA = 0;                                         // no IRQs during the ISP sequence
  SAFE_MOD = 0x55; SAFE_MOD = 0xAA;               // enter safe mode
  GLOBAL_CFG |= bDATA_WE;                          // enable DataFlash program/erase
  SAFE_MOD = 0;                                   // leave safe mode (config latched)

  ROM_ADDR_H = (uint8_t)(DATA_FLASH_ADDR >> 8);
  ROM_ADDR_L = (uint8_t)(addr << 1);
  ROM_DATA_L = dat;
  if(ROM_STATUS & bROM_ADDR_OK)                    // address valid -> commit
    ROM_CTRL = ROM_CMD_WRITE;

  SAFE_MOD = 0x55; SAFE_MOD = 0xAA;               // enter safe mode
  GLOBAL_CFG &= ~bDATA_WE;                          // re-lock DataFlash
  SAFE_MOD = 0;
  EA = 1;                                         // restore interrupts
}
