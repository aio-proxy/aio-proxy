package placement

import "testing"

var work = Rect{Width: 1920, Height: 1032}
var panel = [2]float64{360, 560}

func TestPopupFollowsTheTaskbar(t *testing.T) {
	icon := Rect{X: 1880, Y: 1040, Width: 24, Height: 32}
	if x, y := PopupOrigin(icon, work, panel[0], panel[1]); x != 1920-360 || y != 1032-560 {
		t.Fatalf("bottom (%v, %v)", x, y)
	}
	top := Rect{X: 0, Y: 48, Width: 1920, Height: 1032}
	icon = Rect{X: 900, Y: 8, Width: 24, Height: 32}
	if x, y := PopupOrigin(icon, top, panel[0], panel[1]); x != 912-180 || y != 48 {
		t.Fatalf("top (%v, %v)", x, y)
	}
	left := Rect{X: 60, Width: 1860, Height: 1080}
	if x, y := PopupOrigin(Rect{X: 10, Y: 900, Width: 32, Height: 24}, left, panel[0], panel[1]); x != 60 || y != 1080-560 {
		t.Fatalf("left (%v, %v)", x, y)
	}
	right := Rect{Width: 1860, Height: 1080}
	if x, y := PopupOrigin(Rect{X: 1878, Y: 100, Width: 32, Height: 24}, right, panel[0], panel[1]); x != 1860-360 || y != 0 {
		t.Fatalf("right (%v, %v)", x, y)
	}
	icon = Rect{X: 1700, Y: 900, Width: 24, Height: 24}
	if x, y := PopupOrigin(icon, work, panel[0], panel[1]); x != 1712-180 || y != 900-560 {
		t.Fatalf("overflow (%v, %v)", x, y)
	}
	icon = Rect{X: 1700, Y: 100, Width: 24, Height: 24}
	if x, y := PopupOrigin(icon, work, panel[0], panel[1]); x != 1712-180 || y != 124 {
		t.Fatalf("upper (%v, %v)", x, y)
	}
	if got := ToLogical(Rect{X: 2820, Y: 1560, Width: 36, Height: 48}, 1.5); got != (Rect{X: 1880, Y: 1040, Width: 24, Height: 32}) {
		t.Fatal(got)
	}
	neg := Rect{X: -1920, Width: 1920, Height: 1032}
	if x, y := PopupOrigin(Rect{X: -40, Y: 1040, Width: 24, Height: 32}, neg, panel[0], panel[1]); x != -360 || y != 472 {
		t.Fatalf("negative (%v, %v)", x, y)
	}
}
