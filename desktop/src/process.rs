//! Runs a helper process with a hard timeout. Output is returned, never logged: `__desktop-connect`
//! stdout carries the token.

use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;

pub fn run_with_timeout(mut command: Command, timeout: Duration) -> io::Result<Output> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: no console flash from a GUI app.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn()?;
    // Own threads drain the pipes so a grandchild holding them open cannot block the timeout path.
    let drain = |stream: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut stream) = stream {
                let _ = stream.read_to_end(&mut buffer);
            }
            buffer
        })
    };
    let stdout = drain(child.stdout.take().map(|s| Box::new(s) as _));
    let stderr = drain(child.stderr.take().map(|s| Box::new(s) as _));
    let child = Arc::new(Mutex::new(Some(child)));
    let (tx, rx) = mpsc::channel();
    let waiter = Arc::clone(&child);
    std::thread::Builder::new().name("aio-proxy-child".into()).spawn(move || {
        // Polled, not blocked in wait(), so the timeout path can take the lock to kill.
        let status = loop {
            let mut guard = waiter.lock().unwrap();
            let Some(child) = guard.as_mut() else { return };
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => {}
                Err(error) => break Err(error),
            }
            drop(guard);
            std::thread::sleep(Duration::from_millis(10));
        };
        let _ = tx.send(status.map(|status| Output {
            status,
            stdout: stdout.join().unwrap_or_default(),
            stderr: stderr.join().unwrap_or_default(),
        }));
    })?;
    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(_) => {
            // Not waiting for the pipes: a grandchild may hold them open past the kill.
            if let Some(mut child) = child.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
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
