// Package install holds the install-location policy, the stable symlink and the no-downgrade rule.
// The single-instance lock is mygo's (App.RequestSingleInstanceLock), not a file here.
package install

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/process"
	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

type Paths struct {
	Home    string
	Support string
	// Symlink is `AIO_PROXY_DESKTOP_EXEC`: the only path a desktop-owned plist ever points at.
	Symlink string
	// Logs is the app's own log directory.
	Logs string
}

func PathsForHome(home string) Paths {
	support := filepath.Join(home, "Library/Application Support/aio-proxy-desktop")
	return Paths{
		Home:    home,
		Support: support,
		Symlink: filepath.Join(support, "bin/aio-proxy"),
		Logs:    filepath.Join(home, "Library/Logs/aio-proxy-desktop"),
	}
}

// BundleOf maps `…/X.app/Contents/MacOS/aio-proxy-desktop` to `…/X.app`.
func BundleOf(exe string) (string, bool) {
	if trimmed := strings.TrimRight(exe, "/"); trimmed != "" {
		exe = trimmed
	}
	macos := filepath.Dir(exe)
	contents := filepath.Dir(macos)
	bundle := filepath.Dir(contents)
	if filepath.Base(macos) != "MacOS" || filepath.Base(contents) != "Contents" || !isApp(bundle) {
		return "", false
	}
	return bundle, true
}

func SidecarOf(bundle string) string {
	return filepath.Join(bundle, "Contents/MacOS/aio-proxy")
}

// isApp is an `.app` extension with a non-empty stem, as Rust's Path::extension reads it.
func isApp(path string) bool {
	base := filepath.Base(path)
	return strings.HasSuffix(base, ".app") && len(base) > len(".app")
}

// appOfSidecar maps `…/X.app/Contents/MacOS/aio-proxy` to `…/X.app`, for naming a copy in a notice.
func appOfSidecar(sidecar string) string {
	bundle := filepath.Dir(filepath.Dir(filepath.Dir(sidecar)))
	if isApp(bundle) {
		return bundle
	}
	return sidecar
}

type ReadOnlyKind int

const (
	// ReadOnlyLocation: not in /Applications or ~/Applications on a writable volume: "Move to Applications".
	ReadOnlyLocation ReadOnlyKind = iota
	// ReadOnlyNewerCopy sets App and Version.
	ReadOnlyNewerCopy
	// ReadOnlyUnreadableCopy sets App: the symlink's target exists but its version could not be read;
	// never overwrite what we cannot rank.
	ReadOnlyUnreadableCopy
	// ReadOnlySymlinkFailed sets Err.
	ReadOnlySymlinkFailed
)

// ReadOnlyReason is comparable with ==.
type ReadOnlyReason struct {
	Kind    ReadOnlyKind
	App     string
	Version string
	Err     string
}

type StateKind int

const (
	StatePersistent StateKind = iota
	StateReadOnly
)

// InstallState is comparable with ==; Reason is set only for StateReadOnly.
type InstallState struct {
	Kind   StateKind
	Reason ReadOnlyReason
}

func readOnly(reason ReadOnlyReason) InstallState {
	return InstallState{Kind: StateReadOnly, Reason: reason}
}

// LocationAllowsPersistence is a location policy, not translocation detection: a translocated or
// mounted copy simply is not under an Applications folder.
func LocationAllowsPersistence(bundle, home string, readOnlyVolume bool) bool {
	if readOnlyVolume || !filepath.IsAbs(bundle) {
		return false
	}
	parts := components(bundle)
	for _, part := range parts {
		if part == ".." {
			return false
		}
	}
	under := func(root string) bool {
		rootParts := components(root)
		if len(parts) <= len(rootParts) {
			return false
		}
		for i, part := range rootParts {
			if parts[i] != part {
				return false
			}
		}
		return true
	}
	return under("/Applications") || under(filepath.Join(home, "Applications"))
}

// components splits a path the way Rust's Path::components compares paths: a leading "/" is its own
// component, and empty and interior "." components disappear.
func components(path string) []string {
	var parts []string
	if strings.HasPrefix(path, "/") {
		parts = append(parts, "/")
	}
	for _, part := range strings.Split(path, "/") {
		if part != "" && part != "." {
			parts = append(parts, part)
		}
	}
	return parts
}

