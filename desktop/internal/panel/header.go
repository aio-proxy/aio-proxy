package panel

import (
	"fmt"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/quota"
	"github.com/aio-proxy/aio-proxy/desktop/internal/theme"
	"github.com/egoist/mygo/ui"
)

var refreshIcon = panelIcon(`<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>`)

func header(c *ui.Context, m *app.Model, blocks []quota.Block, onShow func()) {
	p := theme.ForDark(c.Theme().Dark)
	ui.Column(c).FillWidth().Shrink(0).Padding(12, 20, 0).Gap(2).Children(func() {
		ui.Row(c).FillWidth().MinHeight(24).Gap(8).AlignItems(ui.Center).Children(func() {
			ui.Box(c).Size(8, 8).Radius(4).Background(Dot(m, c)).Shrink(0)
			ui.Text(c, m.Headline()).Grow(1).FontSize(16).FontWeight(600).FixedLineHeight(24)
			if m.Summary.Kind == app.SummaryReady && !m.IsDown() {
				updated := m.UpdatedText()
				if updated == "" {
					updated = "Refresh"
				}
				button := ghostButton(c.Key("refresh"), "Refresh", 20, 20).Tooltip(updated).Disabled(m.IsRefreshing()).Children(func() {
					if m.IsRefreshing() {
						ui.Spinner(c).Size(12, 12).Label("Refreshing")
					} else {
						ui.Icon(c, refreshIcon).Size(12, 12)
					}
				})
				if button.Clicked() {
					m.ManualRefresh()
				}
			}
		})
		if endpoint := m.EndpointLine(); endpoint != "" {
			ui.Text(c, endpoint).FontSize(12).FixedLineHeight(16).TextColor(p.MutedForeground).Font("monospace")
		}
		if m.Summary.Kind == app.SummaryReady && m.Summary.Value != nil && !m.IsDown() && len(m.Summary.Value.Alerts) > 0 {
			first := m.Summary.Value.Alerts[0]
			text := first.Message
			if more := len(m.Summary.Value.Alerts) - 1; more > 0 {
				text = fmt.Sprintf("%s · +%d more", text, more)
			}
			inQuota := false
			for i := range blocks {
				if blocks[i].Provider.ID == first.ProviderID {
					inQuota = true
					break
				}
			}
			ui.Row(c).Gap(4).AlignItems(ui.Center).TextColor(p.Danger).FontSize(12).FixedLineHeight(16).Children(func() {
				ui.Text(c, text).Grow(1).MinWidth(0).MaxLines(1).Ellipsis("…")
				show := ui.ButtonBase(c).Key("alert-show").Label("Show").Cursor(ui.CursorPointer).FontSize(12).FixedLineHeight(16).Shrink(0)
				if show.Hovered() || show.Pressed() {
					show.Opacity(0.8)
				}
				show.Children(func() { ui.Text(c, "Show").Underline() })
				if show.Clicked() {
					if inQuota {
						onShow()
					} else {
						m.OpenDashboardProviders()
					}
				}
			})
		}
		if notice := m.Notice(); notice != "" {
			ui.Text(c, notice).FontSize(12).FixedLineHeight(16).TextColor(p.MutedForeground)
		}
	})
}
