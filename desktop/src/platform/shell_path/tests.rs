use super::*;

#[test]
fn appending_the_shims_dir_is_idempotent_and_preserves_other_entries() {
    let dir = r"C:\Users\Zoë Chen\AppData\Local\aio-proxy-desktop\bin\shims";
    let v = r"%USERPROFILE%\bin;C:\Tools;";
    let once = path_with(v, dir);
    assert_eq!(once, format!(r"%USERPROFILE%\bin;C:\Tools;{dir}"));
    assert_eq!(path_with(&once, &dir.to_uppercase()), once);
    assert_eq!(path_with(&format!("{once}\\"), dir), format!("{once}\\"));
    assert_eq!(path_without(&once, dir), r"%USERPROFILE%\bin;C:\Tools");
    assert_eq!(path_with("", dir), dir);
}

#[test]
fn a_shim_forwards_all_arguments_to_the_target() {
    assert_eq!(shim_text(Path::new(r"C:\a b\aio-proxy.exe")), "@\"C:\\a b\\aio-proxy.exe\" %*\r\n");
}
