//! The spec's automatic-action and user-action tables, and each action's completion condition.
//! Pure: callers pass a discovery and get a decision.

use std::cmp::Ordering;

use serde::Deserialize;

use super::discovery::{Discovery, Owner};
use crate::version;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoAction {
    /// No plist: `service install` + `service start`; the app now owns the service.
    InstallAndStart,
    /// Desktop, not loaded, enabled.
    StartNotLoaded,
    /// Desktop, loaded, enabled, no process: the recovery path.
    StartNoProcess,
    /// Desktop, running an older version than the symlink's.
    RestartForVersion,
}

/// Each automatic action runs at most once per app launch; a failure shows an error and never
/// loops (a broken config's exit 1 is remapped to 0 and looks identical to a clean stop).
#[derive(Debug, Default, Clone)]
pub struct AutoAttempts(Vec<AutoAction>);

impl AutoAttempts {
    pub fn used(&self, action: AutoAction) -> bool {
        self.0.contains(&action)
    }

    pub fn mark(&mut self, action: AutoAction) {
        if !self.used(action) {
            self.0.push(action);
        }
    }
}

/// `persistent` is the install-location check (and no newer copy owning the symlink).
pub fn automatic_action(d: &Discovery, persistent: bool, attempts: &AutoAttempts) -> Option<AutoAction> {
    if !persistent {
        return None;
    }
    let action = match d.unit.owner {
        // A hand-started `aio-proxy run` answering the port is not ours to replace.
        Owner::NoPlist if !d.instance.reachable => AutoAction::InstallAndStart,
        Owner::Desktop => {
            let ours = d.instance.matches_job == Some(true) || !d.instance.reachable;
            if !ours || d.job.disabled {
                return None;
            }
            if !d.job.loaded {
                AutoAction::StartNotLoaded
            } else if d.job.pid.is_none() {
                AutoAction::StartNoProcess
            } else {
                let running = d.instance.version.as_deref().filter(|_| d.instance.reachable)?;
                // Never downgrade: only strictly older instances restart; unknown versions do not.
                if version::compare(running, &d.bundled_version) != Some(Ordering::Less) {
                    return None;
                }
                AutoAction::RestartForVersion
            }
        }
        Owner::NoPlist | Owner::External | Owner::Unknown => return None,
    };
    (!attempts.used(action)).then_some(action)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UserAction {
    Start,
    Restart,
    Stop,
    Reload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Offered {
    pub start: bool,
    pub restart: bool,
    pub stop: bool,
    pub reload: bool,
}

/// Which buttons the panel shows. Service actions need a persistent install and a desktop or
/// external owner; Reload only needs a reachable instance.
pub fn offered_actions(d: &Discovery, persistent: bool) -> Offered {
    let service = persistent && matches!(d.unit.owner, Owner::Desktop | Owner::External);
    let running = d.job.loaded && d.job.pid.is_some();
    Offered {
        start: service && !running,
        restart: service && running,
        stop: service && running,
        reload: d.instance.reachable && d.instance.control_url.is_some(),
    }
}

/// One step the CLI (or launchctl) performs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mutation {
    /// `aio-proxy service <verb>`, always with `AIO_PROXY_DESKTOP_EXEC` set.
    Service(&'static str),
    /// `launchctl kickstart -k gui/<uid>/com.aio-proxy.agent`: restarts an external service without
    /// rewriting its plist (`service restart` would rewrite it to the invoking binary).
    Kickstart,
}

pub fn auto_mutations(action: AutoAction) -> &'static [Mutation] {
    match action {
        AutoAction::InstallAndStart => &[Mutation::Service("install"), Mutation::Service("start")],
        AutoAction::StartNotLoaded | AutoAction::StartNoProcess => &[Mutation::Service("start")],
        AutoAction::RestartForVersion => &[Mutation::Service("restart")],
    }
}

/// The ownership table. `None` means not offered; Reload is HTTP and has no mutation.
pub fn user_mutations(action: UserAction, owner: Owner) -> Option<&'static [Mutation]> {
    match (action, owner) {
        (UserAction::Start, Owner::Desktop | Owner::External) => Some(&[Mutation::Service("start")]),
        (UserAction::Restart, Owner::Desktop) => Some(&[Mutation::Service("restart")]),
        (UserAction::Restart, Owner::External) => Some(&[Mutation::Kickstart]),
        (UserAction::Stop, Owner::Desktop | Owner::External) => Some(&[Mutation::Service("stop")]),
        _ => None,
    }
}

/// A mutation proceeds only if a fresh discovery agrees with the one it was decided on.
pub fn unchanged(before: &Discovery, now: &Discovery) -> bool {
    before.unit.owner == now.unit.owner
        && before.instance.matches_job == now.instance.matches_job
        && before.job.disabled == now.job.disabled
}

/// Restart is done once the pre-restart sidecar is gone and `/health` answers with the expected
/// version (`None` for an external service, whose binary version the app does not know). This guards
/// the case where the old sidecar outlives SIGTERM and keeps serving the old binary.
pub fn restart_complete(old_pid_alive: bool, health_version: Option<&str>, expected: Option<&str>) -> bool {
    if old_pid_alive {
        return false;
    }
    match (health_version, expected) {
        (Some(found), Some(expected)) => version::compare(found, expected) == Some(Ordering::Equal),
        (Some(_), None) => true,
        (None, _) => false,
    }
}

/// Stop is done once launchd reports no process and nothing answers.
pub fn stop_complete(d: &Discovery) -> bool {
    d.job.pid.is_none() && !d.instance.reachable
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReloadOutcome {
    Reloaded,
    /// 409 carries `error` and `stage`.
    Rejected {
        error: String,
        stage: Option<String>,
    },
    Failed(String),
}

pub fn parse_reload(status: u16, body: &[u8]) -> ReloadOutcome {
    #[derive(Deserialize)]
    struct Body {
        error: Option<String>,
        stage: Option<String>,
    }
    match status {
        200..=299 => ReloadOutcome::Reloaded,
        409 => match serde_json::from_slice::<Body>(body) {
            Ok(body) => ReloadOutcome::Rejected {
                error: body.error.unwrap_or_else(|| "config rejected".into()),
                stage: body.stage,
            },
            Err(_) => ReloadOutcome::Rejected { error: "config rejected".into(), stage: None },
        },
        other => ReloadOutcome::Failed(format!("reload answered HTTP {other}")),
    }
}

#[cfg(test)]
mod tests;
