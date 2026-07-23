// SPDX-License-Identifier: MIT
//
// Package actions executes a configured Action: keystroke, shell, webhook, or
// led. Shell, webhook, and led are solid cross-platform; keystroke injection is
// best-effort per OS (see keystroke.go).
package actions

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/padkit/padkit-daemon/internal/config"
	"github.com/padkit/padkit-daemon/internal/ledctl"
	"github.com/padkit/padkit-daemon/internal/protocol"
)

// Dispatcher runs actions against the LED controller and the outside world.
type Dispatcher struct {
	LED    *ledctl.Controller
	Log    *slog.Logger
	client *http.Client
}

// New builds a Dispatcher.
func New(led *ledctl.Controller, log *slog.Logger) *Dispatcher {
	if log == nil {
		log = slog.Default()
	}
	return &Dispatcher{
		LED:    led,
		Log:    log,
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

// Run executes an action. It blocks; callers that need async should go func it.
func (d *Dispatcher) Run(ctx context.Context, a *config.Action) error {
	if a == nil {
		return nil
	}
	switch a.Type {
	case "keystroke":
		return d.runKeystroke(a)
	case "shell":
		return d.runShell(ctx, a)
	case "webhook":
		return d.runWebhook(ctx, a)
	case "led":
		return d.runLED(a)
	default:
		return fmt.Errorf("unknown action type %q", a.Type)
	}
}

func (d *Dispatcher) runShell(ctx context.Context, a *config.Action) error {
	var cmd *exec.Cmd
	if len(a.Args) > 0 {
		cmd = exec.CommandContext(ctx, a.Command, a.Args...)
	} else {
		if runtime.GOOS == "windows" {
			cmd = exec.CommandContext(ctx, "cmd", "/C", a.Command)
		} else {
			cmd = exec.CommandContext(ctx, "sh", "-c", a.Command)
		}
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("shell %q: %w (output: %s)", a.Command, err, strings.TrimSpace(string(out)))
	}
	d.Log.Debug("shell action ran", "command", a.Command, "output", strings.TrimSpace(string(out)))
	return nil
}

func (d *Dispatcher) runWebhook(ctx context.Context, a *config.Action) error {
	method := a.Method
	if method == "" {
		if a.Body != "" {
			method = http.MethodPost
		} else {
			method = http.MethodGet
		}
	}
	var body io.Reader
	if a.Body != "" {
		body = strings.NewReader(a.Body)
	}
	req, err := http.NewRequestWithContext(ctx, strings.ToUpper(method), a.URL, body)
	if err != nil {
		return fmt.Errorf("webhook build request: %w", err)
	}
	for k, v := range a.Headers {
		req.Header.Set(k, v)
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return fmt.Errorf("webhook %s %s: %w", method, a.URL, err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("webhook %s %s: status %d", method, a.URL, resp.StatusCode)
	}
	d.Log.Debug("webhook action ran", "method", method, "url", a.URL, "status", resp.StatusCode)
	return nil
}

func (d *Dispatcher) runLED(a *config.Action) error {
	if d.LED == nil {
		return fmt.Errorf("led action requested but no device attached")
	}
	return ApplyLED(d.LED, a.LED)
}

// ApplyLED applies an LEDAction to the controller. Present fields are applied in
// a stable order: brightness, effect, all-colors, single color, flash, save.
// Exported so the HTTP "led from event" endpoint and the MCP server can reuse it.
func ApplyLED(led *ledctl.Controller, l *config.LEDAction) error {
	if l == nil {
		return fmt.Errorf("empty led action")
	}
	if l.Brightness != nil {
		if err := led.SetBrightness(*l.Brightness); err != nil {
			return err
		}
	}
	if l.Effect != "" {
		id, err := effectID(l.Effect)
		if err != nil {
			return err
		}
		params := effectParams(l)
		if err := led.SetEffect(id, params...); err != nil {
			return err
		}
	}
	if len(l.AllColors) > 0 {
		if len(l.AllColors) != protocol.NumLEDs {
			return fmt.Errorf("all_colors needs %d entries, got %d", protocol.NumLEDs, len(l.AllColors))
		}
		var frame [protocol.NumLEDs]protocol.RGB
		for i, s := range l.AllColors {
			c, err := ledctl.ParseColor(s)
			if err != nil {
				return fmt.Errorf("all_colors[%d]: %w", i, err)
			}
			frame[i] = c
		}
		if err := led.SetAllColors(frame); err != nil {
			return err
		}
	}
	if l.Color != "" && l.Slot != nil && !l.Flash {
		c, err := ledctl.ParseColor(l.Color)
		if err != nil {
			return err
		}
		if err := led.SetKeyColor(*l.Slot, c); err != nil {
			return err
		}
	}
	if l.Flash {
		if l.Slot == nil {
			return fmt.Errorf("flash needs a slot")
		}
		color := protocol.RGB{R: 255, G: 255, B: 255}
		if l.Color != "" {
			c, err := ledctl.ParseColor(l.Color)
			if err != nil {
				return err
			}
			color = c
		}
		dur := time.Duration(l.FlashMS) * time.Millisecond
		if err := led.FlashKey(*l.Slot, color, dur); err != nil {
			return err
		}
	}
	if l.Save {
		if err := led.Save(); err != nil {
			return err
		}
	}
	return nil
}

var effectNames = map[string]int{
	"static":   protocol.EffectStatic,
	"breathe":  protocol.EffectBreathe,
	"rainbow":  protocol.EffectRainbow,
	"reactive": protocol.EffectReactive,
	"scanner":  protocol.EffectScanner,
}

func effectID(s string) (int, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if id, ok := effectNames[s]; ok {
		return id, nil
	}
	if n, err := strconv.Atoi(s); err == nil && n >= 0 && n <= 255 {
		return n, nil
	}
	return 0, fmt.Errorf("unknown effect %q", s)
}

// effectParams builds the [speed, R, G, B] param tail from an LEDAction.
func effectParams(l *config.LEDAction) []byte {
	var p []byte
	speed := 128
	if l.EffectSpeed != nil {
		speed = *l.EffectSpeed
	}
	p = append(p, byte(speed))
	if l.EffectRGB != "" {
		if c, err := ledctl.ParseColor(l.EffectRGB); err == nil {
			p = append(p, c.R, c.G, c.B)
		}
	}
	return p
}
