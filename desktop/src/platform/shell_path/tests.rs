use super::*;

#[test]
fn appending_the_shims_dir_is_idempotent_and_preserves_other_entries() {
    let dir = r"C:\Users\Zoë Chen\AppData\Local\aio-proxy-desktop\bin\shims";
    let v = r"%USERPROFILE%\bin;C:\Tools;";
    let once = path_with(v, dir);
    assert_eq!(once, format!(r"%USERPROFILE%\bin;C:\Tools;{dir}"));
    assert_eq!(path_with(&once, &dir.to_uppercase()), once);
    assert_eq!(path_with(&format!("{once}\\"), dir), format!("{once}\\"));
    assert_eq!(path_with("", dir), dir);
}

#[test]
fn a_shim_reaches_the_stable_copy_without_naming_the_profile() {
    // Pure ASCII and no absolute path, so the console code page and `%` in the profile cannot matter.
    assert!(SHIM_TEXT.is_ascii());
    assert!(!SHIM_TEXT.contains(':'));
}
