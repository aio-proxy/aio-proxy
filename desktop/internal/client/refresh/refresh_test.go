package refresh

import (
	"testing"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

var (
	done    = Finished{Kind: Summary}
	loading = Finished{Kind: Summary, AnyLoading: true}
)

func secs(n int) time.Duration { return time.Duration(n) * time.Second }

func mustOrder(t *testing.T, order *FetchOrder, what string) FetchOrder {
	t.Helper()
	if order == nil {
		t.Fatalf("%s: no fetch", what)
	}
	return *order
}

func noOrder(t *testing.T, order *FetchOrder, what string) {
	t.Helper()
	if order != nil {
		t.Fatalf("%s: unexpected fetch %+v", what, *order)
	}
}

func expectWake(t *testing.T, s *Scheduler, want time.Time) {
	t.Helper()
	got, ok := s.NextWake()
	if !ok || !got.Equal(want) {
		t.Fatalf("next wake (%v, %v), want %v", got, ok, want)
	}
}

func TestOpeningFetchesAtOnceWithoutQuotaRefresh(t *testing.T) {
	var s Scheduler
	order := mustOrder(t, s.Open(time.Now()), "panel open fetches")
	if order.RefreshQuota {
		t.Fatal("open asked for a quota refresh")
	}
}

func TestAResponseFromAClosedSessionIsDiscarded(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	first := mustOrder(t, s.Open(t0), "open")
	s.Close()
	if ok, follow := s.Finished(first.Tag, done, t0); ok || follow != nil {
		t.Fatal("closed session's response counted")
	}
	second := mustOrder(t, s.Open(t0.Add(secs(1))), "reopen")
	if ok, _ := s.Finished(first.Tag, done, t0.Add(secs(1))); ok {
		t.Fatal("old session's response counted")
	}
	if ok, _ := s.Finished(second.Tag, done, t0.Add(secs(1))); !ok {
		t.Fatal("current response discarded")
	}
}

func TestAResponseFromAnotherInstanceIsDiscarded(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	old := mustOrder(t, s.Open(t0), "open")
	nw := mustOrder(t, s.SetInstance(7, t0), "a new instance refetches")
	if nw.Tag.Instance != 7 {
		t.Fatalf("instance %d", nw.Tag.Instance)
	}
	if ok, _ := s.Finished(old.Tag, done, t0); ok {
		t.Fatal("old instance's response counted")
	}
	if ok, _ := s.Finished(nw.Tag, done, t0); !ok {
		t.Fatal("new instance's response discarded")
	}
}

func TestAResponseWithAnOlderCounterIsDiscarded(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	older := order.Tag
	older.Counter--
	if ok, _ := s.Finished(older, done, t0); ok {
		t.Fatal("older counter counted")
	}
	if ok, _ := s.Finished(order.Tag, done, t0); !ok {
		t.Fatal("current counter discarded")
	}
}

func TestThe15SecondFloorHoldsUnderATriggerStorm(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	s.Finished(order.Tag, done, t0.Add(secs(1)))
	for ms := 1_000; ms < 15_000; ms += 50 {
		now := t0.Add(time.Duration(ms) * time.Millisecond)
		noOrder(t, s.Trigger(Tick, now), "tick")
		noOrder(t, s.Wake(now), "wake")
	}
	expectWake(t, &s, t0.Add(secs(15)))
	mustOrder(t, s.Wake(t0.Add(secs(15))), "wake at 15 s")
}

func TestManualRefreshBypassesTheFloorAndRefreshesQuota(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	s.Finished(order.Tag, done, t0)
	manual := mustOrder(t, s.Trigger(Manual, t0.Add(secs(2))), "manual refresh fetches now")
	if !manual.RefreshQuota {
		t.Fatal("manual refresh did not refresh quota")
	}
	s.Finished(manual.Tag, done, t0.Add(secs(2)))
	mustOrder(t, s.Trigger(ActionDone, t0.Add(secs(3))), "action done")
}

func TestATriggerDuringARequestRunsExactlyOneMoreFetch(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	noOrder(t, s.Trigger(Manual, t0), "manual in flight")
	noOrder(t, s.Trigger(ActionDone, t0), "action in flight")
	accepted, f := s.Finished(order.Tag, done, t0.Add(secs(1)))
	if !accepted {
		t.Fatal("response discarded")
	}
	follow := mustOrder(t, f, "the dirty trigger runs once the request finishes")
	if !follow.RefreshQuota {
		t.Fatal("follow-up lost the quota refresh")
	}
	if ok, again := s.Finished(follow.Tag, done, t0.Add(secs(2))); !ok || again != nil {
		t.Fatalf("got (%v, %v)", ok, again)
	}
}

func TestADirtyTickStillWaitsForTheFloor(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	noOrder(t, s.Trigger(Tick, t0), "tick in flight")
	if ok, follow := s.Finished(order.Tag, done, t0.Add(secs(1))); !ok || follow != nil {
		t.Fatalf("got (%v, %v)", ok, follow)
	}
	expectWake(t, &s, t0.Add(secs(15)))
}

func TestLoadingQuotaGetsOneSharedRetryAfterTwoSeconds(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	s.Finished(order.Tag, loading, t0.Add(secs(1)))
	expectWake(t, &s, t0.Add(secs(3)))
	noOrder(t, s.Wake(t0.Add(2_900*time.Millisecond)), "early wake")
	retry := mustOrder(t, s.Wake(t0.Add(secs(3))), "one retry after 2 s")
	// Still loading: no second retry, just the next 15 s tick.
	if ok, follow := s.Finished(retry.Tag, loading, t0.Add(secs(4))); !ok || follow != nil {
		t.Fatalf("got (%v, %v)", ok, follow)
	}
	expectWake(t, &s, t0.Add(secs(18)))
}

func TestClosingCancelsEverything(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	s.Finished(order.Tag, loading, t0)
	s.Close()
	if s.IsOpen() {
		t.Fatal("still open")
	}
	if _, ok := s.NextWake(); ok {
		t.Fatal("a closed panel wakes")
	}
	noOrder(t, s.Wake(t0.Add(secs(60))), "wake")
	noOrder(t, s.Trigger(Manual, t0.Add(secs(60))), "manual")
	noOrder(t, s.SetInstance(9, t0.Add(secs(60))), "instance")
}

func TestSwitchingRangeFetchesAtOnceAndDropsTheOldRequest(t *testing.T) {
	start := time.Now()
	var s Scheduler
	first := mustOrder(t, s.Open(start), "open")
	if first.Range != summary.H24 {
		t.Fatalf("default range %v", first.Range)
	}
	// A switch inside the 15 s floor still fetches, and the 24h response no longer counts.
	second := mustOrder(t, s.SetRange(summary.D30, start.Add(secs(1))), "range switch")
	if second.Range != summary.D30 {
		t.Fatalf("range %v", second.Range)
	}
	if ok, _ := s.Finished(first.Tag, done, start.Add(secs(2))); ok {
		t.Fatal("old range's response counted")
	}
	if ok, _ := s.Finished(second.Tag, done, start.Add(secs(2))); !ok {
		t.Fatal("new range's response discarded")
	}
}

func TestTheSameRangeIsANoOpAndAClosedPanelOnlyRemembers(t *testing.T) {
	start := time.Now()
	var s Scheduler
	noOrder(t, s.SetRange(summary.D7, start), "closed panel")
	if s.Range() != summary.D7 {
		t.Fatalf("range %v", s.Range())
	}
	order := mustOrder(t, s.Open(start), "open")
	if order.Range != summary.D7 {
		t.Fatalf("range %v", order.Range)
	}
	noOrder(t, s.SetRange(summary.D7, start), "same range")
}

func TestAManualRefreshFetchesAgainToPickUpTheRefreshedQuota(t *testing.T) {
	t0 := time.Now()
	var s Scheduler
	order := mustOrder(t, s.Open(t0), "open")
	s.Finished(order.Tag, done, t0)
	manual := mustOrder(t, s.Trigger(Manual, t0.Add(secs(2))), "manual")
	// The response still holds the cached quota while the server reads the new one.
	s.Finished(manual.Tag, done, t0.Add(secs(2)))
	expectWake(t, &s, t0.Add(secs(4)))
	follow := mustOrder(t, s.Wake(t0.Add(secs(4))), "one follow-up after 2 s")
	if follow.RefreshQuota {
		t.Fatal("the follow-up only reads")
	}
}
