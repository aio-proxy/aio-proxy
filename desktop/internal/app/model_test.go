package app

import (
	"os"
	"testing"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/refresh"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/transport"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery/discoverytest"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/run"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func testModel(t *testing.T, patch func(discoverytest.Doc)) *Model {
	t.Helper()
	m := NewModel(install.PathsForHome(t.TempDir()), "")
	d := discoverytest.Must(t, patch)
	m.Discovery = &d
	m.Install = &install.InstallState{Kind: install.StatePersistent}
	m.Post = func(f func()) { f() }
	return m
}
func golden(t *testing.T) *summary.SummaryV1 {
	t.Helper()
	b, err := os.ReadFile("../../../packages/types/src/desktop-summary/fixtures/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	p := summary.Parse(b)
	if p.Kind != summary.ParsedV1 {
		t.Fatalf("golden: %+v", p)
	}
	return p.V1
}
func TestAutomaticChangedServiceIsNotAFailure(t *testing.T) {
	if afterAutomaticFailure(policy.AutoRestartForVersion, run.ErrChanged).Kind != ActionIdle {
		t.Fatal("a harmless race shows failure")
	}
	if afterAutomaticFailure(policy.AutoRestartForVersion, &run.RunError{Kind: run.TimedOut, What: "restart"}).Kind != ActionFailed {
		t.Fatal("timeout not reported")
	}
}
func TestClosingClearsOutcomesButNotWork(t *testing.T) {
	for _, kind := range []ActionKind{ActionDone, ActionFailed, ActionAutomatic, ActionRunning} {
		m := NewModel(install.PathsForHome(t.TempDir()), "")
		m.Action = ActionState{Kind: kind, Auto: policy.AutoStartNotLoaded, User: policy.UserStart, Note: "outcome"}
		m.PanelClosed()
		if kind == ActionDone || kind == ActionFailed {
			if m.Action.Kind != ActionIdle {
				t.Fatal("outcome retained")
			}
		} else if m.Action.Kind != kind {
			t.Fatal("in-flight operation cleared")
		}
	}
}
func TestFailedFetchKeepsGoodSummaryOnlyForItsRange(t *testing.T) {
	m := testModel(t, nil)
	s := golden(t)
	m.acceptSummary(s)
	m.show(SummaryState{Kind: SummaryUnavailable, Error: "timeout"}, summary.H24)
	if m.Summary.Value != s || m.UsageError() != "timeout" {
		t.Fatal("last good data lost or failure hidden")
	}
	m.UsageRange = summary.D7
	if m.UsageError() != "" {
		t.Fatal("wrong range reports failure")
	}
	if m.UsageFor(summary.D7) == nil || m.UsageFor(summary.H24) != nil {
		t.Fatal("cached under wrong range")
	}
	m.instanceMaybeChanged()
	if m.UsageFor(summary.D7) != nil {
		t.Fatal("old instance data retained")
	}
}
func TestNoTokenDegradesWithoutRequestOrAttention(t *testing.T) {
	m := testModel(t, func(d discoverytest.Doc) { d.Set("token", nil) })
	_, state := m.summaryRequest(refresh.FetchOrder{Range: summary.H24})
	if state == nil || state.Kind != SummaryDegraded || state.Reason.Kind != summary.DegradedNoToken {
		t.Fatal("built tokenless request")
	}
	m.Summary = *state
	if m.NeedsAttention() {
		t.Fatal("no credential is not a rejection")
	}
}
func TestDashboardPathsEncodeSegments(t *testing.T) {
	for _, base := range []string{"http://127.0.0.1:9317/dashboard", "http://127.0.0.1:9317/dashboard/"} {
		for _, tc := range []struct {
			segments []string
			want     string
		}{
			{[]string{"providers", ""}, "http://127.0.0.1:9317/dashboard/providers/"},
			{[]string{"providers", "team a/b", "edit"}, "http://127.0.0.1:9317/dashboard/providers/team%20a%2Fb/edit"},
		} {
			got, ok := dashboardURL(base, tc.segments)
			if !ok || got != tc.want {
				t.Fatalf("got %s, %v", got, ok)
			}
		}
	}
	if _, ok := dashboardURL("not a url", []string{"providers", ""}); ok {
		t.Fatal("accepted invalid base")
	}
}
func TestDiscoveryCompletionDropsOlderResults(t *testing.T) {
	var o discoveryOrder
	first, after := o.issue(), o.issue()
	if !o.accept(after) || o.accept(first) || o.accept(after) {
		t.Fatal("stale/repeated result accepted")
	}
	third := o.issue()
	if !o.accept(third) {
		t.Fatal("new result rejected")
	}
}
func TestLiveHealthOutranksStaleDiscovery(t *testing.T) {
	m := testModel(t, func(d discoverytest.Doc) { d.Set("job.pid", nil); d.Set("instance.reachable", false) })
	if !m.IsStopped() || !m.IsDown() {
		t.Fatal("stopped instance treated as up")
	}
	m.Health.Record(true)
	if m.IsDown() {
		t.Fatal("live health ignored")
	}
	m.Health.Record(false)
	m.Health.Record(false)
	if !m.IsDown() {
		t.Fatal("failed health ignored")
	}
	m.Discovery.Unit.Owner = discovery.OwnerOrphaned
	if !m.IsOrphaned() {
		t.Fatal("orphan not actionable")
	}
}
func TestStaleSummaryAfterRangeChangeDoesNotOverwrite(t *testing.T) {
	m := testModel(t, nil)
	order := m.scheduler.Open(time.Now())
	newer := m.scheduler.SetRange(summary.D7, time.Now())
	m.UsageRange = summary.D7
	m.finishFetch(*order, transport.Response{Status: 401}, nil)
	if m.authRetryUsed || !m.IsRefreshing() {
		t.Fatal("stale 401 changed retry/in-flight state")
	}
	m.finishFetch(*newer, transport.Response{Status: 404}, nil)
	if m.Summary.Kind != SummaryDegraded || m.IsRefreshing() {
		t.Fatal("current degraded response not applied")
	}
	if m.timer != nil {
		m.timer.Stop()
	}
}
