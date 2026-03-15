// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "AudioSpike",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "AudioSpike",
            path: "Sources"
        )
    ]
)
