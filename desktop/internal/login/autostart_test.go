package login

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAutostartHealsAMovedAppImage(t *testing.T) {
	dir := t.TempDir()
	a, b := "/home/u/Apps/AIO Proxy.AppImage", "/home/u/Downloads/AIO Proxy.AppImage"
	if err := SetEnabledAt(dir, a, true); err != nil {
		t.Fatal(err)
	}
	if StatusAt(dir, a) != Enabled || StatusAt(dir, b) != NotRegistered {
		t.Fatal("status")
	}
	if err := RefreshExec(dir, b); err != nil {
		t.Fatal(err)
	}
	text, _ := os.ReadFile(filepath.Join(dir, autostartFile))
	if !contains(string(text), `Exec="/home/u/Downloads/AIO Proxy.AppImage"`) {
		t.Fatal(string(text))
	}
	if err := SetEnabledAt(dir, b, false); err != nil {
		t.Fatal(err)
	}
	if StatusAt(dir, b) != NotRegistered {
		t.Fatal("removed")
	}
}

func TestRefreshLeavesAMissingEntryMissing(t *testing.T) {
	dir := t.TempDir()
	if err := RefreshExec(dir, "/a.AppImage"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, autostartFile)); !os.IsNotExist(err) {
		t.Fatal("created an entry")
	}
}

func TestWithoutAnAppImageTheLoginItemIsUnavailable(t *testing.T) {
	if StatusAt(t.TempDir(), "") != Unavailable {
		t.Fatal("status")
	}
	if err := SetEnabledAt(t.TempDir(), "", true); err == nil {
		t.Fatal("enabled without an AppImage")
	}
}

func TestExecQuoting(t *testing.T) {
	got := ExecLine(`/a "b"/$c` + "`d\\e%f")
	want := "Exec=\"/a \\\"b\\\"/\\$c\\`d\\\\e%%f\""
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestADisabledEntryStaysDisabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, autostartFile)
	a, b := "/a.AppImage", "/b.AppImage"
	for _, disabled := range []string{"X-GNOME-Autostart-enabled=false", "Hidden=true"} {
		body := "[Desktop Entry]\nType=Application\n" + ExecLine(a) + "\n" + disabled + "\n"
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if StatusAt(dir, a) != NotRegistered {
			t.Fatal(disabled)
		}
		if err := RefreshExec(dir, b); err != nil {
			t.Fatal(err)
		}
		text, _ := os.ReadFile(path)
		if !contains(string(text), ExecLine(b)) || !contains(string(text), disabled) || StatusAt(dir, b) != NotRegistered {
			t.Fatalf("%s\n%s", disabled, text)
		}
	}
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && (s == sub || len(s) > 0 && (s[:len(sub)] == sub || contains(s[1:], sub))))
}
