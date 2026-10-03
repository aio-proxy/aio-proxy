use std::net::SocketAddr;

use super::*;

#[test]
fn the_serving_row_is_the_one_whose_local_end_is_the_server() {
    let s: SocketAddr = "[::1]:4137".parse().unwrap();
    let c: SocketAddr = "[::1]:50001".parse().unwrap();
    let rows = [TcpRow { local: c, remote: s, pid: 1 }, TcpRow { local: s, remote: c, pid: 812 }];
    assert_eq!(serving_pid(&rows, s, c), Some(812));
    assert_eq!(serving_pid(&rows, s, "[::1]:50002".parse().unwrap()), None);
}
