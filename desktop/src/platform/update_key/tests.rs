use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;

use cargo_packager_updater::semver::Version;
use cargo_packager_updater::url::Url;
use cargo_packager_updater::{Config, UpdaterBuilder};

use super::*;

const PAYLOAD: &[u8] = include_bytes!("fixture/payload.bin");
const MINISIG: &str = include_str!("fixture/payload.bin.minisig");
const FIXTURE_KEY: &str = include_str!("fixture/pubkey.txt");

fn signature_field() -> String {
    STANDARD.encode(MINISIG)
}

/// A feed offering the fixture payload as `version` for the running target, served over HTTP/1.1 on
/// loopback, read by an updater for 1.0.0 that trusts `pubkey`.
fn updater_against_local_feed(version: &str, pubkey: String) -> cargo_packager_updater::Updater {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    // The feed is keyed `{os}-{arch}` by the running build, so this runs on Linux and Windows alike.
    let target = cargo_packager_updater::target().expect("the updater supports this platform");
    let feed = serde_json::json!({
        "version": version,
        "platforms": { target: { "url": format!("{base}/payload.bin"), "signature": signature_field(), "format": "appimage" } },
    })
    .to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            // Drain the headers; neither request has a body.
            let mut line = String::new();
            while reader.read_line(&mut line).unwrap() > 2 {
                line.clear();
            }
            let body = match request_line.split_whitespace().nth(1) {
                Some("/latest.json") => feed.as_bytes(),
                Some("/payload.bin") => PAYLOAD,
                _ => &[],
            };
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(head.as_bytes()).unwrap();
            stream.write_all(body).unwrap();
        }
    });
    let config = Config { endpoints: vec![Url::parse(&format!("{base}/latest.json")).unwrap()], pubkey, windows: None };
    UpdaterBuilder::new(Version::new(1, 0, 0), config).build().unwrap()
}

#[test]
fn the_bun_signature_passes_the_updater_verification_entry_point() {
    let update = updater_against_local_feed("9.9.9", updater_pubkey(FIXTURE_KEY.trim())).check().unwrap();
    let update = update.expect("9.9.9 is newer than 1.0.0");
    assert_eq!(update.download().unwrap(), PAYLOAD);
    // The fixture is signed for linux-x86_64: that build accepts it, every other target refuses it.
    match cargo_packager_updater::target().as_deref() {
        Some("linux-x86_64") => assert_eq!(verified_download(&update).unwrap(), PAYLOAD),
        _ => assert!(verified_download(&update).unwrap_err().contains("not `aio-proxy-desktop 9.9.9")),
    }
}

#[test]
fn a_payload_signed_by_another_key_is_refused() {
    let update = updater_against_local_feed("9.9.9", updater_pubkey(PUBLIC_KEY_B64)).check().unwrap();
    // Both keys carry the same key id, so the refusal is the Ed25519 check itself.
    assert!(matches!(
        update.expect("9.9.9 is newer than 1.0.0").download(),
        Err(cargo_packager_updater::Error::Minisign(minisign_verify::Error::InvalidSignature))
    ));
}

#[test]
fn a_package_replayed_under_a_newer_version_is_not_downloaded() {
    // The fixture signature names 9.9.9; the feed offers it as 10.0.0.
    let update = updater_against_local_feed("10.0.0", updater_pubkey(FIXTURE_KEY.trim())).check().unwrap();
    let error = verified_download(&update.expect("10.0.0 is newer than 1.0.0")).unwrap_err();
    assert!(error.contains("aio-proxy-desktop 10.0.0"), "{error}");
}

#[test]
fn the_shipped_release_key_is_a_valid_minisign_key() {
    assert_eq!(STANDARD.decode(PUBLIC_KEY_B64).unwrap().len(), 32);
    let text = String::from_utf8(STANDARD.decode(updater_pubkey(PUBLIC_KEY_B64)).unwrap()).unwrap();
    assert!(minisign_verify::PublicKey::decode(&text).is_ok());
}

#[test]
fn a_trusted_comment_naming_another_version_or_target_is_refused() {
    let sig = signature_field();
    let ok = Offer { version: "9.9.9", target: "linux-x86_64", asset: "payload.bin" };
    assert!(check_trusted(&sig, &ok).is_ok());
    assert!(check_trusted(&sig, &Offer { version: "10.0.0", ..ok }).is_err());
    assert!(check_trusted(&sig, &Offer { target: "windows-x86_64", ..ok }).is_err());
    assert!(check_trusted(&sig, &Offer { asset: "other.bin", ..ok }).is_err());
}
