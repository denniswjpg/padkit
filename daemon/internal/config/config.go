// SPDX-License-Identifier: MIT
//
// Package config defines the daemon's YAML configuration: which control+gesture
// maps to which action, plus device and server settings. A binding may be a
// single action (for momentary controls, or a key's default tap) or a tap/hold
// pair (for the six keys).
package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/padkit/padkit-daemon/internal/protocol"
	"gopkg.in/yaml.v3"
)

// Config is the whole daemon configuration.
type Config struct {
	Device   DeviceConfig       `yaml:"device"`
	Server   ServerConfig       `yaml:"server"`
	Gestures GestureConfig      `yaml:"gestures"`
	Bindings map[string]Binding `yaml:"bindings"`
}

// DeviceConfig selects and configures the pad.
type DeviceConfig struct {
	VID              uint16 `yaml:"vid"`
	PID              uint16 `yaml:"pid"`
	UsagePage        uint16 `yaml:"usage_page"`
	SuppressKeyboard bool   `yaml:"suppress_keyboard"` // SET_FLAGS bit0 on startup
}

// ServerConfig configures the local HTTP API / web UI.
type ServerConfig struct {
	HTTPAddr string `yaml:"http_addr"`
	WebUI    bool   `yaml:"web_ui"`
}

// GestureConfig tunes gesture timing.
type GestureConfig struct {
	HoldMS int `yaml:"hold_ms"` // tap-vs-hold threshold in milliseconds
}

// Binding is what a control does. For keys, Tap/Hold apply; for momentary
// controls (knob, click, push-turn) the single action is used. A key with only
// a single action treats it as the tap action.
type Binding struct {
	Tap    *Action `yaml:"tap"`
	Hold   *Action `yaml:"hold"`
	Single *Action `yaml:"-"` // populated when the YAML node is a bare action
}

// UnmarshalYAML lets a binding be either {tap:.., hold:..} or a bare action.
func (b *Binding) UnmarshalYAML(node *yaml.Node) error {
	// Peek for tap/hold keys.
	hasTapHold := false
	if node.Kind == yaml.MappingNode {
		for i := 0; i < len(node.Content); i += 2 {
			k := node.Content[i].Value
			if k == "tap" || k == "hold" {
				hasTapHold = true
				break
			}
		}
	}
	if hasTapHold {
		type raw struct {
			Tap  *Action `yaml:"tap"`
			Hold *Action `yaml:"hold"`
		}
		var r raw
		if err := node.Decode(&r); err != nil {
			return err
		}
		b.Tap = r.Tap
		b.Hold = r.Hold
		return nil
	}
	var a Action
	if err := node.Decode(&a); err != nil {
		return err
	}
	b.Single = &a
	return nil
}

// Action is one action backend invocation.
type Action struct {
	Type string `yaml:"type"` // keystroke | shell | webhook | led

	// keystroke
	Keys string `yaml:"keys"` // e.g. "ctrl+shift+p" or literal text via Text
	Text string `yaml:"text"` // type a literal string

	// shell
	Command string   `yaml:"command"` // run via the OS shell when Args is empty
	Args    []string `yaml:"args"`    // exec directly when set (Command is argv[0])

	// webhook
	Method  string            `yaml:"method"`
	URL     string            `yaml:"url"`
	Headers map[string]string `yaml:"headers"`
	Body    string            `yaml:"body"`

	// led
	LED *LEDAction `yaml:"led"`
}

// LEDAction describes an LED/config output-report action. Fields are optional;
// each present field produces one output report (evaluated in a stable order).
type LEDAction struct {
	Slot        *int     `yaml:"slot" json:"slot"`               // target one key (0..5) for Color/Flash
	Color       string   `yaml:"color" json:"color"`             // "#RRGGBB" or "R,G,B"
	AllColors   []string `yaml:"all_colors" json:"all_colors"`   // 6 colors, slot order 0..5
	Brightness  *int     `yaml:"brightness" json:"brightness"`   // 0..255
	Effect      string   `yaml:"effect" json:"effect"`           // name (static/breathe/rainbow/reactive/scanner) or number
	EffectRGB   string   `yaml:"effect_rgb" json:"effect_rgb"`   // color param for effects that take one
	EffectSpeed *int     `yaml:"effect_speed" json:"effect_speed"`
	Flash       bool     `yaml:"flash" json:"flash"`     // momentary flash of Slot with Color
	FlashMS     int      `yaml:"flash_ms" json:"flash_ms"` // flash duration (default 200)
	Save        bool     `yaml:"save" json:"save"`       // commit to DataFlash after applying
}

