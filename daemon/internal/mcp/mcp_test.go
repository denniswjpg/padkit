// SPDX-License-Identifier: MIT

package mcp

import (
	"bufio"
	"encoding/json"
	"strings"
	"testing"
)

// stubBackend records calls.
type stubBackend struct {
	lastColorSlot int
	lastColor     string
	saved         bool
}

func (s *stubBackend) SetKeyColor(slot int, color string) error {
	s.lastColorSlot, s.lastColor = slot, color
	return nil
}
func (s *stubBackend) SetAllColors([]string) error              { return nil }
func (s *stubBackend) SetBrightness(int) error                  { return nil }
func (s *stubBackend) SetEffect(string, string, *int) error     { return nil }
func (s *stubBackend) FlashKey(int, string, int) error          { return nil }
func (s *stubBackend) Identify(int) error                       { return nil }
func (s *stubBackend) Save() error                              { s.saved = true; return nil }
func (s *stubBackend) LastEvent() (any, error)                  { return map[string]any{"event": nil}, nil }

func serveLines(t *testing.T, input string) []string {
	t.Helper()
	be := &stubBackend{}
	srv := &Server{Backend: be}
	var out strings.Builder
	if err := srv.Serve(strings.NewReader(input), &out); err != nil {
		t.Fatalf("serve: %v", err)
	}
	sc := bufio.NewScanner(strings.NewReader(out.String()))
	var lines []string
	for sc.Scan() {
		if l := sc.Text(); l != "" {
			lines = append(lines, l)
		}
	}
	return lines
}

func TestInitializeAndToolsList(t *testing.T) {
	in := `{"jsonrpc":"2.0","id":1,"method":"initialize"}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
`
	lines := serveLines(t, in)
	// initialize + tools/list produce 2 responses; the notification produces none.
	if len(lines) != 2 {
		t.Fatalf("expected 2 responses, got %d: %v", len(lines), lines)
	}
	var initResp struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			ServerInfo      struct{ Name string } `json:"serverInfo"`
		}
	}
	if err := json.Unmarshal([]byte(lines[0]), &initResp); err != nil {
		t.Fatal(err)
	}
	if initResp.Result.ServerInfo.Name != "padkit" || initResp.Result.ProtocolVersion == "" {
		t.Fatalf("bad initialize result: %s", lines[0])
	}
	var listResp struct {
		Result struct {
			Tools []map[string]any `json:"tools"`
		}
	}
	if err := json.Unmarshal([]byte(lines[1]), &listResp); err != nil {
		t.Fatal(err)
	}
	if len(listResp.Result.Tools) < 6 {
		t.Fatalf("expected several tools, got %d", len(listResp.Result.Tools))
	}
	names := map[string]bool{}
	for _, tl := range listResp.Result.Tools {
		names[tl["name"].(string)] = true
	}
	for _, want := range []string{"set_key_color", "set_brightness", "flash_key", "get_last_event"} {
		if !names[want] {
			t.Fatalf("missing tool %q", want)
		}
	}
}

func TestToolsCallSetKeyColor(t *testing.T) {
	be := &stubBackend{}
	srv := &Server{Backend: be}
	in := `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"set_key_color","arguments":{"slot":2,"color":"#00ff88"}}}` + "\n"
	var out strings.Builder
	if err := srv.Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	if be.lastColorSlot != 2 || be.lastColor != "#00ff88" {
		t.Fatalf("backend not called correctly: slot=%d color=%q", be.lastColorSlot, be.lastColor)
	}
	if !strings.Contains(out.String(), "content") {
		t.Fatalf("response missing content: %s", out.String())
	}
}

func TestUnknownMethodErrors(t *testing.T) {
	in := `{"jsonrpc":"2.0","id":9,"method":"does/not/exist"}` + "\n"
	lines := serveLines(t, in)
	if len(lines) != 1 || !strings.Contains(lines[0], "-32601") {
		t.Fatalf("expected method-not-found error, got %v", lines)
	}
}
