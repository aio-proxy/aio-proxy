use super::*;

const FILE_PATH: &str = "autostart/aio-proxy-desktop.desktop";

#[test]
fn enabling_then_moving_the_appimage_heals_on_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let a = Path::new("/home/u/Apps/AIO Proxy.AppImage");
    set_enabled_at(dir.path(), Some(a), true).unwrap();
    assert_eq!(status_at(dir.path(), Some(a)), LoginItemStatus::Enabled);
    let b = Path::new("/home/u/Downloads/AIO Proxy.AppImage");
    assert_eq!(status_at(dir.path(), Some(b)), LoginItemStatus::NotRegistered);
    refresh_exec(dir.path(), Some(b)).unwrap();
    let text = fs::read_to_string(dir.path().join(FILE_PATH)).unwrap();
    assert!(text.contains("Exec=\"/home/u/Downloads/AIO Proxy.AppImage\""));
    set_enabled_at(dir.path(), Some(b), false).unwrap();
    assert_eq!(status_at(dir.path(), Some(b)), LoginItemStatus::NotRegistered);
}

#[test]
fn refresh_leaves_a_disabled_login_item_disabled() {
    let dir = tempfile::tempdir().unwrap();
    refresh_exec(dir.path(), Some(Path::new("/a.AppImage"))).unwrap();
    assert!(!dir.path().join(FILE_PATH).exists());
}

#[test]
fn without_an_appimage_the_login_item_is_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(status_at(dir.path(), None), LoginItemStatus::Unavailable);
    assert!(set_enabled_at(dir.path(), None, true).is_err());
}

#[test]
fn exec_quoting_escapes_shell_and_field_code_characters() {
    assert_eq!(exec_line(Path::new("/a \"b\"/$c`d\\e%f")), "Exec=\"/a \\\"b\\\"/\\$c\\`d\\\\e%%f\"");
}
