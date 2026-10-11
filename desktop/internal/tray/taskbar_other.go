//go:build !windows

package tray

func trayUsesLightTaskbar() bool { return false }
