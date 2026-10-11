//go:build !windows

package install

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

const home = "/Users/me"

func allowed(bundle string) bool {
	return LocationAllowsPersistence(bundle, home, false)
}

func TestOnlyAnApplicationsFolderOnAWritableVolumeIsPersistent(t *testing.T) {
	for _, bundle := range []string{
		"/Applications/AIO Proxy.app",
		"/Applications/Utilities/AIO Proxy.app",
		"/Users/me/Applications/AIO Proxy.app",
	} {
		if !allowed(bundle) {
			t.Errorf("%s should be allowed", bundle)
		}
	}
	for _, bundle := range []string{
		"/Volumes/AIO Proxy/AIO Proxy.app",
		"/Users/me/Downloads/AIO Proxy.app",
		"/private/var/folders/xy/T/AppTranslocation/1234/d/AIO Proxy.app",
		"/Applications2/AIO Proxy.app",
		"/Applications/../tmp/AIO Proxy.app",
		"/Applications",
		"/Applications/",
		"Applications/AIO Proxy.app",
		"/Users/other/Applications/AIO Proxy.app",
	} {
		if allowed(bundle) {
			t.Errorf("%s should not be allowed", bundle)
		}
	}
	if LocationAllowsPersistence("/Applications/AIO Proxy.app", home, true) {
		t.Error("a read-only volume is never persistent")
	}
}

func TestFindsTheBundleFromTheExecutable(t *testing.T) {
	if got, ok := BundleOf("/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop"); !ok || got != "/Applications/AIO Proxy.app" {
		t.Errorf("got %q %v", got, ok)
	}
	for _, exe := range []string{
		"/Users/me/desktop/target/debug/aio-proxy-desktop",
		"/Applications/.app/Contents/MacOS/aio-proxy-desktop",
		"/Contents/MacOS/aio-proxy-desktop",
	} {
		if got, ok := BundleOf(exe); ok {
			t.Errorf("%s: got %q", exe, got)
		}
	}
}

func TestPathsForHome(t *testing.T) {
	got := PathsForHome("/Users/me")
	want := Paths{
		Home:    "/Users/me",
		Support: "/Users/me/Library/Application Support/aio-proxy-desktop",
		Symlink: "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy",
		Logs:    "/Users/me/Library/Logs/aio-proxy-desktop",
	}
	if got != want {
		t.Fatalf("got %+v", got)
	}
}

type fixture struct {
	paths  Paths
	bundle string
	other  string
}

