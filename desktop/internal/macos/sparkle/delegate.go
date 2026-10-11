package sparkle

import (
	"sync"

	"github.com/ebitengine/purego/objc"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
)

const delegateClassName = "AIOProxyUserDriverDelegate"

// handlers receive the delegate's events. Sparkle calls its user-driver delegate on the main
// thread, so they are only touched there (set by Start before the controller exists).
var handlers struct {
	onAvailable func(version string)
	onAttended  func()
}

var (
	delegateOnce  sync.Once
	delegateClass objc.Class
	delegateErr   error
	selDisplayVer = objc.RegisterName("displayVersionString")
)

// userDriverDelegate registers AIOProxyUserDriverDelegate, an NSObject implementing the
// SPUStandardUserDriverDelegate methods below; Sparkle checks them with respondsToSelector:.
func userDriverDelegate() (objc.Class, error) {
	delegateOnce.Do(func() {
		delegateClass, delegateErr = objc.RegisterClass(delegateClassName, objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{
			{
				Cmd: objc.RegisterName("supportsGentleScheduledUpdateReminders"),
				Fn:  func(objc.ID, objc.SEL) bool { return true },
			},
			{
				// Let Sparkle show a scheduled update itself only when it would be in immediate
				// focus; otherwise the panel and icon carry the reminder.
				Cmd: objc.RegisterName("standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:"),
				Fn: func(_ objc.ID, _ objc.SEL, _ objc.ID, immediateFocus bool) bool {
					return immediateFocus
				},
			},
			{
				Cmd: objc.RegisterName("standardUserDriverWillHandleShowingUpdate:forUpdate:state:"),
				Fn: func(_ objc.ID, _ objc.SEL, handleShowing bool, update, _ objc.ID) {
					if handleShowing || handlers.onAvailable == nil {
						return
					}
					// `SUAppcastItem.displayVersionString` is a non-null NSString property.
					handlers.onAvailable(foundation.GoString(update.Send(selDisplayVer)))
				},
			},
			{
				Cmd: objc.RegisterName("standardUserDriverDidReceiveUserAttentionForUpdate:"),
				Fn:  func(objc.ID, objc.SEL, objc.ID) { attended() },
			},
			{
				Cmd: objc.RegisterName("standardUserDriverWillFinishUpdateSession"),
				Fn:  func(objc.ID, objc.SEL) { attended() },
			},
		})
	})
	return delegateClass, delegateErr
}

func attended() {
	if handlers.onAttended != nil {
		handlers.onAttended()
	}
}
