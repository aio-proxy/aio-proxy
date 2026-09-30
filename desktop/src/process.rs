//! Runs a helper process with a hard timeout. Output is returned, never logged: `__desktop-connect`
//! stdout carries the token.

use std::io;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::time::Duration;

pub fn run_with_timeout(mut command: Command, timeout: Duration) -> io::Result<Output> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command.spawn()?;
    let pid = child.id();
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new().name("aio-proxy-child".into()).spawn(move || {
        let _ = tx.send(child.wait_with_output());
    })?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            // SAFETY: plain kill(2) on the pid we spawned; the waiter thread still reaps it. Not waiting
            // here: a grandchild holding the pipes open would block us past the timeout.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
            Err(io::Error::new(io::ErrorKind::TimedOut, format!("timed out after {timeout:?}")))
        }
    }
}

/// The last `max` bytes of a stream, for error messages built from stderr.
pub fn tail(bytes: &[u8], max: usize) -> String {
    let start = bytes.len().saturating_sub(max);
    String::from_utf8_lossy(&bytes[start..]).trim().to_string()
}

#[cfg(test)]
mod tests;
