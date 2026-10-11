//go:build !windows

package process

import "os/exec"

func hideWindow(*exec.Cmd) {}
