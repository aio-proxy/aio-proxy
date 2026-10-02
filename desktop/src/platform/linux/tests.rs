use super::tray_color_for;

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
