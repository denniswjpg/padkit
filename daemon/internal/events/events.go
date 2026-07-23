// SPDX-License-Identifier: MIT
//
// Package events is a tiny in-process pub/sub for pad gestures. The HTTP SSE
// endpoint and any local subscribers use it; it also remembers the last event so
// "get_last_event" style polling works.
package events

import (
	"sync"
	"time"
)

// Gesture is a serializable pad event.
type Gesture struct {
	Control string    `json:"control"` // canonical control name (key1, knob_cw, ...)
	Slot    int       `json:"slot"`
	Kind    string    `json:"kind"` // tap, hold, knob_cw, ...
	At      time.Time `json:"at"`
	Seq     uint64    `json:"seq"`
}

// Broker fans out gestures to subscribers and retains the latest.
type Broker struct {
	mu     sync.RWMutex
	subs   map[int]chan Gesture
	nextID int
	seq    uint64
	last   *Gesture
}

// NewBroker returns an empty Broker.
func NewBroker() *Broker {
	return &Broker{subs: make(map[int]chan Gesture)}
}

// Publish records and fans out a gesture. Slow subscribers are skipped (never
// blocks the gesture loop).
func (b *Broker) Publish(g Gesture) {
	b.mu.Lock()
	b.seq++
	g.Seq = b.seq
	cp := g
	b.last = &cp
	subs := make([]chan Gesture, 0, len(b.subs))
	for _, ch := range b.subs {
		subs = append(subs, ch)
	}
	b.mu.Unlock()
	for _, ch := range subs {
		select {
		case ch <- g:
		default:
		}
	}
}

// Last returns the most recent gesture, or false if none yet.
func (b *Broker) Last() (Gesture, bool) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.last == nil {
		return Gesture{}, false
	}
	return *b.last, true
}

// Subscribe returns a channel of future gestures and an unsubscribe func.
func (b *Broker) Subscribe() (<-chan Gesture, func()) {
	b.mu.Lock()
	id := b.nextID
	b.nextID++
	ch := make(chan Gesture, 16)
	b.subs[id] = ch
	b.mu.Unlock()
	return ch, func() {
		b.mu.Lock()
		if c, ok := b.subs[id]; ok {
			delete(b.subs, id)
			close(c)
		}
		b.mu.Unlock()
	}
}
