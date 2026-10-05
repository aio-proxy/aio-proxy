//! The real `Host`: the bundled CLI (through the stable exec when it exists), the OS service manager,
//! and the local transport. Every CLI child gets `AIO_PROXY_DESKTOP_EXEC=<stable exec>`, the only input that makes a
//! plist desktop-owned.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::discovery::{Discovery, parse_discovery};
use super::policy::{Mutation, ReloadOutcome, parse_reload};
use super::run::Host;
use crate::client::health::{HEALTH_TIMEOUT, parse_health};
use crate::client::transport::{Cancel, Limits, LocalUrl, Method, Request, send};
use crate::install::{InstallState, Paths, ReadOnlyReason, sidecar_of};
use crate::process::{run_with_timeout, tail};

/// The CLI bounds `__desktop-connect` at 10 s; this only catches a wedged process.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// `service restart` may wait 10 s for bootout, and `kickstart -k` blocks about 7 s.
pub const SERVICE_TIMEOUT: Duration = Duration::from_secs(60);
/// A loopback connect to a live proxy completes in well under a millisecond.
const WAIT_PROBE_CONNECT_TIMEOUT: Duration = Duration::from_millis(400);

#[derive(Debug, Clone)]
pub struct SystemHost {
    /// The stable exec when it resolves, else this bundle's sidecar.
    pub exec: PathBuf,
    pub desktop_exec: PathBuf,
    /// The OS account, as `platform::kickstart` names it.
    pub user: String,
}

impl SystemHost {
    /// `install` is startup's install preparation: the stable exec is used only when it ran there (ours, or a newer
    /// one we must not downgrade), and is still a runnable file.
    pub fn new(paths: &Paths, bundle: Option<&Path>, install: Option<&InstallState>) -> Option<Self> {
        // A stable copy that cannot run (noexec mount, ACL, corrupt bytes, execute bit lost, a directory in its
        // place) would fail every spawn; the bundled sidecar still works.
        let proven = matches!(
            install,
            Some(InstallState::Persistent | InstallState::ReadOnly(ReadOnlyReason::NewerCopy { .. }))
        );
        let runnable = crate::install::copy::executable;
        let exec = if proven && runnable(&paths.stable) { paths.stable.clone() } else { sidecar_of(bundle?) };
        runnable(&exec).then(|| Self {
            exec,
            desktop_exec: paths.stable.clone(),
            user: crate::platform::current_user(),
        })
    }

    /// The child environment contract. The app never passes its own `AIO_PROXY_HOME` (discovery
    /// reads the plist's), and drops the markers that would make `service restart` think it runs
    /// inside the launchd job.
    pub fn cli(&self, args: &[&str], home: Option<&str>) -> Command {
        let mut command = Command::new(&self.exec);
        command
            .args(args)
            .env("AIO_PROXY_DESKTOP_EXEC", &self.desktop_exec)
            .env_remove("AIO_PROXY_HOME")
            .env_remove("AIO_PROXY_MANAGED")
            .env_remove("XPC_SERVICE_NAME");
        if let Some(home) = home {
            command.env("AIO_PROXY_HOME", home);
        }
        if let Some(appdir) = std::env::var_os("APPDIR").filter(|dir| cfg!(target_os = "linux") && !dir.is_empty()) {
            leave_appimage(&mut command, Path::new(&appdir));
        }
        command
    }
}

/// AppRun puts the AppImage's mount into these lists, and the CLI records PATH into the systemd unit,
/// where a mount that dies with the app would lead every lookup. Nothing the CLI or the service runs
/// reads the AppImage markers.
fn leave_appimage(command: &mut Command, appdir: &Path) {
    for name in ["PATH", "LD_LIBRARY_PATH", "XDG_DATA_DIRS"] {
        let Some(list) = std::env::var_os(name) else { continue };
        match without_dir(&list, appdir) {
            Some(list) => command.env(name, list),
            None => command.env_remove(name),
        };
    }
    for name in ["APPDIR", "APPIMAGE", "ARGV0", "OWD"] {
        command.env_remove(name);
    }
}

