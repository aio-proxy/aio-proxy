package panel

import (
	"fmt"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/tray"
	"github.com/egoist/mygo/ui"
)

var ellipsisIcon = panelIcon(`<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>`)

func footer(c *ui.Context, m *app.Model) {
	ui.Row(c).FillWidth().Shrink(0).Gap(8).AlignItems(ui.Center).Padding(8, 16, 8, 12).Children(func() {
		if !m.IsDown() {
			if ui.PrimaryButton(c, "Open Dashboard").Key("dashboard").Height(24).FontSize(12).FixedLineHeight(16).Padding(0, 8).Radius(6).Transition(controlColorTransition).Clicked() {
				m.OpenDashboard()
			}
		}
		if m.UpdatePending != "" {
			if ui.Button(c, fmt.Sprintf("Update to %s…", m.UpdatePending)).Key("update").Height(24).FontSize(12).FixedLineHeight(16).Padding(0, 8).Radius(6).Transition(controlColorTransition).Clicked() {
				if m.InstallUpdate != nil {
					m.InstallUpdate()
				}
			}
		}
		ui.Box(c).Grow(1)
		more := ghostButton(c.Key("more"), "More", 24, 24).Children(func() { ui.Icon(c, ellipsisIcon).Size(12, 12) })
		more.OnClick(func() {
			r := more.Bounds()
			// The window helper anchors the native menu's bottom-right here.
			popupMenu(tray.NativeMenu(m), int(r.X+r.W), int(r.Y))
		})
	})
}
