// Package live is the desktop-live poll: parsing, failure display, and when the next request is due.
package live

import (
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

// Snapshot is one DesktopLiveV1 body. Token counts are integers, not float64.
type Snapshot struct {
	TodayTokens           *big.Int
	TodayCostNanoUsd      *big.Int
	InFlight              uint64
	OutputTokensPerSecond float64
}

func Parse(body []byte) (Snapshot, error) {
	var raw struct {
		Version               uint64  `json:"version"`
		TodayTokens           string  `json:"todayTokens"`
		TodayCostNanoUsd      string  `json:"todayCostNanoUsd"`
		InFlight              uint64  `json:"inFlight"`
		OutputTokensPerSecond float64 `json:"outputTokensPerSecond"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return Snapshot{}, err
	}
	if raw.Version != 1 {
		return Snapshot{}, fmt.Errorf("unsupported desktop live version: %d", raw.Version)
	}
	tokens, err := decimal(raw.TodayTokens)
	if err != nil {
		return Snapshot{}, fmt.Errorf("todayTokens: %w", err)
	}
	cost, err := decimal(raw.TodayCostNanoUsd)
	if err != nil {
		return Snapshot{}, fmt.Errorf("todayCostNanoUsd: %w", err)
	}
	if math.IsNaN(raw.OutputTokensPerSecond) || math.IsInf(raw.OutputTokensPerSecond, 0) || raw.OutputTokensPerSecond < 0 {
		return Snapshot{}, fmt.Errorf("outputTokensPerSecond must be finite and non-negative")
	}
	return Snapshot{
		TodayTokens: tokens, TodayCostNanoUsd: cost,
		InFlight: raw.InFlight, OutputTokensPerSecond: raw.OutputTokensPerSecond,
	}, nil
}

func decimal(text string) (*big.Int, error) {
	n := new(big.Int)
	if _, ok := n.SetString(text, 10); !ok || n.Sign() < 0 {
		return nil, fmt.Errorf("not a non-negative decimal integer")
	}
	return n, nil
}

// PollInterval is 1s when a live counter is selected, 15s for today-only rows, and off when nothing is selected.
func PollInterval(p menubar.Preferences) (time.Duration, bool) {
	if p.Count() == 0 {
		return 0, false
	}
	for _, metric := range p.Metrics() {
		if metric == menubar.TokensPerSecond || metric == menubar.InFlight {
			return time.Second, true
		}
	}
	return 15 * time.Second, true
}

// Key is the selection and instance a poll belongs to. Preferences is comparable.
type Key struct {
	Prefs menubar.Preferences
	Epoch uint64
}

// Schedule allows one request at a time and polls immediately after the selection, instance, or eligibility changes.
type Schedule struct {
	last     time.Time
	lastKey  Key
	hasLast  bool
	inFlight bool
}

func (s *Schedule) Due(now time.Time, key Key, eligible bool) bool {
	if !eligible {
		s.hasLast = false
		return false
	}
	interval, ok := PollInterval(key.Prefs)
	if !ok {
		s.hasLast = false
		return false
	}
	if s.inFlight {
		return false
	}
	if s.hasLast && s.lastKey == key && now.Sub(s.last) < interval {
		return false
	}
	s.last, s.lastKey, s.hasLast = now, key, true
	s.inFlight = true
	return true
}
func (s *Schedule) Finished() { s.inFlight = false }

// RediscoverUnreachable is true when health is up, a metric is selected, and discovery says the
// instance is gone, at most once every 5s.
func RediscoverUnreachable(hasMetrics, healthUp bool, reachable *bool, last time.Time, now time.Time) bool {
	return hasMetrics && healthUp && reachable != nil && !*reachable && (last.IsZero() || now.Sub(last) >= 5*time.Second)
}

type viewKind int

const (
	viewUnavailable viewKind = iota
	viewFresh
	viewStale
)

// Display remembers the last good snapshot for one instance epoch.
type Display struct {
	epoch         uint64
	last          Snapshot
	hasLast       bool
	failures      uint32
	authRetryUsed bool
}

func (d *Display) Epoch() uint64 { return d.epoch }
func (d *Display) SetEpoch(epoch uint64) {
	if d.epoch != epoch {
		*d = Display{epoch: epoch}
	}
}
func (d *Display) Accept(epoch uint64, snap Snapshot) {
	if epoch == d.epoch {
		d.last, d.hasLast, d.failures, d.authRetryUsed = snap, true, 0, false
	}
}
func (d *Display) Fail(epoch uint64) {
	if epoch == d.epoch {
		d.failures++
	}
}

// Unauthorized counts a failure and allows one rediscovery until a later success.
func (d *Display) Unauthorized(epoch uint64) bool {
	if epoch != d.epoch {
		return false
	}
	d.Fail(epoch)
	retry := !d.authRetryUsed
	d.authRetryUsed = true
	return retry
}

func (d Display) kind() viewKind {
	switch {
	case d.hasLast && d.failures == 0:
		return viewFresh
	case d.hasLast && d.failures <= 2:
		return viewStale
	default:
		return viewUnavailable
	}
}

// Lines is what the menu bar draws. A stopped proxy hides the text and forces the icon.
// A mismatched epoch shows dashes instead of the previous instance's numbers.
func Lines(prefs menubar.Preferences, d Display, epoch uint64, stopped bool) (rows []menubar.MetricRow, showIcon, dimmed bool) {
	showIcon = stopped || prefs.ShowsIcon()
	if stopped {
		return nil, true, true
	}
	kind := viewUnavailable
	snap := d.last
	if d.epoch == epoch {
		kind = d.kind()
	}
	dimmed = kind == viewStale
	for _, metric := range prefs.Metrics() {
		row := Format(metric, snap)
		if kind == viewUnavailable {
			row.Value = "—"
		}
		rows = append(rows, row)
	}
	return rows, showIcon, dimmed
}
