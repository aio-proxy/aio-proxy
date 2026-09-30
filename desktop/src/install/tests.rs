use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::*;

const HOME: &str = "/Users/me";

fn allowed(bundle: &str) -> bool {
    location_allows_persistence(Path::new(bundle), Path::new(HOME), false)
}

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

#[test]
fn finds_the_bundle_from_the_executable() {
    assert_eq!(
        bundle_of(Path::new("/Applications/AIO Proxy.app/Contents/MacOS/aio-proxy-desktop")),
        Some(PathBuf::from("/Applications/AIO Proxy.app"))
    );
    assert_eq!(bundle_of(Path::new("/Users/me/desktop/target/debug/aio-proxy-desktop")), None);
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
    let paths = Paths::for_home(dir.path());
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
    assert!(fs::symlink_metadata(&f.paths.symlink).is_err(), "no symlink may be created");
}

#[test]
fn a_missing_or_dangling_symlink_is_pointed_at_this_copy() {
    let f = fixture();
    assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None), InstallState::Persistent);
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.bundle));

    repoint(&f.paths.symlink, Path::new("/nonexistent/AIO Proxy.app/Contents/MacOS/aio-proxy")).unwrap();
    assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None), InstallState::Persistent);
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.bundle));
}

#[test]
fn a_newer_installed_copy_is_never_repointed_to_an_older_one() {
    let f = fixture();
    repoint(&f.paths.symlink, &sidecar_of(&f.other)).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| Some("0.38.0".into()));
    assert_eq!(
        state,
        InstallState::ReadOnly(ReadOnlyReason::NewerCopy { app: f.other.clone(), version: "0.38.0".into() })
    );
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.other));
}

#[test]
fn an_older_or_equal_copy_is_repointed_to_this_one() {
    for found in ["0.36.9", "0.37.0"] {
        let f = fixture();
        repoint(&f.paths.symlink, &sidecar_of(&f.other)).unwrap();
        assert_eq!(prepare(&f.paths, &f.bundle, true, "0.37.0", |_| Some(found.into())), InstallState::Persistent);
        assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.bundle));
    }
}

#[test]
fn an_unreadable_installed_copy_is_left_alone() {
    let f = fixture();
    repoint(&f.paths.symlink, &sidecar_of(&f.other)).unwrap();
    let state = prepare(&f.paths, &f.bundle, true, "0.37.0", |_| None);
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::UnreadableCopy { app: f.other.clone() }));
    assert_eq!(fs::read_link(&f.paths.symlink).unwrap(), sidecar_of(&f.other));
}

#[test]
fn a_second_instance_cannot_take_the_lock() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("support/instance.lock");
    let _first = acquire_instance_lock(&lock).unwrap().expect("the first copy takes the lock");
    assert!(acquire_instance_lock(&lock).unwrap().is_none(), "a second copy must exit");
}

#[test]
fn probes_a_copy_version_with_its_cli() {
    let dir = tempfile::tempdir().unwrap();
    let exec = dir.path().join("aio-proxy");
    fs::write(&exec, "#!/bin/sh\necho 0.38.0\n").unwrap();
    fs::set_permissions(&exec, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(probe_version(&exec).as_deref(), Some("0.38.0"));
    assert_eq!(probe_version(&dir.path().join("missing")), None);
}
