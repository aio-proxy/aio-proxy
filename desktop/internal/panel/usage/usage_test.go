package usage

import (
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/format"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func n(v uint64) summary.Count { return summary.CountOf(v) }

func totals(requests, failed, cost uint64, coverage *float64) summary.UsageTotals {
	return summary.UsageTotals{Requests: n(requests), FailedRequests: n(failed), InputTokens: n(60), OutputTokens: n(40), EstimatedCostNanoUSD: n(cost), PricingCoverage: coverage}
}

func TestDeltasColorFailedAndCostButNotTraffic(t *testing.T) {
	for _, test := range []struct {
		current, previous uint64
		metric            Metric
		text              string
		tone              Tone
	}{
		{112, 100, MetricRequests, "↑ 12%", ToneNeutral},
		{90, 100, MetricTokens, "↓ 10%", ToneNeutral},
		{8, 5, MetricFailed, "+3", ToneBad},
		{3, 5, MetricFailed, "−2", ToneGood},
		{105, 100, MetricCost, "↑ 5%", ToneBad},
		{95, 100, MetricCost, "↓ 5%", ToneGood},
	} {
		text, tone := Delta(n(test.current), n(test.previous), test.metric)
		if text != test.text || tone != test.tone {
			t.Errorf("Delta(%d,%d,%v) = (%q,%v), want (%q,%v)", test.current, test.previous, test.metric, text, tone, test.text, test.tone)
		}
	}
}

func TestAZeroPreviousWindowReadsNewOrDash(t *testing.T) {
	if text, tone := Delta(n(4), n(0), MetricRequests); text != "new" || tone != ToneNeutral {
		t.Errorf("new = (%q,%v)", text, tone)
	}
	if text, tone := Delta(n(0), n(0), MetricCost); text != "—" || tone != ToneNeutral {
		t.Errorf("empty = (%q,%v)", text, tone)
	}
}

func TestCostMarksPartialPricingAndUnknownPricing(t *testing.T) {
	for _, test := range []struct {
		totals summary.UsageTotals
		metric Metric
		want   string
	}{
		{totals(1, 0, 4_120_000_000, new(1.0)), MetricCost, "$4.12"},
		{totals(1, 0, 4_120_000_000, new(0.8)), MetricCost, "≈$4.12"},
		{totals(1, 0, 0, nil), MetricCost, "—"},
		{totals(1_240, 0, 0, nil), MetricRequests, "1.2K"},
		{totals(1, 0, 0, nil), MetricTokens, "100"},
	} {
		if got := CardValue(&test.totals, test.metric); got != test.want {
			t.Errorf("CardValue(%+v,%v) = %q, want %q", test.totals, test.metric, got, test.want)
		}
	}
}

func TestAZeroPercentChangeHasNoColor(t *testing.T) {
	for _, test := range []struct {
		current uint64
		text    string
	}{{1004, "↑ 0%"}, {996, "↓ 0%"}} {
		if text, tone := Delta(n(test.current), n(1000), MetricCost); text != test.text || tone != ToneNeutral {
			t.Errorf("Delta(%d,1000,Cost) = (%q,%v)", test.current, text, tone)
		}
	}
}

func TestUnknownPricingLeavesTheCostDeltaBlank(t *testing.T) {
	current, previous := totals(5, 0, 900, nil), totals(5, 0, 300, new(1.0))
	if text, tone := CardDelta(&current, &previous, MetricCost); text != "—" || tone != ToneNeutral {
		t.Errorf("unknown cost delta = (%q,%v)", text, tone)
	}
	priced := totals(5, 0, 900, new(1.0))
	if text, tone := CardDelta(&priced, &previous, MetricCost); text != "↑ 200%" || tone != ToneBad {
		t.Errorf("priced cost delta = (%q,%v)", text, tone)
	}
	if text, _ := CardDelta(&current, &previous, MetricRequests); text != "↑ 0%" {
		t.Errorf("request delta = %q", text)
	}
}

func TestHourlyBucketsReadAsTheLocalTimeTheyStart(t *testing.T) {
	for _, test := range []struct {
		start  string
		offset int64
		want   string
	}{
		{"2026-09-29T14:30:00.000Z", 8 * 3600, "22:30"},
		{"2026-09-29T02:15:00.000Z", -5 * 3600, "21:15"},
	} {
		if got := BucketLabel(test.start, summary.BucketUnitHour, summary.H24, test.offset); got != test.want {
			t.Errorf("BucketLabel(%q) = %q, want %q", test.start, got, test.want)
		}
	}
}

func TestDailyBucketsUseWeekdaysFor7dAndMonthDayFor30d(t *testing.T) {
	for _, test := range []struct {
		start  string
		window summary.UsageRange
		offset int64
		want   string
	}{
		{"2026-09-28T16:00:00.000Z", summary.D7, 8 * 3600, "Tue"},
		{"2026-09-28T16:00:00.000Z", summary.D30, 8 * 3600, "Sep 29"},
		{"2026-09-29T05:00:00.000Z", summary.D7, -5 * 3600, "Tue"},
		{"not a date", summary.D30, 0, ""},
	} {
		if got := BucketLabel(test.start, summary.BucketUnitDay, test.window, test.offset); got != test.want {
			t.Errorf("BucketLabel(%q,%v) = %q, want %q", test.start, test.window, got, test.want)
		}
	}
}

func requests(v uint64) summary.UsageSlice { return summary.UsageSlice{Requests: n(v)} }

func TestTheTrendStacksTheTopFourAndFoldsTheRestIntoOther(t *testing.T) {
	buckets := []summary.UsageBucket{{Slice: requests(30)}, {Slice: requests(12)}}
	cell := func(bucket int, key string, n uint64) summary.TrendCell {
		return summary.TrendCell{Bucket: bucket, Key: key, Slice: requests(n)}
	}
	cells := []summary.TrendCell{
		cell(0, "a", 10), cell(0, "b", 6), cell(1, "b", 4), cell(0, "c", 5),
		cell(0, "d", 4), cell(1, "d", 2), cell(0, "e", 1), cell(1, "f", 1), cell(1, "zero", 0),
	}
	series := Stack(buckets, cells, strings.ToUpper, MetricRequests)
	want := []Series{
		{Key: "a", Label: "A", Values: []summary.Count{n(10), n(0)}},
		{Key: "b", Label: "B", Values: []summary.Count{n(6), n(4)}},
		{Key: "d", Label: "D", Values: []summary.Count{n(4), n(2)}},
		{Key: "c", Label: "C", Values: []summary.Count{n(5), n(0)}},
		{Label: "Other", Other: true, Values: []summary.Count{n(5), n(6)}},
	}
	if !reflect.DeepEqual(series, want) {
		t.Fatalf("series = %+v, want %+v", series, want)
	}
	for i, bucket := range buckets {
		var sum summary.Count
		for _, s := range series {
			sum = sum.Add(s.Values[i])
		}
		if sum.Cmp(bucket.Slice.Requests) != 0 {
			t.Errorf("bucket %d stacks to %s, want %s", i, sum, bucket.Slice.Requests)
		}
	}
}

func TestAFullySplitTrendHasNoOther(t *testing.T) {
	buckets := []summary.UsageBucket{{Slice: requests(3)}}
	cells := []summary.TrendCell{{Bucket: 0, Key: "a", Slice: requests(3)}}
	label := func(key string) string { return key }
	if series := Stack(buckets, cells, label, MetricRequests); len(series) != 1 || series[0].Other {
		t.Errorf("fully split = %+v", series)
	}
	if series := Stack(buckets, cells, label, MetricFailed); len(series) != 0 {
		t.Errorf("empty failed series = %+v", series)
	}
}

func TestEachBucketIsLabelledWithTheOffsetAtItsOwnStart(t *testing.T) {
	buckets := []summary.UsageBucket{{Start: "2026-10-31T04:00:00.000Z"}, {Start: "2026-11-02T05:00:00.000Z"}}
	switchAt, _ := format.ParseUTC("2026-11-01T06:00:00.000Z")
	offsetAt := func(unix int64) int64 {
		if unix < switchAt {
			return -4 * 3600
		}
		return -5 * 3600
	}
	if got := BucketLabels(buckets, summary.BucketUnitDay, summary.D30, offsetAt); !slices.Equal(got, []string{"Oct 31", "Nov 2"}) {
		t.Errorf("labels = %v", got)
	}
	if got := BucketLabel(buckets[0].Start, summary.BucketUnitDay, summary.D30, -5*3600); got != "Oct 30" {
		t.Errorf("current offset applied to old bucket = %q", got)
	}
}
