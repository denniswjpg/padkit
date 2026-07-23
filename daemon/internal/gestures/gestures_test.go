// SPDX-License-Identifier: MIT

package gestures

import (
	"testing"
	"time"

	"github.com/padkit/padkit-daemon/internal/protocol"
)

func down(slot int) protocol.InputEvent {
	return protocol.InputEvent{Control: slot, Action: protocol.ActionKeyDown}
}
func up(slot int) protocol.InputEvent {
	return protocol.InputEvent{Control: slot, Action: protocol.ActionKeyUp}
}

func TestTapBelowThreshold(t *testing.T) {
	m := New(400 * time.Millisecond)
	t0 := time.Unix(0, 0)
	if evs := m.HandleInput(down(protocol.SlotKey1), t0); len(evs) != 0 {
		t.Fatalf("key down should not emit, got %v", evs)
	}
	// Tick well before threshold: no hold.
	if evs := m.Tick(t0.Add(100 * time.Millisecond)); len(evs) != 0 {
		t.Fatalf("early tick should not emit hold, got %v", evs)
	}
	evs := m.HandleInput(up(protocol.SlotKey1), t0.Add(150*time.Millisecond))
	if len(evs) != 1 || evs[0].Kind != KindTap || evs[0].Control != protocol.SlotKey1 {
		t.Fatalf("expected one tap on key1, got %v", evs)
	}
}

func TestHoldAtThresholdFiresOnceAndSuppressesTap(t *testing.T) {
	m := New(400 * time.Millisecond)
	t0 := time.Unix(0, 0)
	m.HandleInput(down(protocol.SlotKey3), t0)

	// Tick past threshold -> exactly one hold.
	evs := m.Tick(t0.Add(400 * time.Millisecond))
	if len(evs) != 1 || evs[0].Kind != KindHold || evs[0].Control != protocol.SlotKey3 {
		t.Fatalf("expected one hold on key3, got %v", evs)
	}
	// A later tick must not re-fire hold.
	if evs := m.Tick(t0.Add(700 * time.Millisecond)); len(evs) != 0 {
		t.Fatalf("hold must fire only once, got %v", evs)
	}
	// Release after a hold emits nothing (no tap).
	if evs := m.HandleInput(up(protocol.SlotKey3), t0.Add(900*time.Millisecond)); len(evs) != 0 {
		t.Fatalf("release after hold should emit nothing, got %v", evs)
	}
}

func TestMomentaryControls(t *testing.T) {
	m := New(400 * time.Millisecond)
	now := time.Unix(0, 0)
	cases := []struct {
		action int
		kind   Kind
		slot   int
	}{
		{protocol.ActionKnobCW, KindKnobCW, protocol.SlotKnobCW},
		{protocol.ActionKnobCCW, KindKnobCCW, protocol.SlotKnobCCW},
		{protocol.ActionKnobClick, KindKnobClick, protocol.SlotKnobClick},
		{protocol.ActionPushTurnCW, KindPushTurnCW, protocol.SlotPushTurnCW},
		{protocol.ActionPushTurnCCW, KindPushTurnCCW, protocol.SlotPushTurnCCW},
	}
	for _, c := range cases {
		evs := m.HandleInput(protocol.InputEvent{Action: c.action}, now)
		if len(evs) != 1 || evs[0].Kind != c.kind || evs[0].Control != c.slot {
			t.Fatalf("action %#x: expected kind %v slot %d, got %v", c.action, c.kind, c.slot, evs)
		}
	}
}

func TestTwoKeysIndependentHold(t *testing.T) {
	m := New(300 * time.Millisecond)
	t0 := time.Unix(0, 0)
	m.HandleInput(down(protocol.SlotKey1), t0)
	m.HandleInput(down(protocol.SlotKey2), t0.Add(100*time.Millisecond))

	// At t0+300, key1 has been held 300ms (hold), key2 only 200ms (no hold).
	evs := m.Tick(t0.Add(300 * time.Millisecond))
	if len(evs) != 1 || evs[0].Control != protocol.SlotKey1 || evs[0].Kind != KindHold {
		t.Fatalf("only key1 should hold at t+300, got %v", evs)
	}
	// key2 taps if released quickly.
	evs = m.HandleInput(up(protocol.SlotKey2), t0.Add(320*time.Millisecond))
	if len(evs) != 1 || evs[0].Control != protocol.SlotKey2 || evs[0].Kind != KindTap {
		t.Fatalf("key2 should tap, got %v", evs)
	}
}
