// SPDX-License-Identifier: MIT
//
// Package protocol implements the host side of the PadKit v0.2 vendor-HID wire
// protocol (docs/protocol-v2.md, FROZEN). It provides builders for the 32-byte
// output reports (host -> device) and a parser for the 32-byte input reports
// (device -> host). Nothing here talks to a real device; it is pure byte
// manipulation and is fully unit-testable.
package protocol

import "fmt"

// ReportSize is the fixed payload size of every vendor report, in bytes.
// (Report ID 0 is handled by the HID transport layer, not counted here.)
const ReportSize = 32

// Default USB identity of a PadKit v0.2 device and the vendor collection to
// open. The host MUST select the collection whose usage page is VendorUsagePage
// -- never the keyboard collection (matters on Windows).
const (
	DefaultVendorID  = 0x1189
	DefaultProductID = 0x8890
	VendorUsagePage  = 0xFF60
	VendorUsage      = 0x61
)

// Output command codes (byte[0] of a host -> device report). See spec section 3.
const (
	CmdSetRGB        = 0x01
	CmdSetBrightness = 0x02
	CmdSetEffect     = 0x03
	CmdSetKey        = 0x04
	CmdSetFlags      = 0x05
	CmdSave          = 0x06
	CmdLoadDefaults  = 0x07
	CmdGetConfig     = 0x08
	CmdGetInfo       = 0x09
	CmdIdentify      = 0x0A
	CmdSetIdleDim    = 0x0B
)

// Effect ids for CmdSetEffect. See spec section 4.
const (
	EffectStatic  = 0
	EffectBreathe = 1
	EffectRainbow = 2
	EffectReactive = 3
	EffectScanner = 4
)

// Config flag bits for CmdSetFlags. See spec section 5.
const (
	FlagSuppressKeyboard = 1 << 0
	FlagIdleDimOn        = 1 << 1
)

// Input report type codes (byte[0] of a device -> host report). See spec section 6.
const (
	TypeInputEvent = 0x81
	TypeConfigDump = 0x82
	TypeFWInfo     = 0x83
	TypeACK        = 0x84
)

// INPUT_EVENT action codes (byte[2] of a 0x81 report). See spec section 6.
const (
	ActionKeyDown    = 0x01
	ActionKeyUp      = 0x02
	ActionKnobCW     = 0x10
	ActionKnobCCW    = 0x11
	ActionKnobClick  = 0x12
	ActionPushTurnCW = 0x20
	ActionPushTurnCCW = 0x21
)

// Control slot ids. See spec section 7.
const (
	SlotKey1        = 0
	SlotKey2        = 1
	SlotKey3        = 2
	SlotKey4        = 3
	SlotKey5        = 4
	SlotKey6        = 5
	SlotKnobCCW     = 6
	SlotKnobClick   = 7
	SlotKnobCW      = 8
	SlotPushTurnCCW = 9
	SlotPushTurnCW  = 10

	NumKeys  = 6
	NumLEDs  = 6
	NumSlots = 11
)

// RGB is a single LED color.
type RGB struct{ R, G, B byte }

// blank returns a zeroed 32-byte report with byte[0] set to cmd.
func blank(cmd byte) []byte {
	b := make([]byte, ReportSize)
	b[0] = cmd
	return b
}

// SetRGB builds a SET_RGB report: 6 per-key colors in slot order 0..5.
func SetRGB(colors [NumLEDs]RGB) []byte {
	b := blank(CmdSetRGB)
	for i, c := range colors {
		b[1+i*3] = c.R
		b[2+i*3] = c.G
		b[3+i*3] = c.B
	}
	return b
}

// SetBrightness builds a SET_BRIGHTNESS report (0..255 global scale).
func SetBrightness(level byte) []byte {
	b := blank(CmdSetBrightness)
	b[1] = level
	return b
}

// SetEffect builds a SET_EFFECT report. params are copied into bytes [2..].
func SetEffect(id byte, params ...byte) []byte {
	b := blank(CmdSetEffect)
	b[1] = id
	for i, p := range params {
		if 2+i >= ReportSize {
			break
		}
		b[2+i] = p
	}
	return b
}

// SetKey builds a SET_KEY report remapping one control's emitted keystroke.
func SetKey(slot, modifier, keycode byte) []byte {
	b := blank(CmdSetKey)
	b[1] = slot
	b[2] = modifier
	b[3] = keycode
	return b
}

// SetFlags builds a SET_FLAGS report.
func SetFlags(flags byte) []byte {
	b := blank(CmdSetFlags)
	b[1] = flags
	return b
}

// Save builds a SAVE report (commit RAM config to DataFlash).
func Save() []byte { return blank(CmdSave) }

