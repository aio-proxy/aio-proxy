//! Launch at login via the per-user `Run` key, pointing at the running `aio-proxy-desktop.exe`.

use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;

use windows_registry::CURRENT_USER;

use crate::platform::LoginItemStatus;
use crate::platform::startup_approved::startup_approved_disabled;

#[cfg(test)]
mod tests;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const VALUE_NAME: &str = "AIO Proxy";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The value is the quoted exe path; Windows compares paths case-insensitively.
pub fn run_value_matches(data: &str, exe: &Path) -> bool {
    data.trim().trim_matches('"').eq_ignore_ascii_case(&exe.to_string_lossy())
}

pub fn status() -> LoginItemStatus {
    match std::env::current_exe() {
        Ok(exe) => status_at(VALUE_NAME, &exe),
        Err(_) => LoginItemStatus::Unavailable,
    }
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    set_enabled_at(VALUE_NAME, &exe, enabled)
}

pub fn open_settings() {
    let _ = Command::new("explorer.exe").arg("ms-settings:startupapps").creation_flags(CREATE_NO_WINDOW).spawn();
}

fn status_at(name: &str, exe: &Path) -> LoginItemStatus {
    let data = CURRENT_USER.open(RUN_KEY).and_then(|key| key.get_string(name));
    match data {
        Ok(data) if run_value_matches(&data, exe) => {
            // Disabled in Settings or Task Manager: the Run value stays, so only the user can turn it back on.
            let approval = CURRENT_USER.open(STARTUP_APPROVED_KEY).and_then(|key| key.get_value(name));
            if approval.is_ok_and(|value| startup_approved_disabled(&value)) {
                LoginItemStatus::RequiresApproval
            } else {
                LoginItemStatus::Enabled
            }
        }
        _ => LoginItemStatus::NotRegistered,
    }
}

fn set_enabled_at(name: &str, exe: &Path, enabled: bool) -> Result<(), String> {
    let key = CURRENT_USER.create(RUN_KEY).map_err(|error| error.to_string())?;
    if enabled {
        key.set_string(name, format!("\"{}\"", exe.display())).map_err(|error| error.to_string())
    } else if key.get_string(name).is_err() {
        Ok(())
    } else {
        key.remove_value(name).map_err(|error| error.to_string())
    }
}
