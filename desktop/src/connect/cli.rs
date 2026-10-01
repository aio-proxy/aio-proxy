//! The real `Host`: the bundled CLI (through the symlink when it exists), launchctl, and the local
//! transport. Every CLI child gets `AIO_PROXY_DESKTOP_EXEC=<symlink>`, the only input that makes a
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

pub const LAUNCHD_LABEL: &str = "com.aio-proxy.agent";
/// The CLI bounds `__desktop-connect` at 10 s; this only catches a wedged process.
pub const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(15);
/// `service restart` may wait 10 s for bootout, and `kickstart -k` blocks about 7 s.
pub const SERVICE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct SystemHost {
    /// The symlink when it resolves, else this bundle's sidecar.
    pub exec: PathBuf,
    pub desktop_exec: PathBuf,
    pub uid: u32,
}

impl SystemHost {
    pub fn new(paths: &Paths, bundle: Option<&Path>) -> Option<Self> {
        let exec = if paths.symlink.exists() { paths.symlink.clone() } else { sidecar_of(bundle?) };
        exec.exists().then(|| Self {
            exec,
            desktop_exec: paths.symlink.clone(),
            // SAFETY: getuid never fails.
            uid: unsafe { libc::getuid() },
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
                let mut command = Command::new("/bin/launchctl");
                command.args(["kickstart", "-k", &format!("gui/{}/{LAUNCHD_LABEL}", self.uid)]);
                check(command, SERVICE_TIMEOUT, "launchctl kickstart -k").map(drop)
            }
        }
    }

    fn pid_alive(&self, pid: u32) -> bool {
        // SAFETY: signal 0 only checks existence.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return true;
        }
        // EPERM: it exists under another user.
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
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
