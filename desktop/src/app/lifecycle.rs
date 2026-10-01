//! Startup install step, discovery, the automatic-action table and user actions, wired to GPUI.
//! The decisions live in `connect`; this only moves work to background threads and back.

use std::path::{Path, PathBuf};

use gpui_kit::App;

use super::{ActionState, AppModel, changed, refresh};
use crate::connect::cli::SystemHost;
use crate::connect::discovery::Discovery;
use crate::connect::policy::{ReloadOutcome, UserAction, automatic_action};
use crate::connect::run::{Host, run_auto, run_reload, run_user};
use crate::install::{self, InstallState, Paths, ReadOnlyReason};
use crate::log;
use crate::version::APP_VERSION;

pub fn start(cx: &mut App) {
    let (paths, bundle) = {
        let model = cx.global::<AppModel>();
        (model.paths.clone(), model.bundle.clone())
    };
    let task = cx.background_executor().spawn(async move { prepare_install(&paths, bundle.as_deref()) });
    cx.spawn(async move |cx| {
        let install = task.await;
        cx.update(|cx| {
            log::info(format!("install: {install:?}"));
            cx.global_mut::<AppModel>().install = Some(install);
            changed(cx);
            rediscover(cx);
        });
    })
    .detach();
}

fn prepare_install(paths: &Paths, bundle: Option<&Path>) -> InstallState {
    let Some(bundle) = bundle else {
        return InstallState::ReadOnly(ReadOnlyReason::Location);
    };
    let location_ok = install::location_allows_persistence(bundle, &paths.home, install::volume_is_read_only(bundle));
    install::prepare(paths, bundle, location_ok, APP_VERSION, install::probe_version)
}

fn host(model: &AppModel) -> Option<SystemHost> {
    SystemHost::new(&model.paths, model.bundle.as_deref())
}

pub fn rediscover(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    if model.discovering {
        model.rediscover_again = true;
        return;
    }
    let Some(host) = host(model) else {
        model.discovery_error = Some("The bundled aio-proxy binary was not found.".into());
        changed(cx);
        return;
    };
    model.discovering = true;
    let seq = model.discovery_order.issue();
    let task = cx.background_executor().spawn(async move { host.discover() });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| {
            let again = {
                let model = cx.global_mut::<AppModel>();
                model.discovering = false;
                std::mem::take(&mut model.rediscover_again)
            };
            apply_discovery(cx, seq, result);
            if again {
                rediscover(cx);
            }
        });
    })
    .detach();
}

/// An action's own post-mutation discovery: newer than any discovery still running.
fn apply_after(cx: &mut App, after: Discovery) {
    let seq = cx.global_mut::<AppModel>().discovery_order.issue();
    apply_discovery(cx, seq, Ok(after));
}

/// Drops a result older than one already applied; `discovering` belongs to `rediscover` alone.
fn apply_discovery(cx: &mut App, seq: u64, result: Result<Discovery, String>) {
    let (first, ok) = {
        let model = cx.global_mut::<AppModel>();
        if !model.discovery_order.accept(seq) {
            return;
        }
        let first = model.discovery.is_none();
        let ok = result.is_ok();
        match result {
            Ok(discovery) => {
                model.discovery_error = None;
                model.discovery = Some(discovery);
            }
            Err(error) => {
                log::info(format!("discovery failed: {error}"));
                model.discovery_error = Some(error);
            }
        }
        (first && model.discovery.is_some(), ok)
    };
    refresh::instance_maybe_changed(cx);
    // After an error the stored discovery predates it; never spend the automatic slot on that.
    if ok {
        maybe_automatic(cx);
    }
    changed(cx);
    if first {
        // The timer's startup tick found no discovery to probe; without this the icon would read
        // "down" until the next 60 s tick. Bounded: a transition rediscovers once, and that
        // discovery is no longer the first.
        super::check_health(cx);
    }
}

fn maybe_automatic(cx: &mut App) {
    let model = cx.global_mut::<AppModel>();
    if model.action.is_busy() {
        return;
    }
    let Some(discovery) = model.discovery.clone() else {
        return;
    };
    let Some(action) = automatic_action(&discovery, model.persistent(), &model.attempts) else {
        return;
    };
    let Some(host) = host(model) else {
        return;
    };
    // `run_auto` spends its own slot before the first mutation; the model's copy is marked too so
    // the next discovery sees the row as used. Busy state blocks a second decision meanwhile.
    let mut worker = model.attempts.clone();
    model.attempts.mark(action);
    model.action = ActionState::Automatic(action);
    log::info(format!("automatic action: {action:?}"));
    let task = cx.background_executor().spawn(async move { run_auto(&host, &discovery, action, &mut worker) });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| {
            let model = cx.global_mut::<AppModel>();
            match result {
                Ok(after) => {
                    log::info(format!("automatic action {action:?} finished"));
                    model.action = ActionState::Idle;
                    apply_after(cx, after);
                    refresh::after_action(cx);
                }
                Err(error) => {
                    log::info(format!("automatic action {action:?} failed: {error}"));
                    model.action = ActionState::after_automatic_failure(action, &error);
                    changed(cx);
                    rediscover(cx);
                }
            }
            super::check_health(cx);
        });
    })
    .detach();
}

