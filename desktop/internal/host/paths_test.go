package host

import (
	"strings"
	"testing"
)

func TestLinuxLockIsOutsideTheInstallDirectory(t *testing.T) {
	paths := PathsFrom("linux", "/home/me", func(name string) string {
		switch name {
		case "XDG_DATA_HOME":
			return "/data"
		case "XDG_STATE_HOME":
			return "/state"
		default:
			return ""
		}
	})
	if paths.Lock != "/state/aio-proxy-desktop/instance.lock" {
		t.Fatal(paths.Lock)
	}
	if strings.HasPrefix(paths.Lock, paths.Support) {
		t.Fatal("lock sits in the install directory")
	}
	if paths.Stable != "/data/aio-proxy-desktop/bin/aio-proxy" {
		t.Fatal(paths.Stable)
	}
}

func TestRelativeXDGValuesAreIgnored(t *testing.T) {
	paths := PathsFrom("linux", "/home/me", func(string) string { return "relative" })
	if paths.Support != "/home/me/.local/share/aio-proxy-desktop" {
		t.Fatal(paths.Support)
	}
}

func TestWindowsLockIsInTemp(t *testing.T) {
	paths := PathsFrom("windows", `C:\Users\me`, func(name string) string {
		switch name {
		case "LOCALAPPDATA":
			return `C:\Users\me\AppData\Local`
		case "TEMP":
			return `C:\Users\me\AppData\Local\Temp`
		default:
			return ""
		}
	})
	if paths.Lock != `C:\Users\me\AppData\Local\Temp\aio-proxy-desktop.lock` {
		t.Fatal(paths.Lock)
	}
	if strings.HasPrefix(paths.Lock, paths.Support) {
		t.Fatal("lock sits in the install directory")
	}
	if paths.Stable != `C:\Users\me\AppData\Local\aio-proxy-desktop\bin\aio-proxy.exe` {
		t.Fatal(paths.Stable)
	}
}

func TestTrayModeAndColor(t *testing.T) {
	if mode, open := NextMode(Tray, false); mode != NoTray || !open {
		t.Fatal("losing the host")
	}
	if mode, open := NextMode(NoTray, true); mode != Tray || open {
		t.Fatal("regaining the host closed the window")
	}
	if Close(NoTray) != CloseQuit || Close(Tray) != CloseHide {
		t.Fatal("close action")
	}
	white := [3]byte{255, 255, 255}
	black := [3]byte{0, 0, 0}
	if TrayColor("ubuntu:GNOME", false) != white || TrayColor("gnome", false) != white || TrayColor("KDE", false) != black || TrayColor("KDE", true) != white || TrayColor("", false) != black {
		t.Fatal("color")
	}
}
