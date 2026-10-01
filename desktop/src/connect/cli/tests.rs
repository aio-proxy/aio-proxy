use std::ffi::OsStr;
use std::path::PathBuf;

use super::*;

fn host(exec: &str) -> SystemHost {
    SystemHost {
        exec: PathBuf::from(exec),
        desktop_exec: PathBuf::from("/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy"),
        uid: 501,
    }
}

fn env_of<'a>(command: &'a Command, name: &str) -> Option<Option<&'a OsStr>> {
    command.get_envs().find(|(key, _)| *key == name).map(|(_, value)| value)
}

#[test]
fn every_cli_child_gets_the_symlink_marker_and_no_inherited_home() {
    let command = host("/bin/sh").cli(&["__desktop-connect"], None);
    assert_eq!(
        env_of(&command, "AIO_PROXY_DESKTOP_EXEC"),
        Some(Some(OsStr::new("/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy")))
    );
    assert_eq!(env_of(&command, "AIO_PROXY_HOME"), Some(None), "removed, not inherited");
    assert_eq!(env_of(&command, "AIO_PROXY_MANAGED"), Some(None));
    assert_eq!(env_of(&command, "XPC_SERVICE_NAME"), Some(None));
}

#[test]
fn a_service_command_carries_the_plist_home() {
    let command = host("/bin/sh").cli(&["service", "restart"], Some("/Users/me/.aio-proxy-work"));
    assert_eq!(env_of(&command, "AIO_PROXY_HOME"), Some(Some(OsStr::new("/Users/me/.aio-proxy-work"))));
}

#[test]
fn discovery_reads_the_childs_stdout_and_reports_failures_without_it() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("aio-proxy");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\n[ \"$1\" = __desktop-connect ] || exit 9\ncat <<'JSON'\n{}JSON\n",
            crate::connect::discovery::fixture::SPEC_EXAMPLE
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let found = SystemHost { exec: script.clone(), ..host("/bin/sh") }.discover().unwrap();
    assert_eq!(found.bundled_version, "0.37.0");

    std::fs::write(&script, "#!/bin/sh\necho '{\"token\":\"tok-leak\"}'\necho boom >&2\nexit 2\n").unwrap();
    let error = SystemHost { exec: script, ..host("/bin/sh") }.discover().unwrap_err();
    assert!(error.contains("boom") && !error.contains("tok-leak"), "{error}");
}

#[test]
fn a_failing_discovery_is_an_error_even_when_stdout_is_valid_json() {
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("aio-proxy");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\ncat <<'JSON'\n{}JSON\necho boom >&2\nexit 1\n",
            crate::connect::discovery::fixture::SPEC_EXAMPLE
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let error = SystemHost { exec: script, ..host("/bin/sh") }.discover().unwrap_err();
    assert!(error.contains("boom") && !error.contains("tok-abc"), "{error}");
}
