// SPDX-License-Identifier: MIT
//
// Package gestures turns the raw INPUT_EVENT stream (key down/up, knob, push-turn)
// into high-level gestures. Host-side timing implements tap-vs-hold on the six
// keys; the knob and push-turn controls are momentary. The state machine takes an
// explicit "now" on every call so it is deterministic and unit-testable without a
// real clock.
package gestures

import (
	"time"

	"github.com/padkit/padkit-daemon/internal/protocol"
)

// Kind enumerates the emitted gesture kinds.
type Kind int

const (
	KindTap Kind = iota // key pressed and released before the hold threshold
	KindHold            // key held past the hold threshold (fires once, at threshold)
	KindKnobCW
	KindKnobCCW
	KindKnobClick
	KindPushTurnCW
	KindPushTurnCCW
)

func (k Kind) String() string {
	switch k {
	case KindTap:
		return "tap"
	case KindHold:
		return "hold"
	case KindKnobCW:
		return "knob_cw"
	case KindKnobCCW:
		return "knob_ccw"
	case KindKnobClick:
		return "knob_click"
	case KindPushTurnCW:
		return "pushturn_cw"
	case KindPushTurnCCW:
		return "pushturn_ccw"
	default:
		return "unknown"
	}
}

// Event is a decoded gesture ready to drive an action.
type Event struct {
	Control int // control slot (protocol.SlotKey1 .. SlotPushTurnCW)
	Kind    Kind
	At      time.Time
}

// Machine is the tap/hold state machine. Not safe for concurrent use; drive it
// from a single goroutine. HoldThreshold is the tap-vs-hold boundary for keys.
type Machine struct {
	HoldThreshold time.Duration
	keys          [protocol.NumKeys]keyState
}

type keyState struct {
	down      bool
	pressedAt time.Time
	held      bool // hold already emitted for this press
}

// New returns a Machine with the given hold threshold (default 400ms if <=0).
func New(hold time.Duration) *Machine {
	if hold <= 0 {
		hold = 400 * time.Millisecond
	}
	return &Machine{HoldThreshold: hold}
}

// HandleInput feeds one parsed INPUT_EVENT and returns any gestures it produced.
// For keys, a Tap is emitted on release before the threshold; a Hold is emitted
// by Tick once the threshold is crossed (not here). Knob/click/push-turn events
// are momentary and emitted immediately.
func (m *Machine) HandleInput(ev protocol.InputEvent, now time.Time) []Event {
	switch ev.Action {
	case protocol.ActionKeyDown:
		if ev.Control >= 0 && ev.Control < protocol.NumKeys {
			m.keys[ev.Control] = keyState{down: true, pressedAt: now}
		}
		return nil
	case protocol.ActionKeyUp:
		if ev.Control >= 0 && ev.Control < protocol.NumKeys {
			ks := m.keys[ev.Control]
			m.keys[ev.Control] = keyState{}
			if ks.down && !ks.held {
				// released before hold threshold -> tap
				return []Event{{Control: ev.Control, Kind: KindTap, At: now}}
			}
			// hold already fired on release: nothing more
		}
		return nil
	case protocol.ActionKnobCW:
		return []Event{{Control: protocol.SlotKnobCW, Kind: KindKnobCW, At: now}}
	case protocol.ActionKnobCCW:
		return []Event{{Control: protocol.SlotKnobCCW, Kind: KindKnobCCW, At: now}}
	case protocol.ActionKnobClick:
		return []Event{{Control: protocol.SlotKnobClick, Kind: KindKnobClick, At: now}}
	case protocol.ActionPushTurnCW:
		return []Event{{Control: protocol.SlotPushTurnCW, Kind: KindPushTurnCW, At: now}}
	case protocol.ActionPushTurnCCW:
		return []Event{{Control: protocol.SlotPushTurnCCW, Kind: KindPushTurnCCW, At: now}}
	default:
		return nil
	}
}

// Tick advances time-based state and emits Hold for any key held past the
// threshold. Call it periodically (e.g. every ~20ms) with the current time.
func (m *Machine) Tick(now time.Time) []Event {
	var out []Event
	for slot := range m.keys {
		ks := &m.keys[slot]
		if ks.down && !ks.held && now.Sub(ks.pressedAt) >= m.HoldThreshold {
			ks.held = true
			out = append(out, Event{Control: slot, Kind: KindHold, At: now})
		}
	}
	return out
}
