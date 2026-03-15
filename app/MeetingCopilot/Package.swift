// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MeetingCopilot",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "MeetingCopilot",
            path: "Sources",
            resources: [
                .process("Resources")
            ]
        )
    ]
)
