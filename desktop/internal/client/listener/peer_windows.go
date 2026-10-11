//go:build windows

package listener

import (
	"context"
	"net/netip"
	"os"
	"time"
	"unsafe"

	"github.com/aio-proxy/aio-proxy/desktop/internal/host"
	"golang.org/x/sys/windows"
)

var getExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const tcpTableOwnerPIDAll = 5

func owns(_ context.Context, local, peer netip.AddrPort, _ time.Time) bool {
	rows, err := tcpRows(peer.Addr().Is6())
	if err != nil {
		return false
	}
	pid, ok := host.ServingPID(rows, peer, local)
	if !ok {
		return false
	}
	return sameUser(pid)
}

func tcpRows(v6 bool) ([]host.TcpRow, error) {
	family := uint32(windows.AF_INET)
	if v6 {
		family = uint32(windows.AF_INET6)
	}
	var size uint32
	var buffer []byte
	for range 4 {
		var raw unsafe.Pointer
		if len(buffer) > 0 {
			raw = unsafe.Pointer(&buffer[0])
		}
		status, _, _ := getExtendedTcpTable.Call(uintptr(raw), uintptr(unsafe.Pointer(&size)), 0, uintptr(family), tcpTableOwnerPIDAll, 0)
		if status == 0 && len(buffer) > 0 {
			return decodeRows(buffer[:size], v6), nil
		}
		if status != uintptr(windows.ERROR_INSUFFICIENT_BUFFER) && len(buffer) > 0 {
			return nil, windows.Errno(status)
		}
		buffer = make([]byte, int(size))
	}
	return nil, windows.ERROR_INSUFFICIENT_BUFFER
}

func decodeRows(table []byte, v6 bool) []host.TcpRow {
	if len(table) < 4 {
		return nil
	}
	count := int(*(*uint32)(unsafe.Pointer(&table[0])))
	if v6 {
		return decodeV6(table, count)
	}
	return decodeV4(table, count)
}

func decodeV4(table []byte, count int) []host.TcpRow {
	const rowSize = 24
	const first = 4
	if first+count*rowSize > len(table) {
		return nil
	}
	rows := make([]host.TcpRow, 0, count)
	for i := range count {
		off := first + i*rowSize
		local := addr4(table[off+4:off+8], port(table[off+8:off+12]))
		remote := addr4(table[off+12:off+16], port(table[off+16:off+20]))
		pid := *(*uint32)(unsafe.Pointer(&table[off+20]))
		rows = append(rows, host.TcpRow{Local: local, Remote: remote, PID: pid})
	}
	return rows
}

func decodeV6(table []byte, count int) []host.TcpRow {
	const rowSize = 56
	const first = 4
	if first+count*rowSize > len(table) {
		return nil
	}
	rows := make([]host.TcpRow, 0, count)
	for i := range count {
		off := first + i*rowSize
		local := addr16(table[off:off+16], port(table[off+20:off+24]))
		remote := addr16(table[off+24:off+40], port(table[off+44:off+48]))
		pid := *(*uint32)(unsafe.Pointer(&table[off+52]))
		rows = append(rows, host.TcpRow{Local: local, Remote: remote, PID: pid})
	}
	return rows
}

func port(b []byte) uint16 { return uint16(b[0])<<8 | uint16(b[1]) }

func addr4(b []byte, port uint16) netip.AddrPort {
	return netip.AddrPortFrom(netip.AddrFrom4([4]byte{b[0], b[1], b[2], b[3]}), port)
}
func addr16(b []byte, port uint16) netip.AddrPort {
	var ip [16]byte
	copy(ip[:], b)
	return netip.AddrPortFrom(netip.AddrFrom16(ip), port)
}

func sameUser(pid uint32) bool {
	if pid == uint32(os.Getpid()) {
		return true
	}
	mine, ok := userSID(uint32(os.Getpid()))
	theirs, ok2 := userSID(pid)
	return ok && ok2 && mine == theirs
}

func userSID(pid uint32) (string, bool) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", false
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return "", false
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil || user.User.Sid == nil {
		return "", false
	}
	return user.User.Sid.String(), true
}
