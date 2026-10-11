package placement

// Rect is a top-down rectangle in logical pixels, as Win32 reports after scaling.
type Rect struct {
	X, Y, Width, Height float64
}

// ToLogical converts physical pixels to logical ones.
func ToLogical(r Rect, scale float64) Rect {
	return Rect{X: r.X / scale, Y: r.Y / scale, Width: r.Width / scale, Height: r.Height / scale}
}

// PopupOrigin places a panel beside a Windows tray icon. The taskbar is the side of the icon
// outside the work area. An icon inside the work area opens above itself in the lower half, else below.
func PopupOrigin(icon, work Rect, width, height float64) (x, y float64) {
	left, top := work.X, work.Y
	right, bottom := left+work.Width, top+work.Height
	clampX := func(v float64) float64 { return max(left, min(v, right-width)) }
	clampY := func(v float64) float64 { return max(top, min(v, bottom-height)) }
	centredX := clampX(icon.X + icon.Width/2 - width/2)
	centredY := clampY(icon.Y + icon.Height/2 - height/2)
	switch {
	case icon.Y >= bottom:
		return centredX, clampY(bottom - height)
	case icon.Y+icon.Height <= top:
		return centredX, top
	case icon.X+icon.Width <= left:
		return left, centredY
	case icon.X >= right:
		return clampX(right - width), centredY
	case icon.Y+icon.Height/2 > top+work.Height/2:
		return centredX, clampY(icon.Y - height)
	default:
		return centredX, clampY(icon.Y + icon.Height)
	}
}
