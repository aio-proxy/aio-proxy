import CloudKit
import Foundation

enum ProbeError: Error {
    case accountUnavailable
}

struct AccountProbe {
    static func run(containerId: String) async throws -> String {
        let container = CKContainer(identifier: containerId)
        guard try await container.accountStatus() == .available else {
            throw ProbeError.accountUnavailable
        }
        return try await container.userRecordID().recordName
    }
}
