package panel

import (
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

var controlColorTransition = ui.ElementTransition{Colors: true, Duration: 120 * time.Millisecond}

const controlSlideDuration = 200 * time.Millisecond

// Ghost controls have no idle face; feedback never changes their geometry.
func ghostButton(c *ui.Context, label string, width, height float32) ui.Element {
	p := theme.ForDark(c.Theme().Dark)
	button := ui.ButtonBase(c).Size(width, height).Radius(4).Label(label).TextColor(p.Foreground).Cursor(ui.CursorPointer)
	fill := ui.Transparent
	if button.Pressed() {
		fill = p.Muted
	} else if button.Hovered() {
		fill = p.Muted.Alpha(.7)
	}
	return button.Background(fill).Transition(controlColorTransition)
}

// segmented retains the radio-group keyboard contract and draws one moving thumb below the
// labels. Geometry comes from the committed segment bounds, not character-count estimates.
func segmented(c *ui.Context, selected *int, label string, labels ...string) ui.Element {
	p := theme.ForDark(c.Theme().Dark)
	parts := ui.SegmentedBase(c, selected, len(labels))
	track := parts.Track.Height(20).Padding(2).Gap(2).AlignItems(ui.Center).Radius(6).Background(p.Muted).Label(label)
	var chosen ui.Rect
	track.Children(func() {
		for i, text := range labels {
			segment := parts.Segment(i).Height(16).PaddingX(8).Radius(4).Cursor(ui.CursorPointer).Label(text)
			foreground := p.TabForeground
			if i == *selected {
				foreground = p.TabActiveForeground
			}
			segment.TextColor(foreground).Children(func() { ui.Text(c, text).FontSize(12).LineHeight(1.25).SingleLine() })
			if i == *selected {
				chosen = segment.Bounds()
			}
		}
	})
	bounds := track.Bounds()
	if chosen.W == 0 || bounds.W == 0 {
		// One layout is needed on the first frame; never animate a zero-sized startup thumb.
		c.Invalidate()
		return track
	}
	left := track.Animate("thumb-left", chosen.X-bounds.X, controlSlideDuration)
	width := track.Animate("thumb-width", chosen.W, controlSlideDuration)
	track.Draw(func(painter *ui.Painter, r ui.Rect) {
		thumb := ui.Rect{X: r.X + left, Y: r.Y + 2, W: width, H: 16}
		painter.Fill(thumb, p.Surface, 4)
	})
	return track
}
