// Package listener decides whether this user owns the other end of a connection. Another local account
// can bind the proxy's port while it is down and answer `/health`; the desktop token goes only over a
// connection whose serving socket belongs to this user.
package listener

import (
	"context"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

type Listener struct {
	UID     uint32
	Family  string
	Address string
}

// ParseListeners returns the sockets in `lsof -F tun` output: each file's family and name, under its
// process's uid.
func ParseListeners(output string) []Listener {
	var listeners []Listener
	var uid uint32
	hasUID, family := false, ""
	for line := range strings.Lines(output) {
		line = strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		if line == "" {
			continue
		}
		value := line[1:]
		switch line[0] {
		case 'u':
			n, err := strconv.ParseUint(value, 10, 32)
			uid, hasUID = uint32(n), err == nil
		case 'f':
			family = ""
		case 't':
			family = value
		case 'n':
			if hasUID {
				listeners = append(listeners, Listener{UID: uid, Family: family, Address: value})
			}
		}
	}
	return listeners
}

// Serves reports whether `sockets` hold the serving side of a connection from `local` to `peer`, as
// `lsof` names it (`peer->local`), owned by `uid`. An unprivileged `lsof` lists only this user's
// sockets, so another account's accepted socket never matches.
func Serves(sockets []Listener, uid uint32, peer, local netip.AddrPort) bool {
	name := peer.String() + "->" + local.String()
	for _, s := range sockets {
		if s.UID == uid && s.Address == name {
			return true
		}
	}
	return false
}

const retry = 25 * time.Millisecond

// PeerOwnedByThisUser reports whether this user's process holds the other end of `conn`: the socket
// that is about to carry the token, not merely whatever listens on the port now (a listener can
// change hands after the connection was accepted). The server may not have accepted yet, so `lsof`
// is retried until `deadline`; any failure, or a cancelled `ctx`, counts as not ours.
func PeerOwnedByThisUser(ctx context.Context, conn net.Conn, deadline time.Time) bool {
	local, ok1 := addrPort(conn.LocalAddr())
	peer, ok2 := addrPort(conn.RemoteAddr())
	if !ok1 || !ok2 {
		return false
	}
	for {
		if owns(ctx, local, peer, deadline) {
			return true
		}
		if !time.Now().Add(retry).Before(deadline) {
			return false
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(retry):
		}
	}
}

// addrPort is the address as lsof prints it: an IPv4 socket's address unmapped from its 16-byte form.
func addrPort(addr net.Addr) (netip.AddrPort, bool) {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return netip.AddrPort{}, false
	}
	ap := tcp.AddrPort()
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()), ap.IsValid()
}
