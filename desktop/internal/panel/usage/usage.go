// Package usage is the Usage group's numbers: which metric is picked, how it
// compares with the previous window, and how the breakdowns rank. Pure; the
// views only lay these out.
package usage

import (
	"cmp"
	"fmt"
	"math"
	"slices"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/activity"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

type Metric int

const (
	MetricRequests Metric = iota // the default
	MetricFailed
	MetricTokens
	MetricCost
)

var AllMetrics = [4]Metric{MetricRequests, MetricFailed, MetricTokens, MetricCost}

func (m Metric) Label() string {
	switch m {
	case MetricFailed:
		return "Failed"
	case MetricTokens:
		return "Tokens"
	case MetricCost:
		return "Cost"
	default:
		return "Requests"
	}
}

func (m Metric) String() string { return m.Label() }

func (m Metric) EmptyText() string {
	switch m {
	case MetricFailed:
		return "No failures in this window"
	case MetricTokens:
		return "No tokens in this window"
	case MetricCost:
		return "No cost in this window"
	default:
		return "No requests in this window"
	}
}

// risingIsBad: more failures or more spend is bad; more traffic is neither.
func (m Metric) risingIsBad() bool { return m == MetricFailed || m == MetricCost }

type Tone int

const (
	ToneNeutral Tone = iota
	ToneBad
	ToneGood
)

func (t Tone) String() string {
	switch t {
	case ToneBad:
		return "Bad"
	case ToneGood:
		return "Good"
	default:
		return "Neutral"
	}
}

func MetricTotal(t *summary.UsageTotals, m Metric) summary.Count {
	switch m {
	case MetricFailed:
		return t.FailedRequests
	case MetricTokens:
		return t.InputTokens.Add(t.OutputTokens)
	case MetricCost:
		return t.EstimatedCostNanoUSD
	default:
		return t.Requests
	}
}

func SliceValue(s *summary.UsageSlice, m Metric) summary.Count {
	switch m {
	case MetricFailed:
		return s.FailedRequests
	case MetricTokens:
		return s.TotalTokens
	case MetricCost:
		return s.EstimatedCostNanoUSD
	default:
		return s.Requests
	}
}

func FormatValue(value summary.Count, m Metric) string {
	if m == MetricCost {
		return format.USDDigits(value.String())
	}
	return format.CompactDigits(value.String())
}

func CardValue(t *summary.UsageTotals, m Metric) string {
	if m != MetricCost {
		return FormatValue(MetricTotal(t, m), m)
	}
	switch {
	case t.PricingCoverage == nil:
		return "—"
	case *t.PricingCoverage < 1:
		return "≈" + format.USDShortDigits(t.EstimatedCostNanoUSD.String())
	default:
		return format.USDShortDigits(t.EstimatedCostNanoUSD.String())
	}
}

func Delta(current, previous summary.Count, m Metric) (string, Tone) {
	if previous.IsZero() {
		if current.IsZero() {
			return "—", ToneNeutral
		}
		return "new", ToneNeutral
	}
	tone := ToneNeutral
	if m.risingIsBad() {
		switch current.Cmp(previous) {
		case 1:
			tone = ToneBad
		case -1:
			tone = ToneGood
		}
	}
	if m == MetricFailed {
		if current.Cmp(previous) >= 0 {
			return "+" + current.Sub(previous).String(), tone
		}
		return "−" + previous.Sub(current).String(), tone
	}
	change := (current.Float64() - previous.Float64()) / previous.Float64() * 100
	arrow := "↑"
	if change < 0 {
		arrow = "↓"
	}
	percent := fmt.Sprintf("%.0f", math.Abs(change))
	// A change that reads 0% is no change worth a color.
	if percent == "0" {
		tone = ToneNeutral
	}
	return arrow + " " + percent + "%", tone
}

// CardDelta is the card's delta line. Unknown pricing shows `—` for Cost, so
// its delta cannot claim a change.
func CardDelta(current, previous *summary.UsageTotals, m Metric) (string, Tone) {
	if m == MetricCost && current.PricingCoverage == nil {
		return "—", ToneNeutral
	}
	return Delta(MetricTotal(current, m), MetricTotal(previous, m), m)
}

// Split is what the trend's bars stack by.
type Split int

const (
	SplitModel Split = iota // the default
	SplitProvider
)

var AllSplits = [2]Split{SplitModel, SplitProvider}

func (s Split) Label() string {
	if s == SplitProvider {
		return "Provider"
	}
	return "Model"
}

func (s Split) String() string { return s.Label() }

// Stacked is the named series a trend stacks before the rest folds into
// Other, as the Dashboard's trend does.
const Stacked = 4

type Series struct {
	// Key is the model or Provider id; "" for Other.
	Key   string
	Label string
	Other bool
	// Values is the metric per bucket.
	Values []summary.Count
}

// Stack returns the trend's series, bottom first: the top [Stacked] keys by
// the metric over the window, then Other, the rest of each bucket (cells
// cover only the server's top models), when any is left. Keys with nothing
// for the metric are not drawn.
func Stack(buckets []summary.UsageBucket, cells []summary.TrendCell, label func(string) string, m Metric) []Series {
	type total struct {
		key   string
		value summary.Count
	}
	var totals []total
	for i := range cells {
		value := SliceValue(&cells[i].Slice, m)
		if j := slices.IndexFunc(totals, func(t total) bool { return t.key == cells[i].Key }); j >= 0 {
			totals[j].value = totals[j].value.Add(value)
		} else {
			totals = append(totals, total{cells[i].Key, value})
		}
	}
	totals = slices.DeleteFunc(totals, func(t total) bool { return t.value.IsZero() })
	slices.SortFunc(totals, func(a, b total) int {
		return cmp.Or(b.value.Cmp(a.value), cmp.Compare(a.key, b.key))
	})
	totals = totals[:min(len(totals), Stacked)]

	series := make([]Series, 0, len(totals)+1)
	for _, t := range totals {
		values := make([]summary.Count, len(buckets))
		for i := range cells {
			if b := cells[i].Bucket; cells[i].Key == t.key && b >= 0 && b < len(values) {
				values[b] = values[b].Add(SliceValue(&cells[i].Slice, m))
			}
		}
		series = append(series, Series{Key: t.key, Label: label(t.key), Values: values})
	}
	other := make([]summary.Count, len(buckets))
	anyOther := false
	for i := range buckets {
		var named summary.Count
		for _, s := range series {
			named = named.Add(s.Values[i])
		}
		if v := SliceValue(&buckets[i].Slice, m); v.Cmp(named) > 0 {
			other[i] = v.Sub(named)
			anyOther = true
		}
	}
	if anyOther {
		series = append(series, Series{Label: "Other", Other: true, Values: other})
	}
	return series
}

var months = [12]string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}

