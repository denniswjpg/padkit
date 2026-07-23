// SPDX-License-Identifier: MIT

package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/padkit/padkit-daemon/internal/ledctl"
	"github.com/padkit/padkit-daemon/internal/protocol"
)

// HTTPBackend bridges tool calls to a running daemon's local HTTP API. This is
// the default: the daemon keeps exclusive ownership of the HID device.
type HTTPBackend struct {
	Base   string // e.g. http://127.0.0.1:8787
	client *http.Client
}

// NewHTTPBackend builds an HTTPBackend.
func NewHTTPBackend(base string) *HTTPBackend {
	return &HTTPBackend{Base: base, client: &http.Client{Timeout: 5 * time.Second}}
}

func (h *HTTPBackend) post(path string, body any) error {
	var buf io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		buf = bytes.NewReader(b)
	}
	req, err := http.NewRequest(http.MethodPost, h.Base+path, buf)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := h.client.Do(req)
	if err != nil {
		return fmt.Errorf("daemon not reachable at %s (%w); start the daemon or use --direct", h.Base, err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("daemon %s: %s", path, bytes.TrimSpace(b))
	}
	return nil
}

func (h *HTTPBackend) SetKeyColor(slot int, color string) error {
	return h.post("/api/led/key", map[string]any{"slot": slot, "color": color})
}
func (h *HTTPBackend) SetAllColors(colors []string) error {
	return h.post("/api/led/all", map[string]any{"colors": colors})
}
func (h *HTTPBackend) SetBrightness(v int) error {
	return h.post("/api/led/brightness", map[string]any{"value": v})
}
func (h *HTTPBackend) SetEffect(effect, rgb string, speed *int) error {
	m := map[string]any{"effect": effect}
	if rgb != "" {
		m["rgb"] = rgb
	}
	if speed != nil {
		m["speed"] = *speed
	}
	return h.post("/api/led/effect", m)
}
func (h *HTTPBackend) FlashKey(slot int, color string, ms int) error {
	return h.post("/api/led/flash", map[string]any{"slot": slot, "color": color, "ms": ms})
}
func (h *HTTPBackend) Identify(slot int) error {
	return h.post("/api/led/identify", map[string]any{"slot": slot})
}
func (h *HTTPBackend) Save() error { return h.post("/api/led/save", nil) }

func (h *HTTPBackend) LastEvent() (any, error) {
	resp, err := h.client.Get(h.Base + "/api/events/last")
	if err != nil {
		return nil, fmt.Errorf("daemon not reachable at %s (%w); start the daemon or use --direct", h.Base, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// DirectBackend drives a ledctl.Controller directly (opens the HID device in the
// MCP process). Use when no daemon is running. Gesture reads are unavailable in
// this mode because there is no gesture loop.
type DirectBackend struct {
	LED *ledctl.Controller
}

func (d *DirectBackend) SetKeyColor(slot int, color string) error {
	c, err := ledctl.ParseColor(color)
	if err != nil {
		return err
	}
	return d.LED.SetKeyColor(slot, c)
}
func (d *DirectBackend) SetAllColors(colors []string) error {
	if len(colors) != protocol.NumLEDs {
		return fmt.Errorf("need %d colors, got %d", protocol.NumLEDs, len(colors))
	}
	var frame [protocol.NumLEDs]protocol.RGB
	for i, s := range colors {
		c, err := ledctl.ParseColor(s)
		if err != nil {
			return err
		}
		frame[i] = c
	}
	return d.LED.SetAllColors(frame)
}
func (d *DirectBackend) SetBrightness(v int) error { return d.LED.SetBrightness(v) }
func (d *DirectBackend) SetEffect(effect, rgb string, speed *int) error {
	id, err := effectIDByName(effect)
	if err != nil {
		return err
	}
	sp := byte(128)
	if speed != nil {
		sp = byte(*speed)
	}
	params := []byte{sp}
	if rgb != "" {
		if c, err := ledctl.ParseColor(rgb); err == nil {
			params = append(params, c.R, c.G, c.B)
		}
	}
	return d.LED.SetEffect(id, params...)
}
func (d *DirectBackend) FlashKey(slot int, color string, ms int) error {
	c := protocol.RGB{R: 255, G: 255, B: 255}
	if color != "" {
		parsed, err := ledctl.ParseColor(color)
		if err != nil {
			return err
		}
		c = parsed
	}
	return d.LED.FlashKey(slot, c, time.Duration(ms)*time.Millisecond)
}
func (d *DirectBackend) Identify(slot int) error { return d.LED.Identify(slot) }
func (d *DirectBackend) Save() error             { return d.LED.Save() }
func (d *DirectBackend) LastEvent() (any, error) {
	return map[string]any{"event": nil, "note": "gesture reads require the daemon (HTTP bridge mode)"}, nil
}

var effectNames = map[string]int{
	"static":   protocol.EffectStatic,
	"breathe":  protocol.EffectBreathe,
	"rainbow":  protocol.EffectRainbow,
	"reactive": protocol.EffectReactive,
	"scanner":  protocol.EffectScanner,
}

func effectIDByName(s string) (int, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if id, ok := effectNames[s]; ok {
		return id, nil
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n, nil
	}
	return 0, fmt.Errorf("unknown effect %q", s)
}
