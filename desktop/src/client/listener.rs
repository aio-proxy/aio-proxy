//! Whether this user owns the socket listening at an address. Another local account can bind the
//! proxy's port while it is down and answer `/health`; the desktop token goes only to a listener of
//! this user, checked on the connection that is about to carry it (the same rule as discovery's).

use std::net::SocketAddr;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub uid: u32,
    pub family: String,
    pub address: String,
}

/// The listening sockets in `lsof -F tun` output: each file's family and address, under its uid.
pub fn parse_listeners(output: &str) -> Vec<Listener> {
    let mut listeners = Vec::new();
    let (mut uid, mut family) = (None, String::new());
    for line in output.lines() {
        let (field, value) = line.split_at(line.len().min(1));
        match field {
            "u" => uid = value.parse().ok(),
            "f" => family.clear(),
            "t" => family = value.to_string(),
            "n" => {
                if let Some(uid) = uid {
                    listeners.push(Listener { uid, family: family.clone(), address: value.to_string() });
                }
            }
            _ => {}
        }
    }
    listeners
}

/// `uid` listens at `addr` itself or on its family's wildcard. The kernel keeps a second user off a
/// port within one family but not across IPv4 and IPv6, so a listener elsewhere proves nothing.
pub fn listens_at(listeners: &[Listener], uid: u32, addr: SocketAddr) -> bool {
    let family = if addr.is_ipv6() { "IPv6" } else { "IPv4" };
    let (exact, wildcard) = (addr.to_string(), format!("*:{}", addr.port()));
    listeners.iter().any(|l| l.uid == uid && l.family == family && (l.address == exact || l.address == wildcard))
}

/// Runs `lsof` (an unprivileged one does not even see other users' sockets) until `deadline`; any
/// failure counts as not ours.
pub fn owned_by_this_user(addr: SocketAddr, deadline: Instant) -> bool {
    let Ok(mut child) = Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{}", addr.port()), "-sTCP:LISTEN", "-Ftun"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
    let Ok(output) = child.wait_with_output() else { return false };
    // SAFETY: getuid cannot fail.
    let uid = unsafe { libc::getuid() };
    listens_at(&parse_listeners(&String::from_utf8_lossy(&output.stdout)), uid, addr)
}

#[cfg(test)]
mod tests;
