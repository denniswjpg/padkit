// SPDX-License-Identifier: MIT
//
// Best-effort cross-platform keystroke injection. This is deliberately simple:
// it shells out to the platform's standard automation tool. It is documented as
// BEST-EFFORT -- shell, webhook, and led actions are the solid paths. If no tool
// is available the action returns a clear, actionable error.
//
//   - Linux (X11):     xdotool
//   - Linux (Wayland): wtype (or ydotool with a running ydotoold)
//   - macOS:           osascript (System Events) -- needs Accessibility permission
//   - Windows:         powershell SendKeys
//
// Key spec grammar for the `keys` field: "+"-separated chord, e.g.
// "ctrl+shift+p", "cmd+space", "alt+F4", "enter". Use the `text` field to type a
// literal string instead.
package actions

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"

	"github.com/padkit/padkit-daemon/internal/config"
)

func (d *Dispatcher) runKeystroke(a *config.Action) error {
	if a.Text != "" {
		return typeText(a.Text)
	}
	return sendChord(a.Keys)
}

// have reports whether a command is on PATH.
func have(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func run(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w (%s)", name, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func typeText(text string) error {
	switch runtime.GOOS {
	case "linux":
		switch {
		case have("wtype"):
			return run("wtype", text)
		case have("xdotool"):
			return run("xdotool", "type", "--clearmodifiers", text)
		case have("ydotool"):
			return run("ydotool", "type", text)
		}
		return fmt.Errorf("keystroke(text): install xdotool (X11) or wtype/ydotool (Wayland)")
	case "darwin":
		script := fmt.Sprintf("tell application \"System Events\" to keystroke %q", text)
		return run("osascript", "-e", script)
	case "windows":
		ps := fmt.Sprintf("[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.SendKeys]::SendWait(%q)", escapeSendKeys(text))
		return run("powershell", "-NoProfile", "-Command", ps)
	}
	return fmt.Errorf("keystroke(text): unsupported OS %q", runtime.GOOS)
}

func sendChord(spec string) error {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return fmt.Errorf("keystroke: empty key spec")
	}
	switch runtime.GOOS {
	case "linux":
		switch {
		case have("xdotool"):
			return run("xdotool", "key", "--clearmodifiers", xdotoolChord(spec))
		case have("wtype"):
			return wtypeChord(spec)
		case have("ydotool"):
			return run("ydotool", "key", spec) // ydotool uses keycodes; best-effort
		}
		return fmt.Errorf("keystroke: install xdotool (X11) or wtype/ydotool (Wayland)")
	case "darwin":
		return run("osascript", "-e", osascriptChord(spec))
	case "windows":
		return run("powershell", "-NoProfile", "-Command",
			fmt.Sprintf("[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.SendKeys]::SendWait(%q)", sendKeysChord(spec)))
	}
	return fmt.Errorf("keystroke: unsupported OS %q", runtime.GOOS)
}

// xdotoolChord maps "ctrl+shift+p" -> "ctrl+shift+p" (xdotool's own syntax,
// which is already +-separated with names like ctrl/shift/alt/super).
func xdotoolChord(spec string) string {
	parts := strings.Split(spec, "+")
	for i, p := range parts {
		parts[i] = normalizeMod(p, "super")
	}
	return strings.Join(parts, "+")
}

func wtypeChord(spec string) error {
	parts := strings.Split(spec, "+")
	args := []string{}
	for i, p := range parts {
		mod := normalizeMod(p, "logo")
		if i < len(parts)-1 {
			args = append(args, "-M", mod)
		} else {
			args = append(args, "-k", p)
		}
	}
	// release modifiers
	for i := 0; i < len(parts)-1; i++ {
		args = append(args, "-m", normalizeMod(parts[i], "logo"))
	}
	return run("wtype", args...)
}

// osascriptChord builds a System Events keystroke with modifiers.
func osascriptChord(spec string) string {
	parts := strings.Split(spec, "+")
	key := parts[len(parts)-1]
	var mods []string
	for _, p := range parts[:len(parts)-1] {
		switch strings.ToLower(p) {
		case "ctrl", "control":
			mods = append(mods, "control down")
		case "shift":
			mods = append(mods, "shift down")
		case "alt", "option":
			mods = append(mods, "option down")
		case "cmd", "command", "super", "meta", "gui":
			mods = append(mods, "command down")
		}
	}
	base := fmt.Sprintf("keystroke %q", key)
	if len(mods) > 0 {
		base += " using {" + strings.Join(mods, ", ") + "}"
	}
	return "tell application \"System Events\" to " + base
}

// sendKeysChord maps a chord to Windows SendKeys syntax (^ = ctrl, + = shift,
// % = alt).
func sendKeysChord(spec string) string {
	parts := strings.Split(spec, "+")
	key := parts[len(parts)-1]
	var prefix string
	for _, p := range parts[:len(parts)-1] {
		switch strings.ToLower(p) {
		case "ctrl", "control":
			prefix += "^"
		case "shift":
			prefix += "+"
		case "alt", "option":
			prefix += "%"
		}
	}
	return prefix + escapeSendKeys(key)
}

func escapeSendKeys(s string) string {
	r := strings.NewReplacer("+", "{+}", "^", "{^}", "%", "{%}", "~", "{~}", "(", "{(}", ")", "{)}", "{", "{{}", "}", "{}}", "[", "{[}", "]", "{]}")
	return r.Replace(s)
}

func normalizeMod(p, superName string) string {
	switch strings.ToLower(p) {
	case "ctrl", "control":
		return "ctrl"
	case "shift":
		return "shift"
	case "alt", "option":
		return "alt"
	case "cmd", "command", "super", "meta", "gui", "win":
		return superName
	default:
		return p
	}
}
