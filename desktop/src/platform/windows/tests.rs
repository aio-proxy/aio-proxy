use std::path::Path;

use super::paths_from;

#[test]
fn the_instance_lock_lives_in_the_temp_directory_not_the_install_directory() {
    let paths = paths_from(Path::new(r"C:\Users\me"), |name| match name {
        "LOCALAPPDATA" => Some(r"C:\Users\me\AppData\Local".into()),
        "TEMP" => Some(r"C:\Users\me\AppData\Local\Temp".into()),
        _ => None,
    });
    assert_eq!(paths.lock, Path::new(r"C:\Users\me\AppData\Local\Temp\aio-proxy-desktop.lock"));
    assert!(!paths.lock.starts_with(&paths.support), "an unwritable install directory must not block the lock");
}
