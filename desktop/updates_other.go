//go:build !darwin

package main

import (
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/update"
)

func configureUpdates(m *app.Model) {
	update.Open = m.OpenURL
	m.CheckUpdates = func() { update.CheckNow(true) }
	m.InstallUpdate = update.InstallNow
}

func startUpdates(m *app.Model) {
	update.OnOutcome = func(note string, failed bool) {
		onMain(m, func() {
			if m.Action.IsBusy() {
				return
			}
			if failed {
				m.Action = app.ActionState{Kind: app.ActionFailed, Note: note}
			} else {
				m.Action = app.ActionState{Kind: app.ActionDone, Note: note}
			}
			if m.Changed != nil {
				m.Changed()
			}
		})
	}
	update.Start(func(version string) {
		onMain(m, func() {
			m.UpdatePending = version
			if m.Changed != nil {
				m.Changed()
			}
		})
	}, func() {
		onMain(m, func() {
			m.UpdatePending = ""
			if m.Changed != nil {
				m.Changed()
			}
		})
	})
}

func onMain(m *app.Model, fn func()) {
	if m.Post != nil {
		m.Post(fn)
		return
	}
	fn()
}

func watchWake(*app.Model) {}
