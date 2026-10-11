package placement

import "testing"

const panelWidth = 360.0

var mainDisplay = Frame{Width: 3008, Height: 1692}

func item(x float64) Frame {
	return Frame{X: x, Y: 0, Width: 43, Height: 32}
}

func TestCentersThePanelUnderTheIconBelowTheMenuBar(t *testing.T) {
	x, y := PanelOrigin(item(2298), mainDisplay, panelWidth)
	if x != 2140 || y != 32 {
		t.Fatalf("origin = (%v, %v), want (2140, 32)", x, y)
	}
}

func TestClampsToTheRightAndLeftScreenEdges(t *testing.T) {
	for _, test := range []struct{ iconX, wantX float64 }{{2990, 2648}, {5, 0}} {
		x, y := PanelOrigin(item(test.iconX), mainDisplay, panelWidth)
		if x != test.wantX || y != 32 {
			t.Errorf("icon x=%v: origin = (%v, %v), want (%v, 32)", test.iconX, x, y, test.wantX)
		}
	}
}

func TestUsesGlobalCoordinatesOnSecondaryDisplays(t *testing.T) {
	for _, test := range []struct {
		name         string
		screen, icon Frame
		wantX, wantY float64
	}{
		{"left", Frame{X: -1920, Y: 200, Width: 1920, Height: 1080}, Frame{X: -100, Y: 200, Width: 30, Height: 24}, -360, 224},
		{"above", Frame{X: 400, Y: -1080, Width: 1920, Height: 1080}, Frame{X: 1000, Y: -1080, Width: 30, Height: 24}, 835, -1056},
		{"right edge", Frame{X: 3008, Y: 600, Width: 1920, Height: 1080}, Frame{X: 4910, Y: 600, Width: 30, Height: 24}, 4568, 624},
		{"left edge", Frame{X: -1920, Y: 200, Width: 1920, Height: 1080}, Frame{X: -1915, Y: 200, Width: 30, Height: 24}, -1920, 224},
	} {
		t.Run(test.name, func(t *testing.T) {
			x, y := PanelOrigin(test.icon, test.screen, panelWidth)
			if x != test.wantX || y != test.wantY {
				t.Errorf("origin = (%v, %v), want (%v, %v)", x, y, test.wantX, test.wantY)
			}
		})
	}
}

func TestAScreenNarrowerThanThePanelPinsItToTheLeftEdge(t *testing.T) {
	screen := Frame{X: -300, Y: 200, Width: 300, Height: 600}
	x, y := PanelOrigin(Frame{X: -150, Y: 200, Width: 20, Height: 24}, screen, panelWidth)
	if x != -300 || y != 224 {
		t.Errorf("origin = (%v, %v), want (-300, 224)", x, y)
	}
}
