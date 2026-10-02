/// The CLI's `taskPath(sid)` (packages/cli/src/service/schtasks-unit): the two must match.
pub fn task_path(sid: &str) -> String {
    format!(r"\AIO Proxy\aio-proxy-{sid}")
}

#[test]
fn the_task_path_matches_the_clis_format() {
    assert_eq!(task_path("S-1-5-21-1-2-3-1001"), r"\AIO Proxy\aio-proxy-S-1-5-21-1-2-3-1001");
}
