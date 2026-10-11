//go:build windows

package process

import "os"

func killProcess(p *os.Process) { _ = p.Kill() }
