package app

import (
	"context"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/refresh"
	"github.com/aio-proxy/aio-proxy/desktop/internal/client/transport"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
	"github.com/aio-proxy/aio-proxy/desktop/internal/summary"
)

func (m *Model) ToggleMenuBarDisplay(option menubar.Option) {
	next := m.MenuBarDisplay.Toggle(option)
	if next == m.MenuBarDisplay {
		return
	}
	wasEnabled := m.MenuBarDisplay.MetricsEnabled()
	if err := menubar.Save(m.Paths.Support, next); err != nil {
		m.MenuBarDisplayError = "Cannot save Menu Bar Display: " + err.Error()
		logx.Info(m.MenuBarDisplayError)
	} else {
		m.MenuBarDisplayError = ""
		m.MenuBarDisplay = next
		if !next.MetricsEnabled() {
			m.stopMenuBarPolling()
			m.MenuBarStatistics = menubar.Statistics{}
		} else if !wasEnabled {
			m.refreshMenuBar()
		}
	}
	m.notify()
}
func (m *Model) stopMenuBarPolling() {
	m.menuBarGeneration++
	if m.menuBarTimer != nil {
		m.menuBarTimer.Stop()
		m.menuBarTimer = nil
	}
	if m.menuBarCancel != nil {
		m.menuBarCancel()
		m.menuBarCancel = nil
	}
}
func (m *Model) resetMenuBar() {
	m.stopMenuBarPolling()
	m.MenuBarStatistics = menubar.Statistics{}
	m.refreshMenuBar()
}
func (m *Model) scheduleMenuBar() {
	if m.menuBarTimer != nil {
		m.menuBarTimer.Stop()
	}
	m.menuBarTimer = time.AfterFunc(menubar.PollInterval, func() { m.post(m.refreshMenuBar) })
}
func (m *Model) refreshMenuBar() {
	if !m.menuBarStarted || m.stopped || !m.MenuBarDisplay.MetricsEnabled() || m.menuBarCancel != nil {
		return
	}
	request, state := m.summaryRequest(refresh.FetchOrder{Range: summary.H24})
	if state != nil || m.IsDown() {
		m.MenuBarStatistics = menubar.Statistics{}
		m.scheduleMenuBar()
		m.notify()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.menuBarCancel = cancel
	generation := m.menuBarGeneration
	go func() {
		result, err := transport.Send(ctx, request, transport.DefaultLimits())
		cancel()
		m.post(func() {
			if generation != m.menuBarGeneration {
				return
			}
			m.menuBarCancel = nil
			if err == nil {
				outcome := summary.Classify(result.Status, result.Body)
				if outcome.Kind == summary.OutcomeSummary {
					m.MenuBarStatistics.Observe(outcome.Summary, time.Now())
				} else {
					m.MenuBarStatistics = menubar.Statistics{}
				}
			} else {
				m.MenuBarStatistics = menubar.Statistics{}
			}
			// This fetch must never replace the panel's selected range or quota state.
			m.scheduleMenuBar()
			m.notify()
		})
	}()
}
