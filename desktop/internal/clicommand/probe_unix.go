//go:build unix

package clicommand

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/process"
)

const probeTimeout = 5 * time.Second

func linkDir() string {
	if runtime.GOOS == "darwin" {
		return "/usr/local/bin"
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".local", "bin")
}

// Query asks the account's login shell, not the PATH this app inherited from its launcher.
// Nil when the shell could not answer: the install offer stays hidden.
func Query() *Probe {
	dir := linkDir()
	// Debian and Ubuntu add ~/.local/bin to PATH only when it already exists.
	if runtime.GOOS == "linux" && dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	script := fmt.Sprintf(
		"command -v aiop >/dev/null 2>&1 && echo %saiop; command -v aio-proxy >/dev/null 2>&1 && echo %saio-proxy; echo \"%spath:$PATH\"",
		probeMark, probeMark, probeMark,
	)
	cmd := exec.Command(loginShell(), "-l", "-i", "-c", script)
	output, err := process.RunWithTimeout(cmd, probeTimeout)
	if err != nil {
		return nil
	}
	return ParseProbe(string(output.Stdout), dir)
}
