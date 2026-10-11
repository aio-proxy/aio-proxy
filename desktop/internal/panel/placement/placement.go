// Package placement positions the panel below the tray icon on its display.
package placement

import "math"

// Frame is a rectangle in global, top-left-origin device-independent points,
// matching MyGo tray and screen bounds (not AppKit's bottom-left coordinates).
type Frame struct {
	X, Y, Width, Height float64
}

// PanelOrigin centers the panel under statusWindow and clamps it to screen's
// horizontal bounds. It returns global coordinates, preserving the origin of
// secondary displays. A display narrower than the panel pins its left edge.
func PanelOrigin(statusWindow, screen Frame, panelWidth float64) (x, y float64) {
	anchor := statusWindow.X + statusWindow.Width/2
	maxLeft := math.Max(screen.X+screen.Width-panelWidth, screen.X)
	left := math.Max(screen.X, math.Min(anchor-panelWidth/2, maxLeft))
	// Round relative to the display, as the Rust panel did to avoid AppKit
	// widening a window whose origin lands on a half point.
	x = screen.X + math.Round(left-screen.X)
	y = statusWindow.Y + statusWindow.Height
	return x, y
}
