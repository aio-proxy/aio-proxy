//! Process liveness and account SIDs. A SID, unlike an account name, is stable across renames and
//! code pages. Every failure reads as "unknown", never as a match.

use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ACCESS_DENIED, GetLastError, HANDLE, HLOCAL, LocalFree, STILL_ACTIVE,
};
use windows_sys::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows_sys::Win32::Security::{GetLengthSid, GetTokenInformation, IsValidSid, TOKEN_QUERY, TOKEN_USER, TokenUser};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Closes a real (non-null) handle on drop.
struct Handle(HANDLE);

impl Handle {
    fn new(handle: HANDLE) -> Option<Self> {
        (!handle.is_null()).then_some(Self(handle))
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from an API that returned it open, and is closed exactly once.
        unsafe { CloseHandle(self.0) };
    }
}

fn open_process(pid: u32) -> Option<Handle> {
    // SAFETY: plain call; a null return is handled by `Handle::new`.
    Handle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) })
}

pub fn pid_alive(pid: u32) -> bool {
    let Some(process) = open_process(pid) else {
        // Denied: it exists under an account we cannot query. Any other failure: no such process.
        // SAFETY: reads this thread's last error, set by the failed OpenProcess.
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    };
    let mut code = 0u32;
    // SAFETY: `process` is open with query rights and `code` is a valid out pointer.
    unsafe { GetExitCodeProcess(process.0, &mut code) != 0 && code == STILL_ACTIVE as u32 }
}

/// The binary SID of the account `pid` runs as; `None` when it cannot be read (gone, denied).
pub fn process_user_sid(pid: u32) -> Option<Vec<u8>> {
    let process = open_process(pid)?;
    token_user_sid(process.0)
}

/// This process's account SID; empty when it cannot be read, which matches no process.
pub fn current_user_sid() -> Vec<u8> {
    // SAFETY: the pseudo handle needs no closing and is always valid.
    token_user_sid(unsafe { GetCurrentProcess() }).unwrap_or_default()
}

fn token_user_sid(process: HANDLE) -> Option<Vec<u8>> {
    let mut raw = null_mut();
    // SAFETY: `process` is a process handle with query rights; `raw` is a valid out pointer.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return None;
    }
    let token = Handle::new(raw)?;
    // The first call fails with ERROR_INSUFFICIENT_BUFFER and reports the size TOKEN_USER needs.
    let mut size = 0u32;
    // SAFETY: a null buffer of length 0 only asks for the size.
    unsafe { GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut size) };
    if (size as usize) < size_of::<TOKEN_USER>() {
        return None;
    }
    // u64 elements keep the TOKEN_USER (and the SID pointer in it) aligned.
    let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
    let bytes = buffer.len() * 8;
    // SAFETY: the buffer is `bytes` long and writable.
    if unsafe { GetTokenInformation(token.0, TokenUser, buffer.as_mut_ptr().cast(), bytes as u32, &mut size) } == 0 {
        return None;
    }
    // SAFETY: the call succeeded, so the buffer starts with an initialized TOKEN_USER.
    let sid = unsafe { (*buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
    // The SID lives later in the same buffer; anything else is not the layout we read it as.
    let start = buffer.as_ptr() as usize;
    let at = sid as usize;
    if at < start || at + 8 > start + bytes {
        return None;
    }
    // SAFETY: `sid` points at least 8 bytes into our buffer, enough for the header both calls read.
    if unsafe { IsValidSid(sid) } == 0 {
        return None;
    }
    // SAFETY: as above; the length is bounds-checked before the slice is made.
    let len = unsafe { GetLengthSid(sid) } as usize;
    if len < 8 || at + len > start + bytes {
        return None;
    }
    // SAFETY: `at..at + len` lies inside `buffer`, which outlives the slice.
    Some(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), len) }.to_vec())
}

/// The `S-1-…` form of a binary SID; empty when it is not a valid SID.
pub fn sid_string(sid: &[u8]) -> String {
    if sid.len() < 8 {
        return String::new();
    }
    // The SID APIs take a mutable pointer but only read; the header is checked before the length.
    let psid = sid.as_ptr().cast_mut().cast();
    // SAFETY: `sid` holds at least the 8-byte header IsValidSid and GetLengthSid read.
    if unsafe { IsValidSid(psid) } == 0 || unsafe { GetLengthSid(psid) } as usize > sid.len() {
        return String::new();
    }
    let mut text = null_mut();
    // SAFETY: `psid` is a valid SID inside `sid`; `text` is a valid out pointer.
    if unsafe { ConvertSidToStringSidW(psid, &mut text) } == 0 || text.is_null() {
        return String::new();
    }
    // SAFETY: on success `text` is a NUL-terminated UTF-16 string we own until LocalFree.
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    // SAFETY: `len` units before the terminator were just read.
    let value = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    // SAFETY: ConvertSidToStringSidW allocates with LocalAlloc; freed exactly once.
    unsafe { LocalFree(text as HLOCAL) };
    value
}
