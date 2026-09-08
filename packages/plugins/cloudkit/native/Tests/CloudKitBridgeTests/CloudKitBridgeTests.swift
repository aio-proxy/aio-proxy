// The execution environment used for packaging may not ship XCTest. Keeping
// a source file in this target prevents SwiftPM from treating Sources/ as an
// overlapping test target; macOS CI can add XCTest coverage for native store
// behavior when those targets are introduced.
enum CloudKitBridgeTests {}
