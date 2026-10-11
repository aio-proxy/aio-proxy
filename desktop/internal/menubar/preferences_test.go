package menubar

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestMissingAndCorruptFilesUseDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "preferences.json")
	got, err := Load(dir)
	if err != nil || got != DefaultPreferences() {
		t.Fatalf("missing: %+v %v", got, err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = Load(dir)
	if err == nil || got != DefaultPreferences() {
		t.Fatalf("corrupt: %+v %v", got, err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "{not json" {
		t.Fatal("loading rewrote preferences")
	}
}

func TestUnknownMetricsAreDiscardedBeforeTheLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "preferences.json")
	body := `{"trayMetrics":["todayTokens","bogus","inFlight","todayCost"],"trayShowIcon":false}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := DefaultPreferences().Toggle(TodayTokens).Toggle(InFlight)
	want.ShowIcon = false
	if got != want {
		t.Fatalf("got %+v metrics %v", got, got.Metrics())
	}
}

func TestSaveReplacesPreferences(t *testing.T) {
	dir := t.TempDir()
	prefs := DefaultPreferences().Toggle(TodayCost).Toggle(TokensPerSecond)
	prefs.ShowIcon = false
	if err := Save(dir, prefs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "preferences.json.tmp")); !os.IsNotExist(err) {
		t.Fatal("temp file left behind")
	}
	loaded, err := Load(dir)
	if err != nil || loaded != prefs {
		t.Fatalf("loaded %+v %v", loaded, err)
	}
	prefs.ShowIcon = true
	if err := Save(dir, prefs); err != nil {
		t.Fatal(err)
	}
	loaded, err = Load(dir)
	if err != nil || loaded != prefs {
		t.Fatalf("replaced %+v %v", loaded, err)
	}
}

func TestToggleRespectsLimitAndOrder(t *testing.T) {
	prefs := DefaultPreferences().Toggle(TodayTokens).Toggle(InFlight)
	if next := prefs.Toggle(TodayCost); next != prefs {
		t.Fatal("a third metric was accepted")
	}
	prefs = prefs.Toggle(TodayTokens)
	if len(prefs.Metrics()) != 1 || prefs.Metrics()[0] != InFlight {
		t.Fatalf("remove: %v", prefs.Metrics())
	}
	prefs = prefs.Toggle(TodayCost)
	got := prefs.Metrics()
	if len(got) != 2 || got[0] != InFlight || got[1] != TodayCost {
		t.Fatalf("order: %v", got)
	}
}

func TestEmptyMetricsKeepTheIconVisible(t *testing.T) {
	prefs := Preferences{ShowIcon: false}
	if !prefs.ShowsIcon() {
		t.Fatal("empty selection hid the icon")
	}
	prefs = prefs.Toggle(TodayTokens)
	if prefs.ShowsIcon() {
		t.Fatal("icon stayed on after a metric was selected")
	}
	prefs.ShowIcon = true
	if !prefs.ShowsIcon() {
		t.Fatal("stored icon flag ignored")
	}
}

func TestDuplicateMetricsKeepTheFirst(t *testing.T) {
	dir := t.TempDir()
	body := `{"trayMetrics":["todayTokens","todayTokens","inFlight"],"trayShowIcon":true}`
	if err := os.WriteFile(filepath.Join(dir, "preferences.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	metrics := got.Metrics()
	if len(metrics) != 2 || metrics[0] != TodayTokens || metrics[1] != InFlight {
		t.Fatalf("metrics %v", metrics)
	}
}

func TestLegacyLabelStyleIsDroppedOnSave(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "preferences.json")
	for _, style := range []string{"prefix", "unit", "unknown"} {
		body := `{"trayMetrics":["todayCost"],"trayShowIcon":false,"trayLabelStyle":"` + style + `"}`
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		loaded, err := Load(dir)
		if err != nil {
			t.Fatal(err)
		}
		want := Preferences{ShowIcon: false}.Toggle(TodayCost)
		if loaded != want {
			t.Fatalf("style %s: %+v", style, loaded.Metrics())
		}
		if err := Save(dir, loaded); err != nil {
			t.Fatal(err)
		}
		saved, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var raw map[string]any
		if err := json.Unmarshal(saved, &raw); err != nil {
			t.Fatal(err)
		}
		if _, ok := raw["trayLabelStyle"]; ok {
			t.Fatalf("style %s was written back", style)
		}
	}
}
