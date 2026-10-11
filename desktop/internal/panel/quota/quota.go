// Package quota is the Quota group's model: which Providers appear, each
// window's pace against an even burn, and the attention order. Pure; the view
// only lays these out.
package quota

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strings"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

// Low is the remaining ratio below which a window fills amber and its
// Provider needs attention.
const Low = 0.15

type Pace struct {
	// Expected is where an even burn would be now: the pace tick, as a
	// remaining ratio.
	Expected float64
	Behind   bool
	Note     string
}

type WindowView struct {
	Label string
	// Remaining is clamped to 0..1; nil when the plugin reports none.
	Remaining *float64
	// LeftText is "resets in 2h 13m"; "" without a reset time.
	LeftText string
	// Pace is nil unless the window has a remaining ratio, a reset time and
	// a positive length.
	Pace *Pace
	Low  bool
}

type Block struct {
	Provider *summary.Provider
	// Title is the service, so accounts of different plugins under one email
	// stay apart.
	Title string
	// Subtitle is the account, or the Provider name when the plugin reports
	// none; "" when it repeats the title.
	Subtitle string
	Windows  []WindowView
	// Rank is 0 failed or diagnostic, 1 a window below 15%, 2 a window behind
	// pace, 3 the rest.
	Rank int
	// Message, Command and Plan are "" when absent.
	Message string
	Command string
	Plan    string
	// SampledAt is Unix seconds; nil when not Ready or unparsable.
	SampledAt     *int64
	RefreshFailed bool
	Loading       bool
}

func DurationText(minutes float64) string {
	// As Rust's saturating `as i64`: NaN and negatives are 0.
	var m int64
	switch r := math.Round(minutes); {
	case !(r > 0):
	case r >= math.MaxInt64:
		m = math.MaxInt64
	default:
		m = int64(r)
	}
	d, h, mm := m/1_440, m/60%24, m%60
	switch {
	case d == 0 && h == 0:
		return fmt.Sprintf("%dm", mm)
	case d == 0:
		return fmt.Sprintf("%dh %dm", h, mm)
	default:
		return fmt.Sprintf("%dd %dh", d, h)
	}
}

func Relative(now, at int64) string {
	seconds := max(now-at, 0)
	switch {
	case seconds < 60:
		return "just now"
	case seconds < 3_600:
		return fmt.Sprintf("%d min ago", seconds/60)
	case seconds < 86_400:
		return fmt.Sprintf("%d h ago", seconds/3_600)
	default:
		return fmt.Sprintf("%d d ago", seconds/86_400)
	}
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(v, hi)) }

// pace is the spec's pace math. left and length are minutes; remaining is 0..1.
func pace(remaining, left, length float64) Pace {
	if length <= 0 {
		return Pace{Note: "0% in reserve · lasts until reset"}
	}
	remaining, left = clamp(remaining, 0, 1), math.Max(left, 0)
	elapsed := clamp(1-left/length, 0.01, 1)
	expected := 1 - elapsed
	reserve := remaining - expected
	burn := (1 - remaining) / (elapsed * length)
	runsOutIn := math.Inf(1)
	if burn > 0 {
		runsOutIn = remaining / burn
	}
	behind := reserve < 0 && runsOutIn < left
	var note string
	if behind {
		note = fmt.Sprintf("%.0f%% over pace · runs out in %s", math.Round(-reserve*100), DurationText(runsOutIn))
	} else {
		note = fmt.Sprintf("%.0f%% in reserve · lasts until reset", math.Round(math.Max(reserve, 0)*100))
	}
	return Pace{Expected: expected, Behind: behind, Note: note}
}

func windowView(w *summary.QuotaWindow, now int64) WindowView {
	at, hasReset := int64(0), false
	if w.ResetsAt != "" {
		at, hasReset = format.ParseUTC(w.ResetsAt)
	}
	view := WindowView{Label: w.Label.Text()}
	if w.RemainingRatio != nil {
		view.Remaining = new(clamp(*w.RemainingRatio, 0, 1))
		view.Low = *w.RemainingRatio < Low
	}
	if hasReset {
		view.LeftText = "resets " + format.Until(now, at)
	}
	if w.RemainingRatio != nil && hasReset && w.WindowMinutes != nil && *w.WindowMinutes > 0 {
		view.Pace = new(pace(clamp(*w.RemainingRatio, 0, 1), float64(max(at-now, 0))/60, float64(*w.WindowMinutes)))
	}
	return view
}

