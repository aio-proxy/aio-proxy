use aio_proxy_desktop::version::APP_VERSION;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("{APP_VERSION}");
        return;
    }
    // Replaced by the GPUI menu-bar app in Task 10.
    eprintln!("aio-proxy-desktop {APP_VERSION}: only --version is available in this build");
    std::process::exit(64);
}
