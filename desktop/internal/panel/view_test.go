package panel

import (
	"os"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/usage"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
	"github.com/egoist/mygo/ui"
)

func TestStickyUsageRangeControlsRemainClickable(t *testing.T) {
	b, err := os.ReadFile("../../../packages/types/src/desktop-summary/fixtures/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	s := summary.Parse(b)
	if s.Kind != summary.ParsedV1 {
		t.Fatal(s.Err)
	}
	// Icons are outside this input regression; do not start unrelated remote loads.
	for i := range s.V1.Providers {
		s.V1.Providers[i].Icon = ""
	}
	m := app.NewModel(install.PathsForHome(t.TempDir()), "")
	m.Summary = app.SummaryState{Kind: app.SummaryReady, Value: s.V1}
	t.Cleanup(func() { delete(views, m); delete(providerImages, m) })
	var viewport ui.Rect
	var sticky bool
	tt := ui.NewTester(func(c *ui.Context) {
		Root(c, m)
		v := stateFor(m)
		viewport = v.Body.Bounds(c)
		index, tucked := v.topCard(c)
		sticky = tucked && index == 0
	}, 360, 400)
	tt.Frame()
	tt.Scroll(viewport.X+100, viewport.Y+60, 0, 35)
	tt.Frame()
	if !sticky {
		t.Fatal("usage heading did not stick")
	}
	// The fixed heading's 7d segment; the scrolled-away control must not receive this press.
	tt.ClickAt(viewport.X+280, viewport.Y+25)
	if m.UsageRange != summary.D7 {
		t.Fatal("sticky range press was intercepted")
	}
}

func TestRangeKeyboardFocusSurvivesMetricChange(t *testing.T) {
	m := app.NewModel(install.PathsForHome(t.TempDir()), "")
	m.Summary = app.SummaryState{Kind: app.SummaryReady, Value: &summary.SummaryV1{}}
	t.Cleanup(func() { delete(views, m) })
	tt := ui.NewTester(func(c *ui.Context) { Root(c, m) }, 360, 560)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true, TextScale: 1})
	if err := tt.Click("7d"); err != nil {
		t.Fatal(err)
	}
	// A local metric change must not recreate the root and discard the range control's focus.
	stateFor(m).Metric = usage.MetricCost
	tt.Frame()
	tt.Key(0, ui.KeyRight)
	if m.UsageRange != summary.D30 {
		t.Fatal("local view state change discarded range keyboard focus")
	}
}
func TestStickyHeaderKeepsBothTopCornersClear(t *testing.T) {
	raw, err := os.ReadFile("../../../packages/types/src/desktop-summary/fixtures/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	parsed := summary.Parse(raw)
	if parsed.Kind != summary.ParsedV1 {
		t.Fatal(parsed.Err)
	}
	for i := range parsed.V1.Providers {
		parsed.V1.Providers[i].Icon = ""
	}
	m := app.NewModel(install.PathsForHome(t.TempDir()), "")
	m.Summary = app.SummaryState{Kind: app.SummaryReady, Value: parsed.V1}
	t.Cleanup(func() { delete(views, m); delete(providerImages, m) })
	var viewport, cardBounds ui.Rect
	var stuck bool
	tt := ui.NewTester(func(c *ui.Context) {
		Root(c, m)
		v := stateFor(m)
		viewport = v.Body.Bounds(c)
		index, tucked := v.topCard(c)
		stuck = tucked
		cardBounds = v.cards[index].Bounds(c)
	}, 360, 400)
	tt.SetPreferences(ui.Preferences{ReduceMotion: true, TextScale: 1})
	tt.Scroll(viewport.X+100, viewport.Y+70, 0, 40)
	tt.Frame()
	if !stuck {
		t.Fatal("header did not stick")
	}
	image := tt.Image()
	y := int(viewport.Y) + 1
	for _, x := range []int{int(cardBounds.X) + 1, int(cardBounds.X+cardBounds.W) - 2} {
		if alpha := image.RGBAAt(x, y).A; alpha != 0 {
			t.Errorf("scrolled content painted through top corner (%d,%d): alpha=%d", x, y, alpha)
		}
	}
	if alpha := image.RGBAAt(int(cardBounds.X+cardBounds.W/2), y).A; alpha != 255 {
		t.Errorf("sticky header center disappeared: alpha=%d", alpha)
	}
}
