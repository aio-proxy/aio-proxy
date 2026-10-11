//go:build unix

package clicommand

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstallLinksRefusesAnExistingAiopAndKeepsAnAlias(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "aio-proxy")
	if err := os.WriteFile(target, []byte("bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkDir := filepath.Join(dir, "bin")
	made, err := InstallLinks(linkDir, target, Probe{})
	if err != nil || len(made) != 2 {
		t.Fatalf("made %v %v", made, err)
	}
	if err := os.Remove(filepath.Join(linkDir, "aiop")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("gone", filepath.Join(linkDir, "aiop")); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallLinks(linkDir, target, Probe{}); err == nil {
		t.Fatal("a dangling aiop was replaced")
	}
	alias := filepath.Join(linkDir, "aio-proxy")
	if err := os.Remove(alias); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(alias, []byte("other"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(linkDir, "aiop")); err != nil {
		t.Fatal(err)
	}
	made, err = InstallLinks(linkDir, target, Probe{})
	if err != nil || len(made) != 1 || filepath.Base(made[0]) != "aiop" {
		t.Fatalf("alias should stay, made %v %v", made, err)
	}
	body, err := os.ReadFile(alias)
	if err != nil || string(body) != "other" {
		t.Fatalf("alias %q %v", body, err)
	}
}

func TestLoginShellComesFromTheAccount(t *testing.T) {
	shell := loginShell()
	if shell == "" || shell[0] != '/' {
		t.Fatalf("shell %q", shell)
	}
}
