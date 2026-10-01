use std::net::TcpListener;
use std::time::{Duration, Instant};

use super::*;

const LSOF: &str = "p1\nu501\nf12\ntIPv4\nn127.0.0.1:9317\nf13\ntIPv6\nn*:9418\np2\nu502\nf3\ntIPv6\nn[::1]:9317\n";

#[test]
fn a_listener_vouches_only_for_its_own_address_and_family() {
    let listeners = parse_listeners(LSOF);
    assert_eq!(listeners.len(), 3);
    let at = |addr: &str| listens_at(&listeners, 501, addr.parse().unwrap());
    assert!(at("127.0.0.1:9317"));
    // Another user holds ::1 on the same port; our IPv4 listener says nothing about it.
    assert!(!at("[::1]:9317"));
    assert!(at("[::1]:9418"));
    // An IPv6 wildcard does not vouch for an IPv4 connection.
    assert!(!at("127.0.0.1:9418"));
}

#[test]
fn this_users_own_listener_is_recognised() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    assert!(owned_by_this_user(addr, Instant::now() + Duration::from_secs(5)));
    drop(listener);
    assert!(!owned_by_this_user(addr, Instant::now() + Duration::from_secs(5)));
}
