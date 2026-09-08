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
        XCTAssertFalse(try await store.remove(key: "k", expected: version))
        guard case let .present(value) = try await store.read(key: "k") else {
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
        XCTAssertTrue(try await store.remove(key: "k", expected: version))
        XCTAssertEqual(try await store.read(key: "k"), .absent)
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
        let store = CloudKitStore(driver: driver, pageSize: 2)
        for key in ["a/1", "a/2", "a/3"] {
            _ = try await store.compareAndSwap(key: key, expected: nil, value: Data(key.utf8))
        }
        guard case let .written(version, _) = try await store.compareAndSwap(key: "a/2", expected: nil, value: Data("x".utf8)) else {
            return XCTFail("initial write did not succeed")
        }
        XCTAssertTrue(try await store.remove(key: "a/2", expected: version))
        let first = try await store.list(prefix: "a/", cursor: nil)
        XCTAssertEqual(first.keys, ["a/1", "a/2"])
        let second = try await store.list(prefix: "a/", cursor: first.nextCursor)
        XCTAssertEqual(second.keys, ["a/3"])
    }
}
#endif
