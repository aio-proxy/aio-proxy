//go:build windows

package login

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
	"golang.org/x/sys/windows/registry"
)

const (
	runKey             = `Software\Microsoft\Windows\CurrentVersion\Run`
	startupApprovedKey = `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run`
	runValue           = "AIO Proxy"
)

func Current() Status {
	exe, err := os.Executable()
	if err != nil {
		return Unavailable
	}
	return statusOf(runValue, exe)
}

func statusOf(name, exe string) Status {
	key, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return NotRegistered
	}
	defer key.Close()
	data, _, err := key.GetStringValue(name)
	if err != nil || !host.RunValueMatches(data, exe) {
		return NotRegistered
	}
	approved, err := registry.OpenKey(registry.CURRENT_USER, startupApprovedKey, registry.QUERY_VALUE)
	if err != nil {
		return Enabled
	}
	defer approved.Close()
	flag, _, err := approved.GetBinaryValue(name)
	if err == nil && host.StartupApprovedDisabled(flag) {
		return RequiresApproval
	}
	return Enabled
}

func SetEnabled(enabled bool) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	key, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	if enabled {
		return key.SetStringValue(runValue, fmt.Sprintf("\"%s\"", exe))
	}
	if err := key.DeleteValue(runValue); err != nil && err != registry.ErrNotExist {
		return err
	}
	return nil
}

func Refresh() error { return nil }

func OpenSettings() {
	_ = exec.Command("explorer.exe", "ms-settings:startupapps").Start()
}