pub fn run_user_action(cx: &mut App, action: UserAction) {
    let model = cx.global_mut::<AppModel>();
    if model.action.is_busy() {
        return;
    }
    // Service mutations write the plist and `AIO_PROXY_DESKTOP_EXEC`; only a persistent install may.
    if action != UserAction::Reload && !model.persistent() {
        log::info(format!("{action:?} refused: this copy is not in a persistent location"));
        return;
    }
    let (Some(rendered), Some(host)) = (model.discovery.clone(), host(model)) else {
        return;
    };
    model.action = ActionState::Running(action);
    changed(cx);
    let task = cx.background_executor().spawn(async move { execute(&host, &rendered, action) });
    cx.spawn(async move |cx| {
        let result = task.await;
        cx.update(|cx| {
            let model = cx.global_mut::<AppModel>();
            match result {
                Ok((note, after)) => {
                    if action == UserAction::Stop {
                        // The completion wait already proved it unreachable.
                        model.health.mark_down();
                    }
                    model.action = ActionState::Done(note);
                    if let Some(after) = after {
                        apply_after(cx, after);
                    }
                    refresh::after_action(cx);
                    changed(cx);
                }
                Err(error) => {
                    log::info(format!("{action:?} failed: {error}"));
                    if action != UserAction::Reload {
                        // Otherwise the rediscovery below could run an automatic row as an unclicked retry.
                        model.attempts.spend();
                    }
                    model.action = ActionState::Failed(error);
                    changed(cx);
                    rediscover(cx);
                }
            }
            super::check_health(cx);
        });
    })
    .detach();
}

fn execute(host: &impl Host, rendered: &Discovery, action: UserAction) -> Result<(String, Option<Discovery>), String> {
    if action == UserAction::Reload {
        return match run_reload(host, rendered).map_err(|error| error.to_string())? {
            ReloadOutcome::Reloaded => Ok(("Configuration reloaded.".into(), None)),
            ReloadOutcome::Rejected { error, stage } => {
                Err(format!("Reload rejected{}: {error}", stage.map(|s| format!(" at {s}")).unwrap_or_default()))
            }
            ReloadOutcome::Failed(error) => Err(error),
        };
    }
    // Every other action (Start, Restart, Stop, InstallAndStart) is a service mutation.
    let after = run_user(host, rendered, action).map_err(|error| error.to_string())?;
    Ok((format!("{} finished.", action.label()), Some(after)))
}

pub fn open_dashboard(cx: &mut App) {
    open_dashboard_at(cx, &[]);
}

pub fn open_dashboard_providers(cx: &mut App) {
    open_dashboard_at(cx, &["providers", ""]);
}

pub fn open_dashboard_provider(cx: &mut App, id: &str) {
    open_dashboard_at(cx, &["providers", id, "edit"]);
}

fn open_dashboard_at(cx: &mut App, segments: &[&str]) {
    let Some(base) = cx.global::<AppModel>().discovery.as_ref().and_then(|d| d.instance.dashboard_url.clone()) else {
        return;
    };
    // An unparsable base still opens as it is, as the plain Open Dashboard always did.
    let url = dashboard_url(&base, segments).unwrap_or(base);
    cx.open_url(&url);
}

/// `segments` are percent-encoded onto the dashboard path (a `/` inside one included); `""` last
/// leaves a trailing slash. `None` when `base` is not an absolute URL with a path.
pub(crate) fn dashboard_url(base: &str, segments: &[&str]) -> Option<String> {
    let mut url = url::Url::parse(base).ok()?;
    if !segments.is_empty() {
        url.path_segments_mut().ok()?.pop_if_empty().extend(segments);
    }
    Some(url.into())
}

/// Reveals `$AIO_PROXY_HOME/logs`, the service's own home when the plist names one.
pub fn open_logs(cx: &mut App) {
    let model = cx.global::<AppModel>();
    let home = model
        .discovery
        .as_ref()
        .and_then(|d| d.unit.home.clone())
        .map(PathBuf::from)
        .unwrap_or_else(|| model.paths.home.join(".aio-proxy"));
    cx.reveal_path(&home.join("logs"));
}

/// "App starts at login" is a persistent operation, so it follows the install-location policy.
pub fn set_login_item(cx: &mut App, enabled: bool) {
    let model = cx.global_mut::<AppModel>();
    if !model.persistent() {
        return;
    }
    model.login_item_error =
        crate::login_item::set_enabled(enabled).err().map(|error| format!("Launch at login: {error}"));
    model.login_item = crate::login_item::status();
    changed(cx);
}

/// The menu's check item. Approval pending → System Settings; otherwise flip the registration.
pub fn toggle_login_item(cx: &mut App) {
    let status = cx.global::<AppModel>().login_item;
    if status == crate::login_item::LoginItemStatus::RequiresApproval {
        crate::login_item::open_settings();
    } else {
        set_login_item(cx, status != crate::login_item::LoginItemStatus::Enabled);
    }
    // muda flips the native check itself on click; re-read the status and force a menu rebuild so
    // an unchanged model (approval pending, failed register) cannot leave it flipped.
    cx.global_mut::<AppModel>().login_item = crate::login_item::status();
    crate::tray::invalidate_menu(cx);
    changed(cx);
}

#[cfg(test)]
mod tests;
