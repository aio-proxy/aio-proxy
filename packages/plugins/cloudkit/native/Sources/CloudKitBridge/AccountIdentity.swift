import CryptoKit
import Foundation

struct AccountIdentity: Equatable, Sendable {
    let identifier: String

    /// A CloudKit record name is a stable Apple account identifier, and the identity the session
    /// reports is persisted in the local binding. Nothing downstream needs more than equality, so
    /// only this digest leaves the native component — the same opaque form the probe reports, which
    /// keeps both paths naming one account identically.
    static func opaque(_ recordName: String) -> String {
        let digest = SHA256.hash(data: Data(recordName.utf8))
        return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
    }
}
