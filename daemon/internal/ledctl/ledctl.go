// SPDX-License-Identifier: MIT
//
// Package ledctl provides high-level LED / config operations built on the frozen
// protocol and a hid.Device. All device writes funnel through one mutex so the
// gesture loop, HTTP API, and MCP server can drive the LEDs concurrently.
package ledctl

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/padkit/padkit-daemon/internal/hid"
	"github.com/padkit/padkit-daemon/internal/protocol"
)

// Controller serializes access to a device. shadow holds the last full RGB
// frame so single-key edits and flashes don't clobber the other keys.
type Controller struct {
	mu     sync.Mutex
	dev    hid.Device
	shadow [protocol.NumLEDs]protocol.RGB
}

// New wraps a device.
func New(dev hid.Device) *Controller { return &Controller{dev: dev} }

func (c *Controller) write(payload []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.dev.WriteReport(payload)
}

// ParseColor parses "#RRGGBB", "RRGGBB", or "R,G,B" into an RGB.
func ParseColor(s string) (protocol.RGB, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return protocol.RGB{}, fmt.Errorf("empty color")
	}
	if strings.Contains(s, ",") {
		parts := strings.Split(s, ",")
		if len(parts) != 3 {
			return protocol.RGB{}, fmt.Errorf("expected R,G,B, got %q", s)
		}
		var vals [3]byte
		for i, p := range parts {
			v, err := strconv.Atoi(strings.TrimSpace(p))
			if err != nil || v < 0 || v > 255 {
				return protocol.RGB{}, fmt.Errorf("bad color component %q", p)
			}
			vals[i] = byte(v)
		}
		return protocol.RGB{R: vals[0], G: vals[1], B: vals[2]}, nil
	}
	s = strings.TrimPrefix(s, "#")
	if len(s) != 6 {
		return protocol.RGB{}, fmt.Errorf("expected 6 hex digits, got %q", s)
	}
	n, err := strconv.ParseUint(s, 16, 32)
	if err != nil {
		return protocol.RGB{}, fmt.Errorf("bad hex color %q", s)
	}
	return protocol.RGB{R: byte(n >> 16), G: byte(n >> 8), B: byte(n)}, nil
}

// SetKeyColor sets one key's color. It reads no state from the device, so it
// leaves other keys at whatever they were (host sends all 6; the daemon keeps a
// shadow of the last full frame).
func (c *Controller) SetKeyColor(slot int, color protocol.RGB) error {
	if slot < 0 || slot >= protocol.NumLEDs {
		return fmt.Errorf("slot %d out of range 0..%d", slot, protocol.NumLEDs-1)
	}
	c.mu.Lock()
	c.shadow[slot] = color
	frame := c.shadow
	c.mu.Unlock()
	return c.write(protocol.SetRGB(frame))
}

// SetAllColors sets all six key colors at once.
func (c *Controller) SetAllColors(colors [protocol.NumLEDs]protocol.RGB) error {
	c.mu.Lock()
	c.shadow = colors
	c.mu.Unlock()
	return c.write(protocol.SetRGB(colors))
}

// SetBrightness sets global brightness (0..255).
func (c *Controller) SetBrightness(level int) error {
	if level < 0 || level > 255 {
		return fmt.Errorf("brightness %d out of range 0..255", level)
	}
	return c.write(protocol.SetBrightness(byte(level)))
}

// SetEffect sets an animated effect by id with optional params.
func (c *Controller) SetEffect(id int, params ...byte) error {
	if id < 0 || id > 255 {
		return fmt.Errorf("effect id %d out of range", id)
	}
	return c.write(protocol.SetEffect(byte(id), params...))
}

// FlashKey lights one key to color for dur then restores the shadow frame.
func (c *Controller) FlashKey(slot int, color protocol.RGB, dur time.Duration) error {
	if slot < 0 || slot >= protocol.NumLEDs {
		return fmt.Errorf("slot %d out of range", slot)
	}
	c.mu.Lock()
	restore := c.shadow
	flash := c.shadow
	flash[slot] = color
	c.mu.Unlock()
	if err := c.write(protocol.SetRGB(flash)); err != nil {
		return err
	}
	if dur <= 0 {
		dur = 200 * time.Millisecond
	}
	time.AfterFunc(dur, func() { _ = c.write(protocol.SetRGB(restore)) })
	return nil
}

// Identify blinks one key white via the firmware IDENTIFY command.
func (c *Controller) Identify(slot int) error {
	if slot < 0 || slot >= protocol.NumSlots {
		return fmt.Errorf("slot %d out of range", slot)
	}
	return c.write(protocol.Identify(byte(slot)))
}

// SetFlags writes the config flags byte (e.g. SUPPRESS_KEYBOARD).
func (c *Controller) SetFlags(flags byte) error { return c.write(protocol.SetFlags(flags)) }

// Save commits current RAM config to DataFlash.
func (c *Controller) Save() error { return c.write(protocol.Save()) }

// SetKeystroke remaps a control's emitted HID keystroke.
func (c *Controller) SetKeystroke(slot, modifier, keycode int) error {
	return c.write(protocol.SetKey(byte(slot), byte(modifier), byte(keycode)))
}

// Shadow returns the daemon's current view of the six key colors.
func (c *Controller) Shadow() [protocol.NumLEDs]protocol.RGB {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.shadow
}
