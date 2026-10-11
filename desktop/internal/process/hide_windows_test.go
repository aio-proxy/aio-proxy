//go:build windows

package process

import (
	"os/exec"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestHelpersDoNotOpenAConsole(t *testing.T) {
	cmd := exec.Command("cmd", "/c", "exit 0")
	if _, err := RunWithTimeout(cmd, 5*time.Second); err != nil {
		t.Fatal(err)
	}
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("console was not hidden: %+v", cmd.SysProcAttr)
	}
}
