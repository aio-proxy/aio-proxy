//! Pure `PATH` and shim text helpers for the Windows `aiop` install, compiled everywhere so the
//! tests run on every platform.

use std::path::Path;

#[cfg(test)]
mod tests;

fn same_dir(entry: &str, dir: &str) -> bool {
    entry.trim_end_matches('\\').to_lowercase() == dir.trim_end_matches('\\').to_lowercase()
}

/// `value` with `dir` appended unless an entry already equals it (case-insensitively, ignoring a
/// trailing `\`). Every other entry stays byte-for-byte: `%VAR%` references are never expanded.
pub fn path_with(value: &str, dir: &str) -> String {
    if value.split(';').any(|entry| same_dir(entry, dir)) {
        return value.to_owned();
    }
    match value.trim_end_matches(';') {
        "" => dir.to_owned(),
        kept => format!("{kept};{dir}"),
    }
}

/// `value` without any entry equal to `dir`.
#[allow(dead_code)]
pub fn path_without(value: &str, dir: &str) -> String {
    value.split(';').filter(|entry| !entry.is_empty() && !same_dir(entry, dir)).collect::<Vec<_>>().join(";")
}

/// Whether `value` (already expanded) lists `dir`.
pub fn path_has(value: &str, dir: &str) -> bool {
    value.split(';').any(|entry| same_dir(entry, dir))
}

/// A `.cmd` shim forwarding every argument to `target`.
pub fn shim_text(target: &Path) -> String {
    format!("@\"{}\" %*\r\n", target.display())
}
