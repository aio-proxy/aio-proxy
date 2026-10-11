package panel

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

func TestLargestSeriesIsLightestAndOtherIsDarkest(t *testing.T) {
	var chart [5]ui.Color
	for i := range chart {
		chart[i] = ui.Color{R: uint8(i + 1)}
	}
	if trendColor(chart, 0, false).R != 1 {
		t.Fatal("largest series is not the lightest")
	}
	if trendColor(chart, 5, false).R != 4 {
		t.Fatal("later series did not stop at chart 4")
	}
	if trendColor(chart, 0, true).R != 5 {
		t.Fatal("Other is not the darkest")
	}
}
