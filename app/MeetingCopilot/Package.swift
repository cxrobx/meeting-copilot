// swift-tools-version: 5.9
import PackageDescription

// Homebrew places whisper-cpp's headers + dylibs under its libexec dir
// (not the usual /opt/homebrew/include or /opt/homebrew/lib). The symlink
// `/opt/homebrew/opt/whisper-cpp` is stable across version bumps, so we
// point our C target and linker at it directly. Dev machines without
// whisper-cpp installed will fail `swift build` here with a clear error —
// documented in `.claude/rules/swift-app.md`.
let whisperLibexec = "/opt/homebrew/opt/whisper-cpp/libexec"

let package = Package(
    name: "MeetingCopilot",
    platforms: [.macOS(.v14)],
    targets: [
        // C umbrella exposing whisper.cpp's Silero VAD API to Swift.
        // At runtime, the app loads `libwhisper.1.8.3.dylib` from the bundle's
        // Resources/whisper/lib/ directory (scripts/build-app.sh bundles it
        // with the rest of whisper-server's runtime deps). The rpath in the
        // main binary resolves `@loader_path/../Resources/whisper/lib` to
        // that bundled copy, so dev builds and packaged .app builds both
        // work without any extra configuration.
        .target(
            name: "CWhisperVAD",
            path: "CWhisperVAD",
            publicHeadersPath: "include"
            // Headers (whisper.h + the ggml.h / ggml-cpu.h / ggml-backend.h /
            // ggml-alloc.h it transitively includes) are vendored from
            // /opt/homebrew/opt/whisper-cpp/libexec/include/ into
            // CWhisperVAD/include/ so swift package manager's module-map
            // auto-generation can resolve them without needing
            // absolute -I flags (which SPM doesn't propagate to the
            // module-map build phase). Re-copy after whisper-cpp upgrades
            // that change the VAD ABI.
        ),
        // Tiny Obj-C shim that lets Swift catch NSExceptions raised by
        // AVFoundation / CoreAudio (e.g. AVAudioNode -installTapOnBus:…
        // raises a format-mismatch NSException during input device
        // transitions that Swift cannot catch with do/try, aborting
        // the process). See gotcha #18.
        .target(
            name: "ObjCExceptionBridge",
            path: "ObjCExceptionBridge",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "MeetingCopilot",
            dependencies: ["CWhisperVAD", "ObjCExceptionBridge"],
            path: "Sources",
            resources: [
                .process("Resources")
            ],
            linkerSettings: [
                .linkedLibrary("whisper"),
                .unsafeFlags([
                    "-L\(whisperLibexec)/lib",
                    "-Xlinker", "-rpath",
                    "-Xlinker", "@loader_path/../Resources/whisper/lib",
                    // Dev fallback: swift run / swift build point at the
                    // Homebrew install directly since there's no bundled
                    // whisper in the build dir.
                    "-Xlinker", "-rpath",
                    "-Xlinker", "\(whisperLibexec)/lib",
                ]),
            ]
        ),
        .testTarget(
            name: "MeetingCopilotTests",
            dependencies: ["MeetingCopilot"],
            path: "Tests"
        )
    ]
)
