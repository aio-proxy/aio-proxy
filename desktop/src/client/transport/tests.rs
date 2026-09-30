use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

use super::*;

/// One-shot local server: runs `respond` on the first connection and returns the request head.
fn serve(respond: impl FnOnce(&mut TcpStream) + Send + 'static) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let head = read_head(&mut stream);
        respond(&mut stream);
        head
    });
    (base, handle)
}

fn read_head(stream: &mut TcpStream) -> String {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut head = String::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
            return head;
        }
        head.push_str(&line);
    }
}

fn get(base: &str, bearer: Option<Token>) -> Request {
    Request { method: Method::Get, url: LocalUrl::parse(base, "/dashboard/api/desktop-summary").unwrap(), bearer }
}

fn send_default(request: &Request) -> Result<Response, HttpError> {
    send(request, Limits::default(), &Cancel::default())
}

#[test]
fn only_a_literal_loopback_ip_over_plain_http_is_addressable() {
    for base in [
        "http://localhost:9317",
        "http://192.168.1.2:9317",
        "http://10.0.0.1:9317",
        "http://127.0.0.1.nip.io:9317",
        "https://127.0.0.1:9317",
        "http://user:pw@127.0.0.1:9317",
        "not a url",
    ] {
        assert!(matches!(LocalUrl::parse(base, "/health"), Err(HttpError::NotLoopback)), "{base}");
    }
    assert!(LocalUrl::parse("http://127.0.0.1:9317", "/health").is_ok());
    assert!(LocalUrl::parse("http://[::1]:9317", "/health").is_ok());
    assert!(matches!(LocalUrl::parse("http://127.0.0.1:9317", "/x\r\nEvil: 1"), Err(HttpError::InvalidPath)));
}

#[test]
fn sends_the_bearer_only_on_the_request_that_carries_it() {
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").unwrap();
    });
    let response = send_default(&get(&base, Some(Token::new("tok-1")))).unwrap();
    assert_eq!((response.status, response.body.as_slice()), (200, &b"ok"[..]));
    let head = server.join().unwrap();
    assert!(head.starts_with("GET /dashboard/api/desktop-summary HTTP/1.1\r\n"), "{head}");
    assert!(head.contains("Authorization: Bearer tok-1\r\n"), "{head}");

    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    send_default(&get(&base, None)).unwrap();
    assert!(!server.join().unwrap().to_ascii_lowercase().contains("authorization"));
}

#[test]
fn a_redirect_is_returned_not_followed() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let location = format!("http://{}/steal", target.local_addr().unwrap());
    let (base, server) = serve(move |s| {
        write!(s, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    let response = send_default(&get(&base, Some(Token::new("tok-2")))).unwrap();
    assert_eq!(response.status, 302);
    server.join().unwrap();
    thread::sleep(Duration::from_millis(200));
    assert!(target.accept().is_err(), "the redirect target was contacted");
}

#[test]
fn proxy_environment_variables_are_ignored() {
    // SAFETY: no other test in this crate reads these variables.
    unsafe {
        for name in ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
            std::env::set_var(name, "http://127.0.0.1:1");
        }
    }
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    assert_eq!(send_default(&get(&base, None)).unwrap().status, 200);
    server.join().unwrap();
}

#[test]
fn a_slow_drip_is_cut_off_at_the_total_deadline() {
    let (base, server) = serve(|s| {
        let _ = s.write_all(b"HTTP/1.1 200 OK\r\n");
        for _ in 0..40 {
            thread::sleep(Duration::from_millis(100));
            if s.write_all(b"X").is_err() {
                return;
            }
        }
    });
    let limits = Limits { total: Duration::from_millis(700), ..Limits::default() };
    let started = Instant::now();
    let result = send(&get(&base, None), limits, &Cancel::default());
    let elapsed = started.elapsed();
    assert!(matches!(result, Err(HttpError::Timeout)), "{result:?}");
    assert!(elapsed >= Duration::from_millis(650) && elapsed < Duration::from_millis(1200), "{elapsed:?}");
    server.join().unwrap();
}

#[test]
fn decodes_a_chunked_body() {
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4;ext=1\r\n{\"a\"\r\n3\r\n:1}\r\n0\r\nX-Trailer: t\r\n\r\n")
            .unwrap();
    });
    assert_eq!(send_default(&get(&base, None)).unwrap().body, br#"{"a":1}"#);
    server.join().unwrap();
}

#[test]
fn an_oversized_response_is_refused() {
    let limits = Limits { max_body: 16, ..Limits::default() };
    let bodies: [&'static [u8]; 3] = [
        b"HTTP/1.1 200 OK\r\nContent-Length: 17\r\n\r\n",
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n11\r\n",
        b"HTTP/1.1 200 OK\r\n\r\n",
    ];
    for head in bodies {
        let (base, server) = serve(move |s| {
            let _ = s.write_all(head);
            let _ = s.write_all(&[b'x'; 64]);
        });
        let result = send(&get(&base, None), limits, &Cancel::default());
        assert!(matches!(result, Err(HttpError::TooLarge)), "{result:?}");
        server.join().unwrap();
    }
}

#[test]
fn dropping_a_pending_request_shuts_its_socket() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let pending = spawn(get(&base, None), Limits::default());
    let (mut stream, _) = listener.accept().unwrap();
    read_head(&mut stream);
    drop(pending);
    stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut byte = [0_u8; 1];
    assert_eq!(stream.read(&mut byte).unwrap(), 0, "peer should see EOF after the drop");
}

#[test]
fn a_spawned_request_resolves_through_its_future() {
    let (base, server) = serve(|s| {
        s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").unwrap();
    });
    let response = futures::executor::block_on(spawn(get(&base, None), Limits::default())).unwrap();
    assert_eq!(response.status, 404);
    server.join().unwrap();
}
