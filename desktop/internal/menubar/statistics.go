package menubar

import (
	"fmt"
	"math"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

const PollInterval = 15 * time.Second

type Statistics struct {
	TodayTokens              uint64
	TokensPerSecond          float64
	Available, RateAvailable bool
	day                      string
	sampledAt                time.Time
	receivedAt               time.Time
}

// Throughput is accounted tokens per elapsed second between fresh server samples,
// not a guessed tokenizer count of partial stream chunks or per-request generation speed.
func (s *Statistics) Observe(value *summary.SummaryV1, now time.Time) {
	at, err := time.Parse(time.RFC3339Nano, value.GeneratedAt)
	if err != nil {
		s.Available = false
		s.RateAvailable = false
		return
	}
	if !at.After(s.sampledAt) {
		return
	}
	day := now.Format("2006-01-02")
	var tokens uint64
	for _, activity := range value.Activity {
		if activity.Date == day {
			tokens = activity.TotalTokens
			break
		}
	}
	rateAvailable := s.Available && s.day == day && tokens >= s.TodayTokens && !s.sampledAt.IsZero() && now.Sub(s.receivedAt) <= 2*PollInterval
	var rate float64
	if rateAvailable {
		rate = float64(tokens-s.TodayTokens) / at.Sub(s.sampledAt).Seconds()
	}
	*s = Statistics{TodayTokens: tokens, TokensPerSecond: rate, Available: true, RateAvailable: rateAvailable, day: day, sampledAt: at, receivedAt: now}
}
func (s Statistics) Fresh(now time.Time, down bool) bool {
	return s.Available && !down && s.day == now.Format("2006-01-02") && now.Sub(s.receivedAt) <= 2*PollInterval
}

type MetricRow struct {
	Label, Value, Unit string
}

// Rows follow the compact status-item layout: throughput above the daily total.
// A fixed array avoids an allocation on every health, summary, or preference update.
func (s Statistics) Rows(p Preferences, now time.Time, down bool) (rows [2]MetricRow, count int) {
	available := s.Fresh(now, down)
	if p.TokensPerSecond {
		value := "—"
		if available && s.RateAvailable {
			if math.Round(s.TokensPerSecond*10)/10 < 100 {
				value = fmt.Sprintf("%.1f", s.TokensPerSecond)
			} else {
				value = fmt.Sprintf("%.0f", s.TokensPerSecond)
			}
		}
		rows[count] = MetricRow{Label: "TPS", Value: value, Unit: "tok/s"}
		count++
	}
	if p.TodayTokens {
		value := "—"
		if available {
			value = format.Compact(s.TodayTokens)
		}
		rows[count] = MetricRow{Label: "TOK", Value: value, Unit: "tok"}
		count++
	}
	return
}
