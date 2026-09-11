import CloudKit
import Foundation
#if canImport(XCTest)
@testable import CloudKitBridge

actor FakeCloudKitDriver: CloudKitDriver {
    private var records: [CKRecord.ID: CKRecord] = [:]
    private var nextModificationDate = Date(timeIntervalSince1970: 1_700_000_000.125)
    var failNextSaveAfterPersist = false
    var accountAvailable = true
    private var identity = AccountIdentity(identifier: "fake-account")
    private var transportDown = false
    private var fetchFailsAfterSaveLoss = false
    /// `fetchAlsoFails` models the transport staying down past the save, so the recovery reread
    /// cannot observe what was persisted either.
    func armPostSaveTransportLoss(fetchAlsoFails: Bool = false) {
        failNextSaveAfterPersist = true
        fetchFailsAfterSaveLoss = fetchAlsoFails
    }
    func setAccountAvailable(_ available: Bool) { accountAvailable = available }
    func changeIdentity() { identity = AccountIdentity(identifier: UUID().uuidString) }
    func setNextModificationDate(_ date: Date) { nextModificationDate = date }

    func fetch(id: CKRecord.ID) async throws -> CKRecord? {
        if transportDown { throw CKError(.networkFailure) }
        guard let record = records[id] else { return nil }
        return copy(record)
    }

    func saveConditionally(record: CKRecord) async throws -> CKRecord {
        if let current = records[record.recordID] {
            let expected = record[CloudKitStore.expectedVersionField] as? String
            let currentVersion = current["_fakeVersion"] as? String
            let expectedToken = expected.flatMap { try? RecordVersion(version: $0).changeToken } ?? nil
            let isTombstone = (current[CloudKitStore.removedField] as? Int64 ?? 0) != 0
            let incomingToken = record["_fakeVersion"] as? String
            if (expected == nil && (!isTombstone || incomingToken != currentVersion)) ||
                (expected != nil && expectedToken != currentVersion) {
                throw CKError(.serverRecordChanged, userInfo: [CKRecordChangedErrorServerRecordKey: current])
            }
        }
        let saved = copy(record, modificationDate: nextModificationDate)
        nextModificationDate = nextModificationDate.addingTimeInterval(0.001)
        saved["_fakeVersion"] = UUID().uuidString as CKRecordValue
        records[record.recordID] = saved
        if failNextSaveAfterPersist {
            failNextSaveAfterPersist = false
            transportDown = fetchFailsAfterSaveLoss
            throw CKError(.networkFailure)
        }
        return saved
    }

    private func copy(_ record: CKRecord, modificationDate: Date? = nil) -> CKRecord {
        let result = FakeCKRecord(recordType: record.recordType, recordID: record.recordID, modificationDate: modificationDate ?? record.modificationDate)
        result[CloudKitStore.logicalKeyField] = record[CloudKitStore.logicalKeyField]
        result[CloudKitStore.removedField] = record[CloudKitStore.removedField]
        result[CloudKitStore.payloadField] = record[CloudKitStore.payloadField]
        result["_fakeVersion"] = record["_fakeVersion"]
        return result
    }

    func query(prefix: String, cursor: Data?) async throws -> CloudKitQueryPage {
        let start = Int(String(data: cursor ?? Data("0".utf8), encoding: .utf8) ?? "0") ?? 0
        let values = records.values
            .filter { ($0[CloudKitStore.logicalKeyField] as? String)?.hasPrefix(prefix) == true }
            .sorted { ($0[CloudKitStore.logicalKeyField] as? String ?? "") < ($1[CloudKitStore.logicalKeyField] as? String ?? "") }
        let page = Array(values.dropFirst(start).prefix(2))
        let next = start + page.count < values.count ? Data(String(start + page.count).utf8) : nil
        return CloudKitQueryPage(records: page, cursor: next)
    }

    func accountIdentity() async throws -> AccountIdentity {
        guard accountAvailable else { throw ProbeError.accountUnavailable }
        return identity
    }
}

private final class FakeCKRecord: CKRecord {
    private let fakeModificationDate: Date?

    init(recordType: String, recordID: CKRecord.ID, modificationDate: Date?) {
        fakeModificationDate = modificationDate
        super.init(recordType: recordType, recordID: recordID)
    }

    required init?(coder: NSCoder) {
        fakeModificationDate = nil
        super.init(coder: coder)
    }

    override var modificationDate: Date? { fakeModificationDate ?? super.modificationDate }
}
#endif
