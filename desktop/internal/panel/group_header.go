package panel

import "github.com/egoist/mygo/ui"

// groupHeader is shared by every card and by its sticky overlay.
func groupHeader(c *ui.Context, title string, extra func()) {
	ui.Row(c).FillWidth().Justify(ui.SpaceBetween).AlignItems(ui.Center).Gap(8).Padding(12, 0, 8).Children(func() {
		ui.Text(c, title).FontSize(12).FontWeight(600).FixedLineHeight(16).Shrink(0)
		if extra != nil {
			extra()
		}
	})
}
