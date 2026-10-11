package panel

import (
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/quota"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/usage"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

type viewState struct {
	Metric       usage.Metric
	Split        usage.Split
	Body         ui.Handle
	Heat         ui.Handle
	HeatScrolled bool
	QuotaOpen    map[string]bool
	BodyScroll   ui.ScrollState
	HeatScroll   ui.ScrollState
	cards        [3]ui.Handle
	committedY   float32
}

var views = make(map[*app.Model]*viewState)

// ResetView gives a newly opened panel fresh local picks and accordion state.
// The model's selected usage range, unlike these picks, survives panel closes.
func ResetView(m *app.Model) {
	views[m] = &viewState{QuotaOpen: make(map[string]bool)}
}

func stateFor(m *app.Model) *viewState {
	v := views[m]
	if v == nil {
		ResetView(m)
		v = views[m]
	}
	return v
}

func card(c *ui.Context, handle *ui.Handle, group func()) {
	p := theme.ForDark(c.Theme().Dark)
	ui.Column(c).Bind(handle).FillWidth().Shrink(0).PaddingX(12).Radius(8).Background(p.Surface).Children(group)
}

// Card bounds are from the committed frame. Correct them for a wheel event's
// new offset before selecting the sticky title, rather than lagging one frame.
func (v *viewState) topCard(c *ui.Context) (int, bool) {
	viewport := v.Body.Bounds(c)
	delta := v.BodyScroll.Y - v.committedY
	index := 0
	for i := range v.cards {
		r := v.cards[i].Bounds(c)
		if r.H > 0 && r.Y-delta <= viewport.Y {
			index = i
		}
	}
	r := v.cards[index].Bounds(c)
	return index, viewport.H > 0 && r.H > 0 && r.Y-delta < viewport.Y
}

func (v *viewState) scrollToQuota(c *ui.Context) {
	viewport := v.Body.Bounds(c)
	r := v.cards[1].Bounds(c)
	if r.H > 0 {
		v.BodyScroll.Y = min(max(v.committedY+r.Y-viewport.Y, 0), v.BodyScroll.MaxY)
		c.Invalidate()
	}
}

// Root paints no background: the window's popover material shows between the
// opaque group cards. All model mutations go through its action methods.
func Root(c *ui.Context, m *app.Model) {
	th := theme.UITheme(c.Theme())
	th.Background = ui.Color{}
	c.SetTheme(th)
	c.OnShortcut(0, ui.KeyEscape, Hide)
	c.OnShortcut(ui.Cmd, ui.KeyW, Hide)
	c.OnShortcut(ui.Cmd, ui.KeyQ, m.Quit)
	v := stateFor(m)
	now := time.Now().Unix()
	var blocks []quota.Block
	ready := m.Summary.Kind == app.SummaryReady && m.Summary.Value != nil && !m.IsDown()
	if ready {
		blocks = quota.Blocks(m.Summary.Value.Providers, now)
	}
	ui.Column(c).Key("panel-root").Fill().FontSize(12).LineHeight(4.0 / 3.0).TextColor(th.Text).Children(func() {
		header(c, m, blocks, func() { v.scrollToQuota(c) })
		if ready {
			// The scrolling card behind the sticky title must share its rounded clip; painting a
			// rounded title alone leaves the card's opaque fill visible through its corners.
			ui.Box(c).Grow(1).MinHeight(0).MarginX(8).Radius(8, 8, 0, 0).Clip().Children(func() {
				// Metal shapes only the innermost clip; Scroll creates its own mask, so it must
				// repeat the viewport radii instead of replacing them with a square clip.
				ui.Scroll(c).Key("panel-body").Bind(&v.Body).TrackScroll(&v.BodyScroll).Fill().Radius(8, 8, 0, 0).Gap(8).Padding(8, 0).
					DrawOver(func(_ *ui.Painter, _ ui.Rect) { v.committedY = v.BodyScroll.Y }).Children(func() {
					card(c, &v.cards[0], func() { usageGroup(c, m, v) })
					card(c, &v.cards[1], func() { quotaGroup(c, m, v, blocks, now) })
					card(c, &v.cards[2], func() { activityGroup(c, m.Summary.Value, v) })
				})
				if index, tucked := v.topCard(c); tucked {
					p := theme.ForDark(th.Dark)
					ui.Column(c).Key("sticky-group").Absolute().Top(0).Left(0).Right(0).PaddingX(12).
						Background(p.Surface).BorderWidth(0, 0, 1, 0).BorderColor(p.Border).Radius(8, 8, 0, 0).
						HandleInput(func(ev ui.InputEvent) bool {
							// Handle wheel movement here; let descendant buttons handle presses. Hit
							// testing already picks this overlay rather than the hidden header below.
							if ev.Kind == ui.InputScroll {
								v.BodyScroll.Y = min(max(v.BodyScroll.Y+ev.DY, 0), v.BodyScroll.MaxY)
								c.Invalidate()
							}
							return ev.Kind == ui.InputScroll
						}).Children(func() {
						switch index {
						case 0:
							usageHeader(c, m, v)
						case 1:
							quotaHeader(c, blocks)
						default:
							activityHeader(c, m.Summary.Value, v)
						}
					})
				}
			})
		} else {
			stateBody(c, m)
		}
		footer(c, m)
	})
}
