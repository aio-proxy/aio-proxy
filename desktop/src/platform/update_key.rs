//! The Linux and Windows update key: the Sparkle Ed25519 key in the minisign form
//! `cargo-packager-updater` verifies, and the check that a signature was made for this offer.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use minisign_verify::Signature;

/// The release public key (raw 32-byte base64), the `SPARKLE_PUBLIC_ED_KEY` repository variable.
/// `AIO_PROXY_DESKTOP_UPDATE_KEY` replaces it at compile time for rehearsal builds only.
pub const PUBLIC_KEY_B64: &str = match option_env!("AIO_PROXY_DESKTOP_UPDATE_KEY") {
    Some(key) => key,
    None => "qLdzLskOKPgR6CnH2IeR6stMle0fkJIRx64u5wlT2lo=",
};

/// "aioprxyd" as the little-endian bytes of 0x6169_6f70_7278_7964; desktop/scripts/minisign signs
/// with this key id.
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
pub struct Offer<'a> {
    pub version: &'a str,
    pub target: &'a str,
    pub asset: &'a str,
}

/// Whether `signature_field` (the feed's base64 `.minisig` text) was signed for `offer`, so a validly
/// signed older package cannot be replayed under a newer version or another target. This only reads
/// the comment: it is authentic once the updater's download has verified the same signature, whose
/// global signature covers it.
pub fn check_trusted(signature_field: &str, offer: &Offer) -> Result<(), String> {
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
