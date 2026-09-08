import CloudKit
import Foundation

final class StdioServer: @unchecked Sendable {
    private let containerId: String
    private let store: CloudKitStore
    private let outputLock = NSLock()
    private let taskLock = NSLock()
    private var tasks: [String: Task<Void, Never>] = [:]
    private var stopped = false

    init(containerId: String) {
        self.containerId = containerId
        self.store = CloudKitStore(driver: CloudKitDatabaseDriver(container: CKContainer(identifier: containerId)))
        NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: nil) { [weak self] _ in
            self?.accountChanged()
        }
    }

    func run() async {
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                if line.utf8.count > WireProtocol.maxFrameBytes { break }
                guard let data = line.data(using: .utf8), let request = try? JSONDecoder().decode(NativeRequest.self, from: data) else { continue }
                handle(request)
            }
        } catch { }
        stopAll()
    }

    private func handle(_ request: NativeRequest) {
        if request.op == "cancel" {
            if let target = request.input["targetId"]?.string { taskLock.lock(); tasks[target]?.cancel(); tasks.removeValue(forKey: target); taskLock.unlock() }
            return
        }
        if request.op == "dispose" {
            emit(.success(id: request.id, result: .null)); stopAll(); return
        }
        taskLock.lock(); if stopped { taskLock.unlock(); return }
        let task = Task { [weak self] in
            guard let self else { return }
            let reply = await self.execute(request)
            self.emit(reply)
            self.taskLock.lock(); self.tasks.removeValue(forKey: request.id); self.taskLock.unlock()
        }
        tasks[request.id] = task; taskLock.unlock()
    }

    private func execute(_ request: NativeRequest) async -> NativeReply {
        do {
            switch request.op {
            case "connect":
                let identity = try await store.accountIdentity()
                return .success(id: request.id, result: .object(["identityId": .string(identity.identifier), "spaceId": .string("default"), "maxValueBytes": .number(Double(AssetStore.maxPayload)), "protocol": .number(1), "version": .string("1")]))
            case "read":
                let value = try await store.read(key: requiredString(request, "key"))
                switch value {
                case .absent: return .success(id: request.id, result: .object(["kind": .string("absent")]))
                case let .present(value): return .success(id: request.id, result: .object(["kind": .string("present"), "valueBase64": .string(value.bytes.base64EncodedString()), "version": .string(value.version), "modifiedAt": .number(Double(value.modifiedAt))]))
                }
            case "cas":
                let input = request.input; guard let value = input["valueBase64"]?.data else { throw StoreError.invalidData }
                switch try await store.compareAndSwap(key: requiredString(request, "key"), expected: input["expected"]?.string, value: value) {
                case .conflict: return .success(id: request.id, result: .object(["kind": .string("conflict")]))
                case let .written(version, modifiedAt): return .success(id: request.id, result: .object(["kind": .string("written"), "version": .string(version), "modifiedAt": .number(Double(modifiedAt))]))
                }
            case "list":
                let page = try await store.list(prefix: requiredString(request, "prefix"), cursor: request.input["cursor"]?.string)
                var result: [String: WireValue] = ["keys": .array(page.keys.map { .string($0) })]
                if let cursor = page.nextCursor { result["nextCursor"] = .string(cursor) }
                return .success(id: request.id, result: .object(result))
            case "remove":
                let removed = try await store.remove(key: requiredString(request, "key"), expected: requiredString(request, "expected"))
                return .success(id: request.id, result: .object(["kind": .string(removed ? "removed" : "conflict")]))
            default: throw StoreError.invalidData
            }
        } catch is CancellationError { return .failure(id: request.id, code: "cancelled") }
        catch { return .failure(id: request.id, code: failureCode(for: error)) }
    }

    private func requiredString(_ request: NativeRequest, _ key: String) throws -> String { guard let value = request.input[key]?.string else { throw StoreError.invalidData }; return value }
    private func emit(_ reply: NativeReply) { guard let data = try? JSONEncoder().encode(reply) else { return }; outputLock.lock(); defer { outputLock.unlock() }; FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
    private func accountChanged() { emit(.event("identity-changed")); stopAll() }
    private func stopAll() { taskLock.lock(); stopped = true; let current = tasks.values; tasks.removeAll(); taskLock.unlock(); current.forEach { $0.cancel() } }
    private func failureCode(for error: Error) -> String {
        if let error = error as? StoreError { switch error { case .identityChanged: return "identity-changed"; case .outcomeUnknown: return "outcome-unknown"; case .invalidData: return "invalid-data" } }
        guard let error = error as? CKError else { return "unsupported" }
        switch error.code { case .notAuthenticated, .permissionFailure: return "unauthorized"; case .networkFailure, .networkUnavailable, .serviceUnavailable, .requestRateLimited: return "offline"; case .quotaExceeded: return "quota"; case .operationCancelled: return "cancelled"; default: return "unsupported" }
    }
}
