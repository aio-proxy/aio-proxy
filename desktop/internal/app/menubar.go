package app

import (
	"context"
	"errors"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/transport"
	"github.com/aio-proxy/aio-proxy/desktop/internal/live"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

func (m *Model) ToggleMenuBarMetric(metric menubar.Metric) {
	m.saveDisplay(m.MenuBarDisplay.Toggle(metric))
}
func (m *Model) ToggleMenuBarIcon() {
	if m.MenuBarDisplay.Count() == 0 {
		return
	}
	m.saveDisplay(m.MenuBarDisplay.ToggleIcon())
}
func (m *Model) saveDisplay(next menubar.Preferences) {
	if next == m.MenuBarDisplay {
		return
	}
	if err := menubar.Save(m.Paths.Support, next); err != nil {
		m.MenuBarDisplayError = "Cannot save Menu Bar Display: " + err.Error()
		logx.Info(m.MenuBarDisplayError)
	} else {
		m.MenuBarDisplayError = ""
		m.MenuBarDisplay = next
	}
	m.notify()
}

func (m *Model) startLive() {
	if m.menuBarStarted {
		return
	}
	m.menuBarStarted = true
	ctx, cancel := context.WithCancel(context.Background())
	m.liveCancel = cancel
	go func() {
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		m.post(m.tickLive)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.post(m.tickLive)
			}
		}
	}()
}

func (m *Model) stopMenuBarPolling() {
	m.menuBarGeneration++
	if m.liveCancel != nil {
		m.liveCancel()
		m.liveCancel = nil
	}
	if m.menuBarCancel != nil {
		m.menuBarCancel()
		m.menuBarCancel = nil
	}
}

func (m *Model) tickLive() {
	if !m.menuBarStarted || m.stopped || m.menuBarCancel != nil {
		return
	}
	now := time.Now()
	epoch := m.instanceEpoch
	m.Live.SetEpoch(epoch)
	key := live.Key{Prefs: m.MenuBarDisplay, Epoch: epoch}
	healthUp := m.Health.State() == health.Up
	var reachable *bool
	var request *transport.Request
	if m.Discovery != nil {
		up := m.Discovery.Instance.Reachable
		reachable = &up
		if up && m.Discovery.Instance.ControlURL != "" && m.Discovery.Token != nil {
			if u, err := transport.ParseLocalURL(m.Discovery.Instance.ControlURL, "/dashboard/api/desktop-live"); err == nil {
				request = &transport.Request{Method: transport.MethodGet, URL: u, Bearer: m.Discovery.Token}
			}
		}
	}
	if live.RediscoverUnreachable(m.MenuBarDisplay.Count() > 0, healthUp, reachable, m.goneRediscovered, now) {
		m.goneRediscovered = now
		m.Rediscover()
	}
	if !m.LiveSchedule.Due(now, key, healthUp && request != nil) {
		m.notify()
		return
	}
	if request == nil {
		m.LiveSchedule.Finished()
		m.notify()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.menuBarCancel = cancel
	generation := m.menuBarGeneration
	go func() {
		result, err := transport.Send(ctx, *request, transport.DefaultLimits())
		cancel()
		m.post(func() {
			if generation != m.menuBarGeneration {
				m.menuBarCancel = nil
				m.LiveSchedule.Finished()
				return
			}
			m.menuBarCancel = nil
			m.finishLive(epoch, result, err, time.Now())
		})
	}()
}

func (m *Model) finishLive(epoch uint64, result transport.Response, err error, now time.Time) {
	if epoch != m.instanceEpoch {
		m.LiveSchedule.Finished()
		return
	}
	retry := false
	switch {
	case err == nil && result.Status == 200:
		if snap, parseErr := live.Parse(result.Body); parseErr == nil {
			m.Live.Accept(epoch, snap)
		} else {
			m.Live.Fail(epoch)
		}
	case err == nil && result.Status == 401:
		retry = m.Live.Unauthorized(epoch)
	case err != nil:
		m.Live.Fail(epoch)
		if rediscoversAfter(err, m.goneRediscovered, now) {
			m.goneRediscovered = now
			retry = true
		}
	default:
		m.Live.Fail(epoch)
	}
	m.LiveSchedule.Finished()
	if retry {
		m.Rediscover()
	}
	m.notify()
}

func rediscoversAfter(err error, last, now time.Time) bool {
	var transportError *transport.Error
	if !errors.As(err, &transportError) {
		return false
	}
	if transportError.Kind != transport.KindConnect && transportError.Kind != transport.KindUntrustedListener {
		return false
	}
	return last.IsZero() || now.Sub(last) >= 5*time.Second
}
