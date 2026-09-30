//! aio-proxy version rules: semver precedence, never string order ("0.10.0" is newer than "0.9.0").

use std::cmp::Ordering;

/// This app's version, which is also its bundled sidecar's (both come from npm/aio-proxy/package.json).
pub const APP_VERSION: &str = env!("AIO_PROXY_VERSION");

/// Compares two versions by semver precedence. `None` when either side does not parse, which every
/// caller treats as "unknown": never as older, so an unreadable version can never cause a downgrade.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let a = semver::Version::parse(a.trim()).ok()?;
    let b = semver::Version::parse(b.trim()).ok()?;
    Some(a.cmp_precedence(&b))
}

/// Parses `aio-proxy --version` stdout, which is the bare version on one line.
pub fn parse_version_output(stdout: &str) -> Option<String> {
    let line = stdout.lines().next()?.trim();
    semver::Version::parse(line).ok().map(|_| line.to_string())
}

#[cfg(test)]
mod tests;
