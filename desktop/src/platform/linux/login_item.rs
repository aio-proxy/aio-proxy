//! Launch at login via an XDG autostart entry that runs the current AppImage.

use std::fs;
use std::path::{Path, PathBuf};

use crate::platform::LoginItemStatus;

#[cfg(test)]
mod tests;

const FILE: &str = "autostart/aio-proxy-desktop.desktop";

/// `$XDG_CONFIG_HOME` counts only when absolute and non-empty, as the XDG spec requires.
fn config_home() -> Option<PathBuf> {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
}

fn appimage() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").filter(|path| !path.is_empty()).map(PathBuf::from)
}

pub fn status() -> LoginItemStatus {
    match config_home() {
        Some(home) => status_at(&home, appimage().as_deref()),
        None => LoginItemStatus::Unavailable,
    }
}

pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let home = config_home().ok_or("cannot locate the config directory")?;
    set_enabled_at(&home, appimage().as_deref(), enabled)
}

/// Re-point an existing entry at the AppImage that is running now (the user may have moved it).
pub fn refresh() -> Result<(), String> {
    match config_home() {
        Some(home) => refresh_exec(&home, appimage().as_deref()),
        None => Ok(()),
    }
}

pub fn open_settings() {}

/// Desktop-entry `Exec` quoting: wrap in `"`, backslash-escape `"`, `` ` ``, `$`, `\`; `%` is a field code, so double it.
fn exec_line(appimage: &Path) -> String {
    let mut line = String::from("Exec=\"");
    for c in appimage.to_string_lossy().chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                line.push('\\');
                line.push(c);
            }
            '%' => line.push_str("%%"),
            _ => line.push(c),
        }
    }
    line.push('"');
    line
}

fn entry(appimage: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=AIO Proxy\n{}\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n",
        exec_line(appimage)
    )
}

pub fn status_at(config_home: &Path, appimage: Option<&Path>) -> LoginItemStatus {
    let Some(appimage) = appimage else { return LoginItemStatus::Unavailable };
    match fs::read_to_string(config_home.join(FILE)) {
        Ok(text) if text.lines().any(|line| line == exec_line(appimage)) => LoginItemStatus::Enabled,
        _ => LoginItemStatus::NotRegistered,
    }
}

pub fn set_enabled_at(config_home: &Path, appimage: Option<&Path>, enabled: bool) -> Result<(), String> {
    let appimage = appimage.ok_or("not running from an AppImage")?;
    let path = config_home.join(FILE);
    if !enabled {
        return match fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    }
    write_entry(&path, appimage)
}

/// No-op unless an entry already exists and names a different path.
pub fn refresh_exec(config_home: &Path, appimage: Option<&Path>) -> Result<(), String> {
    let Some(appimage) = appimage else { return Ok(()) };
    match fs::read_to_string(config_home.join(FILE)) {
        Ok(text) if !text.lines().any(|line| line == exec_line(appimage)) => {
            write_entry(&config_home.join(FILE), appimage)
        }
        _ => Ok(()),
    }
}

fn write_entry(path: &Path, appimage: &Path) -> Result<(), String> {
    let dir = path.parent().ok_or("invalid autostart path")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("desktop.tmp");
    fs::write(&tmp, entry(appimage)).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}
