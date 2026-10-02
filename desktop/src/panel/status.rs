//! The panel header's words: what state the proxy is in and what the app may do about it.

use gpui_kit::{App, Hsla};

use crate::app::{ActionState, AppModel, SummaryState};
use crate::client::health::HealthState;
use crate::connect::discovery::Owner;
use crate::install::{InstallState, ReadOnlyReason};

enum Run {
    Stopped,
    NotResponding,
    Running,
}

fn run(model: &AppModel) -> Option<Run> {
    let d = model.discovery.as_ref()?;
    Some(match (model.health.state(), d.instance.reachable) {
        // A live /health answer wins over a discovery that may be stale (its rediscovery can fail).
        (HealthState::Up, _) => Run::Running,
        (HealthState::Down, _) | (_, false) if d.job.pid.is_none() => Run::Stopped,
        (HealthState::Down, _) | (_, false) => Run::NotResponding,
        _ => Run::Running,
    })
}

pub fn headline(model: &AppModel) -> String {
    let Some(d) = &model.discovery else {
        return match &model.discovery_error {
            Some(_) => "Cannot inspect aio-proxy".into(),
            None => "Connecting…".into(),
        };
    };
    match run(model) {
        Some(Run::Stopped) => "Stopped".into(),
        Some(Run::NotResponding) => "Not responding".into(),
        _ => format!("Running{}", d.instance.version.as_deref().map(|v| format!(" {v}")).unwrap_or_default()),
    }
}

pub fn is_stopped(model: &AppModel) -> bool {
    matches!(run(model), Some(Run::Stopped))
}

/// Down, with a plist whose CLI was uninstalled: launchd can only fail to start it.
pub fn is_orphaned(model: &AppModel) -> bool {
    is_down(model) && model.discovery.as_ref().is_some_and(|d| d.unit.owner == Owner::Orphaned)
}

/// Stopped or not responding: a held summary is stale, so the panel shows a message instead.
pub fn is_down(model: &AppModel) -> bool {
    matches!(run(model), Some(Run::Stopped | Run::NotResponding))
}

/// The status dot: amber when running with alerts.
pub fn dot(model: &AppModel, cx: &App) -> Hsla {
    let theme = crate::theme::colors(cx);
    match run(model) {
        Some(Run::Running) if matches!(&model.summary, SummaryState::Ready(s) if !s.alerts.is_empty()) => theme.warning,
        Some(Run::Running) => theme.success,
        Some(Run::NotResponding) => theme.danger,
        Some(Run::Stopped) | None => theme.muted_foreground,
    }
}

/// `127.0.0.1:9317 · started by AIO Proxy`: the address and who runs the service.
pub fn endpoint_line(model: &AppModel) -> Option<String> {
    let d = model.discovery.as_ref()?;
    let url = d.instance.control_url.as_deref()?;
    let address = url.strip_prefix("http://").unwrap_or(url).trim_end_matches('/');
    let owner = match d.unit.owner {
        Owner::Desktop if d.job.disabled => Some("stopped by you"),
        Owner::Desktop => Some("started by AIO Proxy"),
        Owner::External => Some("managed by the aio-proxy CLI"),
        Owner::Orphaned => Some("left by an uninstalled aio-proxy CLI"),
        Owner::Unknown | Owner::NoPlist => None,
    };
    Some(match owner {
        Some(owner) => format!("{address} · {owner}"),
        None => address.to_string(),
    })
}

/// The one line of context under the headline, most important first.
pub fn notice(model: &AppModel) -> Option<String> {
    // Only this line reports a failed login-item change; the menu has no room for it.
    if let Some(error) = &model.login_item_error {
        return Some(error.clone());
    }
    if let ActionState::Failed(error) = &model.action {
        return Some(error.clone());
    }
    match &model.install {
        Some(InstallState::ReadOnly(ReadOnlyReason::Location)) => {
            return Some(if cfg!(target_os = "macos") {
                "Move AIO Proxy to Applications to let it manage the proxy.".into()
            } else {
                "AIO Proxy can't keep its command-line copy here; run it from a writable location.".into()
            });
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
            let what = if cfg!(target_os = "macos") { "service link" } else { "command-line copy" };
            return Some(format!("Cannot update the {what}: {error}"));
        }
        _ => {}
    }
    if let Some(error) = &model.discovery_error {
        return Some(error.clone());
    }
    if model.discovery.as_ref()?.unit.owner == Owner::Unknown {
        return Some("The installed service is not recognised; the app will not change it.".into());
    }
    match &model.action {
        ActionState::Done(note) => Some(note.clone()),
        ActionState::Running(action) => Some(format!("{}…", action.label())),
        ActionState::Automatic(action) => Some(format!("{}…", action.label())),
        // A down proxy is expected to fail its refresh; the body already says why.
        _ if is_down(model) => None,
        _ => model.usage_error().map(|error| format!("Couldn't refresh usage · {error}")),
    }
}

#[cfg(test)]
mod tests;
