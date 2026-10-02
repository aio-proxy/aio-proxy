use std::process::Command;
use std::time::{Duration, Instant};

use super::*;

#[cfg(unix)]
fn sh(script: &str) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]);
    command
}

#[cfg(unix)]
#[test]
fn a_command_past_its_timeout_is_killed() {
    let started = Instant::now();
    let error = run_with_timeout(sh("sleep 30"), Duration::from_millis(200)).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[cfg(unix)]
#[test]
fn captures_stdout_stderr_and_status() {
    let output = run_with_timeout(sh("printf out; printf err >&2; exit 3"), Duration::from_secs(5)).unwrap();
    assert_eq!(output.stdout, b"out");
    assert_eq!(tail(&output.stderr, 10), "err");
    assert_eq!(output.status.code(), Some(3));
}

#[test]
fn tail_keeps_the_end() {
    assert_eq!(tail(b"0123456789", 3), "789");
}

#[cfg(windows)]
#[test]
fn a_command_past_its_timeout_is_killed_on_windows() {
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-Command", "Start-Sleep 5"]);
    let started = Instant::now();
    let error = run_with_timeout(command, Duration::from_millis(500)).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
    assert!(started.elapsed() < Duration::from_secs(4));
}
