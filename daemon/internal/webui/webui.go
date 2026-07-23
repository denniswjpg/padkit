// SPDX-License-Identifier: MIT
//
// Package webui serves the daemon's local HTTP API and a small embedded config
// UI. The API is also the integration surface: external systems (Home Assistant,
// scripts) POST to /api/led/* to drive LEDs "from an event", and the MCP server
// bridges to these same endpoints. Bind to loopback only.
package webui

import (
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/padkit/padkit-daemon/internal/actions"
	"github.com/padkit/padkit-daemon/internal/config"
	"github.com/padkit/padkit-daemon/internal/events"
	"github.com/padkit/padkit-daemon/internal/ledctl"
)

//go:embed index.html
var assets embed.FS

// Deps are the collaborators the HTTP layer needs.
type Deps struct {
	LED       *ledctl.Controller
	Broker    *events.Broker
	Log       *slog.Logger
	Connected func() bool
	DeviceVID func() uint16
	DevicePID func() uint16
	UsagePage func() uint16
	// GetConfigYAML returns the current on-disk config text.
	GetConfigYAML func() (string, error)
	// SetConfigYAML validates and persists new config text (triggers reload).
	SetConfigYAML func(text string) error
	ServeUI       bool
}

// Handler builds the http.Handler for the API + UI.
func Handler(d Deps) http.Handler {
	if d.Log == nil {
		d.Log = slog.Default()
	}
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	mux.HandleFunc("GET /api/info", func(w http.ResponseWriter, r *http.Request) {
		info := map[string]any{"connected": false}
		if d.Connected != nil {
			info["connected"] = d.Connected()
		}
		if d.DeviceVID != nil {
			info["vid"] = fmt.Sprintf("%#04x", d.DeviceVID())
		}
		if d.DevicePID != nil {
			info["pid"] = fmt.Sprintf("%#04x", d.DevicePID())
		}
		if d.UsagePage != nil {
			info["usage_page"] = fmt.Sprintf("%#04x", d.UsagePage())
		}
		writeJSON(w, 200, info)
	})

	// Config get/set (raw YAML text).
	mux.HandleFunc("GET /api/config", func(w http.ResponseWriter, r *http.Request) {
		if d.GetConfigYAML == nil {
			http.Error(w, "config editing disabled", 501)
			return
		}
		txt, err := d.GetConfigYAML()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, txt)
	})
	mux.HandleFunc("PUT /api/config", func(w http.ResponseWriter, r *http.Request) {
		if d.SetConfigYAML == nil {
			http.Error(w, "config editing disabled", 501)
			return
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		if err := d.SetConfigYAML(string(body)); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	// Events: last + SSE stream.
	mux.HandleFunc("GET /api/events/last", func(w http.ResponseWriter, r *http.Request) {
		g, ok := d.Broker.Last()
		if !ok {
			writeJSON(w, 200, map[string]any{"event": nil})
			return
		}
		writeJSON(w, 200, map[string]any{"event": g})
	})
	mux.HandleFunc("GET /api/events/stream", func(w http.ResponseWriter, r *http.Request) {
		fl, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "streaming unsupported", 500)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		ch, cancel := d.Broker.Subscribe()
		defer cancel()
		fl.Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case g, ok := <-ch:
				if !ok {
					return
				}
				b, _ := json.Marshal(g)
				fmt.Fprintf(w, "data: %s\n\n", b)
				fl.Flush()
			}
		}
	})

	// LED endpoints.
	mux.HandleFunc("POST /api/led/key", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		slot, _ := toInt(body["slot"])
		c, err := ledctl.ParseColor(fmt.Sprint(body["color"]))
		if err != nil {
			return err
		}
		return d.LED.SetKeyColor(slot, c)
	}, d))
	mux.HandleFunc("POST /api/led/all", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		arr, ok := body["colors"].([]any)
		if !ok || len(arr) != 6 {
			return fmt.Errorf("colors must be an array of 6 strings")
		}
		var l config.LEDAction
		for _, v := range arr {
			l.AllColors = append(l.AllColors, fmt.Sprint(v))
		}
		return actions.ApplyLED(d.LED, &l)
	}, d))
	mux.HandleFunc("POST /api/led/brightness", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		v, _ := toInt(body["value"])
		return d.LED.SetBrightness(v)
	}, d))
	mux.HandleFunc("POST /api/led/effect", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		l := config.LEDAction{Effect: fmt.Sprint(body["effect"])}
		if rgb, ok := body["rgb"]; ok && rgb != nil {
			l.EffectRGB = fmt.Sprint(rgb)
		}
		if sp, ok := toInt(body["speed"]); ok {
			l.EffectSpeed = &sp
		}
		return actions.ApplyLED(d.LED, &l)
	}, d))
	mux.HandleFunc("POST /api/led/flash", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		slot, _ := toInt(body["slot"])
		ms, _ := toInt(body["ms"])
		l := config.LEDAction{Slot: &slot, Flash: true, FlashMS: ms}
		if c, ok := body["color"]; ok && c != nil {
			l.Color = fmt.Sprint(c)
		}
		return actions.ApplyLED(d.LED, &l)
	}, d))
	mux.HandleFunc("POST /api/led/identify", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		slot, _ := toInt(body["slot"])
		return d.LED.Identify(slot)
	}, d))
	mux.HandleFunc("POST /api/led/save", jsonReq(func(w http.ResponseWriter, body map[string]any) error {
		return d.LED.Save()
	}, d))

	// Generic "led from event" endpoint: accepts a full LEDAction as JSON.
	mux.HandleFunc("POST /api/led", func(w http.ResponseWriter, r *http.Request) {
		var l config.LEDAction
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&l); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if err := actions.ApplyLED(d.LED, &l); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	// UI.
	if d.ServeUI {
		mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/" {
				http.NotFound(w, r)
				return
			}
			b, _ := assets.ReadFile("index.html")
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write(b)
		})
	}
	return logMiddleware(d.Log, mux)
}

// jsonReq wraps a handler that reads a JSON object body and returns an error.
func jsonReq(fn func(http.ResponseWriter, map[string]any) error, d Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.LED == nil {
			http.Error(w, "no device attached", 503)
			return
		}
		body := map[string]any{}
		if r.ContentLength != 0 {
			if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil && err != io.EOF {
				http.Error(w, err.Error(), 400)
				return
			}
		}
		if err := fn(w, body); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		return int(n), true
	case int:
		return n, true
	case json.Number:
		i, _ := n.Int64()
		return int(i), true
	default:
		return 0, false
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func logMiddleware(log *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Debug("http", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start))
	})
}
