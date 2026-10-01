use std::io::{Read as _, Write as _};
use std::net::TcpListener;

use futures::AsyncReadExt as _;
use futures::executor::block_on;

use super::*;

/// The whole NSURLSession round trip against a one-shot loopback server.
#[test]
fn fetches_status_and_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/icon.png", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0; 1024];
        let _ = stream.read(&mut request).unwrap();
        stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 4\r\nConnection: close\r\n\r\ngone").unwrap();
    });
    let response = block_on(UrlSession.get(&url, AsyncBody::empty(), true)).unwrap();
    assert_eq!(response.status().as_u16(), 404);
    let mut body = Vec::new();
    block_on(response.into_body().read_to_end(&mut body)).unwrap();
    assert_eq!(body, b"gone");
}
