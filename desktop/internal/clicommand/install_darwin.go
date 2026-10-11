//go:build darwin

package clicommand

import (
	"errors"
	"os/exec"
	"strings"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/process"
)

const installTimeout = 300 * time.Second

// linkScript runs as root. aiop is replaced only when absent, dangling, or already ours.
// aio-proxy is linked only when that path is free.
const linkScript = `set -e
/bin/mkdir -p "$(/usr/bin/dirname "$2")"
if [ -e "$2" ] && [ "$(/usr/bin/readlink "$2")" != "$1" ]; then
  echo "$2 already exists and is not this app's" >&2
  exit 1
fi
/bin/ln -sf "$1" "$2"
[ -z "$3" ] || [ -e "$3" ] || [ -L "$3" ] || /bin/ln -s "$1" "$3"
`

// Install points /usr/local/bin/aiop, and aio-proxy when alias, at target.
// false with a nil error means the user cancelled the prompt.
func Install(target string, alias bool) (bool, error) {
	aliasPath := ""
	if alias {
		aliasPath = "/usr/local/bin/aio-proxy"
	}
	return link(target, "/usr/local/bin/aiop", aliasPath)
}

func link(target, aiop, alias string) (bool, error) {
	cmd := exec.Command("/usr/bin/osascript",
		"-e", "on run argv",
		"-e", `set cmd to "/bin/sh -c " & quoted form of item 1 of argv & " sh"`,
		"-e", "repeat with arg in rest of argv",
		"-e", `set cmd to cmd & " " & quoted form of (arg as text)`,
		"-e", "end repeat",
		"-e", "do shell script cmd with administrator privileges",
		"-e", "end run",
		linkScript,
		target,
		aiop,
		alias,
	)
	output, err := process.RunWithTimeout(cmd, installTimeout)
	if err != nil {
		return false, err
	}
	if output.Success() {
		return true, nil
	}
	stderr := process.Tail(output.Stderr, 600)
	// -128 is userCanceledErr: the password prompt was dismissed.
	if strings.Contains(stderr, "(-128)") {
		return false, nil
	}
	if stderr == "" {
		stderr = "osascript failed"
	}
	return false, errors.New(stderr)
}
