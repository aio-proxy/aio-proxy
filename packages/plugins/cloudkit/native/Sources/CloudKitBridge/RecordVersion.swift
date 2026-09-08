import CloudKit
import Foundation

struct RecordVersion: Equatable, Sendable {
    let systemFields: Data

    init(record: CKRecord) throws {
        let coder = NSKeyedArchiver(requiringSecureCoding: false)
        record.encodeSystemFields(with: coder)
        systemFields = coder.encodedData
    }

    init(version: String) throws {
        guard let data = Data(base64Encoded: version) else { throw StoreError.invalidData }
        systemFields = data
    }

    var encoded: String { systemFields.base64EncodedString() }

    func record() throws -> CKRecord {
        let coder = try NSKeyedUnarchiver(forReadingFrom: systemFields)
        guard let decoded = CKRecord(coder: coder) else {
            throw StoreError.invalidData
        }
        return decoded
    }
}
