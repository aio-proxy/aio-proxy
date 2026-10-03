use super::{paths_from, tray_color_for};

const WHITE: [u8; 3] = [255, 255, 255];
const BLACK: [u8; 3] = [0, 0, 0];

#[test]
fn the_tray_icon_is_white_on_gnome_in_either_theme() {
    assert_eq!(tray_color_for(Some("ubuntu:GNOME"), false), WHITE);
    assert_eq!(tray_color_for(Some("gnome"), false), WHITE);
    assert_eq!(tray_color_for(Some("GNOME"), true), WHITE);
}

#[test]
fn the_tray_icon_follows_the_theme_elsewhere() {
    assert_eq!(tray_color_for(Some("KDE"), false), BLACK);
    assert_eq!(tray_color_for(Some("KDE"), true), WHITE);
    assert_eq!(tray_color_for(None, false), BLACK);
}

#[test]
fn the_instance_lock_lives_in_the_state_directory_not_the_install_directory() {
    let home = std::path::Path::new("/home/me");
    let paths = paths_from(home, |name| match name {
        "XDG_DATA_HOME" => Some("/data".into()),
        "XDG_STATE_HOME" => Some("/state".into()),
        _ => None,
    });
    assert_eq!(paths.lock, std::path::Path::new("/state/aio-proxy-desktop/instance.lock"));
    assert!(!paths.lock.starts_with(&paths.support), "an unwritable install directory must not block the lock");
}
