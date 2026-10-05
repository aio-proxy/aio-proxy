//! Runs a decided action end to end: fresh discovery, precondition, mutation, completion wait.
//! Blocking; the app calls it on a background thread. `Host` is the seam the tests fake.

use std::fmt;
use std::time::{Duration, Instant};

use super::discovery::{Discovery, Owner};
use super::policy::{
    AutoAction, AutoAttempts, Mutation, ReloadOutcome, UserAction, auto_mutations, automatic_action, offered_actions,
    restart_complete, stop_complete, unchanged, user_mutations,
};

pub const RESTART_WAIT: Duration = Duration::from_secs(30);
/// `service start` returns before the sidecar listens; a start that never answers is a failure.
pub const START_WAIT: Duration = Duration::from_secs(30);
pub const STOP_WAIT: Duration = Duration::from_secs(30);
pub const POLL_EVERY: Duration = Duration::from_millis(500);

pub trait Host {
    fn discover(&self) -> Result<Discovery, String>;
    /// `home` is the plist's `AIO_PROXY_HOME`, so a rewrite keeps the service's own config.
    fn mutate(&self, mutation: Mutation, home: Option<&str>) -> Result<(), String>;
    fn pid_alive(&self, pid: u32) -> bool;
    /// `/health`'s version, or `None` when nothing healthy answers.
    fn health_version(&self, control_url: &str) -> Option<String>;
    fn reload(&self, control_url: &str) -> ReloadOutcome;
    fn sleep(&self, duration: Duration);
    fn now(&self) -> Instant;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// Ownership, `matchesJob` or `job.disabled` changed since the decision; nothing was done.
    Changed,
    NotOffered,
    Discovery(String),
    Command(String),
    TimedOut(&'static str),
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RunError::Changed => f.write_str("the service changed since the panel was shown; nothing was done"),
            RunError::NotOffered => f.write_str("this action is not available for this service"),
            RunError::Discovery(error) => write!(f, "could not inspect the service: {error}"),
            RunError::Command(error) => f.write_str(error),
            RunError::TimedOut(what) => write!(f, "{what} did not finish in time"),
        }
    }
}

enum Wait {
    Nothing,
    Start { control_url: Option<String> },
    Restart { old_pid: Option<u32>, expected: Option<String>, control_url: Option<String> },
    Stop,
}

/// `attempts` is the launch-wide slot: it is spent before the first mutation runs, so a failure is
/// never retried this launch. The caller already decided the install location is persistent.
pub fn run_auto(
    host: &impl Host,
    decided_on: &Discovery,
    action: AutoAction,
    attempts: &mut AutoAttempts,
) -> Result<Discovery, RunError> {
    if attempts.used(action) {
        return Err(RunError::NotOffered);
    }
    let now = fresh(host, decided_on)?;
    // The three-field check misses e.g. a hand-started instance appearing before a fresh install.
    if automatic_action(&now, true, attempts) != Some(action) {
        return Err(RunError::Changed);
    }
    attempts.mark(action);
    let wait = match action {
        AutoAction::RestartForVersion => restart_wait(&now, Some(now.bundled_version.clone())),
        AutoAction::InstallAndStart | AutoAction::StartNotLoaded | AutoAction::StartNoProcess => start_wait(&now),
    };
    execute(host, &now, auto_mutations(action), wait)
}

pub fn run_user(host: &impl Host, rendered: &Discovery, action: UserAction) -> Result<Discovery, RunError> {
    let mutations = user_mutations(action, rendered.unit.owner).ok_or(RunError::NotOffered)?;
    let now = fresh(host, rendered)?;
    if action == UserAction::InstallAndStart && !offered_actions(&now, true).install {
        return Err(RunError::Changed);
    }
    let wait = match action {
        UserAction::Restart => {
            let expected = (now.unit.owner == Owner::Desktop).then(|| now.bundled_version.clone());
            restart_wait(&now, expected)
        }
        UserAction::TakeOver => restart_wait(&now, Some(now.bundled_version.clone())),
        UserAction::Stop => Wait::Stop,
        UserAction::InstallAndStart | UserAction::Start => start_wait(&now),
        UserAction::Reload => Wait::Nothing,
    };
    execute(host, &now, mutations, wait)
}

/// Reload is plain HTTP to the instance and carries no ownership precondition.
pub fn run_reload(host: &impl Host, rendered: &Discovery) -> Result<ReloadOutcome, RunError> {
    let url = rendered.instance.control_url.as_deref().ok_or(RunError::NotOffered)?;
    Ok(host.reload(url))
}

fn fresh(host: &impl Host, decided_on: &Discovery) -> Result<Discovery, RunError> {
    let now = host.discover().map_err(RunError::Discovery)?;
    if unchanged(decided_on, &now) { Ok(now) } else { Err(RunError::Changed) }
}

fn start_wait(now: &Discovery) -> Wait {
    Wait::Start { control_url: now.instance.control_url.clone() }
}

fn restart_wait(now: &Discovery, expected: Option<String>) -> Wait {
    Wait::Restart { old_pid: now.instance.pid, expected, control_url: now.instance.control_url.clone() }
}

fn execute(host: &impl Host, now: &Discovery, mutations: &[Mutation], wait: Wait) -> Result<Discovery, RunError> {
    for &mutation in mutations {
        host.mutate(mutation, now.unit.home.as_deref()).map_err(RunError::Command)?;
    }
    match wait {
        Wait::Nothing => {}
        // No control address means nothing can be probed, as for Restart.
        Wait::Start { control_url } => poll(host, START_WAIT, "start", || {
            control_url.as_deref().is_none_or(|url| host.health_version(url).is_some())
        })?,
        Wait::Restart { old_pid, expected, control_url } => {
            poll(host, RESTART_WAIT, "restart", || {
                let alive = old_pid.is_some_and(|pid| host.pid_alive(pid));
                let health = match (&control_url, alive) {
                    (Some(url), false) => host.health_version(url),
                    _ => None,
                };
                restart_complete(alive, health.as_deref(), expected.as_deref()) || (control_url.is_none() && !alive)
            })?;
        }
        Wait::Stop => {
            // A transient discovery failure mid-wait means "not done yet", not an abort.
            poll(host, STOP_WAIT, "stop", || host.discover().is_ok_and(|d| stop_complete(&d)))?;
        }
    }
    host.discover().map_err(RunError::Discovery)
}

fn poll(
    host: &impl Host,
    budget: Duration,
    what: &'static str,
    mut done: impl FnMut() -> bool,
) -> Result<(), RunError> {
    let started = host.now();
    let deadline = started + budget;
    let mut probes = 0u32;
    loop {
        probes += 1;
        if done() {
            crate::log::info(format!(
                "{what} wait: done after {probes} probes, {} ms",
                (host.now() - started).as_millis()
            ));
            return Ok(());
        }
        if host.now() >= deadline {
            crate::log::info(format!("{what} wait: timed out after {probes} probes"));
            return Err(RunError::TimedOut(what));
        }
        host.sleep(POLL_EVERY);
    }
}

#[cfg(test)]
mod tests;
