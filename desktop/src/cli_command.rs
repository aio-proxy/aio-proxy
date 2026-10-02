//! The `aiop` shell command: whether the user's shell finds one, and installing ours into
//! /usr/local/bin (on every PATH through /etc/paths) behind the system's admin prompt.

use std::ffi::CStr;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::process::{run_with_timeout, tail};

pub const LINK: &str = "/usr/local/bin/aiop";
/// Linked only when free: an npm or Homebrew `aio-proxy` already there is left alone.
const LONG_LINK: &str = "/usr/local/bin/aio-proxy";
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// Long enough for the user to type a password.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// The user's login shell from the account database: an app launched from Finder has launchd's PATH,
/// not the one the user's terminal builds.
fn login_shell() -> String {
    // SAFETY: getpwuid returns a pointer into static storage or null; we copy out at once.
    let shell = unsafe {
        let entry = libc::getpwuid(libc::getuid());
        (!entry.is_null() && !(*entry).pw_shell.is_null())
            .then(|| CStr::from_ptr((*entry).pw_shell).to_string_lossy().into_owned())
    };
    shell.filter(|shell| !shell.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}

/// Printed by the probe itself, so a shell that failed before the lookup ran is told apart from
/// one that ran it and found nothing.
const FOUND: &str = "aio-proxy-probe:found";
const MISSING: &str = "aio-proxy-probe:missing";

/// `None` when the shell could not answer (a slow or broken rc file): the install offer stays hidden,
/// since installing replaces whatever `aiop` the shell would have found.
pub fn on_path() -> Option<bool> {
    // Interactive too, since version managers often extend PATH only in ~/.zshrc. `&&`/`||` rather
    // than `if`, so fish runs it as well.
    let mut command = Command::new(login_shell());
    command.args(["-l", "-i", "-c", &format!("command -v aiop >/dev/null 2>&1 && echo {FOUND} || echo {MISSING}")]);
    let output = run_with_timeout(command, PROBE_TIMEOUT).ok()?;
    probe_answer(&String::from_utf8_lossy(&output.stdout))
}

/// rc files may print to stdout too; only a whole marker line counts.
fn probe_answer(stdout: &str) -> Option<bool> {
    stdout.lines().rev().find_map(|line| match line.trim() {
        FOUND => Some(true),
        MISSING => Some(false),
        _ => None,
    })
}

/// Points `/usr/local/bin/aiop`, and `aio-proxy` when free, at `target`. `Ok(false)` when the user
/// cancelled the prompt.
pub fn install(target: &Path) -> Result<bool, String> {
    link(target, Path::new(LINK), Path::new(LONG_LINK), true)
}

fn link(target: &Path, aiop: &Path, long: &Path, admin: bool) -> Result<bool, String> {
    let privileges = if admin { " with administrator privileges" } else { "" };
    // Paths reach the shell only through `quoted form of`. `ln -s` without `-f` fails on any existing
    // entry, which is the "when free" rule for `aio-proxy`.
    let script = format!(
        "do shell script \"/bin/mkdir -p \" & quoted form of item 4 of argv & \" && /bin/ln -sf \" & target & \" \" & quoted form of item 2 of argv & \" && (/bin/ln -s \" & target & \" \" & quoted form of item 3 of argv & \" 2>/dev/null || true)\"{privileges}"
    );
    let mut command = Command::new("/usr/bin/osascript");
    command
        .args([
            "-e",
            "on run argv",
            "-e",
            "set target to quoted form of item 1 of argv",
            "-e",
            &script,
            "-e",
            "end run",
        ])
        .arg(target)
        .arg(aiop)
        .arg(long)
        .arg(aiop.parent().unwrap_or(Path::new("/")));
    let output = run_with_timeout(command, INSTALL_TIMEOUT).map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = tail(&output.stderr, 600);
    // -128 is userCanceledErr: the password prompt was dismissed.
    if stderr.contains("(-128)") { Ok(false) } else { Err(stderr) }
}

#[cfg(test)]
mod tests;
