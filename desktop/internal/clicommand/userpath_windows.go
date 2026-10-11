//go:build windows

package clicommand

import (
	"errors"
	"unsafe"

	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

const (
	userEnv    = `Environment`
	machineEnv = `SYSTEM\CurrentControlSet\Control\Session Manager\Environment`
)

func effectivePath() string {
	return readPath(registry.LOCAL_MACHINE, machineEnv) + ";" + readPath(registry.CURRENT_USER, userEnv)
}

func readPath(root registry.Key, subkey string) string {
	key, err := registry.OpenKey(root, subkey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer key.Close()
	value, _, err := key.GetStringValue("Path")
	if err != nil {
		return ""
	}
	return expand(value)
}

func expand(value string) string {
	src, err := windows.UTF16PtrFromString(value)
	if err != nil {
		return value
	}
	n, err := windows.ExpandEnvironmentStrings(src, nil, 0)
	if n == 0 || err != nil {
		return value
	}
	buf := make([]uint16, n)
	written, err := windows.ExpandEnvironmentStrings(src, &buf[0], n)
	if written == 0 || err != nil || written > n {
		return value
	}
	return windows.UTF16ToString(buf[:written])
}

// addToUserPath appends dir once, keeping the value's registry type, then tells running programs.
func addToUserPath(dir string) error {
	key, _, err := registry.CreateKey(registry.CURRENT_USER, userEnv, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	current, typ, err := key.GetStringValue("Path")
	switch {
	case errors.Is(err, registry.ErrNotExist):
		typ = registry.EXPAND_SZ
		current = ""
	case errors.Is(err, registry.ErrUnexpectedType):
		return errors.New("the user Path is not a string value")
	case err != nil:
		return err
	}
	updated := host.PathWith(current, dir)
	if updated != current {
		if typ == registry.EXPAND_SZ {
			err = key.SetExpandStringValue("Path", updated)
		} else {
			err = key.SetStringValue("Path", updated)
		}
		if err != nil {
			return err
		}
	}
	broadcastEnvironmentChange()
	return nil
}

func broadcastEnvironmentChange() {
	setting, err := windows.UTF16PtrFromString("Environment")
	if err != nil {
		return
	}
	var result uintptr
	user32 := windows.NewLazySystemDLL("user32.dll")
	send := user32.NewProc("SendMessageTimeoutW")
	const (
		hwndBroadcast   = 0xffff
		wmSettingChange = 0x001A
		smtoAbortIfHung = 0x0002
	)
	_, _, _ = send.Call(
		hwndBroadcast,
		wmSettingChange,
		0,
		uintptr(unsafe.Pointer(setting)),
		smtoAbortIfHung,
		5000,
		uintptr(unsafe.Pointer(&result)),
	)
}
