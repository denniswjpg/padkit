// SPDX-License-Identifier: MIT
//
// padkitd is the PadKit companion daemon: it reads the macropad over its vendor-
// HID interface, runs configured actions (keystroke/shell/webhook/led), serves a
// local config web UI + HTTP API, and can run as an MCP server so coding agents
// can drive the pad.
//
// Usage:
//
//	padkitd serve  [--config path] [--mock]         # run the daemon (default)
//	padkitd mcp    [--config path] [--url URL] [--direct]  # MCP stdio server
//	padkitd version
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/padkit/padkit-daemon/internal/app"
	"github.com/padkit/padkit-daemon/internal/config"
	"github.com/padkit/padkit-daemon/internal/hid"
	"github.com/padkit/padkit-daemon/internal/ledctl"
	"github.com/padkit/padkit-daemon/internal/mcp"
)

const version = "0.3.0"

func main() {
	if len(os.Args) < 2 {
		os.Args = append(os.Args, "serve")
	}
	cmd := os.Args[1]
	args := os.Args[2:]
	switch cmd {
	case "serve":
		runServe(args)
	case "mcp":
		runMCP(args)
	case "version", "-v", "--version":
		fmt.Println("padkitd", version)
	case "help", "-h", "--help":
		usage()
	default:
		// Allow `padkitd --config x` (implicit serve).
		if len(cmd) > 0 && cmd[0] == '-' {
			runServe(os.Args[1:])
			return
		}
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", cmd)
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `padkitd — PadKit companion daemon

Commands:
  serve    Run the daemon: HID gesture loop, actions, web UI + HTTP API (default)
  mcp      Run as an MCP stdio server for coding agents
  version  Print version

Run "padkitd <command> -h" for command flags.
`)
}

func newLogger(level string) *slog.Logger {
	var lv slog.Level
	switch level {
	case "debug":
		lv = slog.LevelDebug
	case "warn":
		lv = slog.LevelWarn
	case "error":
		lv = slog.LevelError
	default:
		lv = slog.LevelInfo
	}
	// Log to stderr so stdout stays clean (important for MCP mode).
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lv}))
}

func runServe(args []string) {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	cfgPath := fs.String("config", defaultConfigPath(), "path to config.yaml")
	mock := fs.Bool("mock", false, "use a mock device (no hardware) for testing")
	logLevel := fs.String("log", "info", "log level: debug|info|warn|error")
	fs.Parse(args)

	log := newLogger(*logLevel)
	slog.SetDefault(log)

	if err := ensureConfig(*cfgPath); err != nil {
		log.Error("config", "err", err)
		os.Exit(1)
	}

	a, err := app.New(app.Options{ConfigPath: *cfgPath, Mock: *mock, Log: log})
	if err != nil {
		log.Error("startup failed", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := a.Run(ctx); err != nil {
		log.Error("run failed", "err", err)
		os.Exit(1)
	}
	log.Info("shut down cleanly")
}

func runMCP(args []string) {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	url := fs.String("url", "http://127.0.0.1:8787", "base URL of a running daemon's HTTP API")
	direct := fs.Bool("direct", false, "open the HID device directly instead of bridging to a daemon")
	cfgPath := fs.String("config", defaultConfigPath(), "config path (used only with --direct)")
	logLevel := fs.String("log", "warn", "log level")
	fs.Parse(args)

	log := newLogger(*logLevel)
	slog.SetDefault(log)

	var backend mcp.Backend
	if *direct {
		cfg, err := config.Load(*cfgPath)
		if err != nil {
			log.Error("config", "err", err)
			os.Exit(1)
		}
		dev, err := hid.Open(cfg.Device.VID, cfg.Device.PID, cfg.Device.UsagePage)
		if err != nil {
			log.Error("open device (direct mode)", "err", err)
			os.Exit(1)
		}
		defer dev.Close()
		backend = &mcp.DirectBackend{LED: ledctl.New(dev)}
		log.Warn("MCP direct mode: gesture reads unavailable; LED control only")
	} else {
		backend = mcp.NewHTTPBackend(*url)
	}

	srv := &mcp.Server{Backend: backend, Log: log}
	if err := srv.Serve(os.Stdin, os.Stdout); err != nil {
		log.Error("mcp server", "err", err)
		os.Exit(1)
	}
}

func defaultConfigPath() string {
	if p := os.Getenv("PADKIT_CONFIG"); p != "" {
		return p
	}
	if dir, err := os.UserConfigDir(); err == nil {
		return dir + string(os.PathSeparator) + "padkit" + string(os.PathSeparator) + "config.yaml"
	}
	return "config.yaml"
}

// ensureConfig writes a starter config if none exists at path.
func ensureConfig(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(starterConfig), 0o644)
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == os.PathSeparator {
			return path[:i]
		}
	}
	return "."
}

const starterConfig = `# PadKit daemon config. See daemon/README.md and examples/configs/.
device:
  vid: 0x1189
  pid: 0x8890
  usage_page: 0xFF60
  suppress_keyboard: false   # set true to let the daemon own the pad (no keystroke leakage)

server:
  http_addr: "127.0.0.1:8787"
  web_ui: true

gestures:
  hold_ms: 400               # tap-vs-hold threshold for the six keys

bindings:
  key1:
    tap:   { type: shell, command: "echo key1 tap" }
    hold:  { type: led, led: { slot: 0, color: "#ff0000", flash: true } }
  knob_cw:
    type: led
    led: { brightness: 255 }
  knob_ccw:
    type: led
    led: { brightness: 40 }
`
