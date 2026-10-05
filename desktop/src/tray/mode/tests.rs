use super::*;

#[test]
fn losing_the_tray_host_opens_the_window_and_regaining_it_does_not_close_it() {
    assert_eq!(next_mode(TrayMode::Tray, false), (TrayMode::NoTray, true));
    assert_eq!(next_mode(TrayMode::NoTray, true), (TrayMode::Tray, false));
    assert_eq!(next_mode(TrayMode::Tray, true), (TrayMode::Tray, false));
}

#[test]
fn closing_the_window_quits_only_without_a_tray() {
    assert_eq!(close_action(TrayMode::NoTray), CloseAction::Quit);
    assert_eq!(close_action(TrayMode::Tray), CloseAction::Hide);
}