// LoadDefaults builds a LOAD_DEFAULTS report.
func LoadDefaults() []byte { return blank(CmdLoadDefaults) }

// GetConfig builds a GET_CONFIG request.
func GetConfig() []byte { return blank(CmdGetConfig) }

// GetInfo builds a GET_INFO request.
func GetInfo() []byte { return blank(CmdGetInfo) }

// Identify builds an IDENTIFY report (blink one key white ~500ms).
func Identify(slot byte) []byte {
	b := blank(CmdIdentify)
	b[1] = slot
	return b
}

// SetIdleDim builds a SET_IDLE_DIM report. timeoutMS is stored as ms/100 (LE).
func SetIdleDim(enable bool, timeoutMS uint16) []byte {
	b := blank(CmdSetIdleDim)
	if enable {
		b[1] = 1
	}
	ticks := timeoutMS / 100
	b[2] = byte(ticks & 0xFF)
	b[3] = byte(ticks >> 8)
	return b
}

// InputEvent is a decoded 0x81 report.
type InputEvent struct {
	Control int // slot id, section 7
	Action  int // action code, section 6
	Value   int
}

// FWInfo is a decoded 0x83 report.
type FWInfo struct {
	FirmwareMajor, FirmwareMinor byte
	ProtocolMajor, ProtocolMinor byte
	Capabilities                 uint32
	KeyCount, LEDCount           byte
}

// HasCapability reports whether a capability bit (see spec section 6) is set.
func (f FWInfo) HasCapability(bit uint) bool { return f.Capabilities&(1<<bit) != 0 }

// ACK is a decoded 0x84 report.
type ACK struct {
	Cmd    byte
	Status byte
}

// ConfigDump is a decoded 0x82 report.
type ConfigDump struct {
	Brightness byte
	Effect     byte
	Flags      byte
	Defaults   [NumLEDs]RGB
}

// ParsedType identifies which kind of input report was decoded.
type ParsedType int

const (
	ParsedUnknown ParsedType = iota
	ParsedInputEvent
	ParsedConfigDump
	ParsedFWInfo
	ParsedACK
)

// Parsed is a tagged union of the possible decoded input reports.
type Parsed struct {
	Type       ParsedType
	InputEvent InputEvent
	ConfigDump ConfigDump
	FWInfo     FWInfo
	ACK        ACK
}

// ParseInput decodes a raw device -> host report. It tolerates buffers longer
// than ReportSize (extra trailing bytes are ignored) and returns an error only
// when the buffer is too short to contain a type code + minimal payload.
func ParseInput(buf []byte) (Parsed, error) {
	if len(buf) == 0 {
		return Parsed{}, fmt.Errorf("empty report")
	}
	switch buf[0] {
	case TypeInputEvent:
		if len(buf) < 4 {
			return Parsed{}, fmt.Errorf("short INPUT_EVENT report (%d bytes)", len(buf))
		}
		return Parsed{
			Type: ParsedInputEvent,
			InputEvent: InputEvent{
				Control: int(buf[1]),
				Action:  int(buf[2]),
				Value:   int(buf[3]),
			},
		}, nil
	case TypeConfigDump:
		if len(buf) < 22 {
			return Parsed{}, fmt.Errorf("short CONFIG_DUMP report (%d bytes)", len(buf))
		}
		var cd ConfigDump
		cd.Brightness = buf[1]
		cd.Effect = buf[2]
		cd.Flags = buf[3]
		for i := 0; i < NumLEDs; i++ {
			cd.Defaults[i] = RGB{buf[4+i*3], buf[5+i*3], buf[6+i*3]}
		}
		return Parsed{Type: ParsedConfigDump, ConfigDump: cd}, nil
	case TypeFWInfo:
		if len(buf) < 11 {
			return Parsed{}, fmt.Errorf("short FW_INFO report (%d bytes)", len(buf))
		}
		return Parsed{
			Type: ParsedFWInfo,
			FWInfo: FWInfo{
				FirmwareMajor: buf[1],
				FirmwareMinor: buf[2],
				ProtocolMajor: buf[3],
				ProtocolMinor: buf[4],
				Capabilities:  uint32(buf[5]) | uint32(buf[6])<<8 | uint32(buf[7])<<16 | uint32(buf[8])<<24,
				KeyCount:      buf[9],
				LEDCount:      buf[10],
			},
		}, nil
	case TypeACK:
		if len(buf) < 3 {
			return Parsed{}, fmt.Errorf("short ACK report (%d bytes)", len(buf))
		}
		return Parsed{Type: ParsedACK, ACK: ACK{Cmd: buf[1], Status: buf[2]}}, nil
	default:
		return Parsed{Type: ParsedUnknown}, fmt.Errorf("unknown report type 0x%02X", buf[0])
	}
}
