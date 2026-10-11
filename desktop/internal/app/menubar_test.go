package app

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/install"
	"github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
)

func TestDisplayWriteFailureKeepsTheNewSelection(t *testing.T) {
	paths := install.PathsForHome(t.TempDir())
	m := NewModel(paths, "")
	if err := os.MkdirAll(filepath.Dir(paths.Support), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Support, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	m.ToggleMenuBarMetric(menubar.TodayTokens)
	if !m.MenuBarDisplay.Has(menubar.TodayTokens) {
		t.Fatal("failed write rolled the selection back")
	}
	if err := os.Remove(paths.Support); err != nil {
		t.Fatal(err)
	}
	m.ToggleMenuBarMetric(menubar.TokensPerSecond)
	reloaded := NewModel(paths, "")
	if !reloaded.MenuBarDisplay.Has(menubar.TodayTokens) || !reloaded.MenuBarDisplay.Has(menubar.TokensPerSecond) {
		t.Fatal("retry was not persisted")
	}
}
