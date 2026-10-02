//! The four-tuple match behind Windows connection ownership. Pure, so it compiles and is tested on
//! every platform.

use std::net::SocketAddr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpRow {
    pub local: SocketAddr,
    pub remote: SocketAddr,
    pub pid: u32,
}

/// The process owning the accepted socket `server` <- `client`. The client's own row has the same
/// endpoints swapped and never matches.
pub fn serving_pid(rows: &[TcpRow], server: SocketAddr, client: SocketAddr) -> Option<u32> {
    // Ignore flow info and scope id: only the address and port identify the connection.
    let same = |a: SocketAddr, b: SocketAddr| a.ip() == b.ip() && a.port() == b.port();
    rows.iter().find(|r| same(r.local, server) && same(r.remote, client)).map(|r| r.pid)
}

#[cfg(test)]
mod tests;
