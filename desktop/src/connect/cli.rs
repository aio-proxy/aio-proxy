//! The real `Host`: the bundled CLI (through the stable exec when it exists), the OS service manager,
//! and the local transport. Every CLI child gets `AIO_PROXY_DESKTOP_EXEC=<stable exec>`, the only input that makes a
//! plist desktop-owned.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use super::discovery::{Discovery, parse_discovery};
use super::policy::{Mutation, ReloadOutcome, parse_reload};
use super::run::Host;
use crate::client::health::{HEALTH_TIMEOUT, parse_health};
use crate::client::transport::{Cancel, Limits, LocalUrl, Method, Request, send};
use crate::install::{Paths, sidecar_of};
use crate::process::{run_with_timeout, tail};

/// The CLI bounds `__desktop-connect` at 10 s; this only catches a wedged process.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// `service restart` may wait 10 s for bootout, and `kickstart -k` blocks about 7 s.
pub const SERVICE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct SystemHost {
    /// The stable exec when it resolves, else this bundle's sidecar.
    pub exec: PathBuf,
    pub desktop_exec: PathBuf,
    /// The OS account, as `platform::kickstart` names it.
    pub user: String,
}

impl SystemHost {
    pub fn new(paths: &Paths, bundle: Option<&Path>) -> Option<Self> {
        let exec = if paths.stable.exists() { paths.stable.clone() } else { sidecar_of(bundle?) };
        exec.exists().then(|| Self { exec, desktop_exec: paths.stable.clone(), user: crate::platform::current_user() })
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
        command
    }
}

fn check(command: Command, timeout: Duration, what: &str) -> Result<Vec<u8>, String> {
    let output = run_with_timeout(command, timeout).map_err(|error| format!("{what}: {error}"))?;
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
        let limits = Limits { total: HEALTH_TIMEOUT, ..Limits::default() };
        let response = send(&Request { method: Method::Get, url, bearer: None }, limits, &Cancel::default()).ok()?;
        parse_health(response.status, &response.body)?.version
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
