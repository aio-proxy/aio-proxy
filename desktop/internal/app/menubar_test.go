package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

func TestDisplayWriteFailureKeepsSavedSelection(t *testing.T) {
	paths := install.PathsForHome(t.TempDir())
	m := NewModel(paths, "")
	original := m.MenuBarDisplay
	if err := os.MkdirAll(filepath.Dir(paths.Support), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Support, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	m.ToggleMenuBarMetric(menubar.TodayTokens)
	if m.MenuBarDisplay != original || m.MenuBarDisplayError == "" {
		t.Fatal("failed write changed selection or hid its error")
	}
	if err := os.Remove(paths.Support); err != nil {
		t.Fatal(err)
	}
	m.ToggleMenuBarMetric(menubar.TodayTokens)
	if !m.MenuBarDisplay.Has(menubar.TodayTokens) || m.MenuBarDisplayError != "" {
		t.Fatal("successful retry did not apply selection and clear error")
	}
	reloaded := NewModel(paths, "")
	if reloaded.MenuBarDisplay != m.MenuBarDisplay {
		t.Fatal("retry was not persisted")
	}
}
