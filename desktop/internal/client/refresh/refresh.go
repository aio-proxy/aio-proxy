// Package refresh is the panel's refresh policy as a clock-injected state machine. The UI glue owns the
// timer and the in-flight request; this decides when to fetch and which responses still count.
package refresh

import (
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

const (
	RefreshInterval = 15 * time.Second
	LoadingRetry    = 2 * time.Second
)

// Tag marks every response; one from a closed session, another instance or an older counter is
// discarded.
type Tag struct {
	Session  uint64
	Instance uint64
	Counter  uint64
}

type FetchOrder struct {
	Tag Tag
	// `?refresh=true`: only for a manual refresh.
	RefreshQuota bool
	// The usage window this response is for.
	Range summary.UsageRange
}

type Trigger int

const (
	// Tick is subject to the 15 s floor.
	Tick Trigger = iota
	// ActionDone: a user action finished its completion condition.
	ActionDone
	// Manual refresh: bypasses the floor and asks the server to refresh quota.
	Manual
	// Rediscovered: discovery re-ran after a 401 and may carry a replaced token.
	Rediscovered
)

func (t Trigger) String() string {
	switch t {
	case Tick:
		return "Tick"
	case ActionDone:
		return "ActionDone"
	case Manual:
		return "Manual"
	case Rediscovered:
		return "Rediscovered"
	}
	return "Trigger(?)"
}

type FinishedKind int

const (
	Summary FinishedKind = iota
	Failed
)

// Finished is how a request ended; AnyLoading is meaningful only for Summary.
type Finished struct {
	Kind       FinishedKind
	AnyLoading bool
}

type dirty struct {
	bypass       bool
	refreshQuota bool
}

type inFlight struct {
	tag            Tag
	isRetry        bool
	refreshedQuota bool
}

// Scheduler's zero value is a closed panel on the 24h range.
type Scheduler struct {
	session  uint64 // 0 while closed; sessions count from 1
	sessions uint64
	instance uint64
	counter  uint64
	// The one request allowed in flight, whether it is the loading retry, and whether it asked the
	// server to refresh quota.
	inFlight  *inFlight
	dirty     *dirty
	lastStart time.Time // zero: none
	retryAt   time.Time // zero: none
	rng       summary.UsageRange
}

func (s *Scheduler) IsOpen() bool { return s.session != 0 }

// IsFetching reports whether a summary request is out, automatic or manual.
func (s *Scheduler) IsFetching() bool { return s.inFlight != nil }

// Open starts a new session when the panel opens; it fetches at once.
func (s *Scheduler) Open(now time.Time) *FetchOrder {
	s.Close()
	s.sessions++
	s.session = s.sessions
	return s.issue(now, false, false)
}

// Close forgets the in-flight request and every timer when the panel closes. The glue drops both tasks.
func (s *Scheduler) Close() {
	s.session = 0
	s.inFlight = nil
	s.dirty = nil
	s.lastStart = time.Time{}
	s.retryAt = time.Time{}
}

func (s *Scheduler) Range() summary.UsageRange { return s.rng }

// SetRange changes the usage window: the in-flight request (for the old window) stops counting and an
// open panel fetches the new one at once, ignoring the 15 s floor. A closed panel only remembers.
func (s *Scheduler) SetRange(r summary.UsageRange, now time.Time) *FetchOrder {
	if r == s.rng {
		return nil
	}
	s.rng = r
	if !s.IsOpen() {
		return nil
	}
	s.inFlight = nil
	s.dirty = nil
	s.retryAt = time.Time{}
	return s.issue(now, false, false)
}

// SetInstance records that discovery found a different instance: stale responses stop counting, and
// an open panel refetches.
func (s *Scheduler) SetInstance(instance uint64, now time.Time) *FetchOrder {
	if instance == s.instance {
		return nil
	}
	s.instance = instance
	s.inFlight = nil
	s.dirty = nil
	s.retryAt = time.Time{}
	return s.issue(now, false, false)
}

func (s *Scheduler) Trigger(trigger Trigger, now time.Time) *FetchOrder {
	if !s.IsOpen() {
		return nil
	}
	bypass := trigger != Tick
	refreshQuota := trigger == Manual
	if s.inFlight != nil {
		if s.dirty == nil {
			s.dirty = &dirty{}
		}
		s.dirty.bypass = s.dirty.bypass || bypass
		s.dirty.refreshQuota = s.dirty.refreshQuota || refreshQuota
		return nil
	}
	if !bypass && s.floorBlocks(now) {
		return nil
	}
	return s.issue(now, refreshQuota, false)
}

// Finished records that a request finished. It returns whether its result may be shown, plus a
// follow-up fetch.
func (s *Scheduler) Finished(tag Tag, outcome Finished, now time.Time) (bool, *FetchOrder) {
	current := s.inFlight
	if current == nil || current.tag != tag || s.session != tag.Session || s.instance != tag.Instance {
		return false, nil
	}
	s.inFlight = nil
	// A quota refresh only starts the read; the response still carries the cached quota, so a manual
	// refresh gets the same one follow-up as a loading quota.
	loading := outcome.Kind == Summary && outcome.AnyLoading
	refreshing := current.refreshedQuota && outcome.Kind == Summary
	if (loading || refreshing) && !current.isRetry && s.retryAt.IsZero() {
		s.retryAt = now.Add(LoadingRetry)
	}
	var follow *FetchOrder
	if d := s.dirty; d != nil {
		s.dirty = nil
		if d.bypass || !s.floorBlocks(now) {
			follow = s.issue(now, d.refreshQuota, false)
		}
	}
	return true, follow
}

// NextWake is when the glue's single timer should fire next; false while closed or while a request runs.
func (s *Scheduler) NextWake() (time.Time, bool) {
	if !s.IsOpen() || s.inFlight != nil {
		return time.Time{}, false
	}
	var tick time.Time
	if !s.lastStart.IsZero() {
		tick = s.lastStart.Add(RefreshInterval)
	}
	switch {
	case !tick.IsZero() && !s.retryAt.IsZero():
		if s.retryAt.Before(tick) {
			return s.retryAt, true
		}
		return tick, true
	case !tick.IsZero():
		return tick, true
	case !s.retryAt.IsZero():
		return s.retryAt, true
	}
	return time.Time{}, false
}

func (s *Scheduler) Wake(now time.Time) *FetchOrder {
	if !s.IsOpen() || s.inFlight != nil {
		return nil
	}
	if !s.retryAt.IsZero() && !s.retryAt.After(now) {
		s.retryAt = time.Time{}
		return s.issue(now, false, true)
	}
	if s.floorBlocks(now) {
		return nil
	}
	return s.issue(now, false, false)
}

func (s *Scheduler) floorBlocks(now time.Time) bool {
	return !s.lastStart.IsZero() && now.Before(s.lastStart.Add(RefreshInterval))
}

func (s *Scheduler) issue(now time.Time, refreshQuota, isRetry bool) *FetchOrder {
	if !s.IsOpen() {
		return nil
	}
	s.counter++
	tag := Tag{Session: s.session, Instance: s.instance, Counter: s.counter}
	s.inFlight = &inFlight{tag: tag, isRetry: isRetry, refreshedQuota: refreshQuota}
	s.lastStart = now
	if !isRetry {
		// The response re-arms the retry if quota is still loading.
		s.retryAt = time.Time{}
	}
	return &FetchOrder{Tag: tag, RefreshQuota: refreshQuota, Range: s.rng}
}
