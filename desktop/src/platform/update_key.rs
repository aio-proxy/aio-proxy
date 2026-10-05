//! The Linux and Windows update key: the Sparkle Ed25519 key in the minisign form
//! `cargo-packager-updater` verifies, and the check that a signature was made for this offer.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use cargo_packager_updater::Update;
use minisign_verify::Signature;

/// The release public key (raw 32-byte base64), the `SPARKLE_PUBLIC_ED_KEY` repository variable.
/// `AIO_PROXY_DESKTOP_UPDATE_KEY` replaces it at compile time for rehearsal builds only.
pub const PUBLIC_KEY_B64: &str = match option_env!("AIO_PROXY_DESKTOP_UPDATE_KEY") {
    Some(key) => key,
    None => "qLdzLskOKPgR6CnH2IeR6stMle0fkJIRx64u5wlT2lo=",
};

/// The little-endian bytes of 0x6169_6f70_7278_7964 ("aioprxyd" read big-endian; the bytes spell
/// "dyxrpoia"); desktop/scripts/minisign signs with this key id.
const KEY_ID: [u8; 8] = 0x6169_6f70_7278_7964_u64.to_le_bytes();

/// The updater's `pubkey`: base64 of the two-line minisign public key text for `raw_b64`.
pub fn updater_pubkey(raw_b64: &str) -> String {
    let mut key = b"Ed".to_vec();
    key.extend_from_slice(&KEY_ID);
    key.extend_from_slice(&STANDARD.decode(raw_b64.trim()).unwrap_or_default());
    let text = format!("untrusted comment: aio-proxy-desktop update key\n{}\n", STANDARD.encode(key));
    STANDARD.encode(text)
}

/// What a feed entry offers: the signed trusted comment must name exactly this.
#[derive(Debug, Clone, Copy)]
struct Offer<'a> {
    version: &'a str,
    target: &'a str,
    asset: &'a str,
}

/// Downloads `update` only if its signature was made for this version, target and asset, so a validly
/// signed older package cannot be replayed under a newer version or another target; the download
/// then verifies that signature, whose global signature covers the trusted comment.
pub fn verified_download(update: &Update) -> Result<Vec<u8>, String> {
    // `update.target` is the OS alone; the feed and the signed comment use `{os}-{arch}`.
    let target = cargo_packager_updater::target().ok_or("the updater does not support this platform")?;
    let asset = update.download_url.path_segments().and_then(|mut s| s.next_back()).unwrap_or_default();
    // The updater parses the feed version as semver after stripping a leading `v`, so the signed
    // comment must carry the normalized form (`1.2.3`, never `v1.2.3`).
    let offer = Offer { version: &update.version, target: &target, asset };
    check_trusted(&update.signature, &offer)?;
    update.download().map_err(|e| e.to_string())
}

/// Whether `signature_field` (the feed's base64 `.minisig` text) was signed for `offer`. It only reads
/// the comment, which is authentic once the same signature has verified.
fn check_trusted(signature_field: &str, offer: &Offer) -> Result<(), String> {
    let text = STANDARD.decode(signature_field).map_err(|e| format!("signature is not base64: {e}"))?;
    let text = String::from_utf8(text).map_err(|_| "signature is not UTF-8".to_string())?;
    let signature = Signature::decode(&text).map_err(|e| format!("signature is not minisign: {e}"))?;
    let expected = format!("aio-proxy-desktop {} {} {}", offer.version, offer.target, offer.asset);
    match signature.trusted_comment() {
        comment if comment == expected => Ok(()),
        comment => Err(format!("the signature is for `{comment}`, not `{expected}`")),
    }
}

#[cfg(test)]
mod tests;
