// SPDX-License-Identifier: MIT
//
// Package hid abstracts the vendor-HID transport behind a small interface so the
// gesture, action, and LED logic can be exercised with a mock and no hardware.
// The real implementation (karalabe.go) is a thin adapter over a vendored
// hidapi/libusb binding; the mock (below) needs no cgo and no device.
package hid

import (
	"errors"
	"sync"
)

// ErrClosed is returned by a closed device.
var ErrClosed = errors.New("hid: device closed")

// Info describes an opened (or enumerable) vendor interface.
type Info struct {
	Path      string
	VendorID  uint16
	ProductID uint16
	UsagePage uint16
	Usage     uint16
	Interface int
	Product   string
	Serial    string
}

// Device is the minimal transport the daemon needs.
//
// WriteReport sends one report payload (byte[0] = command, up to 32 bytes). The
// adapter is responsible for the HID report-ID convention (see karalabe.go), so
// callers pass the raw protocol payload only.
//
// ReadReport blocks until a report arrives (or the device is closed) and fills
// buf with the raw device->host bytes, returning the number read. Close causes
// a pending ReadReport to fail so the reader goroutine can exit.
type Device interface {
	WriteReport(payload []byte) error
	ReadReport(buf []byte) (int, error)
	Close() error
	Info() Info
}

// MockDevice is an in-memory Device for tests. Reads are driven by a channel of
// canned reports; writes are recorded. It is safe for concurrent use.
type MockDevice struct {
	info    Info
	reads   chan []byte
	mu      sync.Mutex
	writes  [][]byte
	closed  bool
	closeCh chan struct{}
}

// NewMockDevice returns a MockDevice with an optional canned Info.
func NewMockDevice(info Info) *MockDevice {
	return &MockDevice{
		info:    info,
		reads:   make(chan []byte, 64),
		closeCh: make(chan struct{}),
	}
}

// PushReport queues a device->host report to be returned by the next ReadReport.
func (m *MockDevice) PushReport(report []byte) {
	m.reads <- report
}

// Writes returns a copy of every payload passed to WriteReport, in order.
func (m *MockDevice) Writes() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([][]byte, len(m.writes))
	for i, w := range m.writes {
		cp := make([]byte, len(w))
		copy(cp, w)
		out[i] = cp
	}
	return out
}

// LastWrite returns the most recent payload, or nil if none.
func (m *MockDevice) LastWrite() []byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.writes) == 0 {
		return nil
	}
	w := m.writes[len(m.writes)-1]
	cp := make([]byte, len(w))
	copy(cp, w)
	return cp
}

// WriteReport records the payload.
func (m *MockDevice) WriteReport(payload []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ErrClosed
	}
	cp := make([]byte, len(payload))
	copy(cp, payload)
	m.writes = append(m.writes, cp)
	return nil
}

// ReadReport returns the next queued report, or fails once Close is called.
func (m *MockDevice) ReadReport(buf []byte) (int, error) {
	select {
	case r := <-m.reads:
		n := copy(buf, r)
		return n, nil
	case <-m.closeCh:
		return 0, ErrClosed
	}
}

// Close unblocks any pending ReadReport.
func (m *MockDevice) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	close(m.closeCh)
	return nil
}

// Info returns the canned device info.
func (m *MockDevice) Info() Info { return m.info }
