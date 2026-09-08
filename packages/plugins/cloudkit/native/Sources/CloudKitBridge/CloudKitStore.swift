import CloudKit
import CryptoKit
import Foundation

struct StoredValue: Equatable, Sendable {
    let bytes: Data
    let version: String
    let modifiedAt: Int64
}

enum StoreRead: Equatable, Sendable { case absent, present(StoredValue) }
enum StoreCAS: Equatable, Sendable { case conflict, written(version: String, modifiedAt: Int64) }
struct StorePage: Equatable, Sendable { let keys: [String]; let nextCursor: String? }

protocol SyncStore: Sendable {
    func read(key: String) async throws -> StoreRead
    func compareAndSwap(key: String, expected: String?, value: Data) async throws -> StoreCAS
    func list(prefix: String, cursor: String?) async throws -> StorePage
    func remove(key: String, expected: String) async throws -> Bool
}

enum StoreError: Error, Equatable { case invalidData, identityChanged, outcomeUnknown }

final class CloudKitStore: SyncStore, @unchecked Sendable {
    static let zoneName = "AioProxySyncV1"
    static let recordType = "AioSyncValue"
    static let logicalKeyField = "logicalKey"
    static let removedField = "removed"
    static let payloadField = "payload"
    #if DEBUG
    static let expectedVersionField = "_expectedVersion"
    #endif

    private let driver: any CloudKitDriver
    private let identityLock = NSLock()
    private var knownIdentity: AccountIdentity?

    init(driver: any CloudKitDriver) {
        self.driver = driver
    }

    func read(key: String) async throws -> StoreRead {
        try await verifyIdentity()
        guard let record = try await driver.fetch(id: Self.recordID(for: key)) else { return .absent }
        try validate(record, key: key)
        guard (record[Self.removedField] as? Int64 ?? 0) == 0 else { return .absent }
        return .present(try storedValue(from: record))
    }

    func compareAndSwap(key: String, expected: String?, value: Data) async throws -> StoreCAS {
        try await verifyIdentity()
        guard value.count <= AssetStore.maxPayload else { throw StoreError.invalidData }
        let id = Self.recordID(for: key)
        let existing = try await driver.fetch(id: id)
        if let existing { try validate(existing, key: key) }
        let isRemoved = (existing?[Self.removedField] as? Int64 ?? 0) != 0
        if expected == nil, existing != nil, !isRemoved { return .conflict }
        if let expected {
            guard let existing, !isRemoved, try RecordVersion(record: existing).encoded == expected else { return .conflict }
        }
        let record: CKRecord
        if let expected {
            let decoded = try RecordVersion(version: expected).record()
            guard decoded.recordID == id else { throw StoreError.invalidData }
            record = decoded
        } else {
            record = existing ?? CKRecord(recordType: Self.recordType, recordID: id)
        }
        #if DEBUG
        if let expected { record[Self.expectedVersionField] = expected as CKRecordValue }
        #endif
        let (asset, url) = try AssetStore.makeAsset(value)
        defer { try? FileManager.default.removeItem(at: url) }
        record[Self.logicalKeyField] = key as CKRecordValue
        record[Self.removedField] = Int64(0) as CKRecordValue
        record[Self.payloadField] = asset
        do {
            let saved = try await driver.saveConditionally(record: record)
            return try writtenResult(from: saved)
        } catch let error as CKError where error.code == .serverRecordChanged {
            return .conflict
        } catch {
            if let recovered = try await driver.fetch(id: id),
               (recovered[Self.removedField] as? Int64 ?? 0) == 0,
               try AssetStore.data(from: recovered[Self.payloadField] as? CKAsset) == value {
                return try writtenResult(from: recovered)
            }
            throw StoreError.outcomeUnknown
        }
    }

    func list(prefix: String, cursor: String?) async throws -> StorePage {
        try await verifyIdentity()
        let input: Data?
        if let cursor {
            guard let decoded = Data(base64Encoded: cursor) else { throw StoreError.invalidData }
            input = decoded
        } else {
            input = nil
        }
        let page = try await driver.query(prefix: prefix, cursor: input)
        var keys: [String] = []
        for record in page.records {
            guard let key = record[Self.logicalKeyField] as? String,
                  key.hasPrefix(prefix),
                  (record[Self.removedField] as? Int64 ?? 0) == 0 else { continue }
            keys.append(key)
        }
        return StorePage(keys: keys, nextCursor: page.cursor?.base64EncodedString())
    }

    func remove(key: String, expected: String) async throws -> Bool {
        try await verifyIdentity()
        let id = Self.recordID(for: key)
        guard let record = try await driver.fetch(id: id) else { return false }
        try validate(record, key: key)
        guard (record[Self.removedField] as? Int64 ?? 0) == 0,
              try RecordVersion(record: record).encoded == expected else { return false }
        guard try RecordVersion(version: expected).record().recordID == id else { throw StoreError.invalidData }
        #if DEBUG
        record[Self.expectedVersionField] = expected as CKRecordValue
        #endif
        record[Self.removedField] = Int64(1) as CKRecordValue
        record[Self.payloadField] = nil
        do {
            _ = try await driver.saveConditionally(record: record)
            return true
        } catch let error as CKError where error.code == .serverRecordChanged {
            return false
        }
    }

    static func recordID(for key: String) -> CKRecord.ID {
        let digest = SHA256.hash(data: Data(key.utf8))
        let name = "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
        return CKRecord.ID(recordName: name, zoneID: CKRecordZone.ID(zoneName: zoneName, ownerName: CKCurrentUserDefaultName))
    }

    private func verifyIdentity() async throws {
        let identity = try await driver.accountIdentity()
        try acceptIdentity(identity)
    }

    private func acceptIdentity(_ identity: AccountIdentity) throws {
        identityLock.lock(); defer { identityLock.unlock() }
        if let knownIdentity, knownIdentity != identity { throw StoreError.identityChanged }
        knownIdentity = identity
    }

    private func validate(_ record: CKRecord, key: String) throws {
        guard record.recordType == Self.recordType,
              record.recordID.zoneID.zoneName == Self.zoneName,
              record[Self.logicalKeyField] as? String == key,
              record.recordID == Self.recordID(for: key) else { throw StoreError.invalidData }
    }

    private func storedValue(from record: CKRecord) throws -> StoredValue {
        let version = try RecordVersion(record: record).encoded
        return StoredValue(bytes: try AssetStore.data(from: record[Self.payloadField] as? CKAsset), version: version, modifiedAt: try modifiedAt(from: record))
    }

    private func writtenResult(from record: CKRecord) throws -> StoreCAS {
        .written(version: try RecordVersion(record: record).encoded, modifiedAt: try modifiedAt(from: record))
    }

    private func modifiedAt(from record: CKRecord) throws -> Int64 {
        if let date = record.modificationDate { return Int64(date.timeIntervalSince1970) }
        throw StoreError.outcomeUnknown
    }
}
