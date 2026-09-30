// The app's version is the product package's: CFBundleShortVersionString, `--version` and the
// no-downgrade rule all read this one value, so it cannot drift from the bundled sidecar.
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let package = manifest.join("../npm/aio-proxy/package.json");
    println!("cargo:rerun-if-changed={}", package.display());
    let text = fs::read_to_string(&package).expect("read npm/aio-proxy/package.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse npm/aio-proxy/package.json");
    let version = json["version"].as_str().expect("npm/aio-proxy/package.json has a string version");
    println!("cargo:rustc-env=AIO_PROXY_VERSION={version}");
}
