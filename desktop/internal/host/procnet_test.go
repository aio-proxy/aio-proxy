package host

import (
	"net/netip"
	"testing"
)

const v4 = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
	"   0: 0100007F:1029 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1\n" +
	"   1: 0100007F:1029 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2 1"

const v6 = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid\n" +
	"   0: 00000000000000000000000001000000:1029 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000\n" +
	"   1: 00000000000000000000000001000000:1029 00000000000000000000000001000000:C351 01 00000000:00000000 00:00000000 00000000  1000"

func mustAddr(s string) netip.AddrPort {
	return netip.MustParseAddrPort(s)
}

func TestProcRowsMatchTheFourTuple(t *testing.T) {
	rows := ParseProcNet(v4, false)
	server := mustAddr("127.0.0.1:4137")
	if uid, ok := ServingUID(rows, server, mustAddr("127.0.0.1:50000")); !ok || uid != 1000 {
		t.Fatalf("v4 %v %v", uid, ok)
	}
	if _, ok := ServingUID(rows, server, mustAddr("127.0.0.1:50001")); ok {
		t.Fatal("wrong client matched")
	}
	rows6 := ParseProcNet(v6, true)
	if uid, ok := ServingUID(rows6, mustAddr("[::1]:4137"), mustAddr("[::1]:50001")); !ok || uid != 1000 {
		t.Fatalf("v6 %v %v", uid, ok)
	}
	if _, ok := ServingUID(rows6, mustAddr("[::1]:4137"), mustAddr("[::]:0")); ok {
		t.Fatal("listening row matched")
	}
}

func TestServingPIDIgnoresTheClientRow(t *testing.T) {
	server, client := mustAddr("[::1]:4137"), mustAddr("[::1]:50001")
	rows := []TcpRow{{Local: client, Remote: server, PID: 1}, {Local: server, Remote: client, PID: 812}}
	if pid, ok := ServingPID(rows, server, client); !ok || pid != 812 {
		t.Fatal(pid, ok)
	}
	if _, ok := ServingPID(rows, server, mustAddr("[::1]:50002")); ok {
		t.Fatal("other client")
	}
}
