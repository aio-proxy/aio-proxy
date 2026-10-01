use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use super::*;

#[test]
fn only_this_users_serving_socket_for_this_connection_counts() {
    // Our client end, our server end of this connection, and another user's socket elsewhere.
    let lsof = "p1\nu501\nf8\ntIPv4\nn127.0.0.1:55000->127.0.0.1:9317\nf9\ntIPv4\nn127.0.0.1:9317->127.0.0.1:55000\np2\nu502\nf3\ntIPv6\nn[::1]:9317->[::1]:55001\n";
    let sockets = parse_listeners(lsof);
    assert_eq!(sockets.len(), 3);
    let (server, client) = ("127.0.0.1:9317".parse().unwrap(), "127.0.0.1:55000".parse().unwrap());
    assert!(serves(&sockets, 501, server, client));
    // Only our client end is visible when another user accepted the connection: not served by us.
    let client_only = parse_listeners("p1\nu501\nf8\ntIPv4\nn127.0.0.1:55000->127.0.0.1:9317\n");
    assert!(!serves(&client_only, 501, server, client));
    // Another user's accepted socket never vouches, even on the same port.
    let (v6_server, v6_client) = ("[::1]:9317".parse().unwrap(), "[::1]:55001".parse().unwrap());
    assert!(!serves(&sockets, 501, v6_server, v6_client));
}

#[test]
fn a_connection_this_process_serves_is_recognised() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let stream = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (accepted, _) = listener.accept().unwrap();
    assert!(peer_owned_by_this_user(&stream, Instant::now() + Duration::from_secs(5)));
    drop(listener);
    // Still the same accepted socket: closing the listener changes nothing about this connection.
    assert!(peer_owned_by_this_user(&stream, Instant::now() + Duration::from_secs(5)));
    drop(accepted);
}
