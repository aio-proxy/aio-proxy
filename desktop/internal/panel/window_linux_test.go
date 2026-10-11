//go:build linux

package panel

import (
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
)

func TestLosingTheTrayHostOpensTheWindowOnce(t *testing.T) {
	prev := currentTray
	t.Cleanup(func() { currentTray = prev })
	currentTray = host.Tray
	if !NoteTray(false) || ShowingTray() {
		t.Fatal("losing the host should open the panel")
	}
	if NoteTray(false) {
		t.Fatal("a host that is already gone opens the panel again")
	}
	if NoteTray(true) || !ShowingTray() {
		t.Fatal("the host returning should keep the panel and show the icon")
	}
}
