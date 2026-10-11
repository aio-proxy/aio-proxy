//go:build windows

package clicommand

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
)

// Install writes aiop.cmd, and aio-proxy.cmd when alias, then adds the shims directory to PATH.
// A file that already holds the same shim is kept, so a retry after a failed PATH step goes on.
func Install(target string, alias bool) (bool, error) {
	dir := filepath.Join(filepath.Dir(target), "shims")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, err
	}
	names := []string{"aiop"}
	if alias {
		names = append(names, "aio-proxy")
	}
	for _, name := range names {
		shim := filepath.Join(dir, name+".cmd")
		file, err := os.OpenFile(shim, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if errors.Is(err, os.ErrExist) {
			existing, readErr := os.ReadFile(shim)
			if readErr == nil && string(existing) == host.ShimText {
				continue
			}
			if name == "aiop" {
				return false, fmt.Errorf("%s already exists", shim)
			}
			continue
		}
		if err != nil {
			return false, fmt.Errorf("%s: %w", shim, err)
		}
		_, err = file.WriteString(host.ShimText)
		file.Close()
		if err != nil {
			return false, err
		}
	}
	if err := addToUserPath(dir); err != nil {
		return false, err
	}
	return true, nil
}
