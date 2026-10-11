package panel

import (
	"time"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	nativemenu "github.com/aio-proxy/aio-proxy/desktop/internal/macos/menu"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/placement"
)

const PanelWidth, PanelHeight = 360, 560
const reopenGuard = 300 * time.Millisecond

var panelWindow *mygo.Window
var closedAt time.Time
var (
	selAnimation  = objc.RegisterName("setAnimationBehavior:")
	selLevel      = objc.RegisterName("setLevel:")
	selCollection = objc.RegisterName("setCollectionBehavior:")
)

// The model survives, but closing releases the window and Metal surface as the previous companion
// did. All window state is accessed on the main thread.
func newWindow(m *app.Model) *mygo.Window {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "AIO Proxy", Width: PanelWidth, Height: PanelHeight, Hidden: true, Frameless: true,
		Transparent: true, Vibrancy: mygo.VibrancyPopover,
		DisableResize: true, DisableMove: true, DisableMinimize: true, DisableMaximize: true,
		DisableFullScreen: true, AlwaysOnTop: true, SkipTaskbar: true,
		Content: ui.View(func(c *ui.Context) { Root(c, m) }),
	})
	native := objc.ID(win.NativeHandle())
	native.Send(selAnimation, uintptr(2)) // NSWindowAnimationBehaviorNone
	// Match the former PopUp panel: above normal windows and available on full-screen Spaces.
	native.Send(selLevel, int64(101))           // NSPopUpMenuWindowLevel
	native.Send(selCollection, uintptr(1|1<<8)) // CanJoinAllSpaces | FullScreenAuxiliary
	win.OnBlur(Hide)
	win.OnClosed(func() {
		if panelWindow == win {
			panelWindow = nil
		}
		closedAt = time.Now()
		delete(views, m)
		m.PanelClosed()
	})
	return win
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
		return
	}
	display := mygo.Screen.DisplayNearestPoint(mygo.Point{X: anchor.X + anchor.Width/2, Y: anchor.Y + anchor.Height/2})
	b := display.Bounds
	x, y := placement.PanelOrigin(
		placement.Frame{X: float64(anchor.X), Y: float64(anchor.Y), Width: float64(anchor.Width), Height: float64(anchor.Height)},
		placement.Frame{X: float64(b.X), Y: float64(b.Y), Width: float64(b.Width), Height: float64(b.Height)}, PanelWidth,
	)
	ResetView(m)
	panelWindow = newWindow(m)
	panelWindow.SetPosition(int(x), int(y))
	panelWindow.Show()
	m.PanelOpened()
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
func popupMenu(menu *mygo.Menu, x, y int) {
	win := panelWindow
	// AppKit runs a nested tracking loop. Enter it only after the surface event and
	// frame have returned, as MyGo's declarative menu host does via postMain.
	go mygo.RunOnMain(func() {
		if win == nil || panelWindow != win {
			return
		}
		width, height := nativemenu.Size(menu)
		menu.PopupAt(win, x-width, y-height)
	})
}
