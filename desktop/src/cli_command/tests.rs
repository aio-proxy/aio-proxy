use std::fs;

use super::*;

#[test]
fn only_a_marker_line_answers_the_probe() {
    assert_eq!(probe_answer(&format!("{FOUND}\n")), Some(true));
    assert_eq!(probe_answer(&format!("welcome back\n{MISSING}\n")), Some(false));
    // The shell died in its rc files before the lookup ran: unknown, never "missing".
    assert_eq!(probe_answer(""), None);
    assert_eq!(probe_answer("zsh: bad option: -i\n"), None);
}

#[test]
fn links_aiop_and_a_free_aio_proxy_through_awkward_paths() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("with space/it's/bin");
    let target = dir.path().join("Application Support/aio-proxy");
    let (aiop, long) = (bin.join("aiop"), bin.join("aio-proxy"));
    assert_eq!(link(&target, &aiop, &long, false), Ok(true));
    assert_eq!(fs::read_link(&aiop).unwrap(), target);
    assert_eq!(fs::read_link(&long).unwrap(), target);
}

#[test]
fn an_existing_aio_proxy_is_left_alone_while_aiop_is_replaced() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("aio-proxy-desktop");
    let (aiop, long) = (dir.path().join("aiop"), dir.path().join("aio-proxy"));
    fs::write(&aiop, "stale").unwrap();
    fs::write(&long, "npm copy").unwrap();
    assert_eq!(link(&target, &aiop, &long, false), Ok(true));
    assert_eq!(fs::read_link(&aiop).unwrap(), target);
    assert_eq!(fs::read_to_string(&long).unwrap(), "npm copy");
}
