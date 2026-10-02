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

/// Run as root behind the prompt with `$1` target, `$2` aiop, `$3` aio-proxy. An `aiop` is replaced
/// only when absent, dangling or already ours, since the probe ran earlier and only saw the user's
/// PATH; `aio-proxy` is linked only when free, so an npm or Homebrew copy is left alone.
const LINK_SCRIPT: &str = r#"set -e
/bin/mkdir -p "$(/usr/bin/dirname "$2")"
if [ -e "$2" ] && [ "$(/usr/bin/readlink "$2")" != "$1" ]; then
  echo "$2 already exists and is not this app's" >&2
  exit 1
fi
/bin/ln -sf "$1" "$2"
[ -e "$3" ] || [ -L "$3" ] || /bin/ln -s "$1" "$3"
"#;

/// Points `/usr/local/bin/aiop`, and `aio-proxy` when free, at `target`. `Ok(false)` when the user
/// cancelled the prompt.
pub fn install(target: &Path) -> Result<bool, String> {
    link(target, Path::new(LINK), Path::new(LONG_LINK), true)
}

fn link(target: &Path, aiop: &Path, long: &Path, admin: bool) -> Result<bool, String> {
    let privileges = if admin { " with administrator privileges" } else { "" };
    // Script and paths reach the shell only through `quoted form of`.
    let run = format!("do shell script cmd{privileges}");
    let mut command = Command::new("/usr/bin/osascript");
    command
        .args([
            "-e",
            "on run argv",
            "-e",
            "set cmd to \"/bin/sh -c \" & quoted form of item 1 of argv & \" sh\"",
            "-e",
            "repeat with arg in rest of argv",
            "-e",
            "set cmd to cmd & \" \" & quoted form of (arg as text)",
            "-e",
            "end repeat",
            "-e",
            &run,
            "-e",
            "end run",
            LINK_SCRIPT,
        ])
        .arg(target)
        .arg(aiop)
        .arg(long);
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
