//go:build unix

package install

import "syscall"

// mntRdonly is MNT_RDONLY from <sys/mount.h>, which package syscall does not export for darwin.
const mntRdonly = 0x1

// VolumeIsReadOnly reports whether path's volume is mounted read-only. Unknown counts as read-only.
func VolumeIsReadOnly(path string) bool {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(path, &stats); err != nil {
		return true
	}
	return stats.Flags&mntRdonly != 0
}
