//! The copy model (Linux and Windows): the stable exec is a real copy of the sidecar, replaced by
//! stage, verify, commit, and never downgraded. An AppImage's sidecar lives only under its
//! temporary mount, and a running Windows `.exe` is locked, so a symlink fits neither.

use std::cmp::Ordering;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use super::{InstallState, Paths, ReadOnlyReason};
use crate::log;
use crate::version;

/// Beside the stable copy, so the commit is a same-directory rename.
/// An `.exe` suffix on Windows, so CreateProcess never relies on extension fallback.
const STAGED: &str = if cfg!(windows) { ".aio-proxy.tmp.exe" } else { ".aio-proxy.tmp" };

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopyPlan {
    Keep,
    Replace,
    Refuse(ReadOnlyReason),
}

/// `installed`: `None` = no copy; `Some(None)` = a copy whose version could not be read. A refusal
/// names `stable` itself: the copy has no app of its own to point at.
pub fn plan_copy(installed: Option<Option<String>>, own_version: &str, stable: &Path) -> CopyPlan {
    let Some(found) = installed else {
        return CopyPlan::Replace;
    };
    let app = stable.to_path_buf();
    match (found.as_deref().and_then(|found| version::compare(found, own_version)), found) {
        (Some(Ordering::Less), _) => CopyPlan::Replace,
        (Some(Ordering::Equal), _) => CopyPlan::Keep,
        (Some(Ordering::Greater), Some(version)) => CopyPlan::Refuse(ReadOnlyReason::NewerCopy { app, version }),
        _ => CopyPlan::Refuse(ReadOnlyReason::UnreadableCopy { app }),
    }
}

/// Copies `sidecar` to a temp beside `stable`, runs it, and commits only when it reports
/// `own_version`. On any failure the temp is gone and `stable` is what it was.
pub fn replace_copy(
    stable: &Path,
    sidecar: &Path,
    own_version: &str,
    probe: impl Fn(&Path) -> Option<String>,
) -> io::Result<()> {
    let dir = stable.parent().ok_or_else(|| io::Error::other("the stable exec has no parent"))?;
    fs::create_dir_all(dir)?;
    let temp = dir.join(STAGED);
    let result = stage(&temp, sidecar, own_version, probe).and_then(|()| commit(stable, &temp));
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn stage(temp: &Path, sidecar: &Path, own_version: &str, probe: impl Fn(&Path) -> Option<String>) -> io::Result<()> {
    let _ = fs::remove_file(temp);
    fs::copy(sidecar, temp)?;
    match probe(temp) {
        Some(found) if version::compare(&found, own_version) == Some(Ordering::Equal) => Ok(()),
        found => Err(io::Error::other(format!(
            "the staged copy reports {} instead of {own_version}",
            found.as_deref().unwrap_or("no version")
        ))),
    }
}

/// Linux: one atomic rename, and a running process keeps the old inode.
fn commit(stable: &Path, temp: &Path) -> io::Result<()> {
    if cfg!(windows) { commit_windows(stable, temp, |from, to| fs::rename(from, to)) } else { fs::rename(temp, stable) }
}

/// A running `.exe` cannot be overwritten but can be renamed: move it to `.old-<pid>-<nanos>`, move
/// the temp in, and move the old one straight back if that fails. A crash in between is healed by
/// `recover_backups` on the next start. The timestamp keeps the name unique: a backup the old
/// supervisor still runs cannot be deleted, and Windows may give a later process the same PID.
pub fn commit_windows(stable: &Path, temp: &Path, rename: impl Fn(&Path, &Path) -> io::Result<()>) -> io::Result<()> {
    let name = stable.file_name().unwrap_or_default().to_string_lossy();
    let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_nanos();
    let backup = stable.with_file_name(format!("{name}.old-{}-{nanos}", std::process::id()));
    let backed_up = match rename(stable, &backup) {
        Ok(()) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    if let Err(error) = rename(temp, stable) {
        if backed_up {
            let _ = rename(&backup, stable);
        }
        return Err(error);
    }
    // Fails while the old copy still runs; a later start's recovery deletes it.
    let _ = fs::remove_file(&backup);
    Ok(())
}

/// Startup recovery, before the no-downgrade check. Only Windows commits leave backups.
pub fn recover_backups(stable: &Path) -> io::Result<()> {
    if cfg!(windows) { recover_backups_windows(stable) } else { Ok(()) }
}

/// A missing copy gets the newest `.old-*` back; every other backup is deleted (best effort).
pub fn recover_backups_windows(stable: &Path) -> io::Result<()> {
    let (Some(dir), Some(name)) = (stable.parent(), stable.file_name()) else {
        return Ok(());
    };
    let prefix = format!("{}.old-", name.to_string_lossy());
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut backups: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .map(|entry| {
            (entry.metadata().and_then(|meta| meta.modified()).unwrap_or(SystemTime::UNIX_EPOCH), entry.path())
        })
        .collect();
    backups.sort();
    if !stable.try_exists()?
        && let Some((_, newest)) = backups.pop()
    {
        fs::rename(&newest, stable)?;
    }
    for (_, backup) in backups {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

/// The sidecar can run and the stable copy's directory takes writes. The sidecar's own volume is
/// never checked: an AppImage mount is always read-only.
pub fn persistent(sidecar: &Path, stable_dir: &Path) -> bool {
    executable(sidecar) && writable(stable_dir)
}

/// A regular file the OS will run (a directory, or a file without an execute bit, is not).
#[cfg(unix)]
pub fn executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
pub fn executable(path: &Path) -> bool {
    path.is_file()
}

fn writable(dir: &Path) -> bool {
    let probe = dir.join(format!(".write-probe-{}", std::process::id()));
    fs::create_dir_all(dir).is_ok() && fs::write(&probe, b"").is_ok() && fs::remove_file(&probe).is_ok()
}

/// Startup install step off macOS. Without a runnable sidecar or a writable data directory nothing
/// on disk changes.
pub fn prepare(
    paths: &Paths,
    sidecar: &Path,
    own_version: &str,
    probe: impl Fn(&Path) -> Option<String>,
) -> InstallState {
    let stable = &paths.stable;
    if let Err(error) = recover_backups(stable) {
        log::info(format!("install: backup recovery failed: {error}"));
    }
    if !stable.parent().is_some_and(|dir| persistent(sidecar, dir)) {
        return InstallState::ReadOnly(ReadOnlyReason::Location);
    }
    // Only a definite "absent" is missing; anything else is a copy we cannot rank.
    let installed = match stable.try_exists() {
        Ok(false) => None,
        Ok(true) => Some(probe(stable)),
        Err(_) => Some(None),
    };
    match plan_copy(installed, own_version, stable) {
        CopyPlan::Keep => InstallState::Persistent,
        CopyPlan::Replace => match replace_copy(stable, sidecar, own_version, probe) {
            Ok(()) => InstallState::Persistent,
            Err(error) => InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(error.to_string())),
        },
        CopyPlan::Refuse(reason) => InstallState::ReadOnly(reason),
    }
}

#[cfg(test)]
mod tests;
