use super::*;
use crate::prefs::{Prefs, TrayMetric};

#[test]
fn only_a_healthy_proxy_shows_running_or_attention() {
    assert_eq!(tray_state(HealthState::Up, false), TrayState::Running);
    assert_eq!(tray_state(HealthState::Up, true), TrayState::Attention);
    assert_eq!(tray_state(HealthState::Down, true), TrayState::Down);
    assert_eq!(tray_state(HealthState::Unknown, false), TrayState::Down);
}

#[test]
fn the_three_states_have_distinct_icons() {
    let icons = [TrayState::Running, TrayState::Down, TrayState::Attention].map(|state| icon_rgba(state, [0, 0, 0]));
    for icon in &icons {
        assert_eq!(icon.len(), (ICON_WIDTH * ICON_HEIGHT * 4) as usize);
        assert!(icon.chunks(4).any(|px| px[3] > 0), "icon is not empty");
    }
    // Down reads as disabled: nothing at full strength.
    assert!(icons[1].chunks(4).all(|px| px[3] < 255));
    assert_ne!(icons[0], icons[1]);
    assert_ne!(icons[0], icons[2]);
    assert_ne!(icons[1], icons[2]);
}

#[test]
fn left_release_toggles_the_panel_and_a_right_press_closes_it_before_the_menu() {
    assert_eq!(click_event(MouseButton::Left, MouseButtonState::Up), Some(AppEvent::TogglePanel));
    // The menu is our own app's, so the panel never deactivates: the press must close it.
    assert_eq!(click_event(MouseButton::Right, MouseButtonState::Down), Some(AppEvent::ClosePanel));
    assert_eq!(click_event(MouseButton::Left, MouseButtonState::Down), None);
    assert_eq!(click_event(MouseButton::Right, MouseButtonState::Up), None);
}

#[test]
fn icon_pixels_take_the_requested_color_and_keep_state_alpha() {
    let white = icon_rgba(TrayState::Running, [255, 255, 255]);
    assert!(white.chunks(4).filter(|p| p[3] > 0).all(|p| p[..3] == [255, 255, 255]));
    let dim = icon_rgba(TrayState::Down, [255, 255, 255]);
    assert!(dim.chunks(4).map(|p| p[3]).max() < white.chunks(4).map(|p| p[3]).max());
}

#[test]
fn the_attention_dot_adds_pixels_the_running_icon_lacks() {
    let running = icon_rgba(TrayState::Running, [0, 0, 0]);
    let attention = icon_rgba(TrayState::Attention, [0, 0, 0]);
    assert!(running.chunks(4).zip(attention.chunks(4)).any(|(r, a)| r[3] == 0 && a[3] > 0));
}

#[test]
fn the_tray_guid_follows_the_executable_path_but_not_its_case() {
    let installed = std::path::Path::new(r"C:\Users\a\AppData\Local\AIO Proxy\aio-proxy-desktop.exe");
    let upper = std::path::Path::new(r"C:\USERS\A\APPDATA\LOCAL\AIO PROXY\AIO-PROXY-DESKTOP.EXE");
    let dev = std::path::Path::new(r"C:\src\aio-proxy\desktop\target\debug\aio-proxy-desktop.exe");
    assert_eq!(tray_guid(installed), tray_guid(upper));
    assert_ne!(tray_guid(installed), tray_guid(dev));
}

#[test]
fn the_tray_guid_for_a_path_never_changes() {
    // FNV-1a 128 test vector ("a"): a changed hash would orphan every user's pinned icon.
    assert_eq!(tray_guid(std::path::Path::new("a")), 0xd228_cb69_6f1a_8caf_7891_2b70_4e4a_8964);
}

