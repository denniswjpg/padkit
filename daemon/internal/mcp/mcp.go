// SPDX-License-Identifier: MIT
//
// Package mcp is a minimal Model Context Protocol server over stdio (newline-
// delimited JSON-RPC 2.0). It exposes tools so a coding agent can drive the pad's
// LEDs and read its gestures. It talks to a Backend -- by default an HTTP bridge
// to a running daemon (so the daemon keeps exclusive ownership of the device),
// or a direct-HID backend when no daemon is running.
//
// No external MCP library is used; the wire format is small and stable.
package mcp

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
)

// protocolVersion is the MCP revision this server implements.
const protocolVersion = "2024-11-05"

// Backend is the pad-control surface the tools call.
type Backend interface {
	SetKeyColor(slot int, color string) error
	SetAllColors(colors []string) error
	SetBrightness(v int) error
	SetEffect(effect, rgb string, speed *int) error
	FlashKey(slot int, color string, ms int) error
	Identify(slot int) error
	Save() error
	LastEvent() (any, error)
}

// Server runs the JSON-RPC loop.
type Server struct {
	Backend Backend
	Log     *slog.Logger
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any         `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Serve runs the stdio loop until in is closed.
func (s *Server) Serve(in io.Reader, out io.Writer) error {
	if s.Log == nil {
		s.Log = slog.Default()
	}
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	enc := json.NewEncoder(out)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			s.Log.Debug("mcp: bad json", "err", err)
			continue
		}
		resp, isNotification := s.handle(req)
		if isNotification {
			continue // notifications get no response
		}
		if err := enc.Encode(resp); err != nil {
			return err
		}
	}
	return sc.Err()
}

func (s *Server) handle(req rpcRequest) (rpcResponse, bool) {
	base := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	switch req.Method {
	case "initialize":
		base.Result = map[string]any{
			"protocolVersion": protocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "padkit", "version": "0.3.0"},
		}
		return base, false
	case "notifications/initialized", "initialized":
		return base, true
	case "ping":
		base.Result = map[string]any{}
		return base, false
	case "tools/list":
		base.Result = map[string]any{"tools": toolDefs}
		return base, false
	case "tools/call":
		res, err := s.callTool(req.Params)
		if err != nil {
			base.Result = map[string]any{
				"content": []map[string]any{{"type": "text", "text": "error: " + err.Error()}},
				"isError": true,
			}
			return base, false
		}
		base.Result = res
		return base, false
	default:
		base.Error = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
		return base, false
	}
}

type callParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

func (s *Server) callTool(raw json.RawMessage) (any, error) {
	var p callParams
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("bad params: %w", err)
	}
	args := map[string]any{}
	if len(p.Arguments) > 0 {
		_ = json.Unmarshal(p.Arguments, &args)
	}
	text, err := s.dispatch(p.Name, args)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"content": []map[string]any{{"type": "text", "text": text}},
	}, nil
}

func (s *Server) dispatch(name string, args map[string]any) (string, error) {
	argInt := func(k string) int {
		switch v := args[k].(type) {
		case float64:
			return int(v)
		case int:
			return v
		default:
			return 0
		}
	}
	argStr := func(k string) string {
		if v, ok := args[k]; ok && v != nil {
			return fmt.Sprint(v)
		}
		return ""
	}
	switch name {
	case "set_key_color":
		if err := s.Backend.SetKeyColor(argInt("slot"), argStr("color")); err != nil {
			return "", err
		}
		return fmt.Sprintf("key %d set to %s", argInt("slot"), argStr("color")), nil
	case "set_all_colors":
		var colors []string
		if arr, ok := args["colors"].([]any); ok {
			for _, v := range arr {
				colors = append(colors, fmt.Sprint(v))
			}
		}
		if err := s.Backend.SetAllColors(colors); err != nil {
			return "", err
		}
		return "all colors set", nil
	case "set_brightness":
		if err := s.Backend.SetBrightness(argInt("value")); err != nil {
			return "", err
		}
		return fmt.Sprintf("brightness %d", argInt("value")), nil
	case "set_effect":
		var speed *int
		if _, ok := args["speed"]; ok {
			sp := argInt("speed")
			speed = &sp
		}
		if err := s.Backend.SetEffect(argStr("effect"), argStr("rgb"), speed); err != nil {
			return "", err
		}
		return "effect " + argStr("effect"), nil
	case "flash_key":
		if err := s.Backend.FlashKey(argInt("slot"), argStr("color"), argInt("ms")); err != nil {
			return "", err
		}
		return fmt.Sprintf("flashed key %d", argInt("slot")), nil
	case "identify_key":
		if err := s.Backend.Identify(argInt("slot")); err != nil {
			return "", err
		}
		return fmt.Sprintf("identifying key %d", argInt("slot")), nil
	case "save_to_device":
		if err := s.Backend.Save(); err != nil {
			return "", err
		}
		return "saved to device flash", nil
	case "get_last_event":
		ev, err := s.Backend.LastEvent()
		if err != nil {
			return "", err
		}
		b, _ := json.Marshal(ev)
		return string(b), nil
	default:
		return "", fmt.Errorf("unknown tool %q", name)
	}
}

// toolDefs is the static tool catalog returned by tools/list.
var toolDefs = []map[string]any{
	{
		"name":        "set_key_color",
		"description": "Set one macropad key's RGB color. slot 0..5 (key1..key6). color as #RRGGBB or 'R,G,B'.",
		"inputSchema": obj(props{
			"slot":  numProp("Key index 0..5"),
			"color": strProp("Color, e.g. #00ff88 or 0,255,136"),
		}, "slot", "color"),
	},
	{
		"name":        "set_all_colors",
		"description": "Set all six key colors at once. colors: array of 6 color strings in key1..key6 order.",
		"inputSchema": obj(props{
			"colors": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "6 colors"},
		}, "colors"),
	},
	{
		"name":        "set_brightness",
		"description": "Set global LED brightness 0..255.",
		"inputSchema": obj(props{"value": numProp("Brightness 0..255")}, "value"),
	},
	{
		"name":        "set_effect",
		"description": "Set an animated LED effect: static, breathe, rainbow, reactive, or scanner. Optional rgb color and speed 0..255.",
		"inputSchema": obj(props{
			"effect": strProp("static|breathe|rainbow|reactive|scanner"),
			"rgb":    strProp("Optional color for the effect"),
			"speed":  numProp("Optional speed 0..255"),
		}, "effect"),
	},
	{
		"name":        "flash_key",
		"description": "Briefly flash one key a color then restore it. Good for signaling an agent event. slot 0..5.",
		"inputSchema": obj(props{
			"slot":  numProp("Key index 0..5"),
			"color": strProp("Optional flash color (default white)"),
			"ms":    numProp("Optional duration in ms (default 200)"),
		}, "slot"),
	},
	{
		"name":        "identify_key",
		"description": "Blink one control white via firmware IDENTIFY so a user can see which physical key a slot is. slot 0..10.",
		"inputSchema": obj(props{"slot": numProp("Control slot 0..10")}, "slot"),
	},
	{
		"name":        "save_to_device",
		"description": "Commit the current LED/config state to the pad's on-device flash so it survives replug.",
		"inputSchema": obj(props{}),
	},
	{
		"name":        "get_last_event",
		"description": "Get the most recent pad gesture (tap/hold/knob/click/push-turn) the daemon observed. Poll this to react to physical input. Requires the daemon to be running (HTTP bridge mode).",
		"inputSchema": obj(props{}),
	},
}

type props = map[string]any

func obj(p props, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": p}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}
func numProp(desc string) map[string]any { return map[string]any{"type": "number", "description": desc} }
func strProp(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }
