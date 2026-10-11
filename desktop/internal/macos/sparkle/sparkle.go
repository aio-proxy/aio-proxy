// Package sparkle is Sparkle 2.10.0 on the main thread: `SPUStandardUpdaterController` plus a
// `SPUStandardUserDriverDelegate` with gentle reminders, because a background (`LSUIElement`) app
// gets none from Sparkle. Updates only ever install through Sparkle's "Install and Relaunch"
// (`SUAllowsAutomaticUpdates` is false); the relaunched app restarts its proxy through the
// automatic-action table.
//
// Sparkle.framework is not linked: Start opens Contents/Frameworks/Sparkle.framework (the main
// bundle's privateFrameworksPath) with Dlopen. Without it, or without the Info.plist keys, the
// updater stays off.
//
// Threading: Start and CheckNow must run on the AppKit main thread. From MyGo code call them inside
// an `mygo.App.WhenReady(func() { … })` callback or `mygo.RunOnMain(func() { … })`. Start's
// callbacks are invoked synchronously on the main thread from inside Sparkle's delegate calls, so
// they must not block (hand the event to the app model and return).
package sparkle

import (
	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"

	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
)

const controllerClassName = "SPUStandardUpdaterController"

var (
	selMainBundle      = objc.RegisterName("mainBundle")
	selInfoValue       = objc.RegisterName("objectForInfoDictionaryKey:")
	selPrivateFwPath   = objc.RegisterName("privateFrameworksPath")
	selAlloc           = objc.RegisterName("alloc")
	selInitController  = objc.RegisterName("initWithStartingUpdater:updaterDelegate:userDriverDelegate:")
	selCheckForUpdates = objc.RegisterName("checkForUpdates:")
)

// Sparkle holds its delegate weakly; both live for the life of the app (owned, never released).
// Main thread only.
var updater struct {
	controller objc.ID
	delegate   objc.ID
}

func mainBundle() objc.ID {
	return objc.ID(objc.GetClass("NSBundle")).Send(selMainBundle)
}

// configured: both keys are written by the bundle step only when a feed and key are configured.
func configured() bool {
	bundle := mainBundle()
	for _, key := range []string{"SUFeedURL", "SUPublicEDKey"} {
		value := bundle.Send(selInfoValue, foundation.NSString(key))
		if !foundation.IsString(value) || foundation.GoString(value) == "" {
			return false
		}
	}
	return true
}

// frameworkBinary is <privateFrameworksPath>/Sparkle.framework/Sparkle, or "" without a path.
func frameworkBinary() string {
	dir := foundation.GoString(mainBundle().Send(selPrivateFwPath))
	if dir == "" {
		return ""
	}
	return dir + "/Sparkle.framework/Sparkle"
}

// load opens the Sparkle binary at path and reports whether its controller class resolved.
// An empty path is refused: Dlopen("") would return the main program instead.
func load(path string) bool {
	if path == "" {
		return false
	}
	if _, err := purego.Dlopen(path, purego.RTLD_GLOBAL|purego.RTLD_NOW); err != nil {
		return false
	}
	return objc.GetClass(controllerClassName) != 0
}

// Start creates the updater controller, which starts Sparkle's scheduled checks. onAvailable gets
// the appcast item's display version when Sparkle leaves a scheduled update to the app's own
// reminder; onAttended fires once the user has seen the update (or the session ends). Both run on
// the main thread; see the package doc. A second call while the updater runs does nothing.
func Start(onAvailable func(version string), onAttended func()) {
	if !foundation.IsMainThread() || updater.controller != 0 {
		return
	}
	foundation.WithPool(func() {
		if !configured() {
			logx.Info("updater: disabled (Info.plist has no SUFeedURL/SUPublicEDKey)")
			return
		}
		if !load(frameworkBinary()) {
			logx.Info("updater: disabled (Sparkle.framework is not loaded)")
			return
		}
		class, err := userDriverDelegate()
		if err != nil {
			logx.Infof("updater: disabled (%v)", err)
			return
		}
		handlers.onAvailable, handlers.onAttended = onAvailable, onAttended
		delegate := foundation.New(class)
		// `-initWithStartingUpdater:updaterDelegate:userDriverDelegate:` (SPUStandardUpdaterController.h).
		controller := objc.ID(objc.GetClass(controllerClassName)).Send(selAlloc).
			Send(selInitController, true, objc.ID(0), delegate)
		updater.controller, updater.delegate = controller, delegate
		logx.Info("updater: started")
	})
}

// CheckNow is "Check for Updates…" and the panel's update button: brings Sparkle's own alert into
// focus. Does nothing off the main thread or when the updater is off.
func CheckNow() {
	if !foundation.IsMainThread() || updater.controller == 0 {
		return
	}
	foundation.WithPool(func() {
		// `-[SPUStandardUpdaterController checkForUpdates:]` takes an optional sender.
		updater.controller.Send(selCheckForUpdates, objc.ID(0))
	})
}
