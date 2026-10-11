// Package menu measures the companion's AppKit command menu. MyGo exposes PopupAt but no menu
// bounds; matching its native template lets the footer preserve its bottom-right anchor.
package menu

import (
	"structs"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

type nativeSize struct {
	_             structs.HostLayout
	Width, Height float64
}

var (
	selAlloc      = objc.RegisterName("alloc")
	selInitTitle  = objc.RegisterName("initWithTitle:")
	selInitItem   = objc.RegisterName("initWithTitle:action:keyEquivalent:")
	selAutoEnable = objc.RegisterName("setAutoenablesItems:")
	selSeparator  = objc.RegisterName("separatorItem")
	selAdd        = objc.RegisterName("addItem:")
	selEnabled    = objc.RegisterName("setEnabled:")
	selState      = objc.RegisterName("setState:")
	selUpdate     = objc.RegisterName("update")
	selSize       = objc.RegisterName("size")
	selSubmenu    = objc.RegisterName("setSubmenu:")
)

// Size must run on the main thread. The menu used by this app has no roles or icons.
func Size(template *mygo.Menu) (width, height int) {
	foundation.WithPool(func() {
		native := objc.ID(objc.GetClass("NSMenu")).Send(selAlloc).Send(selInitTitle, foundation.NSString(""))
		defer foundation.Release(native)
		native.Send(selAutoEnable, uintptr(0))
		itemClass := objc.ID(objc.GetClass("NSMenuItem"))
		for _, it := range template.Items() {
			if it.Type == mygo.MenuItemSeparator {
				native.Send(selAdd, itemClass.Send(selSeparator))
				continue
			}
			item := itemClass.Send(selAlloc).Send(selInitItem, foundation.NSString(it.Label), objc.SEL(0), foundation.NSString(""))
			enabled := uintptr(1)
			if it.Disabled {
				enabled = 0
			}
			item.Send(selEnabled, enabled)
			if len(it.Submenu) > 0 {
				sub := objc.ID(objc.GetClass("NSMenu")).Send(selAlloc).Send(selInitTitle, foundation.NSString(it.Label))
				item.Send(selSubmenu, sub)
				foundation.Release(sub)
			}
			if it.Checked {
				item.Send(selState, int64(1))
			}
			native.Send(selAdd, item)
			foundation.Release(item)
		}
		native.Send(selUpdate)
		s := objc.Send[nativeSize](native, selSize)
		width, height = int(s.Width), int(s.Height)
	})
	return
}
