//go:build !darwin

package install

import (
	"path/filepath"
	"runtime"

	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

// Startup copies the sidecar that sits beside the running executable.
func Startup(paths Paths, root string) InstallState {
	if root == "" {
		return readOnly(ReadOnlyReason{Kind: ReadOnlyLocation})
	}
	name := "aio-proxy"
	if runtime.GOOS == "windows" {
		name = "aio-proxy.exe"
	}
	return PrepareCopy(paths, filepath.Join(filepath.Dir(root), name), version.App, ProbeVersion)
}
