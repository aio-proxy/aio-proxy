//! launchd and process checks for the connect flow.

use std::process::Command;

/// The label `aio-proxy service install` gives the user's LaunchAgent.
const LAUNCHD_LABEL: &str = "com.aio-proxy.agent";

/// `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent`: restarts the external agent without
/// rewriting its plist.
pub fn kickstart(user: &str) -> Vec<Command> {
    let mut command = Command::new("/bin/launchctl");
    command.args(["kickstart", "-k", &format!("gui/{user}/{LAUNCHD_LABEL}")]);
    vec![command]
}
