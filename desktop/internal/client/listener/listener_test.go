package listener

import (
	"context"
	"net"
	"net/netip"
	"testing"
	"time"
)

func TestOnlyThisUsersServingSocketForThisConnectionCounts(t *testing.T) {
	// Our client end, our server end of this connection, and another user's socket elsewhere.
	lsof := "p1\nu501\nf8\ntIPv4\nn127.0.0.1:55000->127.0.0.1:9317\nf9\ntIPv4\nn127.0.0.1:9317->127.0.0.1:55000\np2\nu502\nf3\ntIPv6\nn[::1]:9317->[::1]:55001\n"
	sockets := ParseListeners(lsof)
	if len(sockets) != 3 {
		t.Fatalf("parsed %d sockets: %+v", len(sockets), sockets)
	}
	if sockets[2] != (Listener{UID: 502, Family: "IPv6", Address: "[::1]:9317->[::1]:55001"}) {
		t.Fatalf("third socket %+v", sockets[2])
	}
	server, client := netip.MustParseAddrPort("127.0.0.1:9317"), netip.MustParseAddrPort("127.0.0.1:55000")
	if !Serves(sockets, 501, server, client) {
		t.Fatal("our serving socket was not recognised")
	}
	// Only our client end is visible when another user accepted the connection: not served by us.
	clientOnly := ParseListeners("p1\nu501\nf8\ntIPv4\nn127.0.0.1:55000->127.0.0.1:9317\n")
	if Serves(clientOnly, 501, server, client) {
		t.Fatal("our client end vouched for the server")
	}
	// Another user's accepted socket never vouches, even on the same port.
	v6Server, v6Client := netip.MustParseAddrPort("[::1]:9317"), netip.MustParseAddrPort("[::1]:55001")
	if Serves(sockets, 501, v6Server, v6Client) {
		t.Fatal("another user's socket vouched")
	}
}

func TestAConnectionThisProcessServesIsRecognised(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	accepted, err := ln.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer accepted.Close()
	if !PeerOwnedByThisUser(context.Background(), conn, time.Now().Add(5*time.Second)) {
		t.Fatal("our own accepted socket was not recognised")
	}
	ln.Close()
	// Still the same accepted socket: closing the listener changes nothing about this connection.
	if !PeerOwnedByThisUser(context.Background(), conn, time.Now().Add(5*time.Second)) {
		t.Fatal("not recognised after the listener closed")
	}
}
