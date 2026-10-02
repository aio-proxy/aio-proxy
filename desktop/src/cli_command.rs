//! The `aiop` shell command: whether the user's shell finds one, and installing ours into
//! /usr/local/bin (on every PATH through /etc/paths) behind the system's admin prompt.

#[cfg(unix)]
use std::ffi::CStr;
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use crate::process::{run_with_timeout, tail};

pub const LINK: &str = "/usr/local/bin/aiop";
#[cfg(unix)]
/// Linked only when free: an npm or Homebrew `aio-proxy` already there is left alone.
const LONG_LINK: &str = "/usr/local/bin/aio-proxy";
#[cfg(unix)]
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(unix)]
/// Long enough for the user to type a password.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

#[cfg(unix)]
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

#[cfg(unix)]
/// Prefixes every line the probe prints, so rc-file chatter on stdout is ignored.
const MARK: &str = "aio-proxy-probe:";
#[cfg(unix)]
const LINK_DIR: &str = "/usr/local/bin";

/// What the user's shell resolves, as their terminal would.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Probe {
    pub aiop: bool,
    /// An `aio-proxy` already resolving elsewhere keeps its name: no alias is linked over it.
    pub aio_proxy: bool,
    /// Without it, a link in /usr/local/bin would not make `aiop` resolve.
    pub link_dir_on_path: bool,
}

/// `None` when the shell could not answer (a slow or broken rc file): the install offer stays hidden,
/// since installing replaces whatever `aiop` the shell would have found.
#[cfg(unix)]
pub fn probe() -> Option<Probe> {
    // Interactive too, since version managers often extend PATH only in ~/.zshrc. `&&` and `;` only,
    // so fish runs it as well. The PATH line always prints: it proves the lookups ran.
    let script = format!(
        "command -v aiop >/dev/null 2>&1 && echo {MARK}aiop; command -v aio-proxy >/dev/null 2>&1 && echo {MARK}aio-proxy; echo \"{MARK}path:$PATH\""
    );
    let mut command = Command::new(login_shell());
    command.args(["-l", "-i", "-c", &script]);
    let output = run_with_timeout(command, PROBE_TIMEOUT).ok()?;
    parse_probe(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(unix)]
fn parse_probe(stdout: &str) -> Option<Probe> {
    let marks: Vec<&str> = stdout.lines().filter_map(|line| line.trim().strip_prefix(MARK)).collect();
    let path = marks.iter().find_map(|mark| mark.strip_prefix("path:"))?;
    Some(Probe {
        aiop: marks.contains(&"aiop"),
        aio_proxy: marks.contains(&"aio-proxy"),
        // fish joins its PATH list with spaces inside quotes.
        link_dir_on_path: path.split([':', ' ']).any(|dir| dir.trim_end_matches('/') == LINK_DIR),
    })
}

#[cfg(unix)]
/// Run as root behind the prompt with `$1` target, `$2` aiop, `$3` aio-proxy or empty. An `aiop` is
/// replaced only when absent, dangling or already ours, since the probe ran earlier and only saw the
/// user's PATH; `aio-proxy` is linked only when free, so an npm or Homebrew copy is left alone.
const LINK_SCRIPT: &str = r#"set -e
/bin/mkdir -p "$(/usr/bin/dirname "$2")"
if [ -e "$2" ] && [ "$(/usr/bin/readlink "$2")" != "$1" ]; then
  echo "$2 already exists and is not this app's" >&2
  exit 1
fi
/bin/ln -sf "$1" "$2"
[ -z "$3" ] || [ -e "$3" ] || [ -L "$3" ] || /bin/ln -s "$1" "$3"
"#;

/// Points `/usr/local/bin/aiop`, and `aio-proxy` when `alias` and free, at `target`. `Ok(false)` when
/// the user cancelled the prompt.
#[cfg(unix)]
pub fn install(target: &Path, alias: bool) -> Result<bool, String> {
    link(target, Path::new(LINK), alias.then_some(Path::new(LONG_LINK)), true)
}

#[cfg(unix)]
fn link(target: &Path, aiop: &Path, alias: Option<&Path>, admin: bool) -> Result<bool, String> {
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
        .arg(alias.unwrap_or(Path::new("")));
    let output = run_with_timeout(command, INSTALL_TIMEOUT).map_err(|error| error.to_string())?;
    if output.status.success() {
        return Ok(true);
    }
    let stderr = tail(&output.stderr, 600);
    // -128 is userCanceledErr: the password prompt was dismissed.
    if stderr.contains("(-128)") { Ok(false) } else { Err(stderr) }
}

/// ponytail: the Windows `aiop` install is a later task; until then the offer stays hidden.
#[cfg(windows)]
pub fn probe() -> Option<Probe> {
    None
}

#[cfg(windows)]
pub fn install(_target: &Path, _alias: bool) -> Result<bool, String> {
    Err("not available on Windows".into())
}

#[cfg(all(test, unix))]
mod tests;
