//go:build darwin

package main

import (
	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/sparkle"
)

func configureUpdates(m *app.Model) { m.CheckUpdates = sparkle.CheckNow }

func startUpdates(m *app.Model) {
	sparkle.Start(func(v string) { m.UpdatePending = v; m.Changed() }, func() { m.UpdatePending = ""; m.Changed() })
}

func watchWake(m *app.Model) { mygo.Power.OnResume(m.CheckHealth) }
