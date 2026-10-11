//go:build unix

package clicommand

import (
	"fmt"
	"os"
	"path/filepath"
)

// InstallLinks symlinks aiop, and aio-proxy when that name is free, into dir.
// An existing aiop, including a dangling symlink, is never replaced.
func InstallLinks(dir, target string, probe Probe) ([]string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	names := []string{"aiop"}
	if !probe.AioProxy {
		names = append(names, "aio-proxy")
	}
	var made []string
	for _, name := range names {
		link := filepath.Join(dir, name)
		if _, err := os.Lstat(link); err == nil {
			if name == "aiop" {
				return nil, fmt.Errorf("%s already exists", link)
			}
			continue
		} else if !os.IsNotExist(err) {
			return nil, err
		}
		if err := os.Symlink(target, link); err != nil {
			return nil, err
		}
		made = append(made, link)
	}
	return made, nil
}
