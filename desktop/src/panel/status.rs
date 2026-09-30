//! The panel header's words: what state the proxy is in and what the app may do about it.

use crate::app::{ActionState, AppModel};
use crate::client::health::HealthState;
use crate::connect::discovery::Owner;
use crate::install::{InstallState, ReadOnlyReason};

pub fn headline(model: &AppModel) -> String {
    let Some(d) = &model.discovery else {
        return match &model.discovery_error {
            Some(_) => "Cannot inspect aio-proxy".into(),
            None => "Connecting…".into(),
        };
    };
    let version = d.instance.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default();
    match (model.health.state(), d.instance.reachable) {
        (HealthState::Down, _) | (_, false) if d.job.pid.is_none() => "Stopped".into(),
        (HealthState::Down, _) | (_, false) => "Not responding".into(),
        _ => format!("Running{version}"),
    }
}

pub fn endpoint(model: &AppModel) -> Option<String> {
    model.discovery.as_ref()?.instance.control_url.clone()
}

/// The one line of context under the headline, most important first.
pub fn notice(model: &AppModel) -> Option<String> {
    if let ActionState::Failed(error) = &model.action {
        return Some(error.clone());
    }
    match &model.install {
        Some(InstallState::ReadOnly(ReadOnlyReason::Location)) => {
            return Some("Move AIO Proxy to Applications to let it manage the proxy.".into());
        }
        Some(InstallState::ReadOnly(ReadOnlyReason::NewerCopy { app, version })) => {
            return Some(format!(
                "A newer copy ({version}) is installed at {}. This copy is read-only.",
                app.display()
            ));
        }
        Some(InstallState::ReadOnly(ReadOnlyReason::UnreadableCopy { app })) => {
            return Some(format!("Cannot read the version of {}. This copy is read-only.", app.display()));
        }
        Some(InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(error))) => {
            return Some(format!("Cannot update the service link: {error}"));
        }
        _ => {}
    }
    if let Some(error) = &model.discovery_error {
        return Some(error.clone());
    }
    let d = model.discovery.as_ref()?;
    match d.unit.owner {
        Owner::External => Some("Managed by the aio-proxy CLI. Changes happen only when you click.".into()),
        Owner::Unknown => Some("The installed service is not recognised; the app will not change it.".into()),
        Owner::Desktop if d.job.disabled => Some("Stopped by you. Click Start to run it again.".into()),
        _ => match &model.action {
            ActionState::Done(note) => Some(note.clone()),
            ActionState::Running(action) => Some(format!("{}…", action.label())),
            ActionState::Automatic(action) => Some(format!("{}…", action.label())),
            _ => model.summary_error.clone(),
        },
    }
}

#[cfg(test)]
mod tests;
