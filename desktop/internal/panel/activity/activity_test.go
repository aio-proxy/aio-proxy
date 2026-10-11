package activity

import (
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func day(y int64, m, d uint32) int64 { return format.DaysFromCivil(y, m, d) }

func TestTheGridIs52SundayFirstWeeksEndingInTheWeekOfToday(t *testing.T) {
	today := day(2026, 10, 1) // a Thursday
	grid := Grid(nil, today)
	if len(grid.Weeks) != Weeks {
		t.Fatalf("weeks = %d", len(grid.Weeks))
	}
	last := grid.Weeks[Weeks-1]
	if !last[4].Shown || last[4].Day != today {
		t.Errorf("today's cell = %+v", last[4])
	}
	if last[5].Shown || last[6].Shown {
		t.Error("days after today are empty")
	}
	if first := grid.Weeks[0][0]; !first.Shown || weekday(first.Day) != 0 {
		t.Errorf("column starts on a Sunday, got %+v", first)
	}
}

func TestLevelsScaleToTheBusiestDayAndCountActiveDays(t *testing.T) {
	today := day(2026, 10, 1)
	activity := []summary.ActivityDay{
		{Date: "2026-10-01", TotalTokens: 400},
		{Date: "2026-09-30", TotalTokens: 100},
		{Date: "2025-01-01", TotalTokens: 999_999}, // older than the grid
	}
	grid := Grid(activity, today)
	cell := func(d int64) HeatCell {
		for _, week := range grid.Weeks {
			for _, c := range week {
				if c.Shown && c.Day == d {
					return c
				}
			}
		}
		t.Fatalf("no cell for %d", d)
		return HeatCell{}
	}
	for d, want := range map[int64]uint8{today: 4, today - 1: 1, today - 2: 0} {
		if got := cell(d).Level; got != want {
			t.Errorf("level(%d) = %d, want %d", d-today, got, want)
		}
	}
	if grid.ActiveDays != 2 || grid.TotalTokens != 500 {
		t.Errorf("active %d total %d", grid.ActiveDays, grid.TotalTokens)
	}
}

func TestLevelsDoNotOverflowOnHugeCounts(t *testing.T) {
	huge := ^uint64(0)
	if level(huge, huge) != 4 || level(huge/2, huge) != 2 || level(1, huge) != 1 {
		t.Error("levels overflow near the top of uint64")
	}
}

func TestMonthLabelsMarkTheColumnWhereAMonthStarts(t *testing.T) {
	grid := Grid(nil, day(2026, 10, 1))
	// Oct 1 is a Thursday, so it starts in the last column even though that column opens in Sep.
	n := len(grid.Months)
	if grid.Months[n-1] != (MonthLabel{Weeks - 1, "Oct"}) {
		t.Errorf("last label = %+v", grid.Months[n-1])
	}
	if grid.Months[n-2].Name != "Sep" {
		t.Errorf("second-to-last label = %+v", grid.Months[n-2])
	}
	for j := 1; j < n; j++ {
		if grid.Months[j].Column == grid.Months[j-1].Column {
			t.Error("one label per column at most")
		}
	}
}

func TestAPartialFirstMonthGetsNoLabel(t *testing.T) {
	// The first column opens on Sun 2025-10-05; Oct is partial there, so Nov (the 1st, col 3) is the first label.
	grid := Grid(nil, day(2026, 10, 1))
	if grid.Months[0] != (MonthLabel{3, "Nov"}) || len(grid.Months) != 12 {
		t.Errorf("months = %+v", grid.Months)
	}
}

func TestAMonthThatStartsTomorrowIsNotLabelledYet(t *testing.T) {
	// Wed Sep 30: the last column is Sun Sep 27 - Wed Sep 30, and Oct 1 (Thu) has no cell.
	grid := Grid(nil, day(2026, 9, 30))
	if last := grid.Months[len(grid.Months)-1]; last.Name != "Sep" {
		t.Errorf("last label = %+v", last)
	}
	for _, m := range grid.Months {
		if m.Column >= Weeks-1 {
			t.Errorf("label over the all-Sep last column: %+v", m)
		}
	}
}

func TestTheHoverDateReadsLikeTheDashboard(t *testing.T) {
	cases := map[int64]string{
		day(2026, 10, 1): "October 1st, 2026",
		day(2026, 9, 22): "September 22nd, 2026",
		day(2026, 9, 13): "September 13th, 2026",
		day(2026, 5, 3):  "May 3rd, 2026",
		day(2026, 5, 11): "May 11th, 2026",
	}
	for d, want := range cases {
		if got := LongDate(d); got != want {
			t.Errorf("LongDate = %q, want %q", got, want)
		}
	}
}

func TestWeekdayNames(t *testing.T) {
	if WeekdayName(0) != "Thu" || WeekdayName(-1) != "Wed" || WeekdayName(day(2026, 9, 29)) != "Tue" {
		t.Error("weekday names")
	}
}
