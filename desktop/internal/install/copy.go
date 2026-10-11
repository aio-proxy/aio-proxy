package install

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/version"
)

// CopyPlan is the no-downgrade rule for a real copy of the sidecar (Linux and Windows).
type CopyPlan struct {
	Kind   PlanKind
	Reason ReadOnlyReason
}

// PlanCopy: installed nil means no copy; a nil version inside means the copy's version could not be read.
func PlanCopy(installed *string, ownVersion, stable string) CopyPlan {
	if installed == nil {
		return CopyPlan{Kind: SymlinkRepoint}
	}
	if *installed == "" {
		return CopyPlan{Kind: SymlinkRefuse, Reason: ReadOnlyReason{Kind: ReadOnlyUnreadableCopy, App: stable}}
	}
	cmp, ok := version.Compare(*installed, ownVersion)
	switch {
	case !ok:
		return CopyPlan{Kind: SymlinkRefuse, Reason: ReadOnlyReason{Kind: ReadOnlyUnreadableCopy, App: stable}}
	case cmp < 0:
		return CopyPlan{Kind: SymlinkRepoint}
	case cmp == 0:
		return CopyPlan{Kind: SymlinkKeep}
	default:
		return CopyPlan{Kind: SymlinkRefuse, Reason: ReadOnlyReason{Kind: ReadOnlyNewerCopy, App: stable, Version: *installed}}
	}
}

func stagedName() string {
	if runtime.GOOS == "windows" {
		return ".aio-proxy.tmp.exe"
	}
	return ".aio-proxy.tmp"
}

// ReplaceCopy stages sidecar beside stable and commits only when probe reports ownVersion.
func ReplaceCopy(stable, sidecar, ownVersion string, probe func(string) (string, bool)) error {
	dir := filepath.Dir(stable)
	if dir == "" || dir == stable {
		return errors.New("the stable exec has no parent")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temp := filepath.Join(dir, stagedName())
	err := stage(temp, sidecar, ownVersion, probe)
	if err == nil {
		err = commit(stable, temp)
	}
	if err != nil {
		_ = os.Remove(temp)
	}
	return err
}

func stage(temp, sidecar, ownVersion string, probe func(string) (string, bool)) error {
	_ = os.Remove(temp)
	if err := copyFile(sidecar, temp); err != nil {
		return err
	}
	found, ok := probe(temp)
	cmp, cmpOK := version.Compare(found, ownVersion)
	if ok && cmpOK && cmp == 0 {
		return nil
	}
	if !ok {
		found = "no version"
	}
	return fmt.Errorf("the staged copy reports %s instead of %s", found, ownVersion)
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(to, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	closeErr := out.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		if info, statErr := os.Stat(from); statErr == nil {
			err = os.Chmod(to, info.Mode())
		}
	}
	return err
}

func commit(stable, temp string) error {
	if runtime.GOOS == "windows" {
		return CommitWindows(stable, temp, os.Rename)
	}
	return os.Rename(temp, stable)
}

// CommitWindows renames the running exe aside, moves the temp in, and puts the old one back if that fails.
func CommitWindows(stable, temp string, rename func(from, to string) error) error {
	name := filepath.Base(stable)
	backup := stable + ".old-" + strconv.Itoa(os.Getpid()) + "-" + strconv.FormatInt(time.Now().UnixNano(), 10)
	_ = name
	backedUp := true
	if err := rename(stable, backup); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		backedUp = false
	}
	if err := rename(temp, stable); err != nil {
		if backedUp {
			_ = rename(backup, stable)
		}
		return err
	}
	_ = os.Remove(backup)
	return nil
}

// RecoverBackups restores the newest Windows .old-* when the stable exe is missing, then deletes the rest.
func RecoverBackups(stable string) error {
	if runtime.GOOS != "windows" {
		return nil
	}
	return RecoverBackupsWindows(stable)
}

func RecoverBackupsWindows(stable string) error {
	dir, name := filepath.Dir(stable), filepath.Base(stable)
	if dir == "" || name == "" || name == "." {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	prefix := name + ".old-"
	type backup struct {
		mod  time.Time
		path string
	}
	var backups []backup
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) {
			info, _ := entry.Info()
			mod := time.Time{}
			if info != nil {
				mod = info.ModTime()
			}
			backups = append(backups, backup{mod, filepath.Join(dir, entry.Name())})
		}
	}
	if len(backups) == 0 {
		return nil
	}
	newest := 0
	for i := range backups {
		if backups[i].mod.After(backups[newest].mod) {
			newest = i
		}
	}
	if _, err := os.Stat(stable); errors.Is(err, os.ErrNotExist) {
		if err := os.Rename(backups[newest].path, stable); err != nil {
			return err
		}
		backups = append(backups[:newest], backups[newest+1:]...)
	}
	for _, item := range backups {
		if item.path != stable {
			_ = os.Remove(item.path)
		}
	}
	return nil
}

func stampPath(stable string) string {
	return stable + ".version"
}

func stampKey(stable string) (string, bool) {
	info, err := os.Stat(stable)
	if err != nil {
		return "", false
	}
	return fmt.Sprintf("%d %d", info.Size(), info.ModTime().UnixNano()), true
}

func stampedVersion(stable string) (string, bool) {
	text, err := os.ReadFile(stampPath(stable))
	if err != nil {
		return "", false
	}
	versionText, key, ok := strings.Cut(strings.TrimRight(string(text), "\n"), "\n")
	current, has := stampKey(stable)
	if !ok || !has || key != current {
		return "", false
	}
	return versionText, true
}

func writeStamp(stable, version string) {
	key, ok := stampKey(stable)
	if !ok {
		return
	}
	_ = os.WriteFile(stampPath(stable), []byte(version+"\n"+key+"\n"), 0o600)
}

// PrepareCopy is the startup install step off macOS.
func PrepareCopy(paths Paths, sidecar, ownVersion string, probe func(string) (string, bool)) InstallState {
	stable := paths.Symlink
	if err := RecoverBackups(stable); err != nil {
		// A failed recovery still attempts the no-downgrade check.
		_ = err
	}
	parent := filepath.Dir(stable)
	if !Persistent(sidecar, parent) {
		return readOnly(ReadOnlyReason{Kind: ReadOnlyLocation})
	}
	var installed *string
	if _, err := os.Stat(stable); err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			blank := ""
			installed = &blank
		}
	} else if found, ok := stampedVersion(stable); ok {
		installed = &found
	} else if found, ok := probe(stable); ok {
		writeStamp(stable, found)
		installed = &found
	} else {
		blank := ""
		installed = &blank
	}
	switch plan := PlanCopy(installed, ownVersion, stable); plan.Kind {
	case SymlinkKeep:
		return InstallState{Kind: StatePersistent}
	case SymlinkRepoint:
		if err := ReplaceCopy(stable, sidecar, ownVersion, probe); err != nil {
			return readOnly(ReadOnlyReason{Kind: ReadOnlySymlinkFailed, Err: err.Error()})
		}
		writeStamp(stable, ownVersion)
		return InstallState{Kind: StatePersistent}
	default:
		return readOnly(plan.Reason)
	}
}

// Persistent reports a runnable sidecar and a writable directory for the stable copy.
func Persistent(sidecar, stableDir string) bool {
	return executable(sidecar) && writable(stableDir)
}

func writable(dir string) bool {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false
	}
	probe := filepath.Join(dir, fmt.Sprintf(".write-probe-%d", os.Getpid()))
	if err := os.WriteFile(probe, nil, 0o600); err != nil {
		return false
	}
	return os.Remove(probe) == nil
}
