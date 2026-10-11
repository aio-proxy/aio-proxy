// The menu-bar app: MyGo native UI, tray, wake notification, single instance and --version.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/egoist/mygo"

	"github.com/aio-proxy/aio-proxy/desktop/internal/app"
	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/logx"
	"github.com/aio-proxy/aio-proxy/desktop/internal/panel"
	"github.com/aio-proxy/aio-proxy/desktop/internal/tray"
	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version.App)
		return
	}
	home, err := userHome()
	if err != nil {
		fmt.Fprintln(os.Stderr, "aio-proxy-desktop:", err)
		os.Exit(1)
	}
	var paths install.Paths
	if runtime.GOOS == "darwin" {
		paths = install.PathsForHome(home)
	} else {
		layout := host.CurrentPaths(home)
		paths = install.Paths{Home: layout.Home, Support: layout.Support, Symlink: layout.Stable, Logs: layout.Logs}
	}
	logx.Init(paths.Logs)
	mygo.App.SetName("AIO Proxy")
	mygo.App.SetVersion(version.App)
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	if !mygo.App.RequestSingleInstanceLock() {
		logx.Info("another copy is already running; exiting")
		return
	}
	bundle := ""
	exePath := ""
	if exe, err := os.Executable(); err == nil {
		if exe, err = filepath.EvalSymlinks(exe); err == nil {
			exePath = exe
			if found, ok := install.BundleOf(exe); ok {
				bundle = found
			} else if runtime.GOOS != "darwin" {
				bundle = exe
			}
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
	configureUpdates(m)
	m.Quit = mygo.App.Quit
	// A menu-bar app keeps running when its last panel closes.
	mygo.App.OnWindowAllClosed(func() {})
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { m.Stop() })
	mygo.App.WhenReady(func() {
		if runtime.GOOS == "linux" {
			openShell(m)
			return
		}
		var status *tray.Tray
		status, err := tray.New(m, func() { panel.Toggle(m, status.Icon) }, panel.Hide)
		if err != nil {
			logx.Infof("create the menu-bar icon: %v", err)
			if runtime.GOOS == "darwin" {
				mygo.App.Quit()
				return
			}
			panel.NoteTray(false)
			m.Changed = func() { panel.Invalidate() }
			m.OpenPanel = func() { panel.ShowDetached(m) }
			showWithoutTray(m)
			startUpdates(m)
			m.Start()
			m.StartHealthTimer()
			return
		}
		panel.NoteTray(true)
		m.OpenPanel = func() { panel.Toggle(m, status.Icon) }
		m.Changed = func() { status.Sync(m); panel.Invalidate() }
		startUpdates(m)
		if runtime.GOOS == "darwin" {
			watchWake(m)
		}
		mygo.Theme.OnUpdated(func() {
			status.Recolor()
			panel.Invalidate()
		})
		mygo.App.OnWillQuit(func(*mygo.QuitEvent) { status.Icon.Destroy() })
		_ = exePath
		m.Start()
		m.StartHealthTimer()
	})
	if err := mygo.App.Run(); err != nil {
		logx.Infof("application: %v", err)
		os.Exit(1)
	}
}

func userHome() (string, error) {
	if runtime.GOOS == "windows" {
		if profile := os.Getenv("USERPROFILE"); profile != "" {
			return profile, nil
		}
	}
	if home := os.Getenv("HOME"); home != "" {
		return home, nil
	}
	return os.UserHomeDir()
}

func showWithoutTray(m *app.Model) {
	mygo.App.OnWindowAllClosed(func() { mygo.App.Quit() })
	panel.ShowDetached(m)
}
