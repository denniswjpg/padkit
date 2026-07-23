// SPDX-License-Identifier: MIT

package ledctl

import (
	"testing"

	"github.com/padkit/padkit-daemon/internal/hid"
	"github.com/padkit/padkit-daemon/internal/protocol"
)

func TestParseColor(t *testing.T) {
	cases := map[string]protocol.RGB{
		"#00ff88":       {R: 0, G: 255, B: 136},
		"00ff88":        {R: 0, G: 255, B: 136},
		"255,0,128":     {R: 255, G: 0, B: 128},
		" 10 , 20 , 30 ": {R: 10, G: 20, B: 30},
	}
	for in, want := range cases {
		got, err := ParseColor(in)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if got != want {
			t.Fatalf("%q: got %+v want %+v", in, got, want)
		}
	}
	for _, bad := range []string{"", "#xyz", "1,2", "300,0,0", "#12345"} {
		if _, err := ParseColor(bad); err == nil {
			t.Fatalf("%q should be rejected", bad)
		}
	}
}

func TestSetKeyColorPreservesOtherKeys(t *testing.T) {
	dev := hid.NewMockDevice(hid.Info{})
	c := New(dev)

	if err := c.SetKeyColor(0, protocol.RGB{R: 255}); err != nil {
		t.Fatal(err)
	}
	if err := c.SetKeyColor(3, protocol.RGB{B: 200}); err != nil {
		t.Fatal(err)
	}
	last := dev.LastWrite()
	if last == nil || last[0] != protocol.CmdSetRGB {
		t.Fatalf("expected SET_RGB, got %v", last)
	}
	// key0 red must still be present after setting key3 (shadow frame preserved).
	if last[1] != 255 {
		t.Fatalf("key0 red lost: %v", last[1:4])
	}
	// key3 blue at bytes [10..12] (1 + 3*3 = 10).
	if last[12] != 200 {
		t.Fatalf("key3 blue wrong: %v", last[10:13])
	}
}

func TestSetBrightnessRange(t *testing.T) {
	c := New(hid.NewMockDevice(hid.Info{}))
	if err := c.SetBrightness(300); err == nil {
		t.Fatal("expected out-of-range error")
	}
	if err := c.SetBrightness(128); err != nil {
		t.Fatal(err)
	}
}
