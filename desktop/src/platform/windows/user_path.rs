//! The user's `PATH` as the registry holds it: read for the probe, appended to by the install.

use std::ptr::null_mut;

use windows_registry::{CURRENT_USER, LOCAL_MACHINE, Type};
use windows_sys::Win32::System::Environment::ExpandEnvironmentStringsW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
};

const USER_ENV: &str = "Environment";
const MACHINE_ENV: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

fn expand(value: &str) -> String {
    let src = wide(value);
    // SAFETY: `src` is NUL-terminated; a null destination of size 0 only asks for the length.
    let len = unsafe { ExpandEnvironmentStringsW(src.as_ptr(), null_mut(), 0) };
    if len == 0 {
        return value.to_owned();
    }
    let mut buffer = vec![0u16; len as usize];
    // SAFETY: `buffer` holds `len` writable units, the size the first call asked for.
    let written = unsafe { ExpandEnvironmentStringsW(src.as_ptr(), buffer.as_mut_ptr(), len) };
    if written == 0 || written > len {
        return value.to_owned();
    }
    String::from_utf16_lossy(&buffer[..written as usize - 1])
}

/// What a new terminal's `PATH` is built from: machine entries, then user entries, expanded.
pub fn effective_path() -> String {
    let read = |root: &windows_registry::Key, subkey: &str| {
        root.open(subkey).and_then(|key| key.get_string("Path")).map(|value| expand(&value)).unwrap_or_default()
    };
    format!("{};{}", read(LOCAL_MACHINE, MACHINE_ENV), read(CURRENT_USER, USER_ENV))
}

/// Appends `dir` to the user's `Path`, keeping its registry type, then tells running programs.
pub fn add_to_user_path(dir: &str) -> Result<(), String> {
    let key = CURRENT_USER.create(USER_ENV).map_err(|error| error.to_string())?;
    // An existing non-string value is left alone.
    let (current, ty) = match key.get_type("Path") {
        Ok(ty @ (Type::String | Type::ExpandString)) => {
            (key.get_string("Path").map_err(|error| error.to_string())?, ty)
        }
        Ok(_) => return Err("the user Path is not a string value".into()),
        // Only a missing value starts a new one; any other failure must not turn into a Path that
        // holds just our directory. 0x80070002 is ERROR_FILE_NOT_FOUND.
        Err(error) if error.code().0 == 0x8007_0002_u32 as i32 => (String::new(), Type::ExpandString),
        Err(error) => return Err(error.to_string()),
    };
    let updated = crate::platform::shell_path::path_with(&current, dir);
    if updated != current {
        match ty {
            Type::ExpandString => key.set_expand_string("Path", &updated),
            _ => key.set_string("Path", &updated),
        }
        .map_err(|error| error.to_string())?;
    }
    broadcast_environment_change();
    Ok(())
}

fn broadcast_environment_change() {
    let setting = wide("Environment");
    let mut result = 0usize;
    // SAFETY: `setting` is NUL-terminated and outlives the call; SMTO_ABORTIFHUNG bounds a stuck
    // window to the 5 s timeout. A failure only means running programs keep the old PATH.
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            setting.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        );
    }
}
