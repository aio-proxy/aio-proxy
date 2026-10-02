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

/// `None` when the shell could not answer (a slow or broken rc file): the install offer stays hidden.
pub fn on_path() -> Option<bool> {
    // Interactive too, since version managers often extend PATH only in ~/.zshrc.
    let mut command = Command::new(login_shell());
    command.args(["-l", "-i", "-c", "command -v aiop"]);
    let output = run_with_timeout(command, PROBE_TIMEOUT).ok()?;
    Some(output.status.success())
}

/// Points `/usr/local/bin/aiop`, and `aio-proxy` when free, at `target`. `Ok(false)` when the user
/// cancelled the prompt.
pub fn install(target: &Path) -> Result<bool, String> {
    let mut command = Command::new("/usr/bin/osascript");
    command
        .args([
            "-e",
            "on run argv",
            "-e",
            "set target to quoted form of item 1 of argv",
            "-e",
            // `ln -s` without `-f` fails on any existing entry, which is the "when free" rule.
            "do shell script \"/bin/mkdir -p /usr/local/bin && /bin/ln -sf \" & target & \" \" & quoted form of item 2 of argv & \" && (/bin/ln -s \" & target & \" \" & quoted form of item 3 of argv & \" 2>/dev/null || true)\" with administrator privileges",
            "-e",
            "end run",
        ])
        .arg(target)
        .arg(LINK)
        .arg(LONG_LINK);
    let output = run_with_timeout(command, INSTALL_TIMEOUT).map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = tail(&output.stderr, 600);
    // -128 is userCanceledErr: the password prompt was dismissed.
    if stderr.contains("(-128)") { Ok(false) } else { Err(stderr) }
}
