// Package host is the operating-system edge that is not the macOS bundle: paths, tray mode,
// connection rows, and the Windows PATH edit.
package host

import (
	"os"
	"runtime"
	"strings"
)

// Paths is where one user's desktop state lives. Stable is the path the service is pointed at.
type Paths struct {
	Home, Support, Stable, Lock, Logs string
}

// PathsFrom resolves data directories. Relative or empty environment values are ignored, as the
// XDG and Windows rules require. goos is "darwin", "linux", or "windows".
func PathsFrom(goos, home string, env func(string) string) Paths {
	switch goos {
	case "linux":
		support := join(goos, absOr(goos, env("XDG_DATA_HOME"), join(goos, home, ".local", "share")), "aio-proxy-desktop")
		state := join(goos, absOr(goos, env("XDG_STATE_HOME"), join(goos, home, ".local", "state")), "aio-proxy-desktop")
		return Paths{Home: home, Support: support, Stable: join(goos, support, "bin", "aio-proxy"), Lock: join(goos, state, "instance.lock"), Logs: state}
	case "windows":
		local := absOr(goos, env("LOCALAPPDATA"), join(goos, home, "AppData", "Local"))
		support := join(goos, local, "aio-proxy-desktop")
		temp := absOr(goos, env("TEMP"), join(goos, local, "Temp"))
		return Paths{Home: home, Support: support, Stable: join(goos, support, "bin", "aio-proxy.exe"), Lock: join(goos, temp, "aio-proxy-desktop.lock"), Logs: join(goos, support, "logs")}
	default:
		support := join(goos, home, "Library", "Application Support", "aio-proxy-desktop")
		return Paths{Home: home, Support: support, Stable: join(goos, support, "bin", "aio-proxy"), Lock: join(goos, support, "instance.lock"), Logs: join(goos, home, "Library", "Logs", "aio-proxy-desktop")}
	}
}

func absOr(goos, value, fallback string) string {
	if value != "" && isAbs(goos, value) {
		return value
	}
	return fallback
}

func isAbs(goos, path string) bool {
	if goos == "windows" {
		return len(path) >= 3 && path[1] == ':' || strings.HasPrefix(path, `\\`)
	}
	return strings.HasPrefix(path, "/")
}

func join(goos string, parts ...string) string {
	sep := "/"
	if goos == "windows" {
		sep = `\`
	}
	out := parts[0]
	for _, part := range parts[1:] {
		if out != "" && !strings.HasSuffix(out, sep) {
			out += sep
		}
		out += strings.TrimLeft(part, `/\`)
	}
	return out
}

// CurrentPaths is this process's layout.
func CurrentPaths(home string) Paths {
	return PathsFrom(runtime.GOOS, home, os.Getenv)
}

// TrayMode is whether a tray host is showing the icon. Only Linux can lack one.
type TrayMode int

const (
	Tray TrayMode = iota
	NoTray
)

type CloseAction int

const (
	CloseHide CloseAction = iota
	CloseQuit
)

// NextMode opens the window when the tray host disappears and never closes it when the host returns.
func NextMode(current TrayMode, iconShown bool) (TrayMode, bool) {
	if iconShown {
		return Tray, false
	}
	if current == Tray {
		return NoTray, true
	}
	return NoTray, false
}

func Close(mode TrayMode) CloseAction {
	if mode == NoTray {
		return CloseQuit
	}
	return CloseHide
}

// TrayColor is the Linux mark color. GNOME's top bar stays dark, so the mark is white there.
func TrayColor(desktop string, dark bool) [3]byte {
	gnome := false
	for _, name := range strings.Split(desktop, ":") {
		if strings.EqualFold(name, "GNOME") {
			gnome = true
		}
	}
	if gnome || dark {
		return [3]byte{255, 255, 255}
	}
	return [3]byte{0, 0, 0}
}
