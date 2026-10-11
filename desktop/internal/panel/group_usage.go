package panel

import (
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/usage"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

func usageHeader(c *ui.Context, m *app.Model, v *viewState) {
	groupHeader(c, "Usage", func() {
		selected := int(m.UsageRange)
		segmented(c.Key("usage-range"), &selected, "Usage range", "24h", "7d", "30d").OnChange(func() {
			m.SetUsageRange(summary.AllUsageRanges[selected])
		})
	})
}

func usageCard(c *ui.Context, u *summary.Usage, metric usage.Metric, v *viewState) {
	p := theme.ForDark(c.Theme().Dark)
	value := "—"
	if u != nil {
		value = usage.CardValue(&u.Current, metric)
	}
	fill, border := p.Muted, ui.Transparent
	if v.Metric == metric {
		fill, border = p.Selected, p.SelectedBorder
	}
	card := ui.ButtonBase(c).Key(metric).Grow(1).Basis(0).MinWidth(0).Padding(6).Radius(6).
		AlignItems(ui.Start).Justify(ui.Start).Border(1, border).Background(fill).
		Cursor(ui.CursorPointer).Label(metric.Label()).Transition(controlColorTransition)
	card.Children(func() {
		ui.Column(c).FillWidth().Gap(0).Children(func() {
			ui.Text(c, metric.Label()).FontSize(10).FixedLineHeight(15).TextColor(p.MutedForeground)
			ui.Text(c, value).Font("monospace").FontSize(15).FixedLineHeight(22.5).FontWeight(600).SingleLine()
			if u != nil && u.Previous.Requests != 0 {
				text, tone := usage.CardDelta(&u.Current, &u.Previous, metric)
				color := p.MutedForeground
				if tone == usage.ToneBad {
					color = p.Error
				} else if tone == usage.ToneGood {
					color = p.Success
				}
				ui.Text(c, text).FontSize(10).FixedLineHeight(15).TextColor(color)
			}
		})
	})
	if u != nil && metric == usage.MetricCost && u.Current.PricingCoverage != nil {
		note := usage.FormatValue(u.Current.EstimatedCostNanoUSD, metric)
		if coverage := *u.Current.PricingCoverage; coverage < 1 {
			note += " · " + format.Percent(coverage) + " of requests priced"
		}
		card.Tooltip(note)
	}
	if card.Clicked() {
		v.Metric = metric
	}
}

func usageGroup(c *ui.Context, m *app.Model, v *viewState) {
	p := theme.ForDark(c.Theme().Dark)
	u := m.UsageFor(m.UsageRange)
	ui.Column(c).Padding(0, 0, 12, 0).Children(func() {
		usageHeader(c, m, v)
		ui.Row(c).Gap(5).AlignItems(ui.Stretch).Children(func() {
			for _, metric := range usage.AllMetrics {
				usageCard(c, u, metric, v)
			}
		})
		if u == nil {
			text := m.UsageError()
			if text == "" {
				text = "Loading…"
			}
			ui.Text(c, text).Margin(8, 0, 0, 0).FontSize(12).TextColor(p.MutedForeground)
			return
		}
		caption := "Compared with the previous "
		if u.Previous.Requests == 0 {
			caption = "No usage in the previous "
		}
		ui.Text(c, caption+m.UsageRange.Label()).Margin(4, 0, 0, 0).FontSize(10).TextColor(p.MutedForeground)
		total := usage.MetricTotal(&u.Current, v.Metric)
		if total == 0 {
			ui.Column(c).FillWidth().Padding(20, 8).AlignItems(ui.Center).Gap(8).Children(func() {
				ui.Icon(c, inboxIcon).Size(24, 24).TextColor(p.MutedForeground)
				ui.Text(c, v.Metric.EmptyText()).FontSize(12).FontWeight(500)
			})
			return
		}
		var providers []summary.Provider
		if m.Summary.Kind == app.SummaryReady && m.Summary.Value != nil {
			providers = m.Summary.Value.Providers
		}
		series := trendSeries(c, u, providers, v)
		trendGroup(c, u, series, v)
		if v.Split == usage.SplitProvider && len(u.TrendByProvider) == 0 {
			ui.Text(c, "No per-Provider data for this window").Margin(12, 0, 0, 0).FontSize(12).TextColor(p.MutedForeground)
			return
		}
		usageBreakdown(c, series, v.Split, v.Metric, total)
	})
}

func usageBreakdown(c *ui.Context, series []chartSeries, split usage.Split, metric usage.Metric, total uint64) {
	p := theme.ForDark(c.Theme().Dark)
	ui.Column(c).Margin(12, 0, 0, 0).Gap(5).Children(func() {
		for _, s := range series {
			var value uint64
			for _, x := range s.Values {
				value += x
			}
			share := float64(value) / float64(total)
			percentage := format.Percent(share)
			if value > 0 && share < .01 {
				percentage = "<1%"
			}
			ui.Row(c).Gap(8).FontSize(11).Children(func() {
				ui.Box(c).Size(8, 8).Shrink(0).Radius(2).Background(s.Color)
				name := ui.Text(c, s.Label).Grow(1).MinWidth(0).SingleLine()
				if split == usage.SplitModel && !s.Other {
					name.Font("monospace")
				}
				ui.Text(c, usage.FormatValue(value, metric)).Shrink(0).TextAlign(ui.End)
				ui.Text(c, percentage).Width(32).Shrink(0).TextAlign(ui.End).TextColor(p.MutedForeground)
			})
		}
	})
}

// The chart's tooltip is immediate, unlike MyGo's 600 ms standard tooltip.
// Overlay + PassThrough preserve hover while the custom content covers the chart.
func chartTooltip(c *ui.Context, x, y, width, height float32, content func()) {
	p := theme.ForDark(c.Theme().Dark)
	w, h := c.Size()
	x = max(4, min(x, w-width-4))
	if y-height-6 >= 4 {
		y -= height + 6
	} else {
		y = min(y+18, h-height-4)
	}
	ui.Overlay(c, func() {
		ui.Column(c).Absolute().Left(x).Top(max(4, y)).Width(width).Padding(10).Gap(8).
			PassThrough().Role(ui.RoleTooltip).Radius(6).Border(1, p.Border).
			Background(p.Surface).TextColor(p.Foreground).Shadow(0, 2, 8, 0, ui.RGBA(0, 0, 0, .15)).Children(content)
	})
}

func tooltipSeriesRow(c *ui.Context, color ui.Color, label, value string) {
	ui.Row(c).Gap(8).FontSize(11).Children(func() {
		ui.Box(c).Size(8, 8).Shrink(0).Radius(2).Background(color)
		ui.Text(c, label).Grow(1).MinWidth(0).SingleLine()
		ui.Text(c, value).Shrink(0)
	})
}
