import CloudKit
import Foundation
#if canImport(XCTest)
@testable import CloudKitBridge

actor FakeCloudKitDriver: CloudKitDriver {
    private var records: [CKRecord.ID: CKRecord] = [:]
    var failNextSaveAfterPersist = false
    private var identity = AccountIdentity(identifier: "fake-account")
    func armPostSaveTransportLoss() { failNextSaveAfterPersist = true }
    func changeIdentity() { identity = AccountIdentity(identifier: UUID().uuidString) }

    func fetch(id: CKRecord.ID) async throws -> CKRecord? { records[id] }

    func saveConditionally(record: CKRecord) async throws -> CKRecord {
        if let current = records[record.recordID], record.recordChangeTag == nil {
            throw CKError(.serverRecordChanged, userInfo: [CKRecordChangedErrorServerRecordKey: current])
        }
        let saved = record
        saved["_fakeChangeTag"] = UUID().uuidString as CKRecordValue
        saved["_modifiedAt"] = Int64(Date().timeIntervalSince1970) as CKRecordValue
        records[record.recordID] = saved
        if failNextSaveAfterPersist {
            failNextSaveAfterPersist = false
            throw CKError(.networkFailure)
        }
        return saved
    }

    func query(prefix: String, cursor: Data?) async throws -> CloudKitQueryPage {
        let start = Int(String(data: cursor ?? Data("0".utf8), encoding: .utf8) ?? "0") ?? 0
        let values = records.values
            .filter { ($0[CloudKitStore.logicalKeyField] as? String)?.hasPrefix(prefix) == true }
            .filter { ($0[CloudKitStore.removedField] as? Int64 ?? 0) == 0 }
            .sorted { ($0[CloudKitStore.logicalKeyField] as? String ?? "") < ($1[CloudKitStore.logicalKeyField] as? String ?? "") }
        let page = Array(values.dropFirst(start).prefix(2))
        let next = start + page.count < values.count ? Data(String(start + page.count).utf8) : nil
        return CloudKitQueryPage(records: page, cursor: next)
    }

    func accountIdentity() async throws -> AccountIdentity { identity }
}
#endif
