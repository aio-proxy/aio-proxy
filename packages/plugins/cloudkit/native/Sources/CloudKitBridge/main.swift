import CloudKit
import CryptoKit
import Foundation

private let expectedBundleId = "dev.aioproxy"

private enum SyncFailureCode: String, Codable {
    case offline
    case quota
    case identityChanged = "identity-changed"
    case cancelled
    case unauthorized
    case unsupported
    case outcomeUnknown = "outcome-unknown"
    case invalidData = "invalid-data"
}

private struct ProbeInput: Decodable {
    let containerId: String
    let expectedBundleId: String
}

private struct ProbeErrorOutput: Encodable {
    let code: SyncFailureCode
}

private enum ProbeOutput: Encodable {
    case success(account: String, identityId: String, bundleId: String)
    case failure(code: SyncFailureCode)

    private enum CodingKeys: String, CodingKey {
        case ok, account, identityId, bundleId, error
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .success(account, identityId, bundleId):
            try container.encode(true, forKey: .ok)
            try container.encode(account, forKey: .account)
            try container.encode(identityId, forKey: .identityId)
            try container.encode(bundleId, forKey: .bundleId)
        case let .failure(code):
            try container.encode(false, forKey: .ok)
            try container.encode(ProbeErrorOutput(code: code), forKey: .error)
        }
    }
}

private func emit(_ output: ProbeOutput) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(output), let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

private func readProbeInput() -> ProbeInput? {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 64 * 1024 else {
        return nil
    }
    let line = data.split(whereSeparator: { $0 == 10 || $0 == 13 }).first
    guard let line else { return nil }
    return try? JSONDecoder().decode(ProbeInput.self, from: Data(line))
}

private func identityHash(_ recordName: String) -> String {
    let digest = SHA256.hash(data: Data(recordName.utf8))
    return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
}

private func failureCode(for error: Error) -> SyncFailureCode {
    if error is ProbeError { return .unauthorized }
    guard let cloudKitError = error as? CKError else { return .unsupported }
    switch cloudKitError.code {
    case .notAuthenticated, .permissionFailure:
        return .unauthorized
    case .networkFailure, .networkUnavailable, .serviceUnavailable, .requestRateLimited:
        return .offline
    case .quotaExceeded:
        return .quota
    case .operationCancelled:
        return .cancelled
    default:
        return .unsupported
    }
}

private func runProbe() async {
    guard let input = readProbeInput(), input.expectedBundleId == expectedBundleId,
          input.containerId.hasPrefix("iCloud.") else {
        emit(.failure(code: .invalidData))
        return
    }

    guard Bundle.main.bundleIdentifier == expectedBundleId else {
        emit(.failure(code: .unsupported))
        return
    }

    do {
        let recordName = try await AccountProbe.run(containerId: input.containerId)
        emit(.success(account: "available", identityId: identityHash(recordName), bundleId: expectedBundleId))
    } catch {
        emit(.failure(code: failureCode(for: error)))
    }
}

if CommandLine.arguments.contains("--probe") {
    await runProbe()
}
