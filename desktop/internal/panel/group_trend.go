package panel

import (
	"math"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/usage"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

type chartSeries struct {
	usage.Series
	Color ui.Color
}

func trendSeries(c *ui.Context, u *summary.Usage, providers []summary.Provider, v *viewState) []chartSeries {
	p := theme.ForDark(c.Theme().Dark)
	cells := u.TrendByModel
	label := func(id string) string { return id }
	if v.Split == usage.SplitProvider {
		cells = u.TrendByProvider
		label = func(id string) string { return trendProviderLabel(providers, id) }
	}
	stacked := usage.Stack(u.Buckets, cells, label, v.Metric)
	out := make([]chartSeries, len(stacked))
	for i, s := range stacked {
		out[i] = chartSeries{Series: s, Color: trendColor(p.Chart, i, s.Other)}
	}
	return out
}

// trendColor is largest-first and lightest, matching the Dashboard; Other is darkest.
func trendColor(chart [5]ui.Color, index int, other bool) ui.Color {
	if other {
		return chart[4]
	}
	return chart[min(index, 3)]
}

func trendProviderLabel(providers []summary.Provider, id string) string {
	for i := range providers {
		provider := &providers[i]
		if provider.ID != id {
			continue
		}
		title := provider.Title()
		shared := 0
		for j := range providers {
			if providers[j].Title() == title {
				shared++
			}
		}
		if subtitle, ok := provider.Subtitle(); ok && shared > 1 {
			return title + " · " + subtitle
		}
		return title
	}
	return id
}

// Rust's ScaleBand uses 0.25 inner / 0.1 outer padding and caps only the
// bar width at 28 DIPs, leaving the bucket starts unchanged by the cap.
func trendBand(width float32, n int) (start, step, band float32) {
	if n == 0 {
		return
	}
	average := width / float32(n)
	band = min(average*.75, 28)
	if n == 1 {
		return (width - band) / 2, width, band
	}
	start = average * .1
	step = (width - 2*start) / float32(n) * (1 + .25/float32(n-1))
	return
}

func trendGroup(c *ui.Context, u *summary.Usage, series []chartSeries, v *viewState) {
	p := theme.ForDark(c.Theme().Dark)
	labels := usage.BucketLabels(u.Buckets, u.BucketUnit, u.Range, format.LocalUTCOffset)
	per := "per hour"
	if u.BucketUnit == summary.BucketUnitDay {
		per = "per day"
	}
	metric := v.Metric
	ui.Column(c).Margin(8, 0, 0, 0).Gap(4).Children(func() {
		ui.Row(c).Justify(ui.End).Children(func() {
			selected := int(v.Split)
			segmented(c.Key("trend-split"), &selected, "Trend split", "Model", "Provider").OnChange(func() {
				v.Split = usage.AllSplits[selected]
			})
		})
		chart := ui.Box(c).FillWidth().Height(112).Label("Usage trend").Description("Stacked usage by " + v.Split.Label())
		x, y, over := chart.PointerPosition()
		bounds := chart.Bounds()
		hovered := -1
		if over && y <= 94 && len(labels) > 0 && bounds.W > 0 {
			start, step, _ := trendBand(bounds.W, len(labels))
			hovered = min(len(labels)-1, max(0, int(math.Round(float64((x-start)/step)))))
		}
		var maximum uint64
		for i := range labels {
			var total uint64
			for _, s := range series {
				total += s.Values[i]
			}
			maximum = max(maximum, total)
		}
		chart.Draw(func(painter *ui.Painter, r ui.Rect) {
			plotHeight := r.H - 18
			start, step, band := trendBand(r.W, len(labels))
			painter.Line(r.X, r.Y+plotHeight, r.X+r.W, r.Y+plotHeight, 1, p.Border)
			if len(labels) > 0 {
				last := len(labels) - 1
				for _, i := range []int{0, last / 2, last} {
					span := ui.Span{Text: labels[i], Size: 10, Color: p.MutedForeground}
					tw, _ := painter.MeasureText(0, span)
					painter.RichText(r.X+start+float32(i)*step+band/2-tw/2, r.Y+plotHeight+4, 0, span)
				}
			}
			if maximum > 0 {
				// One running base per bucket without allocating scratch storage in Draw.
				for i := range labels {
					var base uint64
					for _, s := range series {
						value := s.Values[i]
						if value > 0 {
							y0 := plotHeight - float32(float64(base)/float64(maximum))*(plotHeight-2)
							y1 := plotHeight - float32(float64(base+value)/float64(maximum))*(plotHeight-2)
							painter.Fill(ui.Rect{X: r.X + start + float32(i)*step, Y: r.Y + y1, W: band, H: y0 - y1}, s.Color, 0)
						}
						base += value
					}
				}
			}
			if hovered >= 0 {
				left := r.X + start + float32(hovered)*step
				shade := p.Border
				shade.A = 70
				painter.Fill(ui.Rect{X: left, Y: r.Y, W: band, H: plotHeight}, shade, 0)
				painter.Line(left+band/2, r.Y, left+band/2, r.Y+plotHeight, 1, p.MutedForeground)
			}
		})
		if hovered >= 0 {
			rows := 0
			var total uint64
			for _, s := range series {
				if s.Values[hovered] > 0 {
					rows++
					total += s.Values[hovered]
				}
			}
			chartTooltip(c, bounds.X+x+12, bounds.Y+y, 240, float32(60+rows*22), func() {
				ui.Text(c, labels[hovered]+" · "+per).FontSize(12).FontWeight(500)
				// Legend order is descending window usage, not the visual stack.
				for _, s := range series {
					if value := s.Values[hovered]; value > 0 {
						tooltipSeriesRow(c, s.Color, s.Label, usage.FormatValue(value, metric))
					}
				}
				ui.Row(c).Justify(ui.SpaceBetween).FontSize(11).Children(func() {
					ui.Text(c, "Total")
					ui.Text(c, usage.FormatValue(total, metric))
				})
			})
		}
	})
}
