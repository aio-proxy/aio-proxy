use std::net::SocketAddr;

use super::*;

const V4_FIXTURE: &str =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1029 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1
   1: 0100007F:1029 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 2 1";
const V6_FIXTURE: &str = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid
   0: 00000000000000000000000001000000:1029 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000
   1: 00000000000000000000000001000000:1029 00000000000000000000000001000000:C351 01 00000000:00000000 00:00000000 00000000  1000";

fn addr(s: &str) -> SocketAddr {
    s.parse().unwrap()
}

#[test]
fn proc_rows_decode_both_families_and_match_the_four_tuple() {
    let rows = parse_proc_net(V4_FIXTURE, false);
    let server = addr("127.0.0.1:4137");
    assert_eq!(serving_uid(&rows, server, addr("127.0.0.1:50000")), Some(1000));
    assert_eq!(serving_uid(&rows, server, addr("127.0.0.1:50001")), None);
    let rows6 = parse_proc_net(V6_FIXTURE, true);
    assert_eq!(serving_uid(&rows6, addr("[::1]:4137"), addr("[::1]:50001")), Some(1000));
    // The listening row never stands in for a connection.
    assert_eq!(serving_uid(&rows6, addr("[::1]:4137"), addr("[::]:0")), None);
}
