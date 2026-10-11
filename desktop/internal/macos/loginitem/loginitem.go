// Package loginitem is "App starts at login": `SMAppService.mainAppService` (macOS 13+), reached by
// name through the ObjC runtime. ServiceManagement is opened with Dlopen on first use instead of
// being linked, so the class is loaded without cgo.
//
// Call these from the AppKit main thread, as the Rust app did: from MyGo code that means inside
// `mygo.RunOnMain(func() { … })` or an `mygo.App.WhenReady` callback.
package loginitem

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
)

const frameworkPath = "/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement"

// LoginItemStatus mirrors SMAppServiceStatus, plus Unavailable when SMAppService is missing.
type LoginItemStatus int

const (
	NotRegistered LoginItemStatus = iota
	Enabled
	// RequiresApproval: registered, but the user must allow it in System Settings > General > Login Items.
	RequiresApproval
	NotFound
	Unavailable
)

func (s LoginItemStatus) String() string {
	switch s {
	case NotRegistered:
		return "NotRegistered"
	case Enabled:
		return "Enabled"
	case RequiresApproval:
		return "RequiresApproval"
	case NotFound:
		return "NotFound"
	default:
		return "Unavailable"
	}
}

// ErrUnavailable is SetEnabled's error when SMAppService cannot be reached.
var ErrUnavailable = errors.New("ServiceManagement is unavailable")

var (
	loadOnce       sync.Once
	selMainService = objc.RegisterName("mainAppService")
	selStatus      = objc.RegisterName("status")
	selRegister    = objc.RegisterName("registerAndReturnError:")
	selUnregister  = objc.RegisterName("unregisterAndReturnError:")
	selOpenLogin   = objc.RegisterName("openSystemSettingsLoginItems")
)

// serviceClass returns SMAppService, or 0 when ServiceManagement or the class (macOS < 13) is missing.
func serviceClass() objc.Class {
	loadOnce.Do(func() {
		_, _ = purego.Dlopen(frameworkPath, purego.RTLD_GLOBAL|purego.RTLD_NOW)
	})
	return objc.GetClass("SMAppService")
}

// service returns `+[SMAppService mainAppService]`, a non-null autoreleased object (SDK header).
func service() objc.ID {
	class := serviceClass()
	if class == 0 {
		return 0
	}
	return objc.ID(class).Send(selMainService)
}

// statusFromRaw maps the NSInteger SMAppServiceStatus.
func statusFromRaw(raw int) LoginItemStatus {
	switch raw {
	case 0:
		return NotRegistered
	case 1:
		return Enabled
	case 2:
		return RequiresApproval
	case 3:
		return NotFound
	default:
		return Unavailable
	}
}

// Status reads `status`, a readonly NSInteger property.
func Status() LoginItemStatus {
	status := Unavailable
	foundation.WithPool(func() {
		svc := service()
		if svc == 0 {
			return
		}
		status = statusFromRaw(objc.Send[int](svc, selStatus))
	})
	return status
}

// SetEnabled registers or unregisters the app; the error is the NSError's localizedDescription.
func SetEnabled(enabled bool) error {
	var err error
	foundation.WithPool(func() {
		svc := service()
		if svc == 0 {
			err = ErrUnavailable
			return
		}
		selector := selUnregister
		if enabled {
			selector = selRegister
		}
		// Both selectors are `- (BOOL)…AndReturnError:(NSError **)`. nserr escapes to the heap
		// through the interface argument, so the out-pointer stays valid during the call.
		var nserr objc.ID
		if objc.Send[bool](svc, selector, unsafe.Pointer(&nserr)) {
			return
		}
		message := foundation.ErrorDescription(nserr)
		if message == "" {
			message = "SMAppService failed without an error"
		}
		err = errors.New(message)
	})
	return err
}

// OpenSettings opens System Settings > General > Login Items (`+openSystemSettingsLoginItems`).
func OpenSettings() {
	class := serviceClass()
	if class == 0 {
		return
	}
	foundation.WithPool(func() {
		objc.ID(class).Send(selOpenLogin)
	})
}
