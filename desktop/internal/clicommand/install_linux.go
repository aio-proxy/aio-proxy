//go:build linux

package clicommand

import "errors"

// Install symlinks aiop, and aio-proxy when alias, into ~/.local/bin. There is no prompt to cancel.
func Install(target string, alias bool) (bool, error) {
	dir := linkDir()
	if dir == "" {
		return false, errors.New("HOME is not set")
	}
	_, err := InstallLinks(dir, target, Probe{AioProxy: !alias, LinkDirOnPath: true})
	if err != nil {
		return false, err
	}
	return true, nil
}
