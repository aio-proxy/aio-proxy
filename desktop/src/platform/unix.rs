//! Process and user identity shared by macOS and Linux.

pub fn current_uid() -> u32 {
    // SAFETY: getuid never fails.
    unsafe { libc::getuid() }
}

pub fn current_user() -> String {
    current_uid().to_string()
}

pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    // EPERM: it exists under another user.
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}
