//go:build !darwin

package main

import (
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/update"
)

func configureUpdates(m *app.Model) {
	update.Open = m.OpenURL
	m.CheckUpdates = func() { update.CheckNow(true) }
}

func startUpdates(m *app.Model) {
	update.Start(func(version string) {
		m.UpdatePending = version
		if m.Changed != nil {
			m.Changed()
		}
	}, func() {
		m.UpdatePending = ""
		if m.Changed != nil {
			m.Changed()
		}
	})
}

func watchWake(*app.Model) {}
