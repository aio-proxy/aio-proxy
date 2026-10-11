package host

import (
	"encoding/binary"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

// ProcRow is one /proc/net/tcp or tcp6 line that parsed.
type ProcRow struct {
	Local, Remote netip.AddrPort
	Listening     bool
	UID           uint32
}

// ParseProcNet drops rows that do not parse. v6 selects /proc/net/tcp6's 16-byte addresses.
func ParseProcNet(text string, v6 bool) []ProcRow {
	var rows []ProcRow
	for line := range strings.Lines(text) {
		fields := strings.Fields(line)
		if len(fields) < 8 {
			continue
		}
		index, local, remote, state, uidText := fields[0], fields[1], fields[2], fields[3], fields[7]
		n, ok := strings.CutSuffix(index, ":")
		if !ok || n == "" || strings.IndexFunc(n, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			continue
		}
		localAddr, ok1 := procEndpoint(local, v6)
		remoteAddr, ok2 := procEndpoint(remote, v6)
		uid, err := strconv.ParseUint(uidText, 10, 32)
		if !ok1 || !ok2 || err != nil {
			continue
		}
		rows = append(rows, ProcRow{Local: localAddr, Remote: remoteAddr, Listening: strings.EqualFold(state, "0A"), UID: uint32(uid)})
	}
	return rows
}

func procEndpoint(field string, v6 bool) (netip.AddrPort, bool) {
	host, port, ok := strings.Cut(field, ":")
	want := 8
	if v6 {
		want = 32
	}
	if !ok || len(host) != want || len(port) != 4 {
		return netip.AddrPort{}, false
	}
	raw, err := strconv.ParseUint(port, 16, 16)
	if err != nil {
		return netip.AddrPort{}, false
	}
	ip, ok := procAddress(host)
	if !ok {
		return netip.AddrPort{}, false
	}
	return netip.AddrPortFrom(ip, uint16(raw)), true
}

// procAddress decodes the kernel's hex words. Each 32-bit word is little-endian on the host.
func procAddress(hex string) (netip.Addr, bool) {
	var bytes []byte
	for len(hex) > 0 {
		word := hex
		if len(word) > 8 {
			word = hex[:8]
		}
		hex = hex[len(word):]
		value, err := strconv.ParseUint(word, 16, 32)
		if err != nil {
			return netip.Addr{}, false
		}
		var buf [4]byte
		binary.LittleEndian.PutUint32(buf[:], uint32(value))
		bytes = append(bytes, buf[:]...)
	}
	if len(bytes) == 4 {
		return netip.AddrFrom4([4]byte(bytes)), true
	}
	if len(bytes) == 16 {
		return netip.AddrFrom16([16]byte(bytes)), true
	}
	return netip.Addr{}, false
}

// ServingUID is the uid of the accepted socket server <- client. A listening row never matches.
func ServingUID(rows []ProcRow, server, client netip.AddrPort) (uint32, bool) {
	for _, row := range rows {
		if !row.Listening && row.Local == server && row.Remote == client {
			return row.UID, true
		}
	}
	return 0, false
}

// TcpRow is one Windows TCP table row.
type TcpRow struct {
	Local, Remote netip.AddrPort
	PID           uint32
}

// ServingPID is the process that accepted server <- client. The client's own row is swapped and misses.
func ServingPID(rows []TcpRow, server, client netip.AddrPort) (uint32, bool) {
	for _, row := range rows {
		if sameAddr(row.Local, server) && sameAddr(row.Remote, client) {
			return row.PID, true
		}
	}
	return 0, false
}

func sameAddr(a, b netip.AddrPort) bool {
	return a.Addr().Compare(b.Addr()) == 0 && a.Port() == b.Port()
}

// NetIP converts a net.Addr, unmapping IPv4-in-IPv6 the way the tables store it.
func NetIP(addr net.Addr) (netip.AddrPort, bool) {
	tcp, ok := addr.(*net.TCPAddr)
	if !ok {
		return netip.AddrPort{}, false
	}
	ap := tcp.AddrPort()
	return netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()), ap.IsValid()
}