// slotNames maps YAML binding keys to protocol slot ids.
var slotNames = map[string]int{
	"key1":         protocol.SlotKey1,
	"key2":         protocol.SlotKey2,
	"key3":         protocol.SlotKey3,
	"key4":         protocol.SlotKey4,
	"key5":         protocol.SlotKey5,
	"key6":         protocol.SlotKey6,
	"knob_ccw":     protocol.SlotKnobCCW,
	"knob_click":   protocol.SlotKnobClick,
	"knob_cw":      protocol.SlotKnobCW,
	"pushturn_ccw": protocol.SlotPushTurnCCW,
	"pushturn_cw":  protocol.SlotPushTurnCW,
}

// SlotForName resolves a binding key to a slot id.
func SlotForName(name string) (int, bool) {
	s, ok := slotNames[strings.ToLower(name)]
	return s, ok
}

// NameForSlot resolves a slot id back to its canonical binding key.
func NameForSlot(slot int) string {
	for name, s := range slotNames {
		if s == slot {
			return name
		}
	}
	return fmt.Sprintf("slot%d", slot)
}

// IsKey reports whether a slot is one of the six tap/hold keys.
func IsKey(slot int) bool { return slot >= protocol.SlotKey1 && slot <= protocol.SlotKey6 }

// Default returns a Config with sensible defaults filled in.
func Default() Config {
	return Config{
		Device: DeviceConfig{
			VID:       protocol.DefaultVendorID,
			PID:       protocol.DefaultProductID,
			UsagePage: protocol.VendorUsagePage,
		},
		Server:   ServerConfig{HTTPAddr: "127.0.0.1:8787", WebUI: true},
		Gestures: GestureConfig{HoldMS: 400},
		Bindings: map[string]Binding{},
	}
}

// applyDefaults fills zero-valued required fields.
func (c *Config) applyDefaults() {
	if c.Device.VID == 0 {
		c.Device.VID = protocol.DefaultVendorID
	}
	if c.Device.PID == 0 {
		c.Device.PID = protocol.DefaultProductID
	}
	if c.Device.UsagePage == 0 {
		c.Device.UsagePage = protocol.VendorUsagePage
	}
	if c.Server.HTTPAddr == "" {
		c.Server.HTTPAddr = "127.0.0.1:8787"
	}
	if c.Gestures.HoldMS == 0 {
		c.Gestures.HoldMS = 400
	}
	if c.Bindings == nil {
		c.Bindings = map[string]Binding{}
	}
}

// Parse decodes YAML bytes into a validated Config.
func Parse(data []byte) (Config, error) {
	c := Config{}
	if err := yaml.Unmarshal(data, &c); err != nil {
		return Config{}, fmt.Errorf("parse config: %w", err)
	}
	c.applyDefaults()
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Load reads and parses a config file.
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read config: %w", err)
	}
	return Parse(data)
}

// Validate checks binding names and action types.
func (c *Config) Validate() error {
	for name, b := range c.Bindings {
		slot, ok := SlotForName(name)
		if !ok {
			return fmt.Errorf("unknown control %q (valid: key1..key6, knob_cw, knob_ccw, knob_click, pushturn_cw, pushturn_ccw)", name)
		}
		check := func(a *Action, where string) error {
			if a == nil {
				return nil
			}
			return a.Validate(fmt.Sprintf("%s.%s", name, where))
		}
		if err := check(b.Tap, "tap"); err != nil {
			return err
		}
		if err := check(b.Hold, "hold"); err != nil {
			return err
		}
		if err := check(b.Single, "action"); err != nil {
			return err
		}
		if !IsKey(slot) && (b.Tap != nil || b.Hold != nil) {
			return fmt.Errorf("control %q is momentary; use a bare action, not tap/hold", name)
		}
	}
	return nil
}

// Validate checks a single action.
func (a *Action) Validate(where string) error {
	switch a.Type {
	case "keystroke":
		if a.Keys == "" && a.Text == "" {
			return fmt.Errorf("%s: keystroke action needs keys or text", where)
		}
	case "shell":
		if a.Command == "" {
			return fmt.Errorf("%s: shell action needs command", where)
		}
	case "webhook":
		if a.URL == "" {
			return fmt.Errorf("%s: webhook action needs url", where)
		}
	case "led":
		if a.LED == nil {
			return fmt.Errorf("%s: led action needs an led block", where)
		}
	default:
		return fmt.Errorf("%s: unknown action type %q", where, a.Type)
	}
	return nil
}

// Resolve returns the action for a control slot and whether the gesture is a hold.
// For keys: hold -> Hold binding (falling back to Single/Tap only if no Hold set
// is intentional -> nil). tap -> Tap or Single. For momentary controls: Single.
func (c Config) Resolve(slot int, hold bool) *Action {
	name := NameForSlot(slot)
	b, ok := c.Bindings[name]
	if !ok {
		return nil
	}
	if IsKey(slot) {
		if hold {
			return b.Hold
		}
		if b.Tap != nil {
			return b.Tap
		}
		return b.Single
	}
	return b.Single
}
