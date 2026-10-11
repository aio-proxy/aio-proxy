package panel

import (
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/quota"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

func quotaHeader(c *ui.Context, blocks []quota.Block) {
	p := theme.ForDark(c.Theme().Dark)
	groupHeader(c, "Quota", func() {
		ui.Row(c).Gap(4).FontSize(12).TextColor(p.MutedForeground).Children(func() {
			if attention := quota.AttentionCount(blocks); attention > 0 {
				ui.Text(c, fmt.Sprintf("%d need attention", attention)).TextColor(p.Danger)
				ui.Text(c, "·")
			}
			switch len(blocks) {
			case 0:
			case 1:
				ui.Text(c, "1 Provider reports quota")
			default:
				ui.Text(c, fmt.Sprintf("%d Providers report quota", len(blocks)))
			}
		})
	})
}

func quotaBar(c *ui.Context, window *quota.WindowView, height float32, tick bool) {
	p := theme.ForDark(c.Theme().Dark)
	remaining := float32(0)
	if window.Remaining != nil {
		remaining = float32(*window.Remaining)
	}
	fill := p.Success
	if window.Low {
		fill = p.Warning
	}
	track := ui.Box(c).FillWidth().Height(height).Radius(height / 2).Background(p.Track).Clip()
	remaining = track.Animate("remaining", remaining, 200*time.Millisecond)
	track.Children(func() {
		ui.Box(c).Absolute().Top(0).Left(0).Bottom(0).WidthPercent(remaining * 100).Radius(height / 2).Background(fill)
		if tick && window.Pace != nil {
			color := p.Success
			if window.Pace.Behind {
				color = p.Error
			}
			ui.Box(c).Absolute().Top(0).Bottom(0).LeftPercent(float32(window.Pace.Expected)*100).
				Margin(0, 0, 0, -2).Width(4).Background(color).BorderWidth(0, 1).BorderColor(p.Surface)
		}
	})
}

func quotaWindow(c *ui.Context, window *quota.WindowView) {
	p := theme.ForDark(c.Theme().Dark)
	title := window.Label + " · no data"
	if window.Remaining != nil {
		title = window.Label + " · " + format.Percent(*window.Remaining) + " left"
	}
	ui.Column(c).FillWidth().Gap(4).Padding(8, 0, 0).Children(func() {
		ui.Row(c).FillWidth().Gap(8).FontSize(12).Children(func() {
			ui.Text(c, title).Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…")
			if window.LeftText != "" {
				ui.Text(c, window.LeftText).Shrink(0).TextColor(p.MutedForeground)
			}
		})
		quotaBar(c, window, 6, true)
		if window.Pace != nil {
			color := p.MutedForeground
			if window.Pace.Behind {
				color = p.Danger
			}
			ui.Text(c, window.Pace.Note).FontSize(10).TextColor(color)
		}
	})
}

func providerMark(c *ui.Context, m *app.Model, provider *summary.Provider, title string) {
	if provider.Service == nil {
		return
	}
	p := theme.ForDark(c.Theme().Dark)
	url := quota.IconURL(provider.Icon, c.Theme().Dark)
	var source ui.ImageSource
	if url != "" {
		source = providerImageFor(m, url)
	}
	ui.Box(c).Size(16, 16).Shrink(0).Radius(2).Background(p.Muted).Center().Children(func() {
		if source != nil {
			ui.Image(c, source).Size(12, 12)
		} else {
			letter, _ := utf8.DecodeRuneInString(title)
			fallback := ""
			if title != "" {
				fallback = strings.ToUpper(string(letter))
			}
			ui.Text(c, fallback).FontSize(10).FontWeight(600)
		}
	})
}

func quotaTitle(c *ui.Context, m *app.Model, block *quota.Block, open bool, progress float32) {
	p := theme.ForDark(c.Theme().Dark)
	ui.Row(c).FillWidth().Grow(1).MinWidth(0).Gap(4).AlignItems(ui.Center).
		FontSize(12).FontWeight(400).Children(func() {
		providerMark(c, m, block.Provider, block.Title)
		ui.Text(c, block.Title).FontSize(14).FontWeight(600).TextColor(p.Foreground).Shrink(0)
		ui.Text(c, block.Subtitle).Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…").TextColor(p.MutedForeground)
		if !open {
			switch {
			case block.Loading:
				ui.Text(c, "Loading…").TextColor(p.MutedForeground).Shrink(0)
			case block.Message != "":
				ui.Text(c, "Failed").TextColor(p.Danger).Shrink(0)
			default:
				if window := block.Tightest(); window != nil && window.Remaining != nil {
					ui.Row(c).Gap(4).AlignItems(ui.Center).Shrink(0).Children(func() {
						ui.Box(c).Width(32).Children(func() { quotaBar(c, window, 4, false) })
						color := p.MutedForeground
						if window.Pace != nil && window.Pace.Behind {
							color = p.Error
						}
						ui.Text(c, format.Percent(*window.Remaining)).MinWidth(30).NoWrap().TextColor(color)
					})
				}
			}
		}
	})
	sin, cos := math.Sincos(float64(progress) * math.Pi)
	ui.Box(c).Size(12, 12).Shrink(0).Draw(func(painter *ui.Painter, r ui.Rect) {
		cx, cy := r.X+r.W/2, r.Y+r.H/2
		at := func(x, y float32) (float32, float32) {
			return cx + x*float32(cos) - y*float32(sin), cy + x*float32(sin) + y*float32(cos)
		}
		x0, y0 := at(-3, -1.5)
		x1, y1 := at(0, 1.5)
		x2, y2 := at(3, -1.5)
		path := new(ui.Path).MoveTo(x0, y0).LineTo(x1, y1).LineTo(x2, y2)
		painter.StrokePath(path, 1.25, p.MutedForeground)
	})
}

func quotaDetails(c *ui.Context, m *app.Model, block *quota.Block, now int64) {
	p := theme.ForDark(c.Theme().Dark)
	updated := ""
	if block.SampledAt != nil {
		updated = "Updated " + quota.Relative(now, *block.SampledAt)
		if block.RefreshFailed {
			updated = "Last refresh failed · data from " + quota.Relative(now, *block.SampledAt)
		}
	}
	ui.Row(c).FillWidth().Gap(8).FontSize(10).TextColor(p.MutedForeground).Children(func() {
		ui.Text(c, updated).Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…")
		if block.Plan != "" {
			ui.Text(c, block.Plan).Shrink(0)
		}
		link := ghostButton(c.Key("quota-open-"+block.Provider.ID), "Open in Dashboard", 16, 14).Shrink(0).
			Tooltip("Open in Dashboard").Children(func() { ui.Text(c, "›") })
		if link.Clicked() {
			m.OpenDashboardProvider(block.Provider.ID)
		}
	})
	for i := range block.Windows {
		quotaWindow(c, &block.Windows[i])
	}
	if block.Message != "" {
		ui.Text(c, block.Message).Padding(4, 0, 0).FontSize(12).TextColor(p.Danger)
	}
	if block.Command != "" {
		ui.Text(c, block.Command).Padding(4, 0, 0).FontSize(12).TextColor(p.MutedForeground).Font("monospace")
	}
}

func quotaGroup(c *ui.Context, m *app.Model, v *viewState, blocks []quota.Block, now int64) {
	quotaHeader(c, blocks)
	ui.Column(c).FillWidth().Padding(0, 0, 12).Children(func() {
		if len(blocks) == 0 {
			ui.Text(c, "No Provider reports quota").FontSize(12).TextColor(theme.ForDark(c.Theme().Dark).MutedForeground)
			return
		}
		for i := range blocks {
			block := &blocks[i]
			open, touched := v.QuotaOpen[block.Provider.ID]
			if !touched {
				open = block.OpensByDefault()
			}
			ui.Column(c).Key("quota-" + block.Provider.ID).FillWidth().Children(func() {
				parts := ui.CollapsibleBase(c.Key("disclosure"), &open)
				trigger := parts.Trigger.FillWidth().Gap(4).Padding(8, 0).
					AlignItems(ui.Center).Justify(ui.Start).FontSize(12).FontWeight(400).Label(block.Title)
				if trigger.Changed() {
					// Like the accordion's toggle event, retain the entire set of current
					// picks until close; untouched blocks follow attention until this click.
					for j := range blocks {
						id := blocks[j].Provider.ID
						if _, exists := v.QuotaOpen[id]; !exists {
							v.QuotaOpen[id] = blocks[j].OpensByDefault()
						}
					}
					v.QuotaOpen[block.Provider.ID] = open
				}
				trigger.Children(func() { quotaTitle(c, m, block, open, parts.Progress()) })
				parts.Panel(func() { quotaDetails(c, m, block, now) }).FillWidth().Padding(0, 0, 8)
			})
		}
	})
}
