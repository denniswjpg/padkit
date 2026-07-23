// SPDX-License-Identifier: MIT

package app

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/padkit/padkit-daemon/internal/protocol"
)

// TestTapFiresShellAction drives the full daemon with a mock device: a key tap
// (down then a quick up) should run the bound shell action and publish a gesture.
func TestTapFiresShellAction(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell sentinel uses a POSIX shell")
	}
	dir := t.TempDir()
	sentinel := filepath.Join(dir, "fired")
	cfgPath := filepath.Join(dir, "config.yaml")
	cfg := `
device: { vid: 0x1189, pid: 0x8890, usage_page: 0xFF60 }
server: { http_addr: "127.0.0.1:0", web_ui: false }
gestures: { hold_ms: 400 }
bindings:
  key1:
    tap: { type: shell, command: "touch ` + sentinel + `" }
`
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}

	a, err := New(Options{ConfigPath: cfgPath, Mock: true})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go a.Run(ctx)
	time.Sleep(100 * time.Millisecond) // let goroutines start

	// key1 down, then up ~50ms later (below the 400ms hold threshold) -> tap.
	down := make([]byte, protocol.ReportSize)
	down[0] = protocol.TypeInputEvent
	down[1] = protocol.SlotKey1
	down[2] = protocol.ActionKeyDown
	up := make([]byte, protocol.ReportSize)
	up[0] = protocol.TypeInputEvent
	up[1] = protocol.SlotKey1
	up[2] = protocol.ActionKeyUp

	if err := a.InjectInput(down); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if err := a.InjectInput(up); err != nil {
		t.Fatal(err)
	}

	// Wait for the shell action's sentinel file.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sentinel); err == nil {
			// Also confirm the gesture was published.
			if g, ok := a.broker.Last(); !ok || g.Control != "key1" || g.Kind != "tap" {
				t.Fatalf("broker missing tap gesture: %+v ok=%v", g, ok)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("shell action did not fire within timeout")
}
