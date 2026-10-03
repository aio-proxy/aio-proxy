//! The app-level model, a GPUI global. It outlives the panel window (hybrid lifecycle), so a
//! reopened panel renders the last numbers at once while a fresh fetch runs.

mod health;
mod lifecycle;
mod order;
mod refresh;

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Instant;

use gpui_kit::{App, Global, Task};

pub use health::{check_now as check_health, start_timer as start_health_timer};
pub use lifecycle::{
    install_cli, open_dashboard, open_dashboard_provider, open_dashboard_providers, open_logs, rediscover,
    run_user_action, set_login_item, start, toggle_login_item,
};
pub use refresh::{manual_refresh, panel_closed, panel_opened, set_usage_range};

use order::DiscoveryOrder;

use crate::client::health::HealthTracker;
use crate::client::refresh::Scheduler;
use crate::connect::discovery::Discovery;
use crate::connect::policy::{AutoAction, AutoAttempts, UserAction};
use crate::connect::run::RunError;
use crate::install::{InstallState, Paths};
use crate::platform::LoginItemStatus;
use crate::summary::{DegradedReason, SummaryV1, Usage, UsageRange};

/// Everything that reaches the GPUI loop from AppKit callbacks, delivered over one channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEvent {
    TogglePanel,
    ClosePanel,
    Menu(crate::tray::MenuCommand),
    Wake,
    UpdateAvailable(String),
    UpdateAttended,
    /// A manual check found nothing newer (Linux, Windows).
    UpToDate,
    /// An install in progress, for the action line (Linux, Windows).
    UpdateProgress(String),
    /// A manual check or an install failed (Linux, Windows).
    UpdateFailed(String),
    /// An update this AppImage cannot install in place: its Release page.
    OpenUrl(String),
    /// The AppImage at this path was replaced: exec it on the main thread.
    #[cfg(target_os = "linux")]
    RelaunchInto(PathBuf),
    /// Linux: whether a StatusNotifierWatcher owns its D-Bus name, so a tray icon can show.
    TrayHost(bool),
}

pub enum SummaryState {
    Waiting,
    Ready(Box<SummaryV1>),
    Degraded(DegradedReason),
    AuthFailed,
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ActionState {
    Idle,
    Running(UserAction),
    Automatic(AutoAction),
    Done(String),
    Failed(String),
}

impl ActionState {
    pub fn is_busy(&self) -> bool {
        matches!(self, ActionState::Running(_) | ActionState::Automatic(_))
    }

    /// An automatic action that found the service changed did nothing, so it is only logged.
    pub fn after_automatic_failure(action: AutoAction, error: &RunError) -> Self {
        match error {
            RunError::Changed => ActionState::Idle,
            error => ActionState::Failed(format!("{} failed: {error}", action.label())),
        }
    }

    /// Done and Failed are read once: closing the panel clears them.
    pub fn clear_outcome(&mut self) {
        if matches!(self, ActionState::Done(_) | ActionState::Failed(_)) {
            *self = ActionState::Idle;
        }
    }
}

pub struct AppModel {
    pub paths: Paths,
    pub bundle: Option<PathBuf>,
    /// `None` until the startup install step finishes; nothing is automatic before that.
    pub install: Option<InstallState>,
    pub discovery: Option<Discovery>,
    pub discovery_error: Option<String>,
    pub health: HealthTracker,
    pub summary: SummaryState,
    /// Set when a fetch fails while the last good summary stays on screen, with the window it
    /// was for: only that window's Usage group and notice report it.
    pub summary_error: Option<(UsageRange, String)>,
    /// When the last summary landed, for the footer's "Updated …".
    pub last_summary_at: Option<Instant>,
    pub action: ActionState,
    pub update_pending: Option<String>,
    pub login_item: LoginItemStatus,
    /// Last register/unregister failure, shown under the switch; kept out of `action`, which is
    /// the service-action state machine.
    pub login_item_error: Option<String>,
    /// What the user's shell resolves; `None` until (or unless) it answers.
    pub cli_probe: Option<crate::cli_command::Probe>,
    pub cli_installing: bool,
    /// The Usage group's window. Remembered across panel closes; `24h` at launch.
    pub usage_range: UsageRange,
    /// The last usage per window, so a switch back renders at once while a fetch runs.
    usage_cache: HashMap<UsageRange, Usage>,
    attempts: AutoAttempts,
    /// True from spawn to landing of the one in-flight discovery; only that task clears it.
    discovering: bool,
    discovery_order: DiscoveryOrder,
    rediscover_again: bool,
    auth_retry_used: bool,
    refetch_after_discovery: bool,
    scheduler: Scheduler,
    instance: Option<(String, Option<u32>)>,
    instance_epoch: u64,
    fetch_task: Option<Task<()>>,
    timer_task: Option<Task<()>>,
}

impl Global for AppModel {}

impl AppModel {
    pub fn new(paths: Paths, bundle: Option<PathBuf>) -> Self {
        Self {
            paths,
            bundle,
            install: None,
            discovery: None,
            discovery_error: None,
            health: HealthTracker::default(),
            summary: SummaryState::Waiting,
            summary_error: None,
            last_summary_at: None,
            action: ActionState::Idle,
            update_pending: None,
            login_item: LoginItemStatus::Unavailable,
            login_item_error: None,
            cli_probe: None,
            cli_installing: false,
            usage_range: UsageRange::H24,
            usage_cache: HashMap::new(),
            attempts: AutoAttempts::default(),
            discovering: false,
            discovery_order: DiscoveryOrder::default(),
            rediscover_again: false,
            auth_retry_used: false,
            refetch_after_discovery: false,
            scheduler: Scheduler::default(),
            instance: None,
            instance_epoch: 0,
            fetch_task: None,
            timer_task: None,
        }
    }

