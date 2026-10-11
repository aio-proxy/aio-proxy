package live

import (
	"math"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

func golden(t *testing.T) []byte {
	t.Helper()
	body, err := os.ReadFile("../../../packages/types/src/desktop-live/fixtures/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestTheGoldenFixtureParses(t *testing.T) {
	snap, err := Parse(golden(t))
	if err != nil {
		t.Fatal(err)
	}
	if snap.TodayTokens.Cmp(big.NewInt(1_234_567)) != 0 || snap.TodayCostNanoUsd.Cmp(big.NewInt(3_410_000_000)) != 0 {
		t.Fatalf("counts %+v", snap)
	}
	if snap.InFlight != 2 || snap.OutputTokensPerSecond != 48.3 {
		t.Fatalf("live %+v", snap)
	}
}

func TestTheMaximumU128TokenCountSurvives(t *testing.T) {
	body := string(golden(t))
	body = replaceOnce(body, "1234567", "340282366920938463463374607431768211455")
	snap, err := Parse([]byte(body))
	if err != nil {
		t.Fatal(err)
	}
	max := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 128), big.NewInt(1))
	if snap.TodayTokens.Cmp(max) != 0 {
		t.Fatal(snap.TodayTokens)
	}
}

func TestAnUnsupportedVersionIsRejected(t *testing.T) {
	body := replaceOnce(string(golden(t)), `"version": 1`, `"version": 2`)
	if _, err := Parse([]byte(body)); err == nil {
		t.Fatal("accepted version 2")
	}
}

func TestANegativeOrNonFiniteRateIsRejected(t *testing.T) {
	for _, rate := range []string{"-1", "1e400", "-1e400"} {
		body := replaceOnce(string(golden(t)), "48.3", rate)
		if _, err := Parse([]byte(body)); err == nil {
			t.Fatalf("accepted %s", rate)
		}
	}
	if math.IsInf(math.Inf(1), 0) {
		for _, rate := range []string{"NaN", "Infinity", "-Infinity"} {
			body := replaceOnce(string(golden(t)), "48.3", rate)
			if _, err := Parse([]byte(body)); err == nil {
				t.Fatalf("accepted %s", rate)
			}
		}
	}
}

func replaceOnce(s, old, new string) string {
	i := indexOf(s, old)
	if i < 0 {
		return s
	}
	return s[:i] + new + s[i+len(old):]
}
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func sample() Snapshot {
	return Snapshot{
		TodayTokens: big.NewInt(1_234_567), TodayCostNanoUsd: big.NewInt(3_410_000_000),
		InFlight: 2, OutputTokensPerSecond: 48.25,
	}
}

func TestFormatsTokensRateCostAndRequests(t *testing.T) {
	for _, row := range []struct {
		n    int64
		want string
	}{
		{999, "999"}, {1_234, "1.23K"}, {1_234_567, "1.23M"}, {12_345_678, "12.3M"},
		{123_456_789, "123M"}, {1_234_567_890, "1.23B"},
		{9_994, "9.99K"}, {9_995, "10.0K"}, {99_949, "99.9K"}, {99_950, "100K"},
		{999_499, "999K"}, {999_950, "1.00M"}, {999_999, "1.00M"},
		{999_499_999, "999M"}, {999_950_000, "1.00B"},
	} {
		snap := sample()
		snap.TodayTokens = big.NewInt(row.n)
		if got := Format(menubar.TodayTokens, snap); got.Label != "TOK" || got.Value != row.want || got.Unit != "tok" {
			t.Errorf("%d -> %+v", row.n, got)
		}
	}
	snap := sample()
	for _, row := range []struct {
		rate float64
		want string
	}{{48.25, "48.3"}, {0, "0.0"}, {123.6, "124"}, {99.94, "99.9"}, {99.95, "100"}} {
		snap.OutputTokensPerSecond = row.rate
		if got := Format(menubar.TokensPerSecond, snap); got.Value != row.want || got.Unit != "tok/s" {
			t.Errorf("%v -> %+v", row.rate, got)
		}
	}
	for _, row := range []struct {
		nano int64
		want string
	}{{3_410_000_000, "$3.41"}, {123_400_000_000, "$123"}, {99_994_999_999, "$99.99"}, {99_995_000_000, "$100"}} {
		snap.TodayCostNanoUsd = big.NewInt(row.nano)
		if got := Format(menubar.TodayCost, snap); got.Value != row.want || got.Unit != "" {
			t.Errorf("%d -> %+v", row.nano, got)
		}
	}
	if got := Format(menubar.InFlight, snap); got.Label != "REQ" || got.Value != "2" || got.Unit != "req" {
		t.Fatal(got)
	}
}

func TestPollInterval(t *testing.T) {
	if _, ok := PollInterval(menubar.DefaultPreferences()); ok {
		t.Fatal("empty selection polls")
	}
	tokens := menubar.DefaultPreferences().Toggle(menubar.TodayTokens)
	if d, ok := PollInterval(tokens); !ok || d != 15*time.Second {
		t.Fatalf("today %v %v", d, ok)
	}
	cost := menubar.DefaultPreferences().Toggle(menubar.TodayCost)
	if d, ok := PollInterval(cost); !ok || d != 15*time.Second {
		t.Fatal(d)
	}
	both := cost.Toggle(menubar.InFlight)
	if d, ok := PollInterval(both); !ok || d != time.Second {
		t.Fatal(d)
	}
	if d, ok := PollInterval(menubar.DefaultPreferences().Toggle(menubar.TokensPerSecond)); !ok || d != time.Second {
		t.Fatal(d)
	}
}

