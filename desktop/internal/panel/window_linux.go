//go:build linux

package panel

import (
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
)

func positionedPanel() bool { return false }

func closeQuits() bool { return host.Close(currentTray) == host.CloseQuit }

var currentTray = host.Tray

// ShowingTray reports whether a status icon is the way back to a hidden panel.
func ShowingTray() bool { return currentTray == host.Tray }

// NoteTray records a tray-host change. open is true when the panel has to appear because the
// icon can no longer be the way back.
func NoteTray(shown bool) (open bool) {
	var mode host.TrayMode
	mode, open = host.NextMode(currentTray, shown)
	currentTray = mode
	return open
}

func newWindow(m *app.Model) *mygo.Window {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "AIO Proxy", Width: PanelWidth, Height: PanelHeight,
		MinWidth: PanelWidth, MinHeight: PanelHeight,
		Content: ui.View(func(c *ui.Context) { Root(c, m) }),
	})
	bindWindow(m, win, false)
	return win
}

func place(mygo.Rectangle) (int, int, bool) { return 0, 0, false }

func popupMenu(menu *mygo.Menu, x, y int) {
	win := panelWindow
	go mygo.RunOnMain(func() {
		if win == nil || panelWindow != win {
			return
		}
		menu.PopupAt(win, x, y)
	})
}
