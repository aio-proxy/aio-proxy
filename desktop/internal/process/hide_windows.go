//go:build windows

package process

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// hideWindow keeps a GUI app from flashing a console for a helper such as
// `aio-proxy.exe --version` or `where.exe`. Flags already set on the command stay.
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
