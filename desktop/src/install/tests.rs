use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::*;

const HOME: &str = "/Users/me";

fn allowed(bundle: &str) -> bool {
    location_allows_persistence(Path::new(bundle), Path::new(HOME), false)
}

// The Applications-folder persistence model is macOS-only.
#[cfg(target_os = "macos")]
#[test]
fn only_an_applications_folder_on_a_writable_volume_is_persistent() {
    assert!(allowed("/Applications/AIO Proxy.app"));
    assert!(allowed("/Applications/Utilities/AIO Proxy.app"));
    assert!(allowed("/Users/me/Applications/AIO Proxy.app"));
    for bundle in [
        "/Volumes/AIO Proxy/AIO Proxy.app",
        "/Users/me/Downloads/AIO Proxy.app",
        "/private/var/folders/xy/T/AppTranslocation/1234/d/AIO Proxy.app",
        "/Applications2/AIO Proxy.app",
        "/Applications/../tmp/AIO Proxy.app",
        "/Applications",
        "Applications/AIO Proxy.app",
        "/Users/other/Applications/AIO Proxy.app",
    ] {
        assert!(!allowed(bundle), "{bundle}");
    }
    assert!(!location_allows_persistence(Path::new("/Applications/AIO Proxy.app"), Path::new(HOME), true));
}

#[cfg(target_os = "macos")]
#[test]
fn finds_the_bundle_from_the_executable() {
    assert_eq!(
        bundle_of(Path::new("/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop")),
        Some(PathBuf::from("/Applications/AIO Proxy.app"))
    );
    assert_eq!(bundle_of(Path::new("/Users/me/desktop/target/debug/aio-proxy-desktop")), None);
}

#[cfg(unix)]
#[test]
fn an_appimage_runs_the_sidecar_from_its_mount() {
    let exe = Path::new("/opt/aio/aio-proxy-desktop");
    assert_eq!(sidecar_dir(exe, Some("/tmp/.mount_aio".into())), Some(PathBuf::from("/tmp/.mount_aio/usr/bin")));
    assert_eq!(sidecar_dir(exe, Some("relative".into())), Some(PathBuf::from("/opt/aio")));
    assert_eq!(sidecar_dir(exe, None), Some(PathBuf::from("/opt/aio")));
}

struct Fixture {
    _dir: tempfile::TempDir,
    paths: Paths,
    bundle: PathBuf,
    other: PathBuf,
}

/// A fake home with this app's bundle and another installed copy, each holding a sidecar file.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let paths = crate::platform::paths_from(dir.path(), |_| None);
    let make = |name: &str| {
        let bundle = dir.path().join(name);
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        fs::write(sidecar_of(&bundle), b"#!/bin/sh\n").unwrap();
        bundle
    };
    let bundle = make("Applications/AIO Proxy.app");
    let other = make("Other/AIO Proxy.app");
    Fixture { _dir: dir, paths, bundle, other }
}

#[test]
fn outside_an_applications_folder_nothing_persistent_happens() {
    let f = fixture();
    let state = prepare(&f.paths, &f.bundle, false, "0.37.0", |_| panic!("must not probe"));
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::Location));
    assert!(fs::symlink_metadata(&f.paths.stable).is_err(), "no symlink may be created");
}

#[test]
fn a_missing_or_dangling_symlink_is_pointed_at_this_copy() {
    let f = fixture();
    assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None), InstallState::Persistent);
    assert_eq!(fs::read_link(&f.paths.stable).unwrap(), sidecar_of(&f.bundle));

    repoint(&f.paths.stable, Path::new("/nonexistent/AIO Proxy.app/Contents/MacOS/aio-proxy")).unwrap();
    assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None), InstallState::Persistent);
    assert_eq!(fs::read_link(&f.paths.stable).unwrap(), sidecar_of(&f.bundle));
}

