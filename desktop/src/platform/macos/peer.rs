//! Whether this user owns the other end of a connection. Another local account can bind the proxy's
//! port while it is down and answer `/health`; the desktop token goes only over a connection whose
//! serving socket belongs to this user.

use std::net::{SocketAddr, TcpStream};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Listener {
    uid: u32,
    family: String,
    address: String,
}

/// The sockets in `lsof -F tun` output: each file's family and name, under its process's uid.
fn parse_listeners(output: &str) -> Vec<Listener> {
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

/// The serving side of a connection from `local` to `peer`, as `lsof` names it (`peer->local`),
/// owned by `uid`. An unprivileged `lsof` lists only this user's sockets, so another account's
/// accepted socket never matches.
fn serves(sockets: &[Listener], uid: u32, peer: SocketAddr, local: SocketAddr) -> bool {
    let name = format!("{peer}->{local}");
    sockets.iter().any(|s| s.uid == uid && s.address == name)
}

/// Whether this user's process holds the other end of `stream`: the socket that is about to carry
/// the token, not merely whatever listens on the port now (a listener can change hands after the
/// connection was accepted). The server may not have accepted yet, so `lsof` is retried until
/// `deadline`; any failure counts as not ours.
pub fn peer_owned_by_this_user(stream: &TcpStream, deadline: Instant) -> bool {
    let (Ok(local), Ok(peer)) = (stream.local_addr(), stream.peer_addr()) else { return false };
    let uid = super::host::current_uid();
    loop {
        if let Some(output) = lsof(local.port(), deadline)
            && serves(&parse_listeners(&output), uid, peer, local)
        {
            return true;
        }
        if Instant::now() + RETRY >= deadline {
            return false;
        }
        thread::sleep(RETRY);
    }
}

const RETRY: Duration = Duration::from_millis(25);

/// `lsof`'s field output for the TCP sockets on `port` (either end), or `None` past `deadline`.
fn lsof(port: u16, deadline: Instant) -> Option<String> {
    let mut child = Command::new("/usr/sbin/lsof")
        .args(["-nP", &format!("-iTCP:{port}"), "-Ftun"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(5)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let output = child.wait_with_output().ok()?;
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests;
