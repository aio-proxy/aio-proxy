//go:build darwin

package install

import "github.com/aio-proxy/aio-proxy/desktop/internal/version"

// Startup points the stable symlink at this bundle when the location allows it.
func Startup(paths Paths, root string) InstallState {
	if root == "" {
		return readOnly(ReadOnlyReason{Kind: ReadOnlyLocation})
	}
	allowed := LocationAllowsPersistence(root, paths.Home, VolumeIsReadOnly(root))
	return Prepare(paths, root, allowed, version.App, ProbeVersion)
}
