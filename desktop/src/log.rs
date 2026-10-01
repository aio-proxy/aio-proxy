//! The app's own log: `~/Library/Logs/aio-proxy-desktop/aio-proxy-desktop.log`, mirrored to stderr.
//! Callers never pass the token, an `Authorization` header or `__desktop-connect` stdout.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

// ponytail: no rotation; one line per event keeps it small. Rotate if a user reports a large file.
pub fn init(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(dir.join("aio-proxy-desktop.log")) {
        let _ = FILE.set(Mutex::new(file));
    }
}

pub fn info(message: impl AsRef<str>) {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let line = format!("{secs} {}\n", message.as_ref());
    eprint!("{line}");
    if let Some(Ok(mut file)) = FILE.get().map(Mutex::lock) {
        let _ = file.write_all(line.as_bytes());
    }
}
