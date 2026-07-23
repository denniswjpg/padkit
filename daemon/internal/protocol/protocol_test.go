// SPDX-License-Identifier: MIT

package protocol

import "testing"

func TestParseInputEvent(t *testing.T) {
	buf := make([]byte, ReportSize)
	buf[0] = TypeInputEvent
	buf[1] = SlotKey4
	buf[2] = ActionKeyDown
	buf[3] = 0x00
	p, err := ParseInput(buf)
	if err != nil {
		t.Fatal(err)
	}
	if p.Type != ParsedInputEvent {
		t.Fatalf("wrong type %v", p.Type)
	}
	if p.InputEvent.Control != SlotKey4 || p.InputEvent.Action != ActionKeyDown {
		t.Fatalf("bad decode: %+v", p.InputEvent)
	}
}

func TestParseInputToleratesLongBuffer(t *testing.T) {
	// hid_read may return more bytes than the logical report; extras ignored.
	buf := make([]byte, 64)
	buf[0] = TypeInputEvent
	buf[1] = SlotKnobCW
	buf[2] = ActionKnobCW
	p, err := ParseInput(buf)
	if err != nil || p.InputEvent.Control != SlotKnobCW || p.InputEvent.Action != ActionKnobCW {
		t.Fatalf("long-buffer decode failed: %+v err=%v", p, err)
	}
}

func TestParseFWInfoCapabilities(t *testing.T) {
	buf := make([]byte, ReportSize)
	buf[0] = TypeFWInfo
	buf[1], buf[2] = 0, 2 // fw 0.2
	buf[3], buf[4] = 2, 0 // proto 2.0
	buf[5] = 0b00010101   // caps bits 0,2,4
	buf[9], buf[10] = 6, 6
	p, err := ParseInput(buf)
	if err != nil {
		t.Fatal(err)
	}
	fw := p.FWInfo
	if !fw.HasCapability(0) || !fw.HasCapability(2) || !fw.HasCapability(4) {
		t.Fatalf("expected caps 0,2,4 set: %#x", fw.Capabilities)
	}
	if fw.HasCapability(1) || fw.HasCapability(3) {
		t.Fatalf("caps 1,3 should be clear: %#x", fw.Capabilities)
	}
	if fw.KeyCount != 6 || fw.LEDCount != 6 {
		t.Fatalf("bad counts %d/%d", fw.KeyCount, fw.LEDCount)
	}
}

func TestParseErrors(t *testing.T) {
	if _, err := ParseInput(nil); err == nil {
		t.Fatal("expected error on empty")
	}
	if _, err := ParseInput([]byte{0x81, 0x00}); err == nil {
		t.Fatal("expected error on short INPUT_EVENT")
	}
	if _, err := ParseInput([]byte{0x99}); err == nil {
		t.Fatal("expected error on unknown type")
	}
}

func TestSetRGBLayout(t *testing.T) {
	var colors [NumLEDs]RGB
	colors[0] = RGB{1, 2, 3}
	colors[5] = RGB{10, 20, 30}
	b := SetRGB(colors)
	if len(b) != ReportSize {
		t.Fatalf("report size %d", len(b))
	}
	if b[0] != CmdSetRGB {
		t.Fatalf("cmd %#x", b[0])
	}
	if b[1] != 1 || b[2] != 2 || b[3] != 3 {
		t.Fatalf("key0 rgb wrong: %v", b[1:4])
	}
	// key5 occupies bytes [16..18]
	if b[16] != 10 || b[17] != 20 || b[18] != 30 {
		t.Fatalf("key5 rgb wrong: %v", b[16:19])
	}
}

func TestSetIdleDimTicks(t *testing.T) {
	b := SetIdleDim(true, 3000) // 3000ms -> 30 ticks
	if b[0] != CmdSetIdleDim || b[1] != 1 || b[2] != 30 || b[3] != 0 {
		t.Fatalf("idle dim encode wrong: %v", b[:4])
	}
}