// Blocks lists the Providers with a quota capability, in attention order
// (spec ranks), then by name (case-insensitive).
func Blocks(providers []summary.Provider, now int64) []Block {
	var blocks []Block
	for i := range providers {
		provider := &providers[i]
		q := &provider.Quota
		if q.Kind != summary.QuotaLoading && q.Kind != summary.QuotaFailed && q.Kind != summary.QuotaReady {
			continue
		}
		b := Block{Provider: provider, Title: provider.Title(), Loading: q.Kind == summary.QuotaLoading}
		b.Subtitle, _ = provider.Subtitle()
		if q.Kind == summary.QuotaReady {
			for j := range q.Windows {
				b.Windows = append(b.Windows, windowView(&q.Windows[j], now))
			}
			if q.Plan != nil {
				b.Plan = q.Plan.Text()
			}
			if at, ok := format.ParseUTC(q.SampledAt); ok {
				b.SampledAt = new(at)
			}
			b.RefreshFailed = q.RefreshFailed
		}
		if provider.Diagnostic != nil {
			b.Message = provider.Diagnostic.Summary
			b.Command = provider.Diagnostic.SuggestedCommand
		} else if q.Kind == summary.QuotaFailed {
			b.Message = "Quota unavailable"
		}
		b.Rank = rank(provider.Diagnostic != nil || q.Kind == summary.QuotaFailed, b.Windows)
		blocks = append(blocks, b)
	}
	slices.SortStableFunc(blocks, func(a, b Block) int {
		return cmp.Or(
			cmp.Compare(a.Rank, b.Rank),
			strings.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title)),
			strings.Compare(strings.ToLower(a.Subtitle), strings.ToLower(b.Subtitle)),
			strings.Compare(a.Title, b.Title),
		)
	})
	return blocks
}

func rank(message bool, windows []WindowView) int {
	if message {
		return 0
	}
	if slices.ContainsFunc(windows, func(w WindowView) bool { return w.Low }) {
		return 1
	}
	if slices.ContainsFunc(windows, func(w WindowView) bool { return w.Pace != nil && w.Pace.Behind }) {
		return 2
	}
	return 3
}

// IconURL is where a plugin icon loads from, as the Dashboard's `PluginIcon`
// resolves it: a URL as is, a Lobe Icons slug from the static PNG set for the
// appearance. Anything else draws no image ("").
func IconURL(icon string, dark bool) string {
	if strings.HasPrefix(icon, "http://") || strings.HasPrefix(icon, "https://") {
		return icon
	}
	for i := range len(icon) {
		c := icon[i]
		if !('a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-') {
			return ""
		}
	}
	theme := "light"
	if dark {
		theme = "dark"
	}
	return fmt.Sprintf("https://fastly.jsdelivr.net/npm/@lobehub/icons-static-png@latest/%s/%s.png", theme, icon)
}

// Tightest is the window with the least left, which the collapsed title
// shows; nil when no window reports a remaining ratio.
func (b *Block) Tightest() *WindowView {
	var tight *WindowView
	for i := range b.Windows {
		w := &b.Windows[i]
		if w.Remaining != nil && (tight == nil || *w.Remaining < *tight.Remaining) {
			tight = w
		}
	}
	return tight
}

// OpensByDefault: failing or nearly exhausted blocks open on their own; the
// rest start collapsed.
func (b *Block) OpensByDefault() bool { return b.Rank <= 1 }

// AttentionCount counts failing or nearly exhausted blocks; merely over pace
// only sorts higher.
func AttentionCount(blocks []Block) int {
	n := 0
	for i := range blocks {
		if blocks[i].Rank <= 1 {
			n++
		}
	}
	return n
}
