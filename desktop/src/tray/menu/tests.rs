use super::*;
use crate::connect::policy::Offered;

fn offered(install: bool, start: bool, restart: bool, stop: bool, reload: bool) -> Offered {
    Offered { install, start, restart, stop, reload }
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
fn a_read_only_copy_has_no_login_item_and_only_what_it_may_do() {
    let entries =
        labels(&menu_entries(offered(false, false, false, false, true), false, false, LoginItemStatus::Unavailable));
    assert_eq!(
        entries,
        ["Open Dashboard", "---", "Reload config", "Open logs", "---", "Check for Updates…", "---", "Quit AIO Proxy"]
    );
}

#[test]
fn busy_disables_service_actions_and_approval_is_named() {
    let entries = menu_entries(offered(false, false, true, true, true), true, true, LoginItemStatus::RequiresApproval);
    for entry in &entries {
        if let MenuEntry::Item { command: MenuCommand::Run(_), enabled, .. } = entry {
            assert!(!enabled);
        }
    }
    assert!(labels(&entries).contains(&"Open at login (needs approval)".to_string()));
}

#[test]
fn ids_round_trip() {
    for command in [
        MenuCommand::OpenDashboard,
        MenuCommand::Run(UserAction::InstallAndStart),
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
