import CloudKit
import Foundation

struct RecordVersion: Equatable, Sendable {
    let systemFields: Data
    let changeToken: String?

    init(record: CKRecord) throws {
        let coder = NSKeyedArchiver(requiringSecureCoding: true)
        record.encodeSystemFields(with: coder)
        systemFields = coder.encodedData
        #if DEBUG
        changeToken = record["_fakeVersion"] as? String
        #else
        changeToken = nil
        #endif
    }

    init(version: String) throws {
        guard let data = Data(base64Encoded: version),
              let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              let fields = Data(base64Encoded: envelope.systemFields) else { throw StoreError.invalidData }
        systemFields = fields
        changeToken = envelope.changeToken
    }

    var encoded: String {
        let envelope = Envelope(systemFields: systemFields.base64EncodedString(), changeToken: changeToken)
        return (try? JSONEncoder().encode(envelope).base64EncodedString()) ?? ""
    }

    func record() throws -> CKRecord {
        let coder = try NSKeyedUnarchiver(forReadingFrom: systemFields)
        coder.requiresSecureCoding = true
        guard let decoded = CKRecord(coder: coder) else {
            throw StoreError.invalidData
        }
        return decoded
    }

    private struct Envelope: Codable {
        let systemFields: String
        let changeToken: String?
    }
}