func TestSchedule(t *testing.T) {
	now := time.Now()
	key := Key{Prefs: menubar.DefaultPreferences().Toggle(menubar.InFlight), Epoch: 1}
	var schedule Schedule
	if !schedule.Due(now, key, true) || schedule.Due(now.Add(time.Second), key, true) {
		t.Fatal("overlap")
	}
	schedule.Finished()
	if schedule.Due(now.Add(500*time.Millisecond), key, true) || !schedule.Due(now.Add(time.Second), key, true) {
		t.Fatal("one second")
	}
	schedule.Finished()
	today := Key{Prefs: menubar.DefaultPreferences().Toggle(menubar.TodayTokens), Epoch: 1}
	if !schedule.Due(now, today, true) {
		t.Fatal("first today")
	}
	schedule.Finished()
	if schedule.Due(now.Add(14*time.Second), today, true) || !schedule.Due(now.Add(15*time.Second), today, true) {
		t.Fatal("fifteen seconds")
	}
	schedule.Finished()
	changed := today
	changed.Prefs = changed.Prefs.Toggle(menubar.TodayTokens).Toggle(menubar.TodayCost)
	if !schedule.Due(now.Add(16*time.Second), changed, true) {
		t.Fatal("selection change")
	}
	schedule.Finished()
	changed.Epoch = 2
	if !schedule.Due(now.Add(17*time.Second), changed, true) {
		t.Fatal("epoch change")
	}

	var recover Schedule
	selected := Key{Prefs: menubar.DefaultPreferences().Toggle(menubar.TodayTokens), Epoch: 1}
	if !recover.Due(now, selected, true) || recover.Due(now.Add(time.Second), selected, false) {
		t.Fatal("ineligible did not clear")
	}
	recover.Finished()
	if !recover.Due(now.Add(2*time.Second), selected, true) {
		t.Fatal("recovery")
	}
	recover.Finished()
	none := Key{Prefs: menubar.DefaultPreferences(), Epoch: 1}
	for _, seconds := range []int{3, 20, 100} {
		if recover.Due(now.Add(time.Duration(seconds)*time.Second), none, true) {
			t.Fatal("empty selection polled")
		}
	}
	if !recover.Due(now.Add(2*time.Second), selected, true) {
		t.Fatal("re-enabled selection waited")
	}
}

func TestDisplayFailuresEpochAndUnauthorized(t *testing.T) {
	var display Display
	if rows, _, _ := Lines(menubar.DefaultPreferences().Toggle(menubar.TodayTokens), display, 0, false); len(rows) != 1 || rows[0].Value != "—" {
		t.Fatalf("empty %+v", rows)
	}
	display.Accept(0, sample())
	rows, _, dimmed := Lines(menubar.DefaultPreferences().Toggle(menubar.TodayTokens), display, 0, false)
	if dimmed || rows[0].Value != "1.23M" {
		t.Fatalf("fresh %+v dimmed %v", rows, dimmed)
	}
	display.Fail(0)
	display.Fail(0)
	_, _, dimmed = Lines(menubar.DefaultPreferences().Toggle(menubar.TodayTokens), display, 0, false)
	if !dimmed || display.kind() != viewStale {
		t.Fatal("expected stale")
	}
	display.Fail(0)
	rows, _, dimmed = Lines(menubar.DefaultPreferences().Toggle(menubar.TodayTokens), display, 0, false)
	if dimmed || rows[0].Value != "—" {
		t.Fatalf("unavailable %+v", rows)
	}
	display.Accept(0, sample())
	if !display.Unauthorized(0) || display.kind() != viewStale || display.Unauthorized(0) {
		t.Fatal("auth retry")
	}
	display.SetEpoch(2)
	display.Accept(1, sample())
	rows, _, _ = Lines(menubar.DefaultPreferences().Toggle(menubar.TodayTokens), display, 2, false)
	if rows[0].Value != "—" {
		t.Fatal("old epoch restored data")
	}
	if display.Unauthorized(1) {
		t.Fatal("old unauthorized counted")
	}
	display.Accept(2, sample())
	rows, showIcon, dimmed := Lines(prefsPair(), display, 3, false)
	if len(rows) != 2 || rows[0].Value != "—" || rows[1].Value != "—" || dimmed || !showIcon {
		t.Fatalf("epoch gap %+v show %v dim %v", rows, showIcon, dimmed)
	}
	_, showIcon, dimmed = Lines(prefsPair(), display, 2, true)
	if showIcon != true || !dimmed {
		t.Fatal("stopped should force the icon and dim")
	}
	if rows, _, _ := Lines(prefsPair(), display, 2, true); rows != nil {
		t.Fatal("stopped still drew metrics")
	}
}

func prefsPair() menubar.Preferences {
	return menubar.DefaultPreferences().Toggle(menubar.TodayTokens).Toggle(menubar.TokensPerSecond)
}

func TestRediscoveryThrottle(t *testing.T) {
	now := time.Now()
	no := false
	yes := true
	if !RediscoverUnreachable(true, true, &no, time.Time{}, now) {
		t.Fatal("first unreachable")
	}
	if RediscoverUnreachable(true, true, &no, now, now.Add(4*time.Second)) {
		t.Fatal("inside 5s")
	}
	if !RediscoverUnreachable(true, true, &no, now, now.Add(5*time.Second)) {
		t.Fatal("after 5s")
	}
	if RediscoverUnreachable(true, true, &yes, time.Time{}, now) || RediscoverUnreachable(true, false, &no, time.Time{}, now) || RediscoverUnreachable(false, true, &no, time.Time{}, now) {
		t.Fatal("guard")
	}
	if RediscoverUnreachable(true, true, nil, time.Time{}, now) {
		t.Fatal("missing discovery")
	}
}
