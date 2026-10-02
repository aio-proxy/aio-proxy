use std::cell::Cell;
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::*;

const STABLE: &str = "/data/bin/aio-proxy";

fn plan(installed: Option<Option<String>>) -> CopyPlan {
    plan_copy(installed, "0.40.0", Path::new(STABLE))
}

#[test]
fn copy_plan_never_downgrades_and_never_ranks_the_unreadable() {
    assert_eq!(plan(None), CopyPlan::Replace);
    assert_eq!(plan(Some(Some("0.39.0".into()))), CopyPlan::Replace);
    assert_eq!(plan(Some(Some("0.40.0".into()))), CopyPlan::Keep);
    assert_eq!(
        plan(Some(Some("0.41.0".into()))),
        CopyPlan::Refuse(ReadOnlyReason::NewerCopy { app: PathBuf::from(STABLE), version: "0.41.0".into() })
    );
    assert_eq!(plan(Some(None)), CopyPlan::Refuse(ReadOnlyReason::UnreadableCopy { app: PathBuf::from(STABLE) }));
    assert!(matches!(plan(Some(Some("garbage".into()))), CopyPlan::Refuse(ReadOnlyReason::UnreadableCopy { .. })));
}

/// `<dir>/bin/aio-proxy` holding "old" and `<dir>/sidecar` holding "new".
fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let (stable, sidecar) = (dir.path().join("bin/aio-proxy"), dir.path().join("sidecar"));
    fs::create_dir_all(stable.parent().unwrap()).unwrap();
    fs::write(&stable, b"old").unwrap();
    fs::write(&sidecar, b"new").unwrap();
    (dir, stable, sidecar)
}

#[test]
fn a_staged_copy_reporting_another_version_is_discarded_and_the_old_copy_stays() {
    let (dir, stable, sidecar) = setup();
    assert!(replace_copy(&stable, &sidecar, "0.40.0", |_| Some("0.39.9".into())).is_err());
    assert_eq!(fs::read(&stable).unwrap(), b"old");
    assert!(!dir.path().join("bin/.aio-proxy.tmp").exists());
}

#[test]
fn a_successful_replace_swaps_the_bytes() {
    let (dir, stable, sidecar) = setup();
    let probed = std::cell::RefCell::new(None);
    replace_copy(&stable, &sidecar, "0.40.0", |path| {
        *probed.borrow_mut() = Some(fs::read(path).unwrap());
        Some("0.40.0".into())
    })
    .unwrap();
    assert_eq!(probed.into_inner().unwrap(), b"new", "the staged copy is what gets verified");
    assert_eq!(fs::read(&stable).unwrap(), b"new");
    assert!(!dir.path().join("bin/.aio-proxy.tmp").exists());
}

#[test]
fn prepare_installs_a_missing_copy_and_keeps_an_equal_one() {
    let dir = tempfile::tempdir().unwrap();
    let paths = crate::platform::paths_from(dir.path(), |_| None);
    let sidecar = dir.path().join("app/aio-proxy");
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    fs::write(&sidecar, b"new").unwrap();
    #[cfg(unix)]
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();

    assert_eq!(prepare(&paths, &sidecar, "0.40.0", |_| Some("0.40.0".into())), InstallState::Persistent);
    assert_eq!(fs::read(&paths.stable).unwrap(), b"new");

    fs::write(&sidecar, b"newer build, same version").unwrap();
    assert_eq!(prepare(&paths, &sidecar, "0.40.0", |_| Some("0.40.0".into())), InstallState::Persistent);
    assert_eq!(fs::read(&paths.stable).unwrap(), b"new", "an equal copy is kept");

    assert_eq!(
        prepare(&paths, &sidecar, "0.40.0", |_| Some("0.41.0".into())),
        InstallState::ReadOnly(ReadOnlyReason::NewerCopy { app: paths.stable.clone(), version: "0.41.0".into() })
    );
}

