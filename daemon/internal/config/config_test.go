// SPDX-License-Identifier: MIT

package config

import (
	"testing"

	"github.com/padkit/padkit-daemon/internal/protocol"
)

func TestParseTapHoldAndBareBindings(t *testing.T) {
	yaml := `
bindings:
  key1:
    tap:  { type: shell, command: "echo tap" }
    hold: { type: webhook, url: "http://x/y", method: POST }
  knob_cw:
    type: led
    led: { brightness: 200 }
`
	cfg, err := Parse([]byte(yaml))
	if err != nil {
		t.Fatal(err)
	}
	// key1 tap -> shell, hold -> webhook
	if a := cfg.Resolve(protocol.SlotKey1, false); a == nil || a.Type != "shell" {
		t.Fatalf("key1 tap should be shell, got %+v", a)
	}
	if a := cfg.Resolve(protocol.SlotKey1, true); a == nil || a.Type != "webhook" {
		t.Fatalf("key1 hold should be webhook, got %+v", a)
	}
	// momentary knob -> bare led action (hold flag ignored)
	if a := cfg.Resolve(protocol.SlotKnobCW, false); a == nil || a.Type != "led" {
		t.Fatalf("knob_cw should be led, got %+v", a)
	}
	if a := cfg.Resolve(protocol.SlotKnobCW, true); a == nil || a.Type != "led" {
		t.Fatalf("knob_cw ignores hold, got %+v", a)
	}
}

func TestKeyBareActionIsTap(t *testing.T) {
	cfg, err := Parse([]byte(`
bindings:
  key2:
    type: shell
    command: "echo hi"
`))
	if err != nil {
		t.Fatal(err)
	}
	if a := cfg.Resolve(protocol.SlotKey2, false); a == nil || a.Type != "shell" {
		t.Fatalf("bare key action should resolve on tap, got %+v", a)
	}
	if a := cfg.Resolve(protocol.SlotKey2, true); a != nil {
		t.Fatalf("no hold binding -> nil, got %+v", a)
	}
}

func TestRejectsUnknownControlAndType(t *testing.T) {
	if _, err := Parse([]byte("bindings:\n  keyX: {type: shell, command: x}\n")); err == nil {
		t.Fatal("expected error for unknown control")
	}
	if _, err := Parse([]byte("bindings:\n  key1: {type: bogus}\n")); err == nil {
		t.Fatal("expected error for unknown action type")
	}
	if _, err := Parse([]byte("bindings:\n  knob_cw: {tap: {type: shell, command: x}}\n")); err == nil {
		t.Fatal("expected error: momentary control cannot use tap/hold")
	}
}

func TestDefaultsFilled(t *testing.T) {
	cfg, err := Parse([]byte("bindings: {}\n"))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Device.VID != protocol.DefaultVendorID || cfg.Device.UsagePage != protocol.VendorUsagePage {
		t.Fatalf("device defaults not applied: %+v", cfg.Device)
	}
	if cfg.Gestures.HoldMS != 400 || cfg.Server.HTTPAddr == "" {
		t.Fatalf("defaults not applied: %+v", cfg)
	}
}
