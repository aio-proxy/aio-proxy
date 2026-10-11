//go:build linux

package login

import "os"

func configHome() (string, bool) {
	if dir := os.Getenv("XDG_CONFIG_HOME"); dir != "" && dir[0] == '/' {
		return dir, true
	}
	home := os.Getenv("HOME")
	if home == "" {
		return "", false
	}
	return home + "/.config", true
}

func Current() Status { return StatusAt(configHomePath(), os.Getenv("APPIMAGE")) }

func configHomePath() string {
	dir, _ := configHome()
	return dir
}

func SetEnabled(enabled bool) error {
	dir, ok := configHome()
	if !ok {
		return ErrUnavailable
	}
	return SetEnabledAt(dir, os.Getenv("APPIMAGE"), enabled)
}

func Refresh() error {
	dir, ok := configHome()
	if !ok {
		return nil
	}
	return RefreshExec(dir, os.Getenv("APPIMAGE"))
}

func OpenSettings() {}