    pub fn usage_for(&self, range: UsageRange) -> Option<&Usage> {
        self.usage_cache.get(&range)
    }

    /// Files a landed summary under the window it is for, which is not necessarily the one on screen.
    pub(crate) fn accept_summary(&mut self, summary: Box<SummaryV1>) {
        self.usage_cache.insert(summary.usage.range, summary.usage.clone());
        self.summary = SummaryState::Ready(summary);
        self.summary_error = None;
        self.last_summary_at = Some(Instant::now());
    }

    /// A different instance has different numbers.
    pub(crate) fn forget_usage(&mut self) {
        self.usage_cache.clear();
    }

    /// The failed fetch's reason, when it was for the window on screen.
    pub fn usage_error(&self) -> Option<&str> {
        self.summary_error.as_ref().filter(|(range, _)| *range == self.usage_range).map(|(_, error)| error.as_str())
    }

    /// Whether a summary fetch is out: the header's refresh button spins.
    pub fn is_refreshing(&self) -> bool {
        self.scheduler.is_fetching()
    }

    pub fn updated_text(&self) -> Option<String> {
        let minutes = self.last_summary_at?.elapsed().as_secs() / 60;
        Some(if minutes == 0 { "Updated just now".into() } else { format!("Updated {minutes} min ago") })
    }

    /// `/usr/local/bin/aiop` serves every account, so it may only point into the shared /Applications,
    /// never into one user's ~/Applications.
    /// Off macOS the link is per-user, so only a persistent install is needed.
    pub fn can_link_cli(&self) -> bool {
        if !cfg!(target_os = "macos") {
            return self.persistent();
        }
        self.persistent() && self.bundle.as_deref().is_some_and(|bundle| bundle.starts_with("/Applications"))
    }

    /// An updater result for the action line; it never replaces a service action in flight.
    pub fn show_update_outcome(&mut self, outcome: ActionState) {
        if !self.action.is_busy() {
            self.action = outcome;
        }
    }

    pub fn persistent(&self) -> bool {
        self.install == Some(InstallState::Persistent)
    }

    pub fn needs_attention(&self) -> bool {
        let alerts = matches!(&self.summary, SummaryState::Ready(summary) if !summary.alerts.is_empty());
        alerts
            || self.update_pending.is_some()
            || matches!(self.action, ActionState::Failed(_))
            // No token is not a problem the user must act on: nothing was rejected.
            || matches!(
                self.summary,
                SummaryState::AuthFailed
                    | SummaryState::Degraded(DegradedReason::Missing | DegradedReason::UnsupportedVersion(_))
            )
    }
}

/// Call after any model change: updates the icon and re-renders the panel.
pub fn changed(cx: &mut App) {
    crate::tray::sync(cx);
    cx.refresh_windows();
}

#[cfg(test)]
mod tests;
