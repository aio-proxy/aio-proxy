package update

import (
	"path/filepath"
	"testing"
)

func TestDecide(t *testing.T) {
	if outcome, version := Decide("0.40.0", "0.41.0", true, false); outcome != CheckAvailable || version != "0.41.0" {
		t.Fatal(outcome, version)
	}
	if outcome, _ := Decide("0.40.0", "0.40.0", true, false); outcome != CheckSilent {
		t.Fatal(outcome)
	}
	if outcome, _ := Decide("0.40.0", "0.40.0", true, true); outcome != CheckUpToDate {
		t.Fatal(outcome)
	}
	if outcome, _ := Decide("0.40.0", "", false, true); outcome != CheckUpToDate {
		t.Fatal(outcome)
	}
	if outcome, _ := Decide("0.40.0", "0.39.0", true, true); outcome != CheckUpToDate {
		t.Fatal(outcome)
	}
}

func TestInstallPlan(t *testing.T) {
	image := filepath.Join("/opt", "AIO Proxy.AppImage")
	dir := filepath.Dir(image)
	if action, url := InstallPlan(image, func(string) bool { return false }, "0.41.0"); action != InstallOpenURL || url != ReleasePage("0.41.0") {
		t.Fatal(action, url)
	}
	if action, _ := InstallPlan(image, func(got string) bool { return got == dir }, "0.41.0"); action != InstallInPlace {
		t.Fatal(action)
	}
	if action, _ := InstallPlan("", func(string) bool { return true }, "0.41.0"); action != InstallOpenURL {
		t.Fatal(action)
	}
}
