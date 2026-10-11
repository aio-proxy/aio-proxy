//go:build unix

package process

import (
	"os"
	"syscall"
)

func killProcess(p *os.Process) { _ = p.Signal(syscall.SIGKILL) }
