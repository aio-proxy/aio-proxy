package menubar

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDisplayChoicesSurviveRelaunch(t *testing.T) {
	support := filepath.Join(t.TempDir(), "support")
	p, err := Load(support)
	if err != nil {
		t.Fatal(err)
	}
	p = p.Toggle(TodayTokens).Toggle(ShowIcon)
	if err := Save(support, p); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(support)
	if err != nil {
		t.Fatal(err)
	}
	if loaded != p || loaded.TodayTokens || loaded.ShowIcon || !loaded.TokensPerSecond {
		t.Fatalf("choices lost on reload: %+v", loaded)
	}
	if loaded.Toggle(TokensPerSecond) != loaded {
		t.Fatal("last menu-bar control could disappear")
	}
}
func TestUnreadablePreferencesAreNotOverwritten(t *testing.T) {
	support := t.TempDir()
	path := preferencePath(support)
	if err := os.WriteFile(path, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	p, err := Load(support)
	if err == nil || !p.Visible() {
		t.Fatal("invalid preferences must report error and keep a reachable control")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "invalid" {
		t.Fatal("loading rewrote user preferences")
	}
}
func TestAllHiddenPreferencesKeepTheMenuReachable(t *testing.T) {
	support := t.TempDir()
	if err := Save(support, Preferences{}); err != nil {
		t.Fatal(err)
	}
	p, err := Load(support)
	if err != nil {
		t.Fatal(err)
	}
	if !p.ShowIcon || p.MetricsEnabled() {
		t.Fatalf("visibility repair = %+v", p)
	}
}
