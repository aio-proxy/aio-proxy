use std::ffi::OsStr;
use std::path::PathBuf;

use super::*;

fn host(exec: &str) -> SystemHost {
    SystemHost {
        exec: PathBuf::from(exec),
        desktop_exec: PathBuf::from("/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy"),
        user: "501".into(),
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

/// `/End` leaves the supervisor running, and `service restart` would take an external task over.
#[cfg(windows)]
#[test]
fn a_windows_kickstart_stops_then_starts_through_the_cli_with_the_service_home() {
    let host = host(r"C:\Users\me\AppData\Local\aio-proxy-desktop\bin\aio-proxy.exe");
    let commands = crate::platform::kickstart(&host.user, |args| host.cli(args, Some(r"C:\Users\me\.aio-proxy-work")));
    let verbs: Vec<String> = commands.iter().map(|(command, _)| describe(command)).collect();
    assert_eq!(verbs, ["aio-proxy.exe service stop", "aio-proxy.exe service start"]);
    for (command, allow_failure) in &commands {
        assert!(!allow_failure);
        assert_eq!(command.get_program(), host.exec.as_os_str());
        assert_eq!(env_of(command, "AIO_PROXY_HOME"), Some(Some(OsStr::new(r"C:\Users\me\.aio-proxy-work"))));
    }
}

#[cfg(unix)]
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

#[cfg(unix)]
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

#[cfg(unix)]
#[test]
fn a_stable_copy_that_cannot_run_falls_back_to_the_bundled_sidecar() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let bundle = dir.path().join("bundle");
    let sidecar = crate::install::sidecar_of(&bundle);
    std::fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    std::fs::write(&sidecar, "").unwrap();
    std::fs::set_permissions(&sidecar, std::fs::Permissions::from_mode(0o755)).unwrap();
    let stable = dir.path().join("aio-proxy");
    std::fs::write(&stable, "").unwrap();
    std::fs::set_permissions(&stable, std::fs::Permissions::from_mode(0o644)).unwrap();
    let paths = crate::install::Paths {
        home: dir.path().into(),
        support: dir.path().into(),
        stable: stable.clone(),
        lock: dir.path().join("lock"),
        logs: dir.path().join("logs"),
    };
    assert_eq!(SystemHost::new(&paths, Some(&bundle)).unwrap().exec, sidecar);
    std::fs::set_permissions(&stable, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(SystemHost::new(&paths, Some(&bundle)).unwrap().exec, stable);
}
