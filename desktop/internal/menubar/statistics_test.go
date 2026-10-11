package menubar

import (
	"testing"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func sample(at time.Time, tokens uint64) *summary.SummaryV1 {
	return &summary.SummaryV1{GeneratedAt: at.Format(time.RFC3339Nano), Activity: []summary.ActivityDay{{Date: at.Format("2006-01-02"), TotalTokens: tokens}}, Usage: summary.Usage{Range: summary.D30, Current: summary.UsageTotals{InputTokens: 9999999}}}
}
func TestTodayAndThroughputDoNotUseThePanelRange(t *testing.T) {
	at := time.Date(2026, 10, 10, 12, 0, 0, 0, time.Local)
	var s Statistics
	s.Observe(sample(at, 1000), at)
	if s.TodayTokens != 1000 || s.RateAvailable || !s.Fresh(at, false) {
		t.Fatal("first daily sample must be available without claiming a rate")
	}
	later := at.Add(15 * time.Second)
	s.Observe(sample(later, 1300), later)
	if s.TodayTokens != 1300 || !s.RateAvailable || s.TokensPerSecond != 20 {
		t.Fatal("throughput did not follow daily token increments")
	}
	s.Observe(sample(at, 900), later)
	if s.TodayTokens != 1300 || s.TokensPerSecond != 20 {
		t.Fatal("out-of-order response changed statistics")
	}
	if s.Fresh(later.Add(31*time.Second), false) {
		t.Fatal("stale statistics are presented as current")
	}
	if s.Fresh(later, true) {
		t.Fatal("stopped proxy is presented as live")
	}
}
func TestMidnightAndCounterResetCannotCreateRateSpikes(t *testing.T) {
	at := time.Date(2026, 10, 10, 23, 59, 55, 0, time.Local)
	var s Statistics
	s.Observe(sample(at, 1000000), at)
	next := at.Add(15 * time.Second)
	s.Observe(sample(next, 500), next)
	if s.RateAvailable || s.TodayTokens != 500 {
		t.Fatal("rate crossed calendar boundary")
	}
	s.Observe(sample(next.Add(15*time.Second), 600), next.Add(15*time.Second))
	s.Observe(sample(next.Add(30*time.Second), 10), next.Add(30*time.Second))
	if s.RateAvailable || s.TodayTokens != 10 {
		t.Fatal("counter reset became unsigned rate spike")
	}
}
