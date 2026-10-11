package clicommand

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// AiopPath is where Install puts aiop, for the confirmation line.
func AiopPath(home, target string) string {
	switch runtime.GOOS {
	case "windows":
		return filepath.Join(filepath.Dir(target), "shims", "aiop.cmd")
	case "darwin":
		return "/usr/local/bin/aiop"
	default:
		// The shell looks in the account home, which may differ from an overridden app home.
		if account, err := os.UserHomeDir(); err == nil && account != "" {
			home = account
		}
		return filepath.Join(home, ".local", "bin", "aiop")
	}
}

// InstalledNotice is the confirmation. On Linux, a session that does not already have the link
// directory on PATH will not see aiop until the next login.
func InstalledNotice(aiop string) string {
	dir := filepath.Dir(aiop)
	if runtime.GOOS == "linux" && !sessionHasDir(os.Getenv("PATH"), dir) {
		return "Installed aiop at " + aiop + ". It works after you log out and back in."
	}
	return "Installed aiop at " + aiop + "."
}

func sessionHasDir(path, dir string) bool {
	for entry := range strings.SplitSeq(path, string(os.PathListSeparator)) {
		if entry == dir {
			return true
		}
	}
	return false
}
