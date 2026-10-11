package install

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func plan(installed *string) CopyPlan {
	return PlanCopy(installed, "0.40.0", "/data/bin/aio-proxy")
}

func strptr(s string) *string { return &s }

func TestCopyPlanNeverDowngrades(t *testing.T) {
	if plan(nil).Kind != SymlinkRepoint {
		t.Fatal("missing")
	}
	if plan(strptr("0.39.0")).Kind != SymlinkRepoint || plan(strptr("0.40.0")).Kind != SymlinkKeep {
		t.Fatal("rank")
	}
	newer := plan(strptr("0.41.0"))
	if newer.Kind != SymlinkRefuse || newer.Reason.Kind != ReadOnlyNewerCopy || newer.Reason.Version != "0.41.0" || newer.Reason.App != "/data/bin/aio-proxy" {
		t.Fatal(newer)
	}
	if plan(strptr("")).Reason.Kind != ReadOnlyUnreadableCopy || plan(strptr("garbage")).Reason.Kind != ReadOnlyUnreadableCopy {
		t.Fatal("unreadable")
	}
}

func TestAStagedCopyReportingAnotherVersionIsDiscarded(t *testing.T) {
	dir := t.TempDir()
	stable, sidecar := filepath.Join(dir, "bin", "aio-proxy"), filepath.Join(dir, "sidecar")
	if err := os.MkdirAll(filepath.Dir(stable), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stable, []byte("old"), 0o755); err != nil || os.WriteFile(sidecar, []byte("new"), 0o755) != nil {
		t.Fatal(err)
	}
	if err := ReplaceCopy(stable, sidecar, "0.40.0", func(string) (string, bool) { return "0.39.9", true }); err == nil {
		t.Fatal("accepted a different version")
	}
	body, _ := os.ReadFile(stable)
	if string(body) != "old" {
		t.Fatal(string(body))
	}
	if _, err := os.Stat(filepath.Join(dir, "bin", ".aio-proxy.tmp")); !os.IsNotExist(err) {
		t.Fatal("temp left behind")
	}
}

func TestASuccessfulReplaceSwapsTheBytes(t *testing.T) {
	dir := t.TempDir()
	stable, sidecar := filepath.Join(dir, "bin", "aio-proxy"), filepath.Join(dir, "sidecar")
	os.MkdirAll(filepath.Dir(stable), 0o755)
	os.WriteFile(stable, []byte("old"), 0o755)
	os.WriteFile(sidecar, []byte("new"), 0o755)
	var probed []byte
	if err := ReplaceCopy(stable, sidecar, "0.40.0", func(path string) (string, bool) {
		probed, _ = os.ReadFile(path)
		return "0.40.0", true
	}); err != nil {
		t.Fatal(err)
	}
	if string(probed) != "new" {
		t.Fatal("probed the wrong file")
	}
	body, _ := os.ReadFile(stable)
	if string(body) != "new" {
		t.Fatal(string(body))
	}
}

func TestWindowsCommitRestoresOnFailure(t *testing.T) {
	dir := t.TempDir()
	stable := filepath.Join(dir, "aio-proxy")
	temp := filepath.Join(dir, ".aio-proxy.tmp")
	os.WriteFile(stable, []byte("old"), 0o755)
	os.WriteFile(temp, []byte("new"), 0o755)
	calls := 0
	err := CommitWindows(stable, temp, func(from, to string) error {
		calls++
		if calls == 2 {
			return os.ErrPermission
		}
		return os.Rename(from, to)
	})
	if err == nil {
		t.Fatal("commit succeeded")
	}
	body, _ := os.ReadFile(stable)
	if string(body) != "old" {
		t.Fatal(string(body))
	}
}

func TestRecoveryRestoresTheNewestBackup(t *testing.T) {
	dir := t.TempDir()
	stable := filepath.Join(dir, "aio-proxy.exe")
	writeBackup := func(pid, body string, age time.Duration) {
		path := filepath.Join(dir, "aio-proxy.exe.old-"+pid)
		os.WriteFile(path, []byte(body), 0o644)
		when := time.Now().Add(-age)
		os.Chtimes(path, when, when)
	}
	writeBackup("10", "oldest", 300*time.Second)
	writeBackup("20", "newest", 10*time.Second)
	writeBackup("30", "middle", 100*time.Second)
	if err := RecoverBackupsWindows(stable); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(stable)
	if err != nil || string(body) != "newest" {
		t.Fatalf("%q %v", body, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("left %d entries", len(entries))
	}
	writeBackup("40", "stale", 0)
	if err := RecoverBackupsWindows(stable); err != nil {
		t.Fatal(err)
	}
	body, _ = os.ReadFile(stable)
	if string(body) != "newest" {
		t.Fatal("present copy replaced")
	}
}
