//! Pure `PATH` and shim text helpers for the Windows `aiop` install, compiled everywhere so the
//! tests run on every platform.

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

/// A `.cmd` shim forwarding every argument to the stable copy at `..\aio-proxy.exe`, relative to
/// the shim (`%~dp0` ends with `\`). cmd.exe reads batch files in the console code page and expands
/// `%` in them, so an absolute path would break on a profile like `C:\Users\张三` or one with `%`.
pub const SHIM_TEXT: &str = "@\"%~dp0..\\aio-proxy.exe\" %*\r\n";
