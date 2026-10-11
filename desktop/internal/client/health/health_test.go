package health

import (
	"context"
	"io"
	"net"
	"testing"
)

func expect(t *testing.T, label string, gotState HealthState, gotOK bool, want HealthState, wantOK bool) {
	t.Helper()
	if gotOK != wantOK || (wantOK && gotState != want) {
		t.Fatalf("%s: got (%v, %v), want (%v, %v)", label, gotState, gotOK, want, wantOK)
	}
}

func TestOneFailureIsNotDownTwoAre(t *testing.T) {
	var h HealthTracker
	s, ok := h.Record(true)
	expect(t, "first success", s, ok, Up, true)
	s, ok = h.Record(false)
	expect(t, "one failure", s, ok, 0, false)
	if h.State() != Up {
		t.Fatalf("state %v", h.State())
	}
	s, ok = h.Record(false)
	expect(t, "two failures", s, ok, Down, true)
	s, ok = h.Record(false)
	expect(t, "a transition is reported once", s, ok, 0, false)
}

func TestASuccessResetsTheFailureCount(t *testing.T) {
	var h HealthTracker
	h.Record(true)
	h.Record(false)
	h.Record(true)
	s, ok := h.Record(false)
	expect(t, "after reset", s, ok, 0, false)
	if h.State() != Up {
		t.Fatalf("state %v", h.State())
	}
}

func TestOnlyTheAioProxyMarkerCountsAsHealthy(t *testing.T) {
	report, ok := ParseHealth(200, []byte(`{"status":"ok","uptime":1.5,"version":"0.37.0"}`))
	if !ok || report.Version != "0.37.0" {
		t.Fatalf("got %+v %v", report, ok)
	}
	for _, c := range []struct {
		status int
		body   string
	}{{200, `{"status":"degraded"}`}, {200, "OK"}, {503, `{"status":"ok"}`}, {200, `{"status":1}`}} {
		if _, ok := ParseHealth(c.status, []byte(c.body)); ok {
			t.Fatalf("%d %s counted as healthy", c.status, c.body)
		}
	}
}

func TestACompletedStopIsDownAtOnceAndALaterSuccessBringsItBack(t *testing.T) {
	var h HealthTracker
	h.Record(true)
	h.MarkDown()
	if h.State() != Down {
		t.Fatalf("state %v", h.State())
	}
	s, ok := h.Record(false)
	expect(t, "the next failed probe is no new transition", s, ok, 0, false)
	s, ok = h.Record(true)
	expect(t, "success", s, ok, Up, true)
}

func TestOnlyTheLatestProbeCounts(t *testing.T) {
	var h HealthTracker
	first := h.Begin()
	s, ok := h.Finish(first, true)
	expect(t, "first", s, ok, Up, true)
	// Two probes overlap; the newer one answers first and the older one's failures land late.
	old := h.Begin()
	newer := h.Begin()
	s, ok = h.Finish(newer, true)
	expect(t, "newer", s, ok, 0, false)
	s, ok = h.Finish(old, false)
	expect(t, "old", s, ok, 0, false)
	s, ok = h.Finish(old, false)
	expect(t, "stale failures never count toward Down", s, ok, 0, false)
	if h.State() != Up {
		t.Fatalf("state %v", h.State())
	}
}

func TestAProbeInFlightBeforeAStopCannotBringTheProxyBack(t *testing.T) {
	var h HealthTracker
	up := h.Begin()
	h.Finish(up, true)
	inFlight := h.Begin()
	h.MarkDown()
	s, ok := h.Finish(inFlight, true)
	expect(t, "in flight", s, ok, 0, false)
	if h.State() != Down {
		t.Fatalf("state %v", h.State())
	}
}

func TestCheckReadsTheHealthMarker(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	done := make(chan string, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			done <- ""
			return
		}
		defer conn.Close()
		buf := make([]byte, 4096)
		n, _ := conn.Read(buf)
		io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 34\r\n\r\n{\"status\":\"ok\",\"version\":\"0.37.0\"}")
		done <- string(buf[:n])
	}()
	report, ok := Check(context.Background(), "http://"+ln.Addr().String())
	if !ok || report.Version != "0.37.0" {
		t.Fatalf("got %+v %v", report, ok)
	}
	if head := <-done; len(head) < 16 || head[:16] != "GET /health HTTP" {
		t.Fatalf("request head %q", head)
	}
	if _, ok := Check(context.Background(), "http://localhost:9317"); ok {
		t.Fatal("a hostname was probed")
	}
}
func TestHealthMarkerNamesAreCaseSensitive(t *testing.T) {
	for _, body := range []string{`{"STATUS":"ok"}`, `{"status":"down","Status":"ok"}`} {
		if _, ok := ParseHealth(200, []byte(body)); ok {
			t.Errorf("foreign marker accepted: %s", body)
		}
	}
	report, ok := ParseHealth(200, []byte(`{"status":"ok","Version":42}`))
	if !ok || report.Version != "" {
		t.Fatal("unknown field affected health report")
	}
}
