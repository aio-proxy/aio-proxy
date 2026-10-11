//go:build windows

package clicommand

import (
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/process"
)

// Query asks where.exe over the registry PATH. The app's own PATH predates any install.
// LinkDirOnPath is always true: the install adds the shims directory itself.
func Query() *Probe {
	path := effectivePath()
	aiop, ok := found("aiop", path)
	if !ok {
		return nil
	}
	alias, ok := found("aio-proxy", path)
	if !ok {
		return nil
	}
	return &Probe{Aiop: aiop, AioProxy: alias, LinkDirOnPath: true}
}

func found(name, path string) (bool, bool) {
	cmd := exec.Command("where.exe", "$PATH:"+name)
	env := os.Environ()
	replaced := false
	for i, entry := range env {
		if strings.HasPrefix(strings.ToUpper(entry), "PATH=") {
			env[i] = "PATH=" + path
			replaced = true
		}
	}
	if !replaced {
		env = append(env, "PATH="+path)
	}
	cmd.Env = env
	output, err := process.RunWithTimeout(cmd, 5*time.Second)
	if err != nil {
		return false, false
	}
	return output.Success(), true
}
