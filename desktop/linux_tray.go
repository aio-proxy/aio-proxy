//go:build linux

package main

import (
	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel"
	"github.com/aio-proxy/aio-proxy/desktop/internal/tray"
)

// openShell follows the StatusNotifier host. Losing it opens the panel, because a hidden
// window could not be reached again; a host that returns later only adds the icon.
func openShell(m *app.Model) {
	var status *tray.Tray
	var quitOnClose func()
	started := false
	m.Changed = func() {
		if status != nil {
			status.Sync(m)
		}
		panel.Invalidate()
	}
	m.OpenPanel = func() {
		if status != nil && panel.ShowingTray() {
			panel.Toggle(m, status.Icon)
			return
		}
		panel.ShowDetached(m)
	}
	mygo.Theme.OnUpdated(func() {
		if status != nil {
			status.Recolor()
		}
		panel.Invalidate()
	})
	apply := func(owned bool) {
		if owned && status == nil {
			created, err := tray.New(m, func() {
				if status != nil {
					panel.Toggle(m, status.Icon)
				}
			}, panel.Hide)
			if err != nil {
				logx.Infof("create the menu-bar icon: %v", err)
				owned = false
			} else {
				status = created
			}
		}
		shown := owned && status != nil
		if panel.NoteTray(shown) {
			// Listeners are additive. The empty one registered at startup keeps a tray
			// app alive; this one quits only while no icon can reopen the panel.
			if quitOnClose == nil {
				quitOnClose = mygo.App.OnWindowAllClosed(func() { mygo.App.Quit() })
			}
			panel.ShowDetached(m)
		}
		if shown && quitOnClose != nil {
			quitOnClose()
			quitOnClose = nil
		}
		if started {
			return
		}
		started = true
		startUpdates(m)
		m.Start()
		m.StartHealthTimer()
	}
	host.WatchTrayHost(func(owned bool) {
		m.Post(func() { apply(owned) })
	})
}
