//! A minimal HTTP/1.1 client for the local instance only (spike check 2: the one stack meeting every
//! transport rule). It never reads proxy settings, never follows redirects, speaks plain HTTP only to
//! a literal loopback IP, and bounds the whole exchange by one total deadline.

use std::fmt;
use std::future::Future;
use std::io::{self, Read, Write};
use std::net::{IpAddr, Shutdown, SocketAddr, TcpStream};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use futures::channel::oneshot;

use crate::token::Token;

const MAX_HEADER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub connect: Duration,
    /// Raced against the whole request: connect, write, and every read share this one deadline.
    pub total: Duration,
    pub max_body: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self { connect: Duration::from_secs(1), total: Duration::from_secs(5), max_body: 4 * 1024 * 1024 }
    }
}

/// A URL on the local instance. Constructing one is the only way to address a request, so a
/// hostname, a non-loopback address or HTTPS can never carry the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalUrl {
    addr: SocketAddr,
    path: String,
}

impl LocalUrl {
    /// `base` is `instance.controlUrl` (`http://127.0.0.1:9317`, `http://[::1]:9317`); `path` is
    /// absolute, with an optional query.
    pub fn parse(base: &str, path: &str) -> Result<Self, HttpError> {
        let url = url::Url::parse(base).map_err(|_| HttpError::NotLoopback)?;
        if url.scheme() != "http" || !url.username().is_empty() || url.password().is_some() {
            return Err(HttpError::NotLoopback);
        }
        let ip = match url.host() {
            Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
            Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
            _ => return Err(HttpError::NotLoopback),
        };
        // All of 127.0.0.0/8 and ::1, as the CLI's `localControlHost` and the server accept: a config
        // may bind 127.0.0.5. An IPv4-mapped IPv6 address is not loopback here.
        if !ip.is_loopback() {
            return Err(HttpError::NotLoopback);
        }
        if !path.starts_with('/') || path.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control()) {
            return Err(HttpError::InvalidPath);
        }
        let port = url.port_or_known_default().ok_or(HttpError::NotLoopback)?;
        Ok(Self { addr: SocketAddr::new(ip, port), path: path.to_string() })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

#[derive(Debug, Clone)]
pub struct Request {
    pub method: Method,
    pub url: LocalUrl,
    /// Set per request, never as a default; the URL type already guarantees a loopback literal.
    pub bearer: Option<Token>,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

#[derive(Debug)]
pub enum HttpError {
    NotLoopback,
    InvalidPath,
    Connect(io::Error),
    Timeout,
    Io(io::Error),
    Malformed(&'static str),
    TooLarge,
    Cancelled,
    /// The bearer holds a byte that is not visible ASCII, which could inject header lines.
    InvalidToken,
    /// No listener of this user serves the address, so the bearer is not sent.
    UntrustedListener,
}

impl fmt::Display for HttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HttpError::NotLoopback => f.write_str("the control address is not a loopback IP"),
            HttpError::InvalidPath => f.write_str("invalid request path"),
            HttpError::Connect(error) => write!(f, "cannot connect: {error}"),
            HttpError::Timeout => f.write_str("timed out"),
            HttpError::Io(error) => write!(f, "connection error: {error}"),
            HttpError::Malformed(what) => write!(f, "malformed response: {what}"),
            HttpError::TooLarge => f.write_str("response too large"),
            HttpError::Cancelled => f.write_str("cancelled"),
            HttpError::InvalidToken => f.write_str("the token is not a valid header value"),
            HttpError::UntrustedListener => {
                f.write_str("the proxy's port is not served by this user's process; usage is not requested")
            }
        }
    }
}

/// `cancelled` and the stream share one lock, so the worker either registers its stream before a
/// cancel (and gets shut down) or sees `cancelled` and never sends.
#[derive(Default)]
struct Slot {
    cancelled: bool,
    stream: Option<TcpStream>,
}

#[derive(Clone, Default)]
pub struct Cancel(Arc<Mutex<Slot>>);

impl Cancel {
    pub fn cancel(&self) {
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.cancelled = true;
        if let Some(stream) = slot.stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn is_cancelled(&self) -> bool {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).cancelled
    }

    fn register(&self, stream: &TcpStream) -> Result<(), HttpError> {
        let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if slot.cancelled {
            return Err(HttpError::Cancelled);
        }
        slot.stream = Some(stream.try_clone().map_err(HttpError::Io)?);
        Ok(())
    }

    fn release(&self) {
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).stream = None;
    }
}

