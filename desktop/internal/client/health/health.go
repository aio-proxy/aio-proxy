// Package health keeps the `GET /health` bookkeeping: two consecutive failures mark the proxy down.
// Transitions trigger rediscovery; nothing here ever mutates the service.
package health

import (
	"context"
	"encoding/json"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/transport"
)

const (
	HealthInterval = 60 * time.Second
	HealthTimeout  = 2 * time.Second
)

type HealthState int

const (
	Unknown HealthState = iota
	Up
	Down
)

func (s HealthState) String() string {
	switch s {
	case Up:
		return "Up"
	case Down:
		return "Down"
	}
	return "Unknown"
}

type HealthTracker struct {
	state    HealthState
	failures uint32
	// The latest probe issued; an older one's answer is stale (see Finish).
	issued uint64
}

func (h *HealthTracker) State() HealthState { return h.state }

// Begin starts a probe and returns its number. Panel open, wake, the timer and a finished action can
// each start one, so several may be in flight at once.
func (h *HealthTracker) Begin() uint64 {
	h.issued++
	return h.issued
}

// Finish records probe `probe`'s answer if it is still the latest. An older probe may have reached
// the instance a restart replaced, and its late failure must not mark the new one down.
func (h *HealthTracker) Finish(probe uint64, ok bool) (HealthState, bool) {
	if probe != h.issued {
		return 0, false
	}
	return h.Record(ok)
}

// Record records one probe; it returns the new state only when it changed.
func (h *HealthTracker) Record(ok bool) (HealthState, bool) {
	next := Up
	if ok {
		h.failures = 0
	} else {
		h.failures++
		if h.failures < 2 {
			return 0, false
		}
		next = Down
	}
	if next == h.state {
		return 0, false
	}
	h.state = next
	return next, true
}

// MarkUp applies a reachable discovery that just finished an action. A probe already in flight
// predates that discovery, so its failure must not mark the new instance down.
func (h *HealthTracker) MarkUp() {
	h.issued++
	h.failures = 0
	h.state = Up
}

// MarkDown applies a completed Stop, which already proved the proxy unreachable; no need to wait for
// two probes.
func (h *HealthTracker) MarkDown() {
	// A probe already in flight predates the Stop: its success must not bring the proxy back.
	h.issued++
	h.failures = max(h.failures, 2)
	h.state = Down
}

type HealthReport struct {
	// "" when the server did not report one.
	Version string
}

// ParseHealth accepts only aio-proxy's own `status: "ok"` marker, so another service on the port
// reads as down.
func ParseHealth(status int, body []byte) (HealthReport, bool) {
	if status < 200 || status >= 300 {
		return HealthReport{}, false
	}
	// Struct decoding folds key case; another service's `Status` must not count as our marker.
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil {
		return HealthReport{}, false
	}
	var marker string
	if json.Unmarshal(fields["status"], &marker) != nil || marker != "ok" {
		return HealthReport{}, false
	}
	var report HealthReport
	if raw, exists := fields["version"]; exists {
		var value *string
		if json.Unmarshal(raw, &value) != nil {
			return HealthReport{}, false
		}
		if value != nil {
			report.Version = *value
		}
	}
	return report, true
}

// Check probes `GET /health` on `controlURL` without a bearer, bounded by HealthTimeout. An address
// that is not a loopback literal, any transport failure and any non-aio-proxy answer are all false.
func Check(ctx context.Context, controlURL string) (HealthReport, bool) {
	url, err := transport.ParseLocalURL(controlURL, "/health")
	if err != nil {
		return HealthReport{}, false
	}
	limits := transport.DefaultLimits()
	limits.Total = HealthTimeout
	resp, err := transport.Send(ctx, transport.Request{Method: transport.MethodGet, URL: url}, limits)
	if err != nil {
		return HealthReport{}, false
	}
	return ParseHealth(resp.Status, resp.Body)
}
