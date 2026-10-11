package panel

import (
	"time"

	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
)

const PanelWidth, PanelHeight = 360, 560
const reopenGuard = 300 * time.Millisecond

var panelWindow *mygo.Window
var closedAt time.Time

func bindWindow(m *app.Model, win *mygo.Window, hideOnBlur bool) {
	if hideOnBlur {
		win.OnBlur(Hide)
	}
	win.OnClosed(func() {
		if panelWindow == win {
			panelWindow = nil
		}
		closedAt = time.Now()
		delete(views, m)
		m.PanelClosed()
		if closeQuits() {
			if m.Quit != nil {
				m.Quit()
			}
		}
	})
}

func Toggle(m *app.Model, icon *mygo.Tray) {
	if panelWindow != nil {
		Hide()
		return
	}
	if !closedAt.IsZero() && time.Since(closedAt) < reopenGuard {
		return
	}
	anchor := icon.Bounds()
	if anchor.Width == 0 || anchor.Height == 0 {
		logx.Info("panel: could not compute the anchor")
		if !positionedPanel() {
			show(m, 0, 0, false)
		}
		return
	}
	x, y, ok := place(anchor)
	show(m, x, y, ok)
}

func show(m *app.Model, x, y int, positioned bool) {
	ResetView(m)
	panelWindow = newWindow(m)
	if positioned {
		panelWindow.SetPosition(x, y)
	}
	panelWindow.Show()
	m.PanelOpened()
}

// ShowDetached opens the panel with no tray anchor. Linux uses it when no tray host is present.
// A panel that is already open is brought forward instead of replaced.
func ShowDetached(m *app.Model) {
	if panelWindow != nil {
		panelWindow.Show()
		return
	}
	show(m, 0, 0, false)
}

func Hide() {
	if panelWindow != nil {
		panelWindow.Close()
	}
}
func Invalidate() {
	if panelWindow != nil {
		panelWindow.Invalidate()
	}
}
