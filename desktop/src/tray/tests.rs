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
