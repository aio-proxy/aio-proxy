//go:build windows

package panel

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/placement"
)

func positionedPanel() bool { return true }
func closeQuits() bool      { return false }

func newWindow(m *app.Model) *mygo.Window {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "AIO Proxy", Width: PanelWidth, Height: PanelHeight, Hidden: true, Frameless: true,
		DisableResize: true, DisableMove: true, DisableMinimize: true, DisableMaximize: true,
		AlwaysOnTop: true, SkipTaskbar: true,
		Content: ui.View(func(c *ui.Context) { Root(c, m) }),
	})
	bindWindow(m, win, true)
	return win
}

func NoteTray(bool) {}

func place(anchor mygo.Rectangle) (int, int, bool) {
	display := mygo.Screen.DisplayNearestPoint(mygo.Point{X: anchor.X + anchor.Width/2, Y: anchor.Y + anchor.Height/2})
	b := display.Bounds
	x, y := placement.PopupOrigin(
		placement.Rect{X: float64(anchor.X), Y: float64(anchor.Y), Width: float64(anchor.Width), Height: float64(anchor.Height)},
		placement.Rect{X: float64(b.X), Y: float64(b.Y), Width: float64(b.Width), Height: float64(b.Height)},
		PanelWidth, PanelHeight,
	)
	return int(x), int(y), true
}

func popupMenu(menu *mygo.Menu, x, y int) {
	win := panelWindow
	go mygo.RunOnMain(func() {
		if win == nil || panelWindow != win {
			return
		}
		menu.PopupAt(win, x, y)
	})
}