// BucketLabels labels every bucket, each with the UTC offset in force at its
// own start (offsetAt, local time's offset at a Unix time, e.g.
// format.LocalUTCOffset): a window can span a daylight-saving change, and the
// current offset would put an older local midnight on the day before.
func BucketLabels(buckets []summary.UsageBucket, unit summary.BucketUnit, r summary.UsageRange, offsetAt func(int64) int64) []string {
	labels := make([]string, len(buckets))
	for i := range buckets {
		var offset int64
		if unix, ok := format.ParseUTC(buckets[i].Start); ok {
			offset = offsetAt(unix)
		}
		labels[i] = BucketLabel(buckets[i].Start, unit, r, offset)
	}
	return labels
}

// BucketLabel is the axis and caption label of a bucket, from its UTC start.
// Hourly buckets are rolling (they start at now − 24 h + i h), so they read
// `HH:MM`; `7d` days read as weekdays (`Tue`) and `30d` days as `Mon D` (the
// server's day bucket starts at local midnight). Empty when the timestamp does
// not parse.
func BucketLabel(start string, unit summary.BucketUnit, r summary.UsageRange, utcOffset int64) string {
	unix, ok := format.ParseUTC(start)
	if !ok {
		return ""
	}
	local := unix + utcOffset
	days, secs := local/86_400, local%86_400
	if secs < 0 {
		days, secs = days-1, secs+86_400
	}
	switch {
	case unit == summary.BucketUnitHour:
		return fmt.Sprintf("%02d:%02d", secs/3_600, secs%3_600/60)
	case r == summary.D7:
		return activity.WeekdayName(days)
	default:
		_, month, day := format.CivilFromDays(days)
		return fmt.Sprintf("%s %d", months[month-1], day)
	}
}
