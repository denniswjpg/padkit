// SPDX-License-Identifier: MIT
//
// Package app wires the daemon together: it opens the pad (or a mock), runs the
// gesture loop, dispatches configured actions, serves the local HTTP API/UI, and
// hot-reloads the config file on change.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/padkit/padkit-daemon/internal/actions"
	"github.com/padkit/padkit-daemon/internal/config"
	"github.com/padkit/padkit-daemon/internal/events"
	"github.com/padkit/padkit-daemon/internal/gestures"
	"github.com/padkit/padkit-daemon/internal/hid"
	"github.com/padkit/padkit-daemon/internal/ledctl"
	"github.com/padkit/padkit-daemon/internal/protocol"
	"github.com/padkit/padkit-daemon/internal/webui"
)

// Options control how the daemon starts.
type Options struct {
	ConfigPath string
	Mock       bool // use a MockDevice instead of real hardware (for testing/dev)
	Log        *slog.Logger
}

// App is a running daemon instance.
type App struct {
	opts   Options
	log    *slog.Logger
	dev    hid.Device
	led    *ledctl.Controller
	broker *events.Broker
	disp   *actions.Dispatcher

	mu        sync.RWMutex
	cfg       config.Config
	connected bool
}

// New loads config and opens the device (or mock).
func New(opts Options) (*App, error) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	cfg, err := config.Load(opts.ConfigPath)
	if err != nil {
		return nil, err
	}
	a := &App{opts: opts, log: opts.Log, cfg: cfg, broker: events.NewBroker()}

	if opts.Mock {
		a.dev = hid.NewMockDevice(hid.Info{
			VendorID: cfg.Device.VID, ProductID: cfg.Device.PID, UsagePage: cfg.Device.UsagePage,
			Product: "PadKit (mock)",
		})
		a.connected = false
		a.log.Warn("running with a MOCK device: no hardware I/O")
	} else {
		dev, err := hid.Open(cfg.Device.VID, cfg.Device.PID, cfg.Device.UsagePage)
		if err != nil {
			return nil, err
		}
		a.dev = dev
		a.connected = true
		a.log.Info("opened pad", "path", dev.Info().Path, "product", dev.Info().Product)
	}

	a.led = ledctl.New(a.dev)
	a.disp = actions.New(a.led, a.log)

	// Apply SUPPRESS_KEYBOARD if configured (daemon owns the pad).
	if cfg.Device.SuppressKeyboard {
		if err := a.led.SetFlags(protocol.FlagSuppressKeyboard); err != nil {
			a.log.Warn("could not set SUPPRESS_KEYBOARD flag", "err", err)
		} else {
			a.log.Info("SUPPRESS_KEYBOARD set: keystrokes are suppressed, daemon owns the pad")
		}
	}
	return a, nil
}

// Device exposes the underlying device (used by MCP direct mode).
func (a *App) Device() hid.Device { return a.dev }

// LED exposes the LED controller.
func (a *App) LED() *ledctl.Controller { return a.led }

func (a *App) currentConfig() config.Config {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.cfg
}

