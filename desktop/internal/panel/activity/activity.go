// Package activity is the 12-month heatmap's layout: Sunday-first weekly
// columns ending in today's week, five levels scaled to the busiest day, and
// the column where each month starts.
package activity

import (
	"fmt"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

// Weeks is 52: the source (`overviewDashboardActivity`) starts 51 weeks before
// this week, as the Dashboard heatmap does, so a 53rd column would always read
// empty.
const Weeks = 52

var (
	months     = [12]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
	longMonths = [12]string{
		"January", "February", "March", "April", "May", "June",
		"July", "August", "September", "October", "November", "December",
	}
	weekdays = [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
)

type HeatCell struct {
	// Shown is false for the days after today in the last column, which draw
	// nothing; the other fields are then zero.
	Shown  bool
	Day    int64
	Tokens summary.Count
	Level  uint8
}

type MonthLabel struct {
	Column int
	Name   string
}

type HeatGrid struct {
	Weeks       [][7]HeatCell
	Months      []MonthLabel
	ActiveDays  int
	TotalTokens summary.Count
	// Models is each day's model split, for the hover card.
	Models map[int64][]summary.ActivityModel
}

// weekday is 0 for Sunday. Day 0 (1970-01-01) was a Thursday.
func weekday(day int64) int {
	w := (day + 4) % 7
	if w < 0 {
		w += 7
	}
	return int(w)
}

func WeekdayName(day int64) string { return weekdays[weekday(day)] }

// LongDate is the hover card's date, as the Dashboard's `PPP` formats it in
// English: `October 1st, 2026`.
func LongDate(day int64) string {
	year, month, date := format.CivilFromDays(day)
	suffix := "th"
	if d := date % 100; d < 11 || d > 13 {
		switch date % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return fmt.Sprintf("%s %d%s, %d", longMonths[month-1], date, suffix, year)
}

// level is 0 for no tokens, else 1..4 scaled to the busiest day.
func level(t, busiest summary.Count) uint8 {
	if t.IsZero() || busiest.IsZero() {
		return 0
	}
	q := t.Mul(3).Quo(busiest)
	n := 0
	if q.Cmp(summary.CountOf(3)) > 0 {
		n = 3
	} else if !q.IsZero() {
		n = int(q.Float64())
	}
	return uint8(min(1+n, 4))
}

func Grid(activity []summary.ActivityDay, today int64) HeatGrid {
	first := today - int64(weekday(today)) - (Weeks-1)*7
	var tokens [Weeks * 7]summary.Count
	models := map[int64][]summary.ActivityModel{}
	for _, entry := range activity {
		date, ok := format.ParseDate(entry.Date)
		if !ok {
			continue
		}
		if index := date - first; index >= 0 && index <= today-first {
			tokens[index] = entry.TotalTokens
			models[date] = entry.Models
		}
	}
	var busiest summary.Count
	grid := HeatGrid{Weeks: make([][7]HeatCell, Weeks), Models: models}
	for _, t := range tokens {
		if t.Cmp(busiest) > 0 {
			busiest = t
		}
		if !t.IsZero() {
			grid.ActiveDays++
		}
		grid.TotalTokens = grid.TotalTokens.Add(t)
	}
	for week := range Weeks {
		for slot := range 7 {
			day := first + int64(week*7+slot)
			if day <= today {
				t := tokens[week*7+slot]
				grid.Weeks[week][slot] = HeatCell{Shown: true, Day: day, Tokens: t, Level: level(t, busiest)}
			}
		}
		// A month labels the column holding its 1st, so a partial first month
		// gets no label and a month that starts mid-week (Oct 1 on a Thursday)
		// still labels that week. A 1st that is still ahead of today would
		// label cells that all belong to the old month.
		start := first + int64(week*7)
		for d := start; d < start+7 && d <= today; d++ {
			if _, month, date := format.CivilFromDays(d); date == 1 {
				grid.Months = append(grid.Months, MonthLabel{Column: week, Name: months[month-1]})
				break
			}
		}
	}
	return grid
}
