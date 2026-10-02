//! Whether this user owns the serving end of a connection. Another local account can bind the
//! proxy's port while it is down and answer `/health`; the desktop token goes only over a
//! connection whose accepted socket belongs to this user. Fails closed on any read problem.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::thread;
use std::time::{Duration, Instant};

const LISTEN: &str = "0A";
const RETRY: Duration = Duration::from_millis(25);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcRow {
    pub local: SocketAddr,
    pub remote: SocketAddr,
    pub listening: bool,
    pub uid: u32,
}

/// `/proc/net/tcp` writes each 32-bit word of an address in host (little-endian) byte order.
fn address_bytes(hex: &str) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for word in hex.as_bytes().chunks(8) {
        let word = std::str::from_utf8(word).ok()?;
        let value = u32::from_str_radix(word, 16).ok()?;
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    Some(bytes)
}

fn endpoint(field: &str, v6: bool) -> Option<SocketAddr> {
    let (host, port) = field.split_once(':')?;
    if host.len() != if v6 { 32 } else { 8 } || port.len() != 4 {
        return None;
    }
    let bytes = address_bytes(host)?;
    let ip = if v6 {
        IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(bytes).ok()?))
    } else {
        IpAddr::V4(Ipv4Addr::from(<[u8; 4]>::try_from(bytes).ok()?))
    };
    Some(SocketAddr::new(ip, u16::from_str_radix(port, 16).ok()?))
}

/// The rows of `/proc/net/tcp` (or `tcp6` when `v6`). Rows that do not parse are dropped, never guessed.
pub fn parse_proc_net(text: &str, v6: bool) -> Vec<ProcRow> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let [index, local, remote, state, _, _, _, uid, ..] = fields[..] else { return None };
            if !index.strip_suffix(':').is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
                return None;
            }
            Some(ProcRow {
                local: endpoint(local, v6)?,
                remote: endpoint(remote, v6)?,
                listening: state.eq_ignore_ascii_case(LISTEN),
                uid: uid.parse().ok()?,
            })
        })
        .collect()
}

/// The uid owning the accepted socket `server` <- `client`. A listening row never matches a connection.
pub fn serving_uid(rows: &[ProcRow], server: SocketAddr, client: SocketAddr) -> Option<u32> {
    // Ignore flow info and scope id: only the address and port identify the connection.
    let same = |a: SocketAddr, b: SocketAddr| a.ip() == b.ip() && a.port() == b.port();
    rows.iter().find(|r| !r.listening && same(r.local, server) && same(r.remote, client)).map(|r| r.uid)
}

/// Whether this user's process holds the other end of `stream`. The server may not have accepted yet,
/// so the table is re-read every 25 ms until `deadline`; any failure counts as not ours.
pub fn peer_owned_by_this_user(stream: &TcpStream, deadline: Instant) -> bool {
    let (Ok(client), Ok(server)) = (stream.local_addr(), stream.peer_addr()) else { return false };
    let v6 = server.is_ipv6();
    let path = if v6 { "/proc/net/tcp6" } else { "/proc/net/tcp" };
    let uid = crate::platform::unix::current_uid();
    loop {
        if let Ok(text) = std::fs::read_to_string(path)
            && serving_uid(&parse_proc_net(&text, v6), server, client) == Some(uid)
        {
            return true;
        }
        if Instant::now() + RETRY >= deadline {
            return false;
        }
        thread::sleep(RETRY);
    }
}

#[cfg(test)]
mod tests;
