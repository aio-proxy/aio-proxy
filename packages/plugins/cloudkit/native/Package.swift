// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CloudKitBridge",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "AIOProxyCloudKit", targets: ["CloudKitBridge"])],
    targets: [
        .executableTarget(name: "CloudKitBridge"),
        .testTarget(name: "CloudKitBridgeTests", dependencies: ["CloudKitBridge"]),
    ]
)
