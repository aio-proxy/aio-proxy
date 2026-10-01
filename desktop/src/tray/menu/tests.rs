use super::*;
use crate::connect::policy::Offered;

fn offered(install: bool, start: bool, restart: bool, stop: bool, reload: bool) -> Offered {
    Offered { install, take_over: false, start, restart, stop, reload }
}

fn labels(entries: &[MenuEntry]) -> Vec<String> {
    entries
        .iter()
        .map(|e| match e {
            MenuEntry::Item { label, .. } | MenuEntry::Check { label, .. } => label.clone(),
            MenuEntry::Separator => "---".into(),
        })
        .collect()
}

#[test]
fn a_running_desktop_service_offers_stop_restart_reload_and_login() {
    let entries = menu_entries(offered(false, false, true, true, true), false, true, LoginItemStatus::Enabled);
    assert_eq!(
        labels(&entries),
        [
            "Open Dashboard",
            "---",
            "Stop",
            "Restart",
            "Reload config",
            "Open logs",
            "---",
            "Open at login",
            "Check for Updates…",
            "---",
            "Quit AIO Proxy"
        ]
    );
    assert!(entries.iter().any(|e| matches!(e, MenuEntry::Check { checked: true, .. })));
}

#[test]
fn a_stopped_service_offers_start_and_a_fresh_one_install() {
    let stopped =
        labels(&menu_entries(offered(false, true, false, false, false), false, true, LoginItemStatus::NotRegistered));
    assert!(stopped.contains(&"Start".to_string()) && !stopped.contains(&"Stop".to_string()));
    let fresh =
        labels(&menu_entries(offered(true, false, false, false, false), false, true, LoginItemStatus::NotRegistered));
    assert!(fresh.contains(&"Install and start".to_string()));
}

#[test]
fn a_read_only_copy_lists_login_disabled_and_only_what_it_may_do() {
    let entries = menu_entries(offered(false, false, false, false, true), false, false, LoginItemStatus::Unavailable);
    assert_eq!(
        labels(&entries),
        [
            "Open Dashboard",
            "---",
            "Reload config",
            "Open logs",
            "---",
            "Open at login (move to Applications first)",
            "Check for Updates…",
            "---",
            "Quit AIO Proxy"
        ]
    );
    // Listed so it can be found, but a copy outside Applications must not register itself.
    assert!(entries.iter().any(|e| matches!(e, MenuEntry::Check { enabled: false, checked: false, .. })));
}

#[test]
fn busy_disables_service_actions_and_approval_is_named() {
    let entries = menu_entries(offered(false, false, true, true, true), true, true, LoginItemStatus::RequiresApproval);
    let enabled_of = |wanted: MenuCommand| {
        entries.iter().find_map(|e| match e {
            MenuEntry::Item { command, enabled, .. } if *command == wanted => Some(*enabled),
            _ => None,
        })
    };
    let runs: Vec<bool> = entries
        .iter()
        .filter_map(|e| match e {
            MenuEntry::Item { command: MenuCommand::Run(_), enabled, .. } => Some(*enabled),
            _ => None,
        })
        .collect();
    assert!(!runs.is_empty() && runs.iter().all(|enabled| !enabled));
    for command in [MenuCommand::OpenDashboard, MenuCommand::OpenLogs, MenuCommand::CheckForUpdates, MenuCommand::Quit]
    {
        assert_eq!(enabled_of(command), Some(true), "{command:?} stays enabled while busy");
    }
    assert!(labels(&entries).contains(&"Open at login (needs approval)".to_string()));
}

#[test]
fn ids_round_trip() {
    // The exhaustive match below stops compiling when `MenuCommand` gains a variant: add it here too.
    let _exhaustive = |c: MenuCommand| match c {
        MenuCommand::OpenDashboard
        | MenuCommand::Run(_)
        | MenuCommand::OpenLogs
        | MenuCommand::ToggleLogin
        | MenuCommand::CheckForUpdates
        | MenuCommand::Quit => (),
    };
    for command in [
        MenuCommand::OpenDashboard,
        MenuCommand::Run(UserAction::InstallAndStart),
        MenuCommand::Run(UserAction::TakeOver),
        MenuCommand::Run(UserAction::Start),
        MenuCommand::Run(UserAction::Stop),
        MenuCommand::Run(UserAction::Restart),
        MenuCommand::Run(UserAction::Reload),
        MenuCommand::OpenLogs,
        MenuCommand::ToggleLogin,
        MenuCommand::CheckForUpdates,
        MenuCommand::Quit,
    ] {
        assert_eq!(MenuCommand::from_id(command.id()), Some(command));
    }
}
