//go:build linux

package listener

import (
	"context"
	"net/netip"
	"os"
	"time"

	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
)

func owns(_ context.Context, local, peer netip.AddrPort, deadline time.Time) bool {
	path := "/proc/net/tcp"
	if peer.Addr().Is6() {
		path = "/proc/net/tcp6"
	}
	text, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	uid, ok := host.ServingUID(host.ParseProcNet(string(text), peer.Addr().Is6()), peer, local)
	return ok && uid == uint32(os.Getuid()) && time.Now().Before(deadline)
}