func samePath(a, b string) bool {
	pa, pb := components(a), components(b)
	if len(pa) != len(pb) {
		return false
	}
	for i := range pa {
		if pa[i] != pb[i] {
			return false
		}
	}
	return true
}

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

type PlanKind int

const (
	SymlinkKeep PlanKind = iota
	SymlinkRepoint
	SymlinkRefuse
)

// SymlinkPlan is comparable with ==; Reason is set only for SymlinkRefuse.
type SymlinkPlan struct {
	Kind   PlanKind
	Reason ReadOnlyReason
}

// PlanSymlink is the no-downgrade rule: re-point only when the target is missing or provably not
// newer. current is the symlink's target, "" when there is no link.
func PlanSymlink(current, ownSidecar, ownVersion string, targetVersion func(string) (string, bool)) SymlinkPlan {
	if current == "" {
		return SymlinkPlan{Kind: SymlinkRepoint}
	}
	if samePath(current, ownSidecar) {
		return SymlinkPlan{Kind: SymlinkKeep}
	}
	app := appOfSidecar(current)
	unreadable := SymlinkPlan{Kind: SymlinkRefuse, Reason: ReadOnlyReason{Kind: ReadOnlyUnreadableCopy, App: app}}
	// Only a definite ENOENT means "missing"; EACCES, ELOOP and friends are a copy we cannot rank.
	if _, err := os.Stat(current); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return SymlinkPlan{Kind: SymlinkRepoint}
		}
		return unreadable
	}
	found, ok := targetVersion(current)
	if !ok {
		return unreadable
	}
	cmp, ok := version.Compare(found, ownVersion)
	switch {
	case !ok:
		return unreadable
	case cmp > 0:
		return SymlinkPlan{Kind: SymlinkRefuse, Reason: ReadOnlyReason{Kind: ReadOnlyNewerCopy, App: app, Version: found}}
	default:
		return SymlinkPlan{Kind: SymlinkRepoint}
	}
}

// Repoint creates a temp symlink and renames it over symlink, so the service never sees a missing link.
func Repoint(symlink, target string) error {
	dir := filepath.Dir(symlink)
	if symlink == "" || dir == symlink {
		return errors.New("symlink has no parent")
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	temp := filepath.Join(dir, fmt.Sprintf(".aio-proxy.%d.tmp", os.Getpid()))
	_ = os.Remove(temp)
	if err := os.Symlink(target, temp); err != nil {
		return err
	}
	if err := os.Rename(temp, symlink); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// Prepare is the startup install step. Outside an Applications folder nothing on disk changes.
func Prepare(paths Paths, bundle string, locationOK bool, ownVersion string, targetVersion func(string) (string, bool)) InstallState {
	if !locationOK {
		return readOnly(ReadOnlyReason{Kind: ReadOnlyLocation})
	}
	sidecar := SidecarOf(bundle)
	// Anything but "no link there" (a regular file or directory, EACCES, EIO) is something we cannot
	// rank, so it is never renamed over.
	current, err := os.Readlink(paths.Symlink)
	switch {
	case err == nil:
	case errors.Is(err, fs.ErrNotExist):
		current = ""
	case errors.Is(err, syscall.EINVAL):
		return readOnly(ReadOnlyReason{Kind: ReadOnlySymlinkFailed, Err: paths.Symlink + " exists and is not a symlink"})
	default:
		return readOnly(ReadOnlyReason{Kind: ReadOnlySymlinkFailed, Err: err.Error()})
	}
	plan := PlanSymlink(current, sidecar, ownVersion, targetVersion)
	switch plan.Kind {
	case SymlinkKeep:
		return InstallState{Kind: StatePersistent}
	case SymlinkRepoint:
		if err := Repoint(paths.Symlink, sidecar); err != nil {
			return readOnly(ReadOnlyReason{Kind: ReadOnlySymlinkFailed, Err: err.Error()})
		}
		return InstallState{Kind: StatePersistent}
	default:
		return readOnly(plan.Reason)
	}
}

// ProbeVersion runs `<exec> --version`, bounded so a hung copy cannot stall startup.
func ProbeVersion(execPath string) (string, bool) {
	out, err := process.RunWithTimeout(exec.Command(execPath, "--version"), 5*time.Second)
	if err != nil || !out.Success() {
		return "", false
	}
	return version.ParseOutput(string(out.Stdout))
}
