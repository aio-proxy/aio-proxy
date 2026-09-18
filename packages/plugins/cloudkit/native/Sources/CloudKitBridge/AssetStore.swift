import CloudKit
import Foundation

enum AssetStore {
    static let maxPayload = 8 * 1024 * 1024
    static let maxFrame = 16 * 1024 * 1024

    static let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("aio-proxy-cloudkit", isDirectory: true)
    private static let directory = root.appendingPathComponent(String(getpid()), isDirectory: true)

    static func makeAsset(_ data: Data) throws -> (CKAsset, URL) {
        guard data.count <= maxPayload else { throw StoreError.invalidData }
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

    // Helpers overlap: a probe can start while another helper is mid-CAS, and CloudKit reads the
    // asset file off disk until the save returns. Sweeping the whole shared directory deleted that
    // in-flight file and turned a healthy write into outcome-unknown recovery. Each process owns a
    // directory named for its PID, and startup reclaims only the ones whose process is gone — which
    // is what a crash mid-save leaves behind.
    static func removeAbandonedFiles() {
        for name in (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? [] {
            // A non-numeric entry is a loose file from the previous flat layout: abandoned by definition.
            if let pid = pid_t(name), kill(pid, 0) == 0 || errno != ESRCH { continue }
            try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
        }
    }
}