/// `list` (a PATH-style list) without the entries under `dir`; `None` when none are left.
fn without_dir(list: &OsStr, dir: &Path) -> Option<OsString> {
    let kept: Vec<PathBuf> = std::env::split_paths(list).filter(|entry| !entry.starts_with(dir)).collect();
    if kept.is_empty() { None } else { std::env::join_paths(kept).ok() }
}

fn check(command: Command, timeout: Duration, what: &str) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let output = run_with_timeout(command, timeout).map_err(|error| format!("{what}: {error}"));
    // A slow CLI call is the usual reason an action takes long (first run of a new copy, a stuck child holding the
    // pipe); the log is the only place a user's report can show which one it was.
    crate::log::info(format!("cli: {what} took {} ms", started.elapsed().as_millis()));
    let output = output?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(format!("{what} failed ({}): {}", output.status, tail(&output.stderr, 600)))
    }
}

/// `launchctl kickstart -k gui/501/…`: the program's file name and its arguments, for an error.
fn describe(command: &Command) -> String {
    let program = Path::new(command.get_program()).file_name().unwrap_or(command.get_program());
    std::iter::once(program).chain(command.get_args()).map(|part| part.to_string_lossy()).collect::<Vec<_>>().join(" ")
}

impl Host for SystemHost {
    fn discover(&self) -> Result<Discovery, String> {
        parse_discovery(&check(self.cli(&["__desktop-connect"], None), DISCOVERY_TIMEOUT, "__desktop-connect")?)
    }

    fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String> {
        match mutation {
            Mutation::Service(verb) => {
                check(self.cli(&["service", verb], home), SERVICE_TIMEOUT, &format!("service {verb}")).map(drop)
            }
            Mutation::Kickstart => {
                let commands = crate::platform::kickstart(&self.user, |args| self.cli(args, home));
                if commands.is_empty() {
                    return Err("kickstart is not supported on this platform yet".into());
                }
                commands.into_iter().try_for_each(|(command, allow_failure)| {
                    let what = describe(&command);
                    match check(command, SERVICE_TIMEOUT, &what) {
                        Err(_) if allow_failure => Ok(()),
                        result => result.map(drop),
                    }
                })
            }
        }
    }

    fn pid_alive(&self, pid: u32) -> bool {
        crate::platform::pid_alive(pid)
    }

    fn health_version(&self, control_url: &str) -> Option<String> {
        let url = LocalUrl::parse(control_url, "/health").ok()?;
        // Windows retries a SYN to a loopback port without a listener for about 2 s instead of refusing it; a short
        // connect bound keeps the wait's poll cadence while the proxy is still coming up.
        let limits = Limits { connect: WAIT_PROBE_CONNECT_TIMEOUT, total: HEALTH_TIMEOUT, ..Limits::default() };
        let response = match send(&Request { method: Method::Get, url, bearer: None }, limits, &Cancel::default()) {
            Ok(response) => response,
            Err(error) => {
                crate::log::info(format!("health probe: {error}"));
                return None;
            }
        };
        let version = parse_health(response.status, &response.body).and_then(|health| health.version);
        if version.is_none() {
            crate::log::info(format!("health probe: status {} without a version", response.status));
        }
        version
    }

    fn reload(&self, control_url: &str) -> ReloadOutcome {
        let url = match LocalUrl::parse(control_url, "/admin/reload") {
            Ok(url) => url,
            Err(error) => return ReloadOutcome::Failed(error.to_string()),
        };
        match send(&Request { method: Method::Post, url, bearer: None }, Limits::default(), &Cancel::default()) {
            Ok(response) => parse_reload(response.status, &response.body),
            Err(error) => ReloadOutcome::Failed(error.to_string()),
        }
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[cfg(test)]
mod tests;
