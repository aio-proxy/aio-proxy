package panel

import (
	"fmt"
	"math"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/activity"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

const (
	heatCellSize    float32 = 10
	heatGap         float32 = 2
	heatMonthHeight float32 = 14
	heatWidth               = float32(activity.Weeks)*(heatCellSize+heatGap) - heatGap
	heatHeight              = heatMonthHeight + 7*(heatCellSize+heatGap) - heatGap
)

func activityGrid(s *summary.SummaryV1) activity.HeatGrid {
	now := time.Now()
	year, month, day := now.Date()
	today := format.DaysFromCivil(int64(year), uint32(month), uint32(day))
	return activity.Grid(s.Activity, today)
}

func activityHeader(c *ui.Context, s *summary.SummaryV1, v *viewState) {
	activityGridHeader(c, activityGrid(s))
}

func activityGridHeader(c *ui.Context, grid activity.HeatGrid) {
	p := theme.ForDark(c.Theme().Dark)
	groupHeader(c, "Last 12 months", func() {
		ui.Text(c, activityTotalsText(grid.ActiveDays, grid.TotalTokens)).FontSize(12).TextColor(p.MutedForeground)
	})
}
func activityTotalsText(days int, tokens uint64) string {
	return fmt.Sprintf("%d active days · %s tokens", days, format.Compact(tokens))
}

func activityGroup(c *ui.Context, s *summary.SummaryV1, v *viewState) {
	grid := activityGrid(s)
	p := theme.ForDark(c.Theme().Dark)
	if !v.HeatScrolled {
		// TrackScroll clamps to the last week in layout, including the first frame.
		v.HeatScroll.X = math.MaxFloat32
		v.HeatScrolled = true
	}
	ui.Column(c).Padding(0, 0, 12, 0).Children(func() {
		activityGridHeader(c, grid)
		ui.ScrollHorizontal(c).FillWidth().Height(heatHeight + 6).Bind(&v.Heat).TrackScroll(&v.HeatScroll).Children(func() {
			canvas := ui.Box(c).Size(heatWidth, heatHeight).Shrink(0).Label("Daily token activity").Description("52 weeks of daily token usage; hover a day for its model breakdown")
			canvas.Draw(func(painter *ui.Painter, r ui.Rect) {
				for _, month := range grid.Months {
					span := ui.Span{Text: month.Name, Size: 9, Color: p.MutedForeground}
					x := float32(month.Column) * (heatCellSize + heatGap)
					if month.Column+2 >= activity.Weeks {
						width, _ := painter.MeasureText(0, span)
						x = r.W - width
					}
					painter.RichText(r.X+x, r.Y, 0, span)
				}
				for week, column := range grid.Weeks {
					for slot, cell := range column {
						if !cell.Shown {
							continue
						}
						painter.Fill(ui.Rect{X: r.X + float32(week)*(heatCellSize+heatGap), Y: r.Y + heatMonthHeight + float32(slot)*(heatCellSize+heatGap), W: heatCellSize, H: heatCellSize}, p.Heat[min(cell.Level, 4)], 2)
					}
				}
			})
			x, y, over := canvas.PointerPosition()
			if !over || y < heatMonthHeight {
				return
			}
			week := int(x / (heatCellSize + heatGap))
			slot := int((y - heatMonthHeight) / (heatCellSize + heatGap))
			if week < 0 || week >= len(grid.Weeks) || slot < 0 || slot >= 7 {
				return
			}
			cellX := float32(week) * (heatCellSize + heatGap)
			cellY := heatMonthHeight + float32(slot)*(heatCellSize+heatGap)
			// Neither the two-DIP gutters nor future days have a hover card.
			if x-cellX >= heatCellSize || y-cellY >= heatCellSize {
				return
			}
			cell := grid.Weeks[week][slot]
			if !cell.Shown {
				return
			}
			bounds := canvas.Bounds()
			models := grid.Models[cell.Day]
			height := float32(68)
			if len(models) > 0 {
				height += 40 + float32(len(models))*38
			}
			chartTooltip(c, bounds.X+cellX, bounds.Y+cellY, 260, height, func() {
				activityDayCard(c, cell, models)
			})
		})
		ui.Row(c).Justify(ui.End).Gap(heatGap).Margin(4, 0, 0, 0).FontSize(9).TextColor(p.MutedForeground).Children(func() {
			ui.Text(c, "Less")
			ui.Box(c).Size(5*(heatCellSize+heatGap)-heatGap, heatCellSize).Draw(func(painter *ui.Painter, r ui.Rect) {
				for level := range 5 {
					painter.Fill(ui.Rect{X: r.X + float32(level)*(heatCellSize+heatGap), Y: r.Y, W: heatCellSize, H: heatCellSize}, p.Heat[level], 2)
				}
			})
			ui.Text(c, "More")
		})
	})
}

func activityDayCard(c *ui.Context, cell activity.HeatCell, models []summary.ActivityModel) {
	p := theme.ForDark(c.Theme().Dark)
	ui.Text(c, activity.LongDate(cell.Day)).FontSize(13).FontWeight(500)
	ui.Text(c, format.Compact(cell.Tokens)+" Token").FontSize(13)
	if len(models) == 0 {
		return
	}
	ui.Column(c).Margin(4, 0, 0, 0).Padding(12, 0, 0, 0).BorderWidth(1, 0, 0, 0).BorderColor(p.Border).Gap(8).Children(func() {
		ui.Text(c, "Model breakdown").FontSize(12).FontWeight(500).TextColor(p.MutedForeground)
		for _, model := range models {
			share := float64(0)
			if cell.Tokens != 0 {
				share = float64(model.TotalTokens) / float64(cell.Tokens)
			}
			ui.Column(c).Gap(4).Children(func() {
				ui.Row(c).Gap(6).FontSize(12).Children(func() {
					ui.Text(c, model.ModelID).Grow(1).MinWidth(0).SingleLine()
					ui.Text(c, format.Compact(model.TotalTokens)).Shrink(0).TextColor(p.MutedForeground)
					ui.Text(c, fmt.Sprintf("%.0f%%", share*100)).Shrink(0)
				})
				ui.Box(c).FillWidth().Height(6).Draw(func(painter *ui.Painter, r ui.Rect) {
					painter.Fill(r, p.Muted, 3)
					if share > 0 {
						painter.Fill(ui.Rect{X: r.X, Y: r.Y, W: r.W * float32(share), H: r.H}, p.Primary, 3)
					}
				})
			})
		}
	})
}
