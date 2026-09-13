import CloudKit
import Foundation

struct CloudKitQueryPage {
    let records: [CKRecord]
    let cursor: Data?
}

protocol CloudKitDriver: Sendable {
    func fetch(id: CKRecord.ID) async throws -> CKRecord?
    func saveConditionally(record: CKRecord) async throws -> CKRecord
    func query(prefix: String, cursor: Data?) async throws -> CloudKitQueryPage
    func accountIdentity() async throws -> AccountIdentity
    func ensureZone() async throws
}

final class CloudKitDatabaseDriver: CloudKitDriver, @unchecked Sendable {
    private let container: CKContainer
    private let database: CKDatabase

    init(container: CKContainer) {
        self.container = container
        database = container.privateCloudDatabase
    }

    func fetch(id: CKRecord.ID) async throws -> CKRecord? {
        try await withCheckedThrowingContinuation { continuation in
            database.fetch(withRecordID: id) { record, error in
                if let error {
                    if (error as? CKError)?.code == .unknownItem { continuation.resume(returning: nil) }
                    else { continuation.resume(throwing: error) }
                } else if let record { continuation.resume(returning: record) }
                else { continuation.resume(throwing: StoreError.invalidData) }
            }
        }
    }

    func saveConditionally(record: CKRecord) async throws -> CKRecord {
        try await withCheckedThrowingContinuation { continuation in
            let operation = CKModifyRecordsOperation(recordsToSave: [record], recordIDsToDelete: nil)
            operation.savePolicy = .ifServerRecordUnchanged
            operation.isAtomic = true
            let saved = SavedRecordBox()
            operation.perRecordSaveBlock = { _, result in
                if case let .success(record) = result { saved.store(record) }
            }
            operation.modifyRecordsResultBlock = { result in
                switch result {
                case .success:
                    if let record = saved.load() { continuation.resume(returning: record) }
                    else { continuation.resume(throwing: StoreError.invalidData) }
                case let .failure(error): continuation.resume(throwing: error)
                }
            }
            database.add(operation)
        }
    }

    func query(prefix: String, cursor: Data?) async throws -> CloudKitQueryPage {
        try await withCheckedThrowingContinuation { continuation in
            let query = CKQuery(recordType: CloudKitStore.recordType, predicate: NSPredicate(format: "logicalKey BEGINSWITH %@", prefix))
            let operation = CKQueryOperation(query: query)
            operation.zoneID = CKRecordZone.ID(zoneName: CloudKitStore.zoneName, ownerName: CKCurrentUserDefaultName)
            operation.desiredKeys = [CloudKitStore.logicalKeyField, CloudKitStore.removedField]
            if let cursor, let coder = try? NSKeyedUnarchiver(forReadingFrom: cursor), let decoded = CKQueryOperation.Cursor(coder: coder) {
                operation.cursor = decoded
            }
            let box = QueryResultBox()
            operation.recordMatchedBlock = { _, result in
                if case let .success(record) = result { box.append(record) }
            }
            operation.queryResultBlock = { result in
                switch result {
                case let .success(cursor): continuation.resume(returning: CloudKitQueryPage(records: box.records, cursor: cursor.flatMap { Self.encode($0) }))
                case let .failure(error): continuation.resume(throwing: error)
                }
            }
            database.add(operation)
        }
    }

    func accountIdentity() async throws -> AccountIdentity {
        guard try await container.accountStatus() == .available else { throw ProbeError.accountUnavailable }
        return AccountIdentity(identifier: AccountIdentity.opaque(try await container.userRecordID().recordName))
    }

    // A custom zone does not exist in a private database until someone creates it, so every
    // record path would fail with `zoneNotFound` on a device that has never synced. Saving a
    // zone that already exists is a no-op, which keeps this safe to run on each connect.
    func ensureZone() async throws {
        _ = try await database.modifyRecordZones(saving: [CKRecordZone(zoneName: CloudKitStore.zoneName)], deleting: [])
    }

    private static func encode(_ cursor: CKQueryOperation.Cursor) -> Data? {
        let archiver = NSKeyedArchiver(requiringSecureCoding: false)
        cursor.encode(with: archiver)
        return archiver.encodedData
    }
}

final class SavedRecordBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: CKRecord?
    func store(_ record: CKRecord) { lock.lock(); defer { lock.unlock() }; value = record }
    func load() -> CKRecord? { lock.lock(); defer { lock.unlock() }; return value }
}

private final class QueryResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: [CKRecord] = []
    func append(_ record: CKRecord) { lock.lock(); defer { lock.unlock() }; value.append(record) }
    var records: [CKRecord] { lock.lock(); defer { lock.unlock() }; return value }
}
