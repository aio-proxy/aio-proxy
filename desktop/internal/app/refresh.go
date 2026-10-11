package app

import (
	"context"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/refresh"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/transport"
	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/loginitem"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func summaryPath(r summary.UsageRange, quota bool) string {
	path := "/dashboard/api/desktop-summary?range=" + r.Query()
	if quota {
		path += "&refresh=true"
	}
	return path
}
func (m *Model) PanelOpened() {
	m.LoginItem = loginitem.Status()
	m.dispatch(m.scheduler.Open(time.Now()))
	m.CheckHealth()
	m.Rediscover()
}
func (m *Model) PanelClosed() {
	m.scheduler.Close()
	if m.fetchCancel != nil {
		m.fetchCancel()
		m.fetchCancel = nil
	}
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	m.Action.ClearOutcome()
	m.LoginItemError = ""
	m.notify()
}
func (m *Model) ManualRefresh() { m.trigger(refresh.Manual) }
func (m *Model) SetUsageRange(r summary.UsageRange) {
	m.UsageRange = r
	m.dispatch(m.scheduler.SetRange(r, time.Now()))
	m.notify()
}
func (m *Model) trigger(t refresh.Trigger) { m.dispatch(m.scheduler.Trigger(t, time.Now())) }
func (m *Model) instanceMaybeChanged() {
	key := instanceKey{}
	set := m.Discovery != nil
	if set {
		d := m.Discovery.Instance
		key.URL = d.ControlURL
		if d.Pid != nil {
			key.PID = *d.Pid
			key.HasPID = true
		}
	}
	if set != m.instanceSet || key != m.instance {
		m.instance = key
		m.instanceSet = set
		m.instanceEpoch++
		m.resetMenuBar()
		clear(m.usageCache)
		m.authRetryUsed = false
		m.refetchAfterDiscovery = false
		m.dispatch(m.scheduler.SetInstance(m.instanceEpoch, time.Now()))
	} else if m.refetchAfterDiscovery {
		m.refetchAfterDiscovery = false
		m.trigger(refresh.Rediscovered)
	}
}
func (m *Model) dispatch(order *refresh.FetchOrder) {
	if order != nil {
		m.startFetch(*order)
	}
	m.armTimer()
}
func (m *Model) summaryRequest(order refresh.FetchOrder) (transport.Request, *SummaryState) {
	if m.Discovery == nil {
		return transport.Request{}, &SummaryState{Kind: SummaryWaiting}
	}
	d := m.Discovery
	if d.Instance.ControlURL == "" || !d.Instance.Reachable {
		return transport.Request{}, &SummaryState{Kind: SummaryUnavailable, Error: "aio-proxy is not running."}
	}
	if d.Token == nil {
		return transport.Request{}, &SummaryState{Kind: SummaryDegraded, Reason: summary.DegradedReason{Kind: summary.DegradedNoToken}}
	}
	u, err := transport.ParseLocalURL(d.Instance.ControlURL, summaryPath(order.Range, order.RefreshQuota))
	if err != nil {
		return transport.Request{}, &SummaryState{Kind: SummaryUnavailable, Error: err.Error()}
	}
	return transport.Request{Method: transport.MethodGet, URL: u, Bearer: d.Token}, nil
}
func (m *Model) startFetch(order refresh.FetchOrder) {
	if m.fetchCancel != nil {
		m.fetchCancel()
		m.fetchCancel = nil
	}
	request, state := m.summaryRequest(order)
	if state != nil {
		m.scheduler.Finished(order.Tag, refresh.Finished{Kind: refresh.Failed}, time.Now())
		m.show(*state, order.Range)
		m.notify()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.fetchCancel = cancel
	go func() {
		result, err := transport.Send(ctx, request, transport.DefaultLimits())
		cancel()
		m.post(func() { m.finishFetch(order, result, err) })
	}()
	m.notify()
}

// A failed request leaves the last good numbers visible; only the failed range reports its error.
func (m *Model) show(state SummaryState, r summary.UsageRange) {
	if m.Summary.Kind == SummaryReady && state.Kind == SummaryUnavailable {
		m.SummaryError = state.Error
		m.SummaryErrorRange = r
	} else {
		m.Summary = state
	}
}
func (m *Model) finishFetch(order refresh.FetchOrder, result transport.Response, err error) {
	outcome := summary.FetchOutcome{Kind: summary.OutcomeFailed}
	finished := refresh.Finished{Kind: refresh.Failed}
	if err == nil {
		outcome = summary.Classify(result.Status, result.Body)
		if outcome.Kind == summary.OutcomeSummary {
			finished = refresh.Finished{Kind: refresh.Summary, AnyLoading: outcome.Summary.AnyQuotaLoading()}
		}
	}
	accepted, follow := m.scheduler.Finished(order.Tag, finished, time.Now())
	if !accepted {
		return
	}
	m.fetchCancel = nil
	retry := false
	if err != nil {
		m.show(SummaryState{Kind: SummaryUnavailable, Error: "desktop summary: " + err.Error()}, order.Range)
	} else {
		switch outcome.Kind {
		case summary.OutcomeSummary:
			m.acceptSummary(outcome.Summary)
			m.authRetryUsed = false
		case summary.OutcomeDegraded:
			m.Summary = SummaryState{Kind: SummaryDegraded, Reason: outcome.Degraded}
			m.SummaryError = ""
		case summary.OutcomeUnauthorized:
			if !m.authRetryUsed {
				m.authRetryUsed = true
				m.refetchAfterDiscovery = true
				retry = true
			} else {
				m.Summary = SummaryState{Kind: SummaryAuthFailed}
				m.SummaryError = ""
			}
		case summary.OutcomeFailed:
			m.show(SummaryState{Kind: SummaryUnavailable, Error: outcome.Err}, order.Range)
		}
	}
	m.dispatch(follow)
	m.notify()
	if retry {
		m.Rediscover()
	}
}
func (m *Model) armTimer() {
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	at, ok := m.scheduler.NextWake()
	if !ok {
		return
	}
	m.timer = time.AfterFunc(max(0, time.Until(at)), func() { m.post(func() { m.dispatch(m.scheduler.Wake(time.Now())) }) })
}
