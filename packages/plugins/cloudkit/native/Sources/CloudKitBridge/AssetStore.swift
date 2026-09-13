import CloudKit
import Foundation

enum AssetStore {
    static let maxPayload = 8 * 1024 * 1024
    static let maxFrame = 16 * 1024 * 1024

    static func makeAsset(_ data: Data) throws -> (CKAsset, URL) {
        guard data.count <= maxPayload else { throw StoreError.invalidData }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("aio-proxy-cloudkit", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw StoreError.invalidData
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return (CKAsset(fileURL: url), url)
    }

    static func data(from asset: CKAsset?) throws -> Data {
        guard let url = asset?.fileURL else { throw StoreError.invalidData }
        let data = try Data(contentsOf: url)
        guard data.count <= maxFrame else { throw StoreError.invalidData }
        return data
    }

    static func removeAbandonedFiles() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aio-proxy-cloudkit", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
    }
}
