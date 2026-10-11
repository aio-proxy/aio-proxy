//go:build darwin

// Package foundation holds the few Objective-C runtime helpers the macOS packages (loginitem,
// sparkle) share. Everything goes through purego, so the app keeps building with CGO_ENABLED=0 and
// frameworks are reached at runtime by Dlopen instead of being linked.
package foundation

import (
	"fmt"
	"runtime"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

const frameworkPath = "/System/Library/Frameworks/Foundation.framework/Foundation"

var (
	poolPush     func() uintptr
	poolPop      func(pool uintptr)
	pthreadMain  func() int32
	selString    = objc.RegisterName("stringWithUTF8String:")
	selUTF8      = objc.RegisterName("UTF8String")
	selDesc      = objc.RegisterName("localizedDescription")
	selKindOf    = objc.RegisterName("isKindOfClass:")
	selResponds  = objc.RegisterName("respondsToSelector:")
	selAlloc     = objc.RegisterName("alloc")
	selInit      = objc.RegisterName("init")
	selRelease   = objc.RegisterName("release")
	nsStringType objc.Class
)

// The process always has Foundation (MyGo loads it too); opening it here makes NSString and
// NSBundle resolvable before any other framework is loaded, as in tests and unbundled runs.
func init() {
	if _, err := purego.Dlopen(frameworkPath, purego.RTLD_GLOBAL|purego.RTLD_NOW); err != nil {
		panic(fmt.Errorf("foundation: %w", err))
	}
	libobjc, err := purego.Dlopen("/usr/lib/libobjc.A.dylib", purego.RTLD_GLOBAL|purego.RTLD_NOW)
	if err != nil {
		panic(fmt.Errorf("foundation: %w", err))
	}
	purego.RegisterLibFunc(&poolPush, libobjc, "objc_autoreleasePoolPush")
	purego.RegisterLibFunc(&poolPop, libobjc, "objc_autoreleasePoolPop")
	purego.RegisterLibFunc(&pthreadMain, purego.RTLD_DEFAULT, "pthread_main_np")
	nsStringType = objc.GetClass("NSString")
}

// IsMainThread reports whether the caller runs on the process's main (AppKit) thread.
func IsMainThread() bool { return pthreadMain() != 0 }

// WithPool runs fn inside an autorelease pool. A pool belongs to the thread that pushed it, so the
// goroutine stays locked to its thread meanwhile.
func WithPool(fn func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	pool := poolPush()
	defer poolPop(pool)
	fn()
}

// NSString returns an autoreleased NSString copy of s (purego hands it over as a C string).
func NSString(s string) objc.ID {
	return objc.ID(nsStringType).Send(selString, s)
}

// GoString copies an NSString into a Go string; nil gives "".
func GoString(s objc.ID) string {
	if s == 0 {
		return ""
	}
	return objc.Send[string](s, selUTF8)
}

// IsString reports whether obj is a non-nil NSString (or subclass).
func IsString(obj objc.ID) bool {
	return obj != 0 && objc.Send[bool](obj, selKindOf, nsStringType)
}

// ErrorDescription returns an NSError's localizedDescription.
func ErrorDescription(nserr objc.ID) string {
	if nserr == 0 {
		return ""
	}
	return GoString(nserr.Send(selDesc))
}

// RespondsTo reports whether obj implements selector.
func RespondsTo(obj objc.ID, selector string) bool {
	return obj != 0 && objc.Send[bool](obj, selResponds, objc.RegisterName(selector))
}

// New returns an owned (+1) `[[class alloc] init]` instance; balance it with Release.
func New(class objc.Class) objc.ID {
	return objc.ID(class).Send(selAlloc).Send(selInit)
}

// Release balances New/alloc.
func Release(obj objc.ID) {
	if obj != 0 {
		obj.Send(selRelease)
	}
}
