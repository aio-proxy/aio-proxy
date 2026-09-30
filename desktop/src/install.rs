//! Install-location policy, the stable symlink, the no-downgrade rule and the single-instance lock.

use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use crate::process::run_with_timeout;
use crate::version;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paths {
    pub home: PathBuf,
    pub support: PathBuf,
    /// `AIO_PROXY_DESKTOP_EXEC`: the only path a desktop-owned plist ever points at.
    pub symlink: PathBuf,
    pub lock: PathBuf,
    /// The app's own log directory.
    pub logs: PathBuf,
}

impl Paths {
    pub fn for_home(home: &Path) -> Self {
        let support = home.join("Library/Application Support/aio-proxy-desktop");
        Self {
            home: home.to_path_buf(),
            symlink: support.join("bin/aio-proxy"),
            lock: support.join("instance.lock"),
            logs: home.join("Library/Logs/aio-proxy-desktop"),
            support,
        }
    }
}

/// `…/X.app/Contents/MacOS/aio-proxy-desktop` → `…/X.app`.
pub fn bundle_of(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let ok = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension().is_some_and(|ext| ext == "app");
    ok.then(|| bundle.to_path_buf())
}

pub fn sidecar_of(bundle: &Path) -> PathBuf {
    bundle.join("Contents/MacOS/aio-proxy")
}

/// `…/X.app/Contents/MacOS/aio-proxy` → `…/X.app`, for naming a copy in a notice.
fn app_of_sidecar(sidecar: &Path) -> PathBuf {
    sidecar
        .ancestors()
        .nth(3)
        .filter(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
        .unwrap_or(sidecar)
        .to_path_buf()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadOnlyReason {
    /// Not in /Applications or ~/Applications on a writable volume: "Move to Applications".
    Location,
    NewerCopy {
        app: PathBuf,
        version: String,
    },
    /// The symlink's target exists but its version could not be read; never overwrite what we cannot rank.
    UnreadableCopy {
        app: PathBuf,
    },
    SymlinkFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallState {
    Persistent,
    ReadOnly(ReadOnlyReason),
}

/// A location policy, not translocation detection: a translocated or mounted copy simply is not
/// under an Applications folder.
pub fn location_allows_persistence(bundle: &Path, home: &Path, read_only_volume: bool) -> bool {
    if read_only_volume || !bundle.is_absolute() {
        return false;
    }
    if bundle.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return false;
    }
    let under = |root: &Path| bundle.starts_with(root) && bundle != root;
    under(Path::new("/Applications")) || under(&home.join("Applications"))
}

/// Unknown counts as read-only.
pub fn volume_is_read_only(path: &Path) -> bool {
    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()) else {
        return true;
    };
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: statvfs writes the struct on success; we read it only then.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stats.as_mut_ptr()) };
    rc != 0 || unsafe { stats.assume_init() }.f_flag & libc::ST_RDONLY != 0
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SymlinkPlan {
    Keep,
    Repoint,
    Refuse(ReadOnlyReason),
}

/// The no-downgrade rule: re-point only when the target is missing or provably not newer.
pub fn plan_symlink(
    current: Option<&Path>,
    own_sidecar: &Path,
    own_version: &str,
    target_version: impl FnOnce(&Path) -> Option<String>,
) -> SymlinkPlan {
    let Some(target) = current else {
        return SymlinkPlan::Repoint;
    };
    if target == own_sidecar {
        return SymlinkPlan::Keep;
    }
    let app = app_of_sidecar(target);
    // Only a definite ENOENT means "missing"; EACCES, ELOOP and friends are a copy we cannot rank.
    match target.try_exists() {
        Ok(true) => {}
        Ok(false) => return SymlinkPlan::Repoint,
        Err(_) => return SymlinkPlan::Refuse(ReadOnlyReason::UnreadableCopy { app }),
    }
    match target_version(target) {
        Some(found) => match version::compare(&found, own_version) {
            Some(Ordering::Greater) => SymlinkPlan::Refuse(ReadOnlyReason::NewerCopy { app, version: found }),
            Some(_) => SymlinkPlan::Repoint,
            None => SymlinkPlan::Refuse(ReadOnlyReason::UnreadableCopy { app }),
        },
        None => SymlinkPlan::Refuse(ReadOnlyReason::UnreadableCopy { app }),
    }
}

/// Create-temp-symlink + rename, so the service never sees a missing link.
pub fn repoint(symlink: &Path, target: &Path) -> io::Result<()> {
    let dir = symlink.parent().ok_or_else(|| io::Error::other("symlink has no parent"))?;
    fs::create_dir_all(dir)?;
    let temp = dir.join(format!(".aio-proxy.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&temp);
    std::os::unix::fs::symlink(target, &temp)?;
    fs::rename(&temp, symlink).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

/// Startup install step. Outside an Applications folder nothing on disk changes.
pub fn prepare(
    paths: &Paths,
    bundle: &Path,
    location_ok: bool,
    own_version: &str,
    target_version: impl FnOnce(&Path) -> Option<String>,
) -> InstallState {
    if !location_ok {
        return InstallState::ReadOnly(ReadOnlyReason::Location);
    }
    let sidecar = sidecar_of(bundle);
    // Anything but "no link there" (a regular file or directory, EACCES, EIO) is something we cannot
    // rank, so it is never renamed over.
    let current = match fs::read_link(&paths.symlink) {
        Ok(target) => Some(target),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
            return InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(format!(
                "{} exists and is not a symlink",
                paths.symlink.display()
            )));
        }
        Err(error) => return InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(error.to_string())),
    };
    match plan_symlink(current.as_deref(), &sidecar, own_version, target_version) {
        SymlinkPlan::Keep => InstallState::Persistent,
        SymlinkPlan::Repoint => match repoint(&paths.symlink, &sidecar) {
            Ok(()) => InstallState::Persistent,
            Err(error) => InstallState::ReadOnly(ReadOnlyReason::SymlinkFailed(error.to_string())),
        },
        SymlinkPlan::Refuse(reason) => InstallState::ReadOnly(reason),
    }
}

/// `<target> --version`, bounded so a hung copy cannot stall startup.
pub fn probe_version(exec: &Path) -> Option<String> {
    let mut command = Command::new(exec);
    command.arg("--version");
    let output = run_with_timeout(command, Duration::from_secs(5)).ok()?;
    output.status.success().then(|| version::parse_version_output(&String::from_utf8_lossy(&output.stdout)))?
}

/// Held for the life of the process; the kernel drops the flock when it exits.
#[derive(Debug)]
#[must_use = "dropping releases the single-instance lock"]
pub struct InstanceLock {
    _file: File,
}

/// `Ok(None)` when another copy holds the lock: this one must exit.
pub fn acquire_instance_lock(path: &Path) -> io::Result<Option<InstanceLock>> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path)?;
    // SAFETY: flock on a descriptor we own.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(InstanceLock { _file: file }));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) { Ok(None) } else { Err(error) }
}

#[cfg(test)]
mod tests;