/// Blocking exchange on the calling thread. `cancel` from another thread shuts the socket down.
pub fn send(request: &Request, limits: Limits, cancel: &Cancel) -> Result<Response, HttpError> {
    let result = match Instant::now().checked_add(limits.total) {
        Some(deadline) => exchange(request, limits, deadline, cancel),
        None => Err(HttpError::Timeout),
    };
    cancel.release();
    // A cancel shuts the socket, which a read without a length reads as a clean EOF and would
    // return as a truncated `Ok`; whatever the result was, a cancelled exchange is Cancelled.
    if cancel.is_cancelled() {
        return Err(HttpError::Cancelled);
    }
    result
}

fn exchange(request: &Request, limits: Limits, deadline: Instant, cancel: &Cancel) -> Result<Response, HttpError> {
    let head = head(request)?;
    let connect_for = limits.connect.min(remaining(deadline)?);
    let mut stream = TcpStream::connect_timeout(&request.url.addr, connect_for).map_err(|error| {
        if matches!(error.kind(), io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock) {
            HttpError::Timeout
        } else {
            HttpError::Connect(error)
        }
    })?;
    cancel.register(&stream)?;
    // Checked on the connection that would carry the token: the proxy may have exited since
    // discovery, and another account may hold the port, or may have accepted this very connection
    // and handed the port back; only this connection's serving socket decides.
    if request.bearer.is_some() && !super::listener::peer_owned_by_this_user(&stream, deadline) {
        return Err(HttpError::UntrustedListener);
    }
    stream.set_write_timeout(Some(remaining(deadline)?)).map_err(HttpError::Io)?;
    stream.write_all(head.as_bytes()).map_err(io_error)?;
    let mut reader = Reader { stream, buf: Vec::new(), pos: 0, deadline };
    read_response(&mut reader, limits.max_body)
}

fn head(request: &Request) -> Result<String, HttpError> {
    let method = match request.method {
        Method::Get => "GET",
        Method::Post => "POST",
    };
    let mut head = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\nAccept: application/json\r\n",
        request.url.path, request.url.addr
    );
    if request.method == Method::Post {
        head.push_str("Content-Length: 0\r\n");
    }
    if let Some(token) = &request.bearer {
        // Tokens arrive as JSON, where `\r\n` can be escaped into a value; refuse rather than send.
        if token.expose().is_empty() || !token.expose().bytes().all(|b| b.is_ascii_graphic()) {
            return Err(HttpError::InvalidToken);
        }
        head.push_str(&format!("Authorization: Bearer {}\r\n", token.expose()));
    }
    head.push_str("\r\n");
    Ok(head)
}

fn remaining(deadline: Instant) -> Result<Duration, HttpError> {
    deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero()).ok_or(HttpError::Timeout)
}

fn io_error(error: io::Error) -> HttpError {
    match error.kind() {
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => HttpError::Timeout,
        _ => HttpError::Io(error),
    }
}

struct Reader {
    stream: TcpStream,
    buf: Vec<u8>,
    pos: usize,
    deadline: Instant,
}

