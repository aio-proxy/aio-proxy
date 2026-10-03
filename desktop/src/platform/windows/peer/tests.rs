use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use super::super::process::sid_string;
use super::*;

#[test]
fn a_local_listener_of_this_process_is_owned_by_this_user() {
    for bind in ["127.0.0.1:0", "[::1]:0"] {
        let listener = TcpListener::bind(bind).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let _accepted = listener.accept().unwrap();
        assert!(peer_owned_by_this_user(&client, Instant::now() + Duration::from_secs(2)), "{bind}");
    }
}

/// Decodes addresses and ports in the right byte order: the serving row is found by its four-tuple.
#[test]
fn the_tcp_table_names_this_process_as_the_server() {
    for (bind, v6) in [("127.0.0.1:0", false), ("[::1]:0", true)] {
        let listener = TcpListener::bind(bind).unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let _accepted = listener.accept().unwrap();
        let rows = tcp_rows(v6).unwrap();
        let found = serving_pid(&rows, client.peer_addr().unwrap(), client.local_addr().unwrap());
        assert_eq!(found, Some(std::process::id()), "{bind}");
    }
}

#[test]
fn this_users_sid_reads_as_a_sid_string() {
    let sid = sid_string(&current_user_sid());
    assert!(sid.starts_with("S-1-5-"), "{sid}");
    assert_eq!(sid_string(&[]), "");
}
