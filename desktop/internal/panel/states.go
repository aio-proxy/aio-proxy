package panel

import (
	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/policy"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/degraded"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

func panelIcon(shapes string) *ui.SVG {
	return ui.MustParseSVG([]byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` + shapes + `</svg>`))
}

var (
	unplugIcon    = panelIcon(`<path d="m19 5-3 3"/><path d="m5 19 3-3"/><path d="m12 7 5 5"/><path d="m7 12 5 5"/><path d="m3 3 18 18"/><path d="M11 8 8 11a3 3 0 0 0 0 4l1 1a3 3 0 0 0 4 0l3-3"/>`)
	powerOffIcon  = panelIcon(`<path d="M12 2v2"/><path d="M18.4 6.4a9 9 0 0 1 2.4 8.4"/><path d="M6.4 6.4a9 9 0 1 0 11.2 11.2"/><path d="m2 2 20 20"/>`)
	serverOffIcon = panelIcon(`<path d="M7 2h13a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-5"/><path d="M4 2a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h6"/><path d="M20 14a2 2 0 0 1 2 2v4"/><path d="M16 14H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h16"/><path d="M6 6h.01M6 18h.01"/><path d="m2 2 20 20"/>`)
	inboxIcon     = panelIcon(`<path d="m22 12-3-8H5l-3 8"/><path d="M2 12h6l2 3h4l2-3h6v8H2Z"/>`)
)

func startAction(m *app.Model) (policy.UserAction, bool) {
	if m.Discovery == nil {
		return 0, false
	}
	offered := policy.OfferedActions(m.Discovery, m.Persistent())
	switch {
	case offered.Install:
		return policy.UserInstallAndStart, true
	case offered.TakeOver:
		return policy.UserTakeOver, true
	case offered.Start:
		return policy.UserStart, true
	default:
		return 0, false
	}
}

func downState(c *ui.Context, m *app.Model) {
	icon, title, description := serverOffIcon, "aio-proxy is not responding", "Restart it from the ⋯ menu or the menu-bar icon's right-click menu."
	if m.IsOrphaned() {
		icon, title, description = unplugIcon, "Its CLI was uninstalled", "The aio-proxy CLI that ran this service is gone. Take it over to run it from AIO Proxy, with the same config."
	} else if m.IsStopped() {
		icon, title, description = powerOffIcon, "The proxy is not running", "It stays stopped until you start it."
	}
	p := theme.ForDark(c.Theme().Dark)
	ui.Column(c).Grow(1).FillWidth().PaddingX(20).Center().Gap(12).Children(func() {
		ui.Box(c).Size(40, 40).Radius(8).Background(p.Muted).Center().Children(func() { ui.Icon(c, icon).Size(24, 24) })
		ui.Text(c, title).FontSize(16).FontWeight(600)
		ui.Text(c, description).FontSize(14).TextColor(p.MutedForeground)
		if action, ok := startAction(m); ok {
			busy := m.Action.IsBusy()
			button := ui.PrimaryButton(c, "").Key("start").Disabled(busy).Padding(4, 8).FontSize(12).Children(func() {
				if busy {
					ui.Spinner(c).Size(12, 12)
				}
				ui.Text(c, action.Label())
			})
			if button.Clicked() {
				m.RunUserAction(action)
			}
		}
	})
}

func stateBody(c *ui.Context, m *app.Model) {
	if m.IsDown() {
		downState(c, m)
		return
	}
	text := "Loading…"
	muted := true
	switch m.Summary.Kind {
	case app.SummaryDegraded:
		text, muted = degraded.Body(m.Summary.Reason), false
	case app.SummaryAuthFailed:
		text = "Authentication failed. The desktop token was rejected."
	case app.SummaryUnavailable:
		text = m.Summary.Error
	}
	ui.Column(c).Grow(1).FillWidth().Padding(8, 20).Children(func() {
		line := ui.Text(c, text).FontSize(14)
		if muted {
			line.TextColor(theme.ForDark(c.Theme().Dark).MutedForeground)
		}
	})
}
