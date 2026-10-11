package app

import (
	"context"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/client/health"
)

func (m *Model) StartHealthTimer() {
	ctx, cancel := context.WithCancel(context.Background())
	m.healthCancel = cancel
	m.refreshLoginItem()
	m.CheckHealth()
	go func() {
		ticker := time.NewTicker(health.HealthInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.post(func() {
					m.refreshLoginItem()
					m.CheckHealth()
				})
			}
		}
	}()
}
func (m *Model) CheckHealth() {
	if m.Discovery == nil {
		return
	}
	base := m.Discovery.Instance.ControlURL
	probe := m.Health.Begin()
	if base == "" {
		m.recordHealth(probe, false)
		return
	}
	go func() {
		_, ok := health.Check(context.Background(), base)
		m.post(func() { m.recordHealth(probe, ok) })
	}()
}
func (m *Model) recordHealth(probe uint64, ok bool) {
	if _, transition := m.Health.Finish(probe, ok); transition {
		m.notify()
		m.Rediscover()
	}
}