#[test]
fn prepare_without_a_sidecar_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let paths = crate::platform::paths_from(dir.path(), |_| None);
    let state = prepare(&paths, &dir.path().join("missing"), "0.40.0", |_| Some("0.40.0".into()));
    assert_eq!(state, InstallState::ReadOnly(ReadOnlyReason::Location));
    assert!(!paths.stable.exists());
}

#[cfg(unix)]
#[test]
fn the_sidecar_mount_being_read_only_does_not_block_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let mount = dir.path().join("mount");
    fs::create_dir_all(&mount).unwrap();
    let sidecar = mount.join("aio-proxy");
    fs::write(&sidecar, b"bin").unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&mount, fs::Permissions::from_mode(0o555)).unwrap();
    let stable_dir = dir.path().join("data/bin");
    let result = persistent(&sidecar, &stable_dir);
    fs::set_permissions(&mount, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(result);
    assert_eq!(fs::read_dir(&stable_dir).unwrap().count(), 0, "the write probe is removed");
}

#[cfg(unix)]
#[test]
fn a_non_executable_sidecar_or_unwritable_stable_dir_is_not_persistent() {
    let dir = tempfile::tempdir().unwrap();
    let sidecar = dir.path().join("aio-proxy");
    fs::write(&sidecar, b"bin").unwrap();
    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!persistent(&sidecar, &dir.path().join("bin")));

    fs::set_permissions(&sidecar, fs::Permissions::from_mode(0o755)).unwrap();
    let locked = dir.path().join("locked");
    fs::create_dir_all(&locked).unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    let result = persistent(&sidecar, &locked);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(!result);
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<_> =
        fs::read_dir(dir).unwrap().map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

#[test]
fn the_windows_commit_moves_the_running_copy_aside() {
    let (dir, stable, _) = setup();
    let temp = dir.path().join("bin/.aio-proxy.tmp");
    fs::write(&temp, b"new").unwrap();
    commit_windows(&stable, &temp, |from, to| fs::rename(from, to)).unwrap();
    assert_eq!(fs::read(&stable).unwrap(), b"new");
    assert_eq!(names(&dir.path().join("bin")), ["aio-proxy"]);
}

#[test]
fn a_failed_windows_commit_puts_the_old_copy_back() {
    let (dir, stable, _) = setup();
    let temp = dir.path().join("bin/.aio-proxy.tmp");
    fs::write(&temp, b"new").unwrap();
    let calls = Cell::new(0);
    let result = commit_windows(&stable, &temp, |from, to| {
        calls.set(calls.get() + 1);
        if calls.get() == 2 { Err(io::Error::other("locked")) } else { fs::rename(from, to) }
    });
    assert!(result.is_err());
    assert_eq!(fs::read(&stable).unwrap(), b"old");
    assert_eq!(names(&dir.path().join("bin")), [".aio-proxy.tmp", "aio-proxy"]);
}

#[test]
fn recovery_restores_the_newest_backup_and_deletes_the_rest() {
    let dir = tempfile::tempdir().unwrap();
    let stable = dir.path().join("aio-proxy.exe");
    let backup = |pid: u32, body: &str, age: u64| {
        let path = dir.path().join(format!("aio-proxy.exe.old-{pid}"));
        fs::write(&path, body).unwrap();
        let time = std::time::SystemTime::now() - std::time::Duration::from_secs(age);
        fs::File::options().write(true).open(&path).unwrap().set_modified(time).unwrap();
    };
    backup(10, "oldest", 300);
    backup(20, "newest", 10);
    backup(30, "middle", 100);
    recover_backups_windows(&stable).unwrap();
    assert_eq!(fs::read(&stable).unwrap(), b"newest");
    assert_eq!(names(dir.path()), ["aio-proxy.exe"]);

    backup(40, "stale", 0);
    recover_backups_windows(&stable).unwrap();
    assert_eq!(fs::read(&stable).unwrap(), b"newest", "a present copy is never replaced by a backup");
    assert_eq!(names(dir.path()), ["aio-proxy.exe"]);
}
