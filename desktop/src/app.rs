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
    open_dashboard, open_dashboard_provider, open_dashboard_providers, open_logs, rediscover, run_user_action,
    set_login_item, start, toggle_login_item,
};
pub use refresh::{manual_refresh, panel_closed, panel_opened, set_usage_range};

use order::DiscoveryOrder;

use crate::client::health::HealthTracker;
use crate::client::refresh::Scheduler;
use crate::connect::discovery::Discovery;
use crate::connect::policy::{AutoAction, AutoAttempts, UserAction};
use crate::connect::run::RunError;
use crate::install::{InstallState, Paths};
use crate::login_item::LoginItemStatus;
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
    /// Set when a fetch fails while the last good summary stays on screen.
    pub summary_error: Option<String>,
    /// When the last summary landed, for the footer's "Updated …".
    pub last_summary_at: Option<Instant>,
    pub action: ActionState,
    pub update_pending: Option<String>,
    pub login_item: LoginItemStatus,
    /// Last register/unregister failure, shown under the switch; kept out of `action`, which is
    /// the service-action state machine.
    pub login_item_error: Option<String>,
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

    pub fn updated_text(&self) -> String {
        match self.last_summary_at.map(|at| at.elapsed().as_secs() / 60) {
            None | Some(0) => "Updated just now".into(),
            Some(minutes) => format!("Updated {minutes} min ago"),
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
