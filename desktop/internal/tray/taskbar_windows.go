//go:build windows

package tray

import "golang.org/x/sys/windows/registry"

// trayUsesLightTaskbar reads the taskbar's own theme. A missing value is dark.
func trayUsesLightTaskbar() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	value, _, err := key.GetIntegerValue("SystemUsesLightTheme")
	return err == nil && value == 1
}
