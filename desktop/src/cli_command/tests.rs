use std::fs;

use super::*;

#[test]
fn only_marker_lines_answer_the_probe() {
    let dir = link_dir_on_path_target().unwrap().display().to_string();
    let probe = parse_probe(&format!("welcome back\n{MARK}aio-proxy\n{MARK}path:/opt/homebrew/bin:{dir}/\n"));
    assert_eq!(probe, Some(Probe { aiop: false, aio_proxy: true, link_dir_on_path: true }));
    // fish's PATH, and one whose rc files dropped the link directory.
    assert_eq!(parse_probe(&format!("{MARK}path:{dir} /usr/bin\n")).map(|p| p.link_dir_on_path), Some(true));
    assert_eq!(parse_probe(&format!("{MARK}path:/usr/bin:/bin\n")).map(|p| p.link_dir_on_path), Some(false));
    // The shell died in its rc files before the lookups ran: unknown, never "missing".
    assert_eq!(parse_probe(""), None);
    assert_eq!(parse_probe(&format!("zsh: bad option: -i\n{MARK}aiop\n")), None);
}

#[test]
fn a_link_dir_the_session_lacks_works_only_after_the_next_login() {
    let aiop = Path::new("/home/me/.local/bin/aiop");
    let on = std::ffi::OsString::from("/usr/bin:/home/me/.local/bin");
    assert_eq!(installed_notice(aiop, Some(&on)), "Installed aiop at /home/me/.local/bin/aiop.");
    let off = std::ffi::OsString::from("/usr/bin:/bin");
    assert!(installed_notice(aiop, Some(&off)).ends_with("It works after you log out and back in."));
}

// Exercises the macOS /usr/local/bin install.
#[cfg(target_os = "macos")]
#[test]
fn links_aiop_and_a_free_aio_proxy_through_awkward_paths() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("with space/it's/bin");
    let target = dir.path().join("Application Support/aio-proxy");
    let (aiop, long) = (bin.join("aiop"), bin.join("aio-proxy"));
    assert_eq!(link(&target, &aiop, Some(&long), false), Ok(true));
    assert_eq!(fs::read_link(&aiop).unwrap(), target);
    assert_eq!(fs::read_link(&long).unwrap(), target);
}

// Exercises the macOS /usr/local/bin install.
#[cfg(target_os = "macos")]
#[test]
fn an_existing_aio_proxy_is_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("aio-proxy-desktop");
    let (aiop, long) = (dir.path().join("aiop"), dir.path().join("aio-proxy"));
    fs::write(&long, "npm copy").unwrap();
    assert_eq!(link(&target, &aiop, Some(&long), false), Ok(true));
    assert_eq!(fs::read_link(&aiop).unwrap(), target);
    assert_eq!(fs::read_to_string(&long).unwrap(), "npm copy");
}

// Exercises the macOS /usr/local/bin install.
#[cfg(target_os = "macos")]
#[test]
fn a_foreign_aiop_is_refused_while_ours_and_dangling_ones_are_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("AIO Proxy.app/Contents/MacOS/aio-proxy");
    let (aiop, long) = (dir.path().join("aiop"), dir.path().join("aio-proxy"));
    fs::write(&aiop, "installed after the probe").unwrap();
    assert!(link(&target, &aiop, Some(&long), false).unwrap_err().contains("already exists"));
    assert_eq!(fs::read_to_string(&aiop).unwrap(), "installed after the probe");

    fs::remove_file(&aiop).unwrap();
    std::os::unix::fs::symlink(dir.path().join("moved away"), &aiop).unwrap();
    assert_eq!(link(&target, &aiop, Some(&long), false), Ok(true));
    // Ours already: installing again is a no-op, not a refusal.
    assert_eq!(link(&target, &aiop, Some(&long), false), Ok(true));
    assert_eq!(fs::read_link(&aiop).unwrap(), target);
}

// Exercises the macOS /usr/local/bin install.
#[cfg(target_os = "macos")]
#[test]
fn no_alias_is_linked_when_aio_proxy_resolves_elsewhere() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("aio-proxy-desktop");
    let aiop = dir.path().join("aiop");
    assert_eq!(link(&target, &aiop, None, false), Ok(true));
    assert_eq!(fs::read_link(&aiop).unwrap(), target);
    assert!(!dir.path().join("aio-proxy").exists());
}

#[test]
fn links_aiop_and_only_a_free_aio_proxy_name() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("stable/aio-proxy");
    let taken = Probe { aiop: false, aio_proxy: true, link_dir_on_path: true };
    let made = install_links(dir.path(), &target, taken).unwrap();
    assert_eq!(made, vec![dir.path().join("aiop")]);
    assert_eq!(fs::read_link(dir.path().join("aiop")).unwrap(), target);
    assert!(!dir.path().join("aio-proxy").exists());
}

#[test]
fn an_existing_aiop_is_never_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let aiop = dir.path().join("aiop");
    fs::write(&aiop, "someone else's").unwrap();
    let free = Probe { aiop: false, aio_proxy: false, link_dir_on_path: true };
    assert!(install_links(dir.path(), &dir.path().join("target"), free).is_err());
    assert_eq!(fs::read_to_string(&aiop).unwrap(), "someone else's");
}
