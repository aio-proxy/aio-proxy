//! launchd and process checks for the connect flow.

use std::process::Command;

/// The label `aio-proxy service install` gives the user's LaunchAgent.
const LAUNCHD_LABEL: &str = "com.aio-proxy.agent";

pub(super) fn current_uid() -> u32 {
    // SAFETY: getuid never fails.
    unsafe { libc::getuid() }
}

pub fn current_user() -> String {
    current_uid().to_string()
}

/// `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent`: restarts the external agent without
/// rewriting its plist.
pub fn kickstart(user: &str) -> Vec<Command> {
    let mut command = Command::new("/bin/launchctl");
    command.args(["kickstart", "-k", &format!("gui/{user}/{LAUNCHD_LABEL}")]);
    vec![command]
}

pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    // EPERM: it exists under another user.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
