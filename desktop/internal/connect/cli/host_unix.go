//go:build unix

package cli

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func currentUID() uint32 { return uint32(os.Getuid()) }

func prepareCommand(*exec.Cmd) {}

func pidAlive(pid uint32) bool {
	err := syscall.Kill(int(pid), 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
