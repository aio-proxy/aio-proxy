package tray

import (
	"image"
	"image/color"
	"testing"
)

func TestSquareTrayIconKeepsTheMarkSizeAndAcceptsAColor(t *testing.T) {
	mark := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	mark.SetNRGBA(2, 3, color.NRGBA{A: 255})
	im := iconImage(Running, mark)
	if im.Bounds().Dx() != 32 || im.Bounds().Dy() != 32 {
		t.Fatalf("size %v", im.Bounds())
	}
	tint(im, [3]byte{255, 255, 255})
	if got := im.NRGBAAt(2, 3); got != (color.NRGBA{R: 255, G: 255, B: 255, A: 255}) {
		t.Fatalf("tinted pixel %+v", got)
	}
	if got := im.NRGBAAt(0, 0); got.A != 0 {
		t.Fatalf("empty pixel %+v", got)
	}
}

func TestWideTrayIconStaysTheMenuBarSize(t *testing.T) {
	mark := image.NewNRGBA(image.Rect(0, 0, IconWidth, IconHeight))
	mark.SetNRGBA(1, 1, color.NRGBA{A: 255})
	im := iconImage(Down, mark)
	if im.Bounds().Dx() != IconWidth || im.Bounds().Dy() != IconHeight {
		t.Fatalf("size %v", im.Bounds())
	}
	if got := im.NRGBAAt(1, 1); got.A == 0 || got.A == 255 {
		t.Fatalf("down state should dim the mark, pixel %+v", got)
	}
}