#[test]
fn display_commands_round_trip_through_their_native_ids() {
    let commands = [
        (MenuCommand::TrayMetric(TrayMetric::TodayTokens), "tray-metric-today-tokens"),
        (MenuCommand::TrayMetric(TrayMetric::TokensPerSecond), "tray-metric-tokens-per-second"),
        (MenuCommand::TrayMetric(TrayMetric::TodayCost), "tray-metric-today-cost"),
        (MenuCommand::TrayMetric(TrayMetric::InFlight), "tray-metric-in-flight"),
        (MenuCommand::ToggleTrayIcon, "tray-icon"),
    ];
    for (command, id) in commands {
        assert_eq!(command.id(), id);
        assert_eq!(MenuCommand::from_id(command.id()), Some(command));
    }
}

fn check_state(entries: &[MenuEntry], command: MenuCommand) -> (bool, bool) {
    entries
        .iter()
        .find_map(|entry| match entry {
            MenuEntry::Check { command: found, checked, enabled, .. } if *found == command => {
                Some((*checked, *enabled))
            }
            _ => None,
        })
        .expect("display command is a check item")
}

#[test]
fn two_selected_metrics_remain_removable_and_disable_the_unselected_metrics() {
    let prefs = Prefs { tray_metrics: vec![TrayMetric::TodayTokens, TrayMetric::InFlight], ..Prefs::default() };
    let entries = display_menu_entries(&prefs);
    let labels: Vec<_> = entries
        .iter()
        .filter_map(|entry| match entry {
            MenuEntry::Check { label, .. } => Some(label.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(labels, ["Today Tokens", "Tokens per Second", "Today Cost", "Requests in Flight", "Show Icon",]);
    for metric in [TrayMetric::TodayTokens, TrayMetric::InFlight] {
        assert_eq!(check_state(&entries, MenuCommand::TrayMetric(metric)), (true, true));
    }
    for metric in [TrayMetric::TokensPerSecond, TrayMetric::TodayCost] {
        assert_eq!(check_state(&entries, MenuCommand::TrayMetric(metric)), (false, false));
    }
    assert_eq!(entries.len(), 6);
    assert!(matches!(entries[4], MenuEntry::Separator));
    assert!(matches!(entries[5], MenuEntry::Check { command: MenuCommand::ToggleTrayIcon, .. }));
}

#[test]
fn fewer_than_two_metrics_allows_adding_another_metric() {
    for selected in [vec![], vec![TrayMetric::TodayCost]] {
        let prefs = Prefs { tray_metrics: selected, ..Prefs::default() };
        let entries = display_menu_entries(&prefs);
        for metric in
            [TrayMetric::TodayTokens, TrayMetric::TokensPerSecond, TrayMetric::TodayCost, TrayMetric::InFlight]
        {
            assert_eq!(
                check_state(&entries, MenuCommand::TrayMetric(metric)),
                (prefs.tray_metrics.contains(&metric), true)
            );
        }
    }
}

#[test]
fn no_metrics_forces_the_icon_checked_and_prevents_hiding_it() {
    let prefs = Prefs { tray_show_icon: false, ..Prefs::default() };
    assert_eq!(check_state(&display_menu_entries(&prefs), MenuCommand::ToggleTrayIcon), (true, false));
    let prefs = Prefs { tray_metrics: vec![TrayMetric::TodayTokens], ..prefs };
    assert_eq!(check_state(&display_menu_entries(&prefs), MenuCommand::ToggleTrayIcon), (false, true));
}

#[test]
fn the_panel_menu_never_contains_display_commands() {
    let home = tempfile::tempdir().unwrap();
    let mut model = AppModel::new(crate::platform::paths_from(home.path(), |_| None), None);
    model.prefs.tray_metrics = vec![TrayMetric::TodayTokens, TrayMetric::InFlight];
    assert!(entries(&model).iter().all(|entry| match entry {
        MenuEntry::Item { command, .. } | MenuEntry::Check { command, .. } =>
            !matches!(command, MenuCommand::TrayMetric(_) | MenuCommand::ToggleTrayIcon),
        MenuEntry::Separator => true,
    }));
}