// newFixture is a fake home with this app's bundle and another installed copy, each holding a sidecar file.
func newFixture(t *testing.T) fixture {
	t.Helper()
	dir := t.TempDir()
	makeBundle := func(name string) string {
		bundle := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Join(bundle, "Contents/MacOS"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(SidecarOf(bundle), []byte("#!/bin/sh\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		return bundle
	}
	return fixture{paths: PathsForHome(dir), bundle: makeBundle("Applications/AIO Proxy.app"), other: makeBundle("Other/AIO Proxy.app")}
}

func found(v string) func(string) (string, bool) {
	return func(string) (string, bool) { return v, v != "" }
}

func mustNotProbe(t *testing.T) func(string) (string, bool) {
	return func(string) (string, bool) {
		t.Fatal("must not probe")
		return "", false
	}
}

func mustRepoint(t *testing.T, symlink, target string) {
	t.Helper()
	if err := Repoint(symlink, target); err != nil {
		t.Fatal(err)
	}
}

func linkTarget(t *testing.T, symlink string) string {
	t.Helper()
	target, err := os.Readlink(symlink)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

var persistent = InstallState{Kind: StatePersistent}

func TestOutsideAnApplicationsFolderNothingPersistentHappens(t *testing.T) {
	f := newFixture(t)
	state := Prepare(f.paths, f.bundle, false, "0.37.0", mustNotProbe(t))
	if state != readOnly(ReadOnlyReason{Kind: ReadOnlyLocation}) {
		t.Errorf("got %+v", state)
	}
	if _, err := os.Lstat(f.paths.Symlink); err == nil {
		t.Error("no symlink may be created")
	}
}

func TestAMissingOrDanglingSymlinkIsPointedAtThisCopy(t *testing.T) {
	f := newFixture(t)
	if got := Prepare(f.paths, f.bundle, true, "0.37.0", found("")); got != persistent {
		t.Fatalf("missing: got %+v", got)
	}
	if got := linkTarget(t, f.paths.Symlink); got != SidecarOf(f.bundle) {
		t.Fatalf("missing: link → %s", got)
	}

	mustRepoint(t, f.paths.Symlink, "/nonexistent/AIO Proxy.app/Contents/MacOS/aio-proxy")
	if got := Prepare(f.paths, f.bundle, true, "0.37.0", found("")); got != persistent {
		t.Fatalf("dangling: got %+v", got)
	}
	if got := linkTarget(t, f.paths.Symlink); got != SidecarOf(f.bundle) {
		t.Fatalf("dangling: link → %s", got)
	}
}

func TestALinkToThisCopyIsKeptWithoutProbing(t *testing.T) {
	f := newFixture(t)
	mustRepoint(t, f.paths.Symlink, SidecarOf(f.bundle))
	if got := Prepare(f.paths, f.bundle, true, "0.37.0", mustNotProbe(t)); got != persistent {
		t.Fatalf("got %+v", got)
	}
}

func TestANewerInstalledCopyIsNeverRepointedToAnOlderOne(t *testing.T) {
	f := newFixture(t)
	mustRepoint(t, f.paths.Symlink, SidecarOf(f.other))
	state := Prepare(f.paths, f.bundle, true, "0.37.0", found("0.38.0"))
	if want := readOnly(ReadOnlyReason{Kind: ReadOnlyNewerCopy, App: f.other, Version: "0.38.0"}); state != want {
		t.Errorf("got %+v, want %+v", state, want)
	}
	if got := linkTarget(t, f.paths.Symlink); got != SidecarOf(f.other) {
		t.Errorf("link → %s", got)
	}
}

func TestAnOlderOrEqualCopyIsRepointedToThisOne(t *testing.T) {
	for _, v := range []string{"0.36.9", "0.37.0"} {
		f := newFixture(t)
		mustRepoint(t, f.paths.Symlink, SidecarOf(f.other))
		if got := Prepare(f.paths, f.bundle, true, "0.37.0", found(v)); got != persistent {
			t.Errorf("%s: got %+v", v, got)
		}
		if got := linkTarget(t, f.paths.Symlink); got != SidecarOf(f.bundle) {
			t.Errorf("%s: link → %s", v, got)
		}
	}
}

func TestAnUnreadableInstalledCopyIsLeftAlone(t *testing.T) {
	for _, v := range []string{"", "not-a-version"} {
		f := newFixture(t)
		mustRepoint(t, f.paths.Symlink, SidecarOf(f.other))
		state := Prepare(f.paths, f.bundle, true, "0.37.0", found(v))
		if want := readOnly(ReadOnlyReason{Kind: ReadOnlyUnreadableCopy, App: f.other}); state != want {
			t.Errorf("%q: got %+v", v, state)
		}
		if got := linkTarget(t, f.paths.Symlink); got != SidecarOf(f.other) {
			t.Errorf("%q: link → %s", v, got)
		}
	}
}

func TestProbesACopyVersionWithItsCLI(t *testing.T) {
	dir := t.TempDir()
	execPath := filepath.Join(dir, "aio-proxy")
	if err := os.WriteFile(execPath, []byte("#!/bin/sh\necho 0.38.0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := ProbeVersion(execPath); !ok || got != "0.38.0" {
		t.Errorf("got %q %v", got, ok)
	}
	if got, ok := ProbeVersion(filepath.Join(dir, "missing")); ok {
		t.Errorf("missing: got %q", got)
	}
	failing := filepath.Join(dir, "failing")
	if err := os.WriteFile(failing, []byte("#!/bin/sh\necho 0.38.0\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got, ok := ProbeVersion(failing); ok {
		t.Errorf("failing: got %q", got)
	}
}

func TestSomethingThatIsNotASymlinkIsNeverRenamedOver(t *testing.T) {
	f := newFixture(t)
	if err := os.MkdirAll(filepath.Dir(f.paths.Symlink), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.paths.Symlink, []byte("user data"), 0o644); err != nil {
		t.Fatal(err)
	}
	state := Prepare(f.paths, f.bundle, true, "0.37.0", mustNotProbe(t))
	if state.Kind != StateReadOnly || state.Reason.Kind != ReadOnlySymlinkFailed {
		t.Errorf("got %+v", state)
	}
	if body, err := os.ReadFile(f.paths.Symlink); err != nil || string(body) != "user data" {
		t.Errorf("got %q %v", body, err)
	}
	if info, err := os.Lstat(f.paths.Symlink); err != nil || info.Mode()&os.ModeSymlink != 0 {
		t.Errorf("must still be a regular file: %v %v", info, err)
	}
}

func TestATargetThatCannotBeStatEdIsNotTreatedAsMissing(t *testing.T) {
	f := newFixture(t)
	a, b := filepath.Join(f.paths.Home, "loop-a"), filepath.Join(f.paths.Home, "loop-b")
	mustRepoint(t, a, b)
	mustRepoint(t, b, a)
	mustRepoint(t, f.paths.Symlink, a)
	state := Prepare(f.paths, f.bundle, true, "0.37.0", mustNotProbe(t))
	if want := readOnly(ReadOnlyReason{Kind: ReadOnlyUnreadableCopy, App: a}); state != want {
		t.Errorf("got %+v", state)
	}
	if got := linkTarget(t, f.paths.Symlink); got != a {
		t.Errorf("link → %s", got)
	}
}

func TestAFailedRepointLeavesTheOriginalAndNoTempFile(t *testing.T) {
	f := newFixture(t)
	// A non-empty directory at the link path makes the final rename fail.
	keep := filepath.Join(f.paths.Symlink, "keep")
	if err := os.MkdirAll(keep, 0o755); err != nil {
		t.Fatal(err)
	}
	if Repoint(f.paths.Symlink, SidecarOf(f.bundle)) == nil {
		t.Fatal("repoint over a non-empty directory must fail")
	}
	if info, err := os.Stat(keep); err != nil || !info.IsDir() {
		t.Errorf("original must survive: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(f.paths.Symlink))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	if !slices.Equal(names, []string{"aio-proxy"}) {
		t.Errorf("temp symlink must be removed: %v", names)
	}
}

func TestTheVolumeOfATempDirIsWritable(t *testing.T) {
	if VolumeIsReadOnly(t.TempDir()) {
		t.Error("a temp dir is on a writable volume")
	}
	if !VolumeIsReadOnly("/nonexistent/path") {
		t.Error("an unknown volume counts as read-only")
	}
}
