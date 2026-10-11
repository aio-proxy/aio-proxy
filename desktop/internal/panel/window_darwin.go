//go:build darwin

package panel

import (
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	nativemenu "github.com/aio-proxy/aio-proxy/desktop/internal/macos/menu"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel/placement"
)

var (
	selAnimation  = objc.RegisterName("setAnimationBehavior:")
	selLevel      = objc.RegisterName("setLevel:")
	selCollection = objc.RegisterName("setCollectionBehavior:")
)

func positionedPanel() bool { return true }
func closeQuits() bool      { return false }

func newWindow(m *app.Model) *mygo.Window {
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: "AIO Proxy", Width: PanelWidth, Height: PanelHeight, Hidden: true, Frameless: true,
		Transparent: true, Vibrancy: mygo.VibrancyPopover,
		DisableResize: true, DisableMove: true, DisableMinimize: true, DisableMaximize: true,
		DisableFullScreen: true, AlwaysOnTop: true, SkipTaskbar: true,
		Content: ui.View(func(c *ui.Context) { Root(c, m) }),
	})
	native := objc.ID(win.NativeHandle())
	native.Send(selAnimation, uintptr(2))
	native.Send(selLevel, int64(101))
	native.Send(selCollection, uintptr(1|1<<8))
	bindWindow(m, win, true)
	return win
}

func NoteTray(bool) {}

func place(anchor mygo.Rectangle) (int, int, bool) {
	display := mygo.Screen.DisplayNearestPoint(mygo.Point{X: anchor.X + anchor.Width/2, Y: anchor.Y + anchor.Height/2})
	b := display.Bounds
	x, y := placement.PanelOrigin(
		placement.Frame{X: float64(anchor.X), Y: float64(anchor.Y), Width: float64(anchor.Width), Height: float64(anchor.Height)},
		placement.Frame{X: float64(b.X), Y: float64(b.Y), Width: float64(b.Width), Height: float64(b.Height)}, PanelWidth,
	)
	return int(x), int(y), true
}

func popupMenu(menu *mygo.Menu, x, y int) {
	win := panelWindow
	go mygo.RunOnMain(func() {
		if win == nil || panelWindow != win {
			return
		}
		width, height := nativemenu.Size(menu)
		menu.PopupAt(win, x-width, y-height)
	})
}
