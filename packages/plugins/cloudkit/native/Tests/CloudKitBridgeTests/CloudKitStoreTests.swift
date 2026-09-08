import CloudKit
#if canImport(XCTest)
import XCTest
@testable import CloudKitBridge

final class CloudKitStoreTests: XCTestCase {
    func testOnlyOneConcurrentCreateWins() async throws {
        let driver = FakeCloudKitDriver()
        let a = CloudKitStore(driver: driver)
        let b = CloudKitStore(driver: driver)
        async let left = a.compareAndSwap(key: "k", expected: nil, value: Data("a".utf8))
        async let right = b.compareAndSwap(key: "k", expected: nil, value: Data("b".utf8))
        let results = try await [left, right]
        XCTAssertEqual(results.filter { if case .written = $0 { return true }; return false }.count, 1)
        XCTAssertEqual(results.filter { if case .conflict = $0 { return true }; return false }.count, 1)
    }

    func testStaleRemoveDoesNotDeleteNewerValue() async throws {
        let driver = FakeCloudKitDriver()
        let store = CloudKitStore(driver: driver)
        guard case let .written(version, _) = try await store.compareAndSwap(key: "k", expected: nil, value: Data("old".utf8)) else {
            return XCTFail("initial write did not succeed")
        }
        guard case .written = try await store.compareAndSwap(key: "k", expected: version, value: Data("new".utf8)) else {
            return XCTFail("replacement write did not succeed")
        }
        let removed = try await store.remove(key: "k", expected: version)
        XCTAssertFalse(removed)
        let read = try await store.read(key: "k")
        guard case let .present(value) = read else {
            return XCTFail("new value was removed")
        }
        XCTAssertEqual(value.bytes, Data("new".utf8))
    }

    func testRemoveThenExpectedNilCreateReusesBackingRecord() async throws {
        let driver = FakeCloudKitDriver()
        let store = CloudKitStore(driver: driver)
        guard case let .written(version, _) = try await store.compareAndSwap(key: "k", expected: nil, value: Data("old".utf8)) else {
            return XCTFail("initial write did not succeed")
        }
        let removed = try await store.remove(key: "k", expected: version)
        XCTAssertTrue(removed)
        let afterRemove = try await store.read(key: "k")
        XCTAssertEqual(afterRemove, .absent)
        guard case let .written(newVersion, _) = try await store.compareAndSwap(key: "k", expected: nil, value: Data("new".utf8)) else {
            return XCTFail("recreate did not succeed")
        }
        XCTAssertFalse(newVersion.isEmpty)
        guard case let .present(value) = try await store.read(key: "k") else {
            return XCTFail("recreated value missing")
        }
        XCTAssertEqual(value.bytes, Data("new".utf8))
    }

    func testPostSaveTransportLossRecoversByRead() async throws {
        let driver = FakeCloudKitDriver()
        await driver.armPostSaveTransportLoss()
        let store = CloudKitStore(driver: driver)
        guard case let .written(version, _) = try await store.compareAndSwap(key: "k", expected: nil, value: Data("v".utf8)) else {
            return XCTFail("write did not recover")
        }
        XCTAssertFalse(version.isEmpty)
    }

    func testAccountIdentityChangeIsRejected() async throws {
        let driver = FakeCloudKitDriver()
        let store = CloudKitStore(driver: driver)
        _ = try await store.list(prefix: "", cursor: nil)
        await driver.changeIdentity()
        do {
            _ = try await store.list(prefix: "", cursor: nil)
            XCTFail("identity change was accepted")
        } catch StoreError.identityChanged {
        }
    }

    func testListPaginatesAndHidesTombstones() async throws {
        let driver = FakeCloudKitDriver()
        let store = CloudKitStore(driver: driver)
        for key in ["a/1", "a/2", "a/3", "a/4", "a/5"] {
            _ = try await store.compareAndSwap(key: key, expected: nil, value: Data(key.utf8))
        }
        guard case let .written(version, _) = try await store.compareAndSwap(key: "a/2", expected: nil, value: Data("x".utf8)) else {
            return XCTFail("initial write did not succeed")
        }
        let removed = try await store.remove(key: "a/2", expected: version)
        XCTAssertTrue(removed)
        let first = try await store.list(prefix: "a/", cursor: nil)
        XCTAssertEqual(first.keys, ["a/1", "a/3"])
        let second = try await store.list(prefix: "a/", cursor: first.nextCursor)
        XCTAssertEqual(second.keys, ["a/4", "a/5"])
    }

    func testMissingAccountIsPropagated() async throws {
        let driver = FakeCloudKitDriver()
        await driver.setAccountAvailable(false)
        do {
            _ = try await CloudKitStore(driver: driver).read(key: "k")
            XCTFail("missing account was accepted")
        } catch ProbeError.accountUnavailable {
        }
    }

    func testMalformedCursorIsRejected() async throws {
        do {
            _ = try await CloudKitStore(driver: FakeCloudKitDriver()).list(prefix: "", cursor: "%%%")
            XCTFail("malformed cursor was accepted")
        } catch StoreError.invalidData {
        }
    }

    func testPayloadAndFrameBounds() throws {
        XCTAssertThrowsError(try AssetStore.makeAsset(Data(repeating: 0, count: AssetStore.maxPayload + 1))) { error in
            XCTAssertEqual(error as? StoreError, .invalidData)
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data(repeating: 0, count: AssetStore.maxFrame + 1).write(to: url)
        XCTAssertThrowsError(try AssetStore.data(from: CKAsset(fileURL: url))) { error in
            XCTAssertEqual(error as? StoreError, .invalidData)
        }
    }
}
#endif
