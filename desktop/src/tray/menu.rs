//! The right-click menu's contents, from the same offer table the panel's action row used.

use crate::connect::policy::{Offered, UserAction};
use crate::login_item::LoginItemStatus;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuCommand {
    OpenDashboard,
    Run(UserAction),
    OpenLogs,
    ToggleLogin,
    CheckForUpdates,
    Quit,
}

impl MenuCommand {
    pub fn id(self) -> &'static str {
        match self {
            MenuCommand::OpenDashboard => "open-dashboard",
            MenuCommand::Run(UserAction::InstallAndStart) => "run-install",
            MenuCommand::Run(UserAction::TakeOver) => "run-take-over",
            MenuCommand::Run(UserAction::Start) => "run-start",
            MenuCommand::Run(UserAction::Stop) => "run-stop",
            MenuCommand::Run(UserAction::Restart) => "run-restart",
            MenuCommand::Run(UserAction::Reload) => "run-reload",
            MenuCommand::OpenLogs => "open-logs",
            MenuCommand::ToggleLogin => "login",
            MenuCommand::CheckForUpdates => "check-updates",
            MenuCommand::Quit => "quit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Some(match id {
            "open-dashboard" => MenuCommand::OpenDashboard,
            "run-install" => MenuCommand::Run(UserAction::InstallAndStart),
            "run-take-over" => MenuCommand::Run(UserAction::TakeOver),
            "run-start" => MenuCommand::Run(UserAction::Start),
            "run-stop" => MenuCommand::Run(UserAction::Stop),
            "run-restart" => MenuCommand::Run(UserAction::Restart),
            "run-reload" => MenuCommand::Run(UserAction::Reload),
            "open-logs" => MenuCommand::OpenLogs,
            "login" => MenuCommand::ToggleLogin,
            "check-updates" => MenuCommand::CheckForUpdates,
            "quit" => MenuCommand::Quit,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuEntry {
    Item { command: MenuCommand, label: String, enabled: bool },
    Check { command: MenuCommand, label: String, checked: bool, enabled: bool },
    Separator,
}

fn item(command: MenuCommand, label: &str, enabled: bool) -> MenuEntry {
    MenuEntry::Item { command, label: label.into(), enabled }
}

/// `dashboard` is false while the proxy is down: from live health, not only the last discovery.
pub fn menu_entries(
    offered: Offered,
    dashboard: bool,
    busy: bool,
    persistent: bool,
    login: LoginItemStatus,
) -> Vec<MenuEntry> {
    let mut entries = vec![item(MenuCommand::OpenDashboard, "Open Dashboard", dashboard), MenuEntry::Separator];
    let services = [
        (offered.install, UserAction::InstallAndStart, "Install and start"),
        (offered.take_over, UserAction::TakeOver, "Take over and start"),
        (offered.start, UserAction::Start, "Start"),
        (offered.stop, UserAction::Stop, "Stop"),
        (offered.restart, UserAction::Restart, "Restart"),
        (offered.reload, UserAction::Reload, "Reload config"),
    ];
    for (shown, action, label) in services {
        if shown {
            entries.push(item(MenuCommand::Run(action), label, !busy));
        }
    }
    entries.push(item(MenuCommand::OpenLogs, "Open logs", true));
    entries.push(MenuEntry::Separator);
    // Always listed, so the switch is findable; a copy outside Applications cannot register (the
    // login item would point at wherever this bundle happens to be), so there it is disabled.
    let label = match (persistent, login) {
        (false, _) => "Open at login (move to Applications first)",
        (true, LoginItemStatus::RequiresApproval) => "Open at login (needs approval)",
        (true, _) => "Open at login",
    };
    let checked = persistent && matches!(login, LoginItemStatus::Enabled | LoginItemStatus::RequiresApproval);
    entries.push(MenuEntry::Check {
        command: MenuCommand::ToggleLogin,
        label: label.into(),
        checked,
        enabled: persistent,
    });
    entries.push(item(MenuCommand::CheckForUpdates, "Check for Updates…", true));
    entries.push(MenuEntry::Separator);
    entries.push(item(MenuCommand::Quit, "Quit AIO Proxy", true));
    entries
}

#[cfg(test)]
mod tests;