impl Reader {
    /// Reads more bytes, with the socket timeout set to whatever is left of the total deadline, so
    /// a server dripping one byte at a time still hits the deadline. `false` at EOF.
    fn fill(&mut self) -> Result<bool, HttpError> {
        if self.pos > 0 {
            self.buf.drain(..self.pos);
            self.pos = 0;
        }
        let mut chunk = [0_u8; 8192];
        loop {
            self.stream.set_read_timeout(Some(remaining(self.deadline)?)).map_err(HttpError::Io)?;
            match self.stream.read(&mut chunk) {
                Ok(0) => return Ok(false),
                Ok(n) => {
                    self.buf.extend_from_slice(&chunk[..n]);
                    return Ok(true);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(io_error(error)),
            }
        }
    }

    fn line(&mut self, max: usize) -> Result<Vec<u8>, HttpError> {
        loop {
            if let Some(at) = self.buf[self.pos..].iter().position(|&b| b == b'\n') {
                let mut line = self.buf[self.pos..self.pos + at].to_vec();
                self.pos += at + 1;
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(line);
            }
            if self.buf.len() - self.pos > max {
                return Err(HttpError::TooLarge);
            }
            if !self.fill()? {
                return Err(HttpError::Malformed("connection closed mid-line"));
            }
        }
    }

    fn exact(&mut self, n: usize) -> Result<Vec<u8>, HttpError> {
        while self.buf.len() - self.pos < n {
            if !self.fill()? {
                return Err(HttpError::Malformed("connection closed mid-body"));
            }
        }
        let out = self.buf[self.pos..self.pos + n].to_vec();
        self.pos += n;
        Ok(out)
    }

    fn rest(&mut self, max: usize) -> Result<Vec<u8>, HttpError> {
        while self.fill()? {
            if self.buf.len() - self.pos > max {
                return Err(HttpError::TooLarge);
            }
        }
        if self.buf.len() - self.pos > max {
            return Err(HttpError::TooLarge);
        }
        Ok(self.buf[self.pos..].to_vec())
    }
}

fn read_response(reader: &mut Reader, max_body: usize) -> Result<Response, HttpError> {
    let (status, content_length, chunked) = loop {
        let head = read_head(reader)?;
        match head.0 {
            101 => return Err(HttpError::Malformed("unexpected protocol upgrade")),
            // Interim responses precede the final one on the same connection.
            100..=199 => continue,
            _ => break head,
        }
    };
    let body = if status == 204 || status == 304 {
        Vec::new()
    } else if chunked {
        read_chunked(reader, max_body)?
    } else if let Some(length) = content_length {
        if length > max_body {
            return Err(HttpError::TooLarge);
        }
        reader.exact(length)?
    } else {
        reader.rest(max_body)?
    };
    Ok(Response { status, body })
}

/// Status line and headers: `(status, content-length, chunked)`.
fn read_head(reader: &mut Reader) -> Result<(u16, Option<usize>, bool), HttpError> {
    let status_line = reader.line(MAX_HEADER_BYTES)?;
    let status = std::str::from_utf8(&status_line)
        .ok()
        .filter(|line| line.starts_with("HTTP/1."))
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or(HttpError::Malformed("status line"))?;
    let mut content_length = None;
    let mut chunked = false;
    let mut header_bytes = status_line.len();
    loop {
        let line = reader.line(MAX_HEADER_BYTES)?;
        header_bytes += line.len();
        if header_bytes > MAX_HEADER_BYTES {
            return Err(HttpError::TooLarge);
        }
        if line.is_empty() {
            break;
        }
        let text = String::from_utf8_lossy(&line);
        let Some((name, value)) = text.split_once(':') else {
            return Err(HttpError::Malformed("header line"));
        };
        let (name, value) = (name.trim(), value.trim());
        if name.eq_ignore_ascii_case("content-length") {
            content_length = Some(value.parse::<usize>().map_err(|_| HttpError::Malformed("content-length"))?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.split(',').any(|coding| coding.trim().eq_ignore_ascii_case("chunked"));
        }
    }
    Ok((status, content_length, chunked))
}

fn read_chunked(reader: &mut Reader, max_body: usize) -> Result<Vec<u8>, HttpError> {
    let mut body = Vec::new();
    loop {
        let line = reader.line(MAX_HEADER_BYTES)?;
        let size = String::from_utf8_lossy(&line);
        let size = size.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size, 16).map_err(|_| HttpError::Malformed("chunk size"))?;
        if size == 0 {
            while !reader.line(MAX_HEADER_BYTES)?.is_empty() {}
            return Ok(body);
        }
        if body.len().saturating_add(size) > max_body {
            return Err(HttpError::TooLarge);
        }
        body.extend(reader.exact(size)?);
        if !reader.line(MAX_HEADER_BYTES)?.is_empty() {
            return Err(HttpError::Malformed("chunk terminator"));
        }
    }
}

/// A request running on its own thread. Dropping it shuts the socket down, which is how closing the
/// panel cancels a fetch.
pub struct Pending {
    rx: oneshot::Receiver<Result<Response, HttpError>>,
    cancel: Cancel,
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

impl Future for Pending {
    type Output = Result<Response, HttpError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match Pin::new(&mut self.rx).poll(cx) {
            Poll::Ready(Ok(result)) => Poll::Ready(result),
            Poll::Ready(Err(oneshot::Canceled)) => Poll::Ready(Err(HttpError::Cancelled)),
            Poll::Pending => Poll::Pending,
        }
    }
}

/// Starts `request` on a new thread at once (no async runtime).
pub fn spawn(request: Request, limits: Limits) -> Pending {
    let cancel = Cancel::default();
    let (tx, rx) = oneshot::channel();
    let worker = cancel.clone();
    // A failed spawn drops `tx`, which the future reports as Cancelled.
    let _ = std::thread::Builder::new().name("aio-proxy-http".into()).spawn(move || {
        let _ = tx.send(send(&request, limits, &worker));
    });
    Pending { rx, cancel }
}

#[cfg(test)]
mod tests;
