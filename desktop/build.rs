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

    #[cfg(windows)]
    windows_resources(&manifest, version);

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    // SMAppService is looked up by name at runtime; linking loads the framework.
    println!("cargo:rustc-link-lib=framework=ServiceManagement");

    // Sparkle links only for a bundle build (desktop/scripts/bundle.ts sets SPARKLE_DIR). `cargo test`
    // and `cargo run` then need no framework; the updater finds no class and stays off.
    println!("cargo:rerun-if-env-changed=SPARKLE_DIR");
    if let Ok(dir) = env::var("SPARKLE_DIR") {
        println!("cargo:rustc-link-search=framework={dir}");
        println!("cargo:rustc-link-lib=framework=Sparkle");
        println!("cargo:rustc-link-arg-bins=-Wl,-rpath,@loader_path/../Frameworks");
    }
}

// gpui-pre's default `windows-manifest` feature already embeds the application manifest (PerMonitorV2 DPI
// awareness, common controls); a second manifest fails the link with CVT1100, so only the icon and version
// info are added here. The icon is what Explorer, the Start menu and the taskbar show.
#[cfg(windows)]
fn windows_resources(manifest: &std::path::Path, version: &str) {
    let icon = manifest.join("packaging/icons/icon.ico");
    println!("cargo:rerun-if-changed={}", icon.display());
    // VERSIONINFO packs major.minor.patch into the top three 16-bit words; a pre-release tag is dropped.
    let numeric = version
        .split(['.', '-', '+'])
        .take(3)
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .zip([48, 32, 16])
        .fold(0, |packed, (part, shift)| packed | (part << shift));
    let mut resource = winresource::WindowsResource::new();
    resource
        .set_icon(&icon.to_string_lossy())
        .set("ProductName", "AIO Proxy")
        // Task Manager shows the description as the process name.
        .set("FileDescription", "AIO Proxy")
        .set("FileVersion", version)
        .set("ProductVersion", version)
        .set_version_info(winresource::VersionInfo::FILEVERSION, numeric)
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, numeric);
    resource.compile().expect("compile the Windows resources (needs the Windows SDK's rc.exe)");
}