// Run starts the gesture loop, HTTP server, and config watcher until ctx is done.
func (a *App) Run(ctx context.Context) error {
	defer a.dev.Close()

	var wg sync.WaitGroup

	// Gesture loop.
	wg.Add(1)
	go func() {
		defer wg.Done()
		a.gestureLoop(ctx)
	}()

	// Config watcher (hot reload).
	wg.Add(1)
	go func() {
		defer wg.Done()
		a.watchConfig(ctx)
	}()

	// HTTP server.
	cfg := a.currentConfig()
	srv := &http.Server{
		Addr:    cfg.Server.HTTPAddr,
		Handler: a.httpHandler(cfg.Server.WebUI),
	}
	serverErr := make(chan error, 1)
	go func() {
		a.log.Info("http listening", "addr", cfg.Server.HTTPAddr, "ui", cfg.Server.WebUI)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	select {
	case <-ctx.Done():
	case err := <-serverErr:
		a.log.Error("http server failed", "err", err)
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	wg.Wait()
	return nil
}

func (a *App) httpHandler(serveUI bool) http.Handler {
	return webui.Handler(webui.Deps{
		LED:       a.led,
		Broker:    a.broker,
		Log:       a.log,
		Connected: func() bool { a.mu.RLock(); defer a.mu.RUnlock(); return a.connected },
		DeviceVID: func() uint16 { return a.currentConfig().Device.VID },
		DevicePID: func() uint16 { return a.currentConfig().Device.PID },
		UsagePage: func() uint16 { return a.currentConfig().Device.UsagePage },
		GetConfigYAML: func() (string, error) {
			b, err := os.ReadFile(a.opts.ConfigPath)
			return string(b), err
		},
		SetConfigYAML: func(text string) error {
			if _, err := config.Parse([]byte(text)); err != nil {
				return err
			}
			return os.WriteFile(a.opts.ConfigPath, []byte(text), 0o644)
		},
		ServeUI: serveUI,
	})
}

// gestureLoop reads input reports, runs the tap/hold machine, and dispatches
// actions. A ticker drives Tick so holds fire at the threshold.
func (a *App) gestureLoop(ctx context.Context) {
	machine := gestures.New(time.Duration(a.currentConfig().Gestures.HoldMS) * time.Millisecond)

	// Reader goroutine feeds parsed input events onto a channel.
	inputs := make(chan protocol.InputEvent, 32)
	go func() {
		buf := make([]byte, 64)
		for {
			n, err := a.dev.ReadReport(buf)
			if err != nil {
				if ctx.Err() == nil && !errors.Is(err, hid.ErrClosed) {
					a.log.Debug("hid read ended", "err", err)
				}
				close(inputs)
				return
			}
			parsed, perr := protocol.ParseInput(buf[:n])
			if perr != nil || parsed.Type != protocol.ParsedInputEvent {
				continue
			}
			select {
			case inputs <- parsed.InputEvent:
			case <-ctx.Done():
				return
			}
		}
	}()

	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		// keep the hold threshold in sync with hot-reloaded config
		machine.HoldThreshold = time.Duration(a.currentConfig().Gestures.HoldMS) * time.Millisecond
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-inputs:
			if !ok {
				return
			}
			for _, g := range machine.HandleInput(ev, time.Now()) {
				a.emit(ctx, g)
			}
		case now := <-ticker.C:
			for _, g := range machine.Tick(now) {
				a.emit(ctx, g)
			}
		}
	}
}

// emit publishes a gesture and runs its bound action (async so a slow shell/HTTP
// action never stalls the input loop).
func (a *App) emit(ctx context.Context, g gestures.Event) {
	name := config.NameForSlot(g.Control)
	a.broker.Publish(events.Gesture{
		Control: name,
		Slot:    g.Control,
		Kind:    g.Kind.String(),
		At:      g.At,
	})
	hold := g.Kind == gestures.KindHold
	act := a.currentConfig().Resolve(g.Control, hold)
	if act == nil {
		a.log.Debug("gesture with no binding", "control", name, "kind", g.Kind)
		return
	}
	go func() {
		actx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		if err := a.disp.Run(actx, act); err != nil {
			a.log.Error("action failed", "control", name, "kind", g.Kind.String(), "type", act.Type, "err", err)
		}
	}()
}

// watchConfig reloads the config file when it changes on disk.
func (a *App) watchConfig(ctx context.Context) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		a.log.Warn("config watch disabled", "err", err)
		return
	}
	defer w.Close()
	if err := w.Add(a.opts.ConfigPath); err != nil {
		a.log.Warn("cannot watch config file", "err", err)
		return
	}
	debounce := time.NewTimer(time.Hour)
	debounce.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			if ev.Op&(fsnotify.Write|fsnotify.Create) != 0 {
				debounce.Reset(150 * time.Millisecond)
			}
			// Some editors replace the file; re-add the watch.
			if ev.Op&fsnotify.Remove != 0 {
				_ = w.Add(a.opts.ConfigPath)
			}
		case <-debounce.C:
			a.reload()
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			a.log.Warn("config watcher error", "err", err)
		}
	}
}

func (a *App) reload() {
	cfg, err := config.Load(a.opts.ConfigPath)
	if err != nil {
		a.log.Error("config reload failed (keeping previous)", "err", err)
		return
	}
	a.mu.Lock()
	suppressChanged := cfg.Device.SuppressKeyboard != a.cfg.Device.SuppressKeyboard
	a.cfg = cfg
	a.mu.Unlock()
	if suppressChanged {
		var flags byte
		if cfg.Device.SuppressKeyboard {
			flags = protocol.FlagSuppressKeyboard
		}
		if err := a.led.SetFlags(flags); err != nil {
			a.log.Warn("could not update SUPPRESS_KEYBOARD", "err", err)
		}
	}
	a.log.Info("config reloaded", "bindings", len(cfg.Bindings))
}

// InjectInput is a test hook: feed a raw input report as if it came from the pad
// (only meaningful with a MockDevice).
func (a *App) InjectInput(report []byte) error {
	m, ok := a.dev.(*hid.MockDevice)
	if !ok {
		return fmt.Errorf("InjectInput requires a mock device")
	}
	m.PushReport(report)
	return nil
}
