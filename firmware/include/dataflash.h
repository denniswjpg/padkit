// ===================================================================================
// PadKit DataFlash (persistent config) helper for CH552
// ===================================================================================
//
// /* PadKit local addition (not part of the wagiminator upstream stack)
//  * ---------------------------------------------------------------------------
//  * The vendored wagiminator CH552 stack ships no DataFlash driver, so PadKit
//  * adds one here per the CH552 datasheet ISP method (safe-mode unlock +
//  * ROM_CTRL byte read/write against DATA_FLASH_ADDR). Used to persist the v0.2
//  * config (brightness/effect/flags/idle/RGB/keymap). Byte-addressed 0..127.
//  *
//  * HARDWARE-UNVERIFIED: written to spec, not exercised on silicon in this build.
//  * A bad/blank DataFlash must never brick boot — the caller validates a magic
//  * and falls back to factory defaults (see padkit.c cfg_load).
//  * ---------------------------------------------------------------------------
//  */
#pragma once
#include <stdint.h>

// Read one config byte (addr 0..127) from DataFlash.
uint8_t DF_read(uint8_t addr);

// Write one config byte (addr 0..127) to DataFlash. Disables interrupts around
// the flash operation; feed the watchdog between calls when writing many bytes.
void DF_write(uint8_t addr, uint8_t dat);
