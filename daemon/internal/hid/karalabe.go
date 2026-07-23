// SPDX-License-Identifier: MIT
//
// Real Device implementation over github.com/karalabe/hid, which vendors both
// hidapi and libusb as C sources -- so this builds with cgo and gcc + a C
// toolchain, but needs NO system HID/udev development packages. That is why it
// is preferred here: no libudev-dev headache on Linux.
//
// Report-ID convention: PadKit's vendor interface uses NO report IDs (report ID
// 0). hidapi still treats the first byte of a written buffer as the report ID
// and strips it when 0. karalabe/hid prepends a 0x00 itself ONLY on Windows, so:
//   - Linux/macOS: we prepend the 0x00 ourselves.
//   - Windows:     karalabe adds it, so we must NOT prepend.
// The net wire result is exactly one leading report-ID byte on every platform.
package hid

import (
	"fmt"
	"runtime"

	khid "github.com/karalabe/hid"
)

// karalabeDevice adapts *khid.Device to our Device interface.
type karalabeDevice struct {
	dev  *khid.Device
	info Info
}

// Supported reports whether this build has a working HID backend (cgo enabled).
func Supported() bool { return khid.Supported() }

// Enumerate lists vendor collections matching usagePage. Pass vid/pid 0 to match
// any. Only entries whose UsagePage == usagePage are returned, implementing the
// spec's "open the 0xFF60 collection, never the keyboard collection" rule.
func Enumerate(vid, pid, usagePage uint16) []Info {
	var out []Info
	for _, d := range khid.Enumerate(vid, pid) {
		if usagePage != 0 && d.UsagePage != usagePage {
			continue
		}
		out = append(out, Info{
			Path:      d.Path,
			VendorID:  d.VendorID,
			ProductID: d.ProductID,
			UsagePage: d.UsagePage,
			Interface: d.Interface,
			Product:   d.Product,
			Serial:    d.Serial,
		})
	}
	return out
}

// Open opens the first vendor collection matching vid/pid/usagePage. It selects
// strictly by usagePage so the keyboard collection is never opened.
func Open(vid, pid, usagePage uint16) (Device, error) {
	if !khid.Supported() {
		return nil, fmt.Errorf("hid: no HID backend in this build (cgo disabled)")
	}
	matches := khid.Enumerate(vid, pid)
	var chosen *khid.DeviceInfo
	for i := range matches {
		if usagePage != 0 && matches[i].UsagePage != usagePage {
			continue
		}
		chosen = &matches[i]
		break
	}
	if chosen == nil {
		return nil, fmt.Errorf("hid: no vendor collection found (vid=%#04x pid=%#04x usagePage=%#04x); is the pad plugged in and is the udev rule installed?", vid, pid, usagePage)
	}
	dev, err := chosen.Open()
	if err != nil {
		return nil, fmt.Errorf("hid: open %s: %w", chosen.Path, err)
	}
	return &karalabeDevice{
		dev: dev,
		info: Info{
			Path:      chosen.Path,
			VendorID:  chosen.VendorID,
			ProductID: chosen.ProductID,
			UsagePage: chosen.UsagePage,
			Interface: chosen.Interface,
			Product:   chosen.Product,
			Serial:    chosen.Serial,
		},
	}, nil
}

func (k *karalabeDevice) WriteReport(payload []byte) error {
	var out []byte
	if runtime.GOOS == "windows" {
		// karalabe/hid prepends the report-ID byte for us on Windows.
		out = payload
	} else {
		// Prepend the report-ID byte (0x00) so hidapi strips it and sends the
		// true payload on the wire.
		out = make([]byte, len(payload)+1)
		copy(out[1:], payload)
	}
	_, err := k.dev.Write(out)
	return err
}

func (k *karalabeDevice) ReadReport(buf []byte) (int, error) {
	return k.dev.Read(buf)
}

func (k *karalabeDevice) Close() error { return k.dev.Close() }

func (k *karalabeDevice) Info() Info { return k.info }
