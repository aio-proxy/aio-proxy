use super::*;

#[test]
fn run_value_matches_only_this_executable() {
    let exe = Path::new(r"C:\Users\Zoë Chen\AppData\Local\Programs\AIO Proxy\aio-proxy-desktop.exe");
    assert!(run_value_matches(r#""C:\Users\Zoë Chen\AppData\Local\Programs\AIO Proxy\aio-proxy-desktop.exe""#, exe));
    assert!(run_value_matches(r#""c:\users\zoë chen\appdata\local\programs\aio proxy\aio-proxy-desktop.exe""#, exe));
    assert!(!run_value_matches(r#""C:\Other\aio-proxy-desktop.exe""#, exe));
}

#[cfg(windows)]
#[test]
fn enabling_writes_a_quoted_run_value_and_disabling_removes_it() {
    let name = format!("AIO Proxy test {}", std::process::id());
    let exe = Path::new(r"C:\Program Files\AIO Proxy\aio-proxy-desktop.exe");
    let other = Path::new(r"C:\Elsewhere\aio-proxy-desktop.exe");
    assert_eq!(status_at(&name, exe), LoginItemStatus::NotRegistered);
    set_enabled_at(&name, exe, true).unwrap();
    let raw = CURRENT_USER.open(RUN_KEY).unwrap().get_string(&name).unwrap();
    assert_eq!(raw, format!("\"{}\"", exe.display()));
    assert_eq!(status_at(&name, exe), LoginItemStatus::Enabled);
    assert_eq!(status_at(&name, other), LoginItemStatus::NotRegistered);
    set_enabled_at(&name, other, true).unwrap();
    assert_eq!(status_at(&name, other), LoginItemStatus::Enabled);
    set_enabled_at(&name, other, false).unwrap();
    assert_eq!(status_at(&name, other), LoginItemStatus::NotRegistered);
    set_enabled_at(&name, other, false).unwrap();
}
