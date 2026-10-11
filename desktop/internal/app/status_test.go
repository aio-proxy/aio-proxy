package app

import (
	"testing"

	"github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
)

func TestEndpointOwnerDoesNotCallAnUnreadableLinuxUnitStopped(t *testing.T) {
	if got := endpointOwner("linux", discovery.OwnerDesktop, true, false); got != "" {
		t.Fatalf("unreadable linux unit: %q", got)
	}
	if got := endpointOwner("linux", discovery.OwnerDesktop, true, true); got != "stopped by you" {
		t.Fatalf("disabled loaded unit: %q", got)
	}
	if got := endpointOwner("darwin", discovery.OwnerDesktop, true, false); got != "stopped by you" {
		t.Fatalf("darwin: %q", got)
	}
	if got := endpointOwner("windows", discovery.OwnerDesktop, false, true); got != "started by AIO Proxy" {
		t.Fatalf("running: %q", got)
	}
}

func TestReadOnlyNoticesNameThePlatform(t *testing.T) {
	if locationNotice("darwin") != "Move AIO Proxy to Applications to let it manage the proxy." {
		t.Fatal("macos")
	}
	if locationNotice("linux") != "AIO Proxy can't manage the proxy: its bundled command-line tool is missing, or ~/.local/share/aio-proxy-desktop isn't writable." {
		t.Fatal("linux")
	}
	if locationNotice("windows") != "AIO Proxy can't manage the proxy: aio-proxy.exe is missing next to the app, or %LOCALAPPDATA%\\aio-proxy-desktop isn't writable." {
		t.Fatal("windows")
	}
	if copyFailureWhat("darwin") != "service link" || copyFailureWhat("linux") != "command-line copy" {
		t.Fatal("copy failure")
	}
}