/// Names the `.app` bundle, a macOS-only layout.
#[cfg(target_os = "macos")]
#[test]
fn a_newer_installed_copy_is_never_repointed_to_an_older_one() {
    let f = fixture();
    repoint(&f.paths.stable, &sidecar_of(&f.other)).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| Some("0.38.0".into()));
    assert_eq!(
        state,
        InstallState::ReadOnly(ReadOnlyReason::NewerCopy { app: f.other.clone(), version: "0.38.0".into() })
    );
    assert_eq!(fs::read_link(&f.paths.stable).unwrap(), sidecar_of(&f.other));
}

#[test]
fn an_older_or_equal_copy_is_repointed_to_this_one() {
    for found in ["0.36.9", "0.37.0"] {
        let f = fixture();
        repoint(&f.paths.stable, &sidecar_of(&f.other)).unwrap();
        assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| Some(found.into())), InstallState::Persistent);
        assert_eq!(fs::read_link(&f.paths.stable).unwrap(), sidecar_of(&f.bundle));
    }
}

/// Names the `.app` bundle, a macOS-only layout.
#[cfg(target_os = "macos")]
#[test]
fn an_unreadable_installed_copy_is_left_alone() {
    let f = fixture();
    repoint(&f.paths.stable, &sidecar_of(&f.other)).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None);
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::UnreadableCopy { app: f.other.clone() }));
    assert_eq!(fs::read_link(&f.paths.stable).unwrap(), sidecar_of(&f.other));
}

#[test]
fn a_second_instance_cannot_take_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("support/instance.lock");
    let first = acquire_instance_lock(&lock).unwrap().expect("the first copy takes the lock");
    assert!(acquire_instance_lock(&lock).unwrap().is_none(), "a second copy must exit");
    drop(first);
    assert!(acquire_instance_lock(&lock).unwrap().is_some(), "exiting releases the lock");
}

#[cfg(unix)]
#[test]
fn probes_a_copy_version_with_its_cli() {
    let dir = tempfile::tempdir().unwrap();
    let exec = dir.path().join("aio-proxy");
    fs::write(&exec, "#!/bin/sh\necho 0.38.0\n").unwrap();
    fs::set_permissions(&exec, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(probe_version(&exec).as_deref(), Some("0.38.0"));
    assert_eq!(probe_version(&dir.path().join("missing")), None);
}

#[test]
fn something_that_is_not_a_symlink_is_never_renamed_over() {
    let f = fixture();
    fs::create_dir_all(f.paths.stable.parent().unwrap()).unwrap();
    fs::write(&f.paths.stable, b"user data").unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| panic!("must not probe"));
    assert!(matches!(state, InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(_))), "{state:?}");
    assert_eq!(fs::read(&f.paths.stable).unwrap(), b"user data");
    assert!(!fs::symlink_metadata(&f.paths.stable).unwrap().is_symlink());
}

#[test]
fn a_target_that_cannot_be_stat_ed_is_not_treated_as_missing() {
    let f = fixture();
    let (a, b) = (f.paths.home.join("loop-a"), f.paths.home.join("loop-b"));
    repoint(&a, &b).unwrap();
    repoint(&b, &a).unwrap();
    repoint(&f.paths.stable, &a).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| panic!("must not probe"));
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::UnreadableCopy { app: a.clone() }));
    assert_eq!(fs::read_link(&f.paths.stable).unwrap(), a);
}

// Symlink repoint; Windows copies a sidecar instead.
#[cfg(unix)]
#[test]
fn a_failed_repoint_leaves_the_original_and_no_temp_file() {
    let f = fixture();
    // A non-empty directory at the link path makes the final rename fail.
    fs::create_dir_all(f.paths.stable.join("keep")).unwrap();
    assert!(repoint(&f.paths.stable, &sidecar_of(&f.bundle)).is_err());
    assert!(f.paths.stable.join("keep").is_dir());
    let leftovers: Vec<_> =
        fs::read_dir(f.paths.stable.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(leftovers, ["aio-proxy"], "temp symlink must be removed");
}
