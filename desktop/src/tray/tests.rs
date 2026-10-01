use super::*;

#[test]
fn only_a_healthy_proxy_shows_running_or_attention() {
    assert_eq!(tray_state(HealthState::Up, false), TrayState::Running);
    assert_eq!(tray_state(HealthState::Up, true), TrayState::Attention);
    assert_eq!(tray_state(HealthState::Down, true), TrayState::Down);
    assert_eq!(tray_state(HealthState::Unknown, false), TrayState::Down);
}

#[test]
fn the_three_states_have_distinct_icons() {
    let icons = [TrayState::Running, TrayState::Down, TrayState::Attention].map(icon_rgba);
    for icon in &icons {
        assert_eq!(icon.len(), (ICON_PX * ICON_PX * 4) as usize);
        assert!(icon.chunks(4).any(|px| px[3] == 255), "icon is not empty");
    }
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
