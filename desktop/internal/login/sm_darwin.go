//go:build darwin

package login

import (
	"errors"
	"sync"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
)

const frameworkPath = "/System/Library/Frameworks/ServiceManagement.framework/ServiceManagement"

var (
	loadOnce       sync.Once
	selMainService = objc.RegisterName("mainAppService")
	selStatus      = objc.RegisterName("status")
	selRegister    = objc.RegisterName("registerAndReturnError:")
	selUnregister  = objc.RegisterName("unregisterAndReturnError:")
	selOpenLogin   = objc.RegisterName("openSystemSettingsLoginItems")
)

func serviceClass() objc.Class {
	loadOnce.Do(func() {
		_, _ = purego.Dlopen(frameworkPath, purego.RTLD_GLOBAL|purego.RTLD_NOW)
	})
	return objc.GetClass("SMAppService")
}

func service() objc.ID {
	class := serviceClass()
	if class == 0 {
		return 0
	}
	return objc.ID(class).Send(selMainService)
}

func statusFromRaw(raw int) Status {
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

func Current() Status {
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

func Refresh() error { return nil }

func OpenSettings() {
	class := serviceClass()
	if class == 0 {
		return
	}
	foundation.WithPool(func() {
		objc.ID(class).Send(selOpenLogin)
	})
}
