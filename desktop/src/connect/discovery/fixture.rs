//! A `__desktop-connect` result shared by the connect tests: the spec's example, patched per case.

use super::{Discovery, parse_discovery};

pub(crate) const SPEC_EXAMPLE: &str = r#"{
  "protocolVersion": 1,
  "bundledVersion": "0.37.0",
  "unit": {
    "present": true,
    "wrapperValid": true,
    "target": "/Users/me/Library/Application Support/aio-proxy-desktop/bin/aio-proxy",
    "home": "/Users/me/.aio-proxy",
    "owner": "desktop"
  },
  "job": { "loaded": true, "disabled": false, "pid": 4310 },
  "instance": {
    "controlUrl": "http://127.0.0.1:9317",
    "dashboardUrl": "http://127.0.0.1:9317/dashboard",
    "reachable": true,
    "version": "0.36.0",
    "pid": 4312,
    "ppid": 4310,
    "matchesJob": true
  },
  "token": "tok-abc"
}
"#;

/// The spec example with `patch` applied to its JSON before parsing.
pub(crate) fn discovery_with(patch: impl FnOnce(&mut serde_json::Value)) -> Result<Discovery, String> {
    let mut value: serde_json::Value = serde_json::from_str(SPEC_EXAMPLE).expect("fixture is JSON");
    patch(&mut value);
    parse_discovery(value.to_string().as_bytes())
}

/// Same, for tests that only build valid discoveries.
pub(crate) fn discovery(patch: impl FnOnce(&mut serde_json::Value)) -> Discovery {
    discovery_with(patch).expect("patched fixture parses")
}
