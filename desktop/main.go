// The menu-bar app: MyGo native UI, tray, wake notification, single instance and --version.
package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/sparkle"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel"
	"github.com/aio-proxy/aio-proxy/desktop/internal/tray"
	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version.App)
		return
	}
	home := os.Getenv("HOME")
	if home == "" {
		fmt.Fprintln(os.Stderr, "aio-proxy-desktop: HOME is not set")
		os.Exit(1)
	}
	paths := install.PathsForHome(home)
	logx.Init(paths.Logs)
	mygo.App.SetName("AIO Proxy")
	mygo.App.SetVersion(version.App)
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	if !mygo.App.RequestSingleInstanceLock() {
		logx.Info("another copy is already running; exiting")
		return
	}
	bundle := ""
	if exe, err := os.Executable(); err == nil {
		if exe, err = filepath.EvalSymlinks(exe); err == nil {
			bundle, _ = install.BundleOf(exe)
		}
	}
	logx.Infof("aio-proxy-desktop %s starting from %q", version.App, bundle)
	m := app.NewModel(paths, bundle)
	m.Post = mygo.RunOnMain
	m.OpenURL = func(s string) {
		if err := mygo.Shell.OpenExternal(s); err != nil {
			logx.Infof("open URL: %v", err)
		}
	}
	m.RevealPath = mygo.Shell.ShowItemInFolder
	m.CheckUpdates = sparkle.CheckNow
	m.Quit = mygo.App.Quit
	// A menu-bar app keeps running when its last panel closes.
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { m.Stop() })
	mygo.App.WhenReady(func() {
		var status *tray.Tray
		status, err := tray.New(m, func() { panel.Toggle(m, status.Icon) }, panel.Hide)
		if err != nil {
			logx.Infof("create the menu-bar icon: %v", err)
			mygo.App.Quit()
			return
		}
		m.Changed = func() { status.Sync(m); panel.Invalidate() }
		sparkle.Start(func(v string) { m.UpdatePending = v; m.Changed() }, func() { m.UpdatePending = ""; m.Changed() })
		mygo.Power.OnResume(m.CheckHealth)
		mygo.Theme.OnUpdated(panel.Invalidate)
		mygo.App.OnWillQuit(func(*mygo.QuitEvent) { status.Icon.Destroy() })
		m.Start()
		m.StartHealthTimer()
	})
	if err := mygo.App.Run(); err != nil {
		logx.Infof("application: %v", err)
		os.Exit(1)
	}
}
