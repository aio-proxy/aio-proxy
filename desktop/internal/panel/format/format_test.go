package format

import (
	"testing"
	"time"
)

func TestCompactsCounts(t *testing.T) {
	cases := []struct {
		n    uint64
		want string
	}{
		{999, "999"},
		{1_204, "1.2K"},
		{14_815_402, "14.8M"},
		{148_000_000, "148M"},
		{1_500_000, "1.5M"},
		{18_014_398_509_481_985, "18014T"},
		{^uint64(0), "18446744T"},
	}
	for _, c := range cases {
		if got := Compact(c.n); got != c.want {
			t.Errorf("Compact(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}

func TestFormatsNanoUSD(t *testing.T) {
	for nano, want := range map[uint64]string{20_521_353_840: "$20.52", 0: "$0.00", 1: "<$0.01"} {
		if got := USD(nano); got != want {
			t.Errorf("USD(%d) = %q, want %q", nano, got, want)
		}
	}
}

func TestRoundTripsCalendarDays(t *testing.T) {
	if DaysFromCivil(1970, 1, 1) != 0 {
		t.Error("epoch is day 0")
	}
	if d, ok := ParseDate("2026-09-29"); !ok || d != DaysFromCivil(2026, 9, 29) {
		t.Errorf("ParseDate = %d, %v", d, ok)
	}
	if y, m, d := CivilFromDays(DaysFromCivil(2024, 2, 29)); y != 2024 || m != 2 || d != 29 {
		t.Errorf("round trip = %d-%d-%d", y, m, d)
	}
	if y, m, d := CivilFromDays(-1); y != 1969 || m != 12 || d != 31 {
		t.Errorf("day -1 = %d-%d-%d", y, m, d)
	}
	for _, bad := range []string{"2026-13-01", "yesterday"} {
		if _, ok := ParseDate(bad); ok {
			t.Errorf("ParseDate(%q) parsed", bad)
		}
	}
}

func TestParsesUTCTimestampsOnly(t *testing.T) {
	if v, ok := ParseUTC("1970-01-02T00:00:01.000Z"); !ok || v != 86_401 {
		t.Errorf("Z = %d, %v", v, ok)
	}
	if v, ok := ParseUTC("1970-01-01T00:00:00+00:00"); !ok || v != 0 {
		t.Errorf("+00:00 = %d, %v", v, ok)
	}
	if _, ok := ParseUTC("1970-01-01T08:00:00+08:00"); ok {
		t.Error("a non-UTC offset parsed")
	}
}

func TestDescribesResetTimes(t *testing.T) {
	cases := []struct {
		now, at int64
		want    string
	}{
		{0, 30, "now"},
		{0, 40 * 60, "in 40m"},
		{0, 2*3_600 + 5*60, "in 2h 5m"},
		{0, 3*86_400 + 3_600, "in 3d 1h"},
		{100, 0, "now"},
	}
	for _, c := range cases {
		if got := Until(c.now, c.at); got != c.want {
			t.Errorf("Until(%d, %d) = %q, want %q", c.now, c.at, got, c.want)
		}
	}
}

func TestPercentsFloorWithoutFloatArtifacts(t *testing.T) {
	for ratio, want := range map[float64]string{0.29: "29%", 0.996: "99%", 1.5: "100%", -0.2: "0%"} {
		if got := Percent(ratio); got != want {
			t.Errorf("Percent(%v) = %q, want %q", ratio, got, want)
		}
	}
}

func TestTheCostCardKeepsThreeSignificantDigits(t *testing.T) {
	cases := []struct {
		dollars float64
		want    string
	}{
		{0.004, "<$0.01"},
		{7.468, "$7.46"},
		{74.6, "$74.6"},
		{746.99, "$746"},
		{1_234.0, "$1.2K"},
		{56_000.0, "$56.0K"},
	}
	for _, c := range cases {
		if got := USDShort(uint64(c.dollars * 1e9)); got != c.want {
			t.Errorf("USDShort(%v) = %q, want %q", c.dollars, got, c.want)
		}
	}
}

func TestUTCOffsetFollowsTheZoneAtEachInstant(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skip("no tzdata:", err)
	}
	summer, _ := ParseUTC("2026-07-01T12:00:00Z")
	winter, _ := ParseUTC("2026-12-01T12:00:00Z")
	if got := UTCOffset(ny, summer); got != -4*3_600 {
		t.Errorf("summer offset = %d", got)
	}
	if got := UTCOffset(ny, winter); got != -5*3_600 {
		t.Errorf("winter offset = %d", got)
	}
	if got := UTCOffset(time.UTC, summer); got != 0 {
		t.Errorf("UTC offset = %d", got)
	}
}
