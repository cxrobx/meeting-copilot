import XCTest
@testable import MeetingCopilot

/// Covers what a fresh Mac sees while local transcription sets itself up
/// (T230): the app ships uv and the Parakeet lock but not the 2.5 GB model,
/// and no longer ships whisper's 148 MB model either.
final class TranscriptionSetupTests: XCTestCase {
    private var scratch: URL!

    override func setUpWithError() throws {
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("mc-setup-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: scratch)
    }

    // MARK: - Where the model lands

    func testModelCacheFollowsHuggingFaceOrder() {
        let model = "models--mlx-community--parakeet-tdt-0.6b-v3"
        XCTAssertEqual(
            ProcessSupervisor.parakeetModelCacheDir(environment: ["HF_HUB_CACHE": "/c", "HF_HOME": "/h"]),
            "/c/\(model)")
        XCTAssertEqual(
            ProcessSupervisor.parakeetModelCacheDir(environment: ["HF_HOME": "/h"]),
            "/h/hub/\(model)")
        XCTAssertEqual(
            ProcessSupervisor.parakeetModelCacheDir(environment: [:]),
            NSString(string: "~/.cache/huggingface/hub/\(model)").expandingTildeInPath)
    }

    // MARK: - What the card says

    func testNothingDownloadedYetSaysWhatTheFirstStartFetches() {
        let status = ProcessSupervisor.parakeetSetupStatus(cacheDir: scratch.path)
        XCTAssertTrue(status.contains("2.5 GB"), status)
        XCTAssertFalse(status.contains("%"), status)
    }

    func testPartialDownloadReportsAPercentage() throws {
        let blobs = scratch.appendingPathComponent("blobs")
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        // A sparse file: the size counts, the disk isn't used.
        let partial = blobs.appendingPathComponent("abc.incomplete")
        FileManager.default.createFile(atPath: partial.path, contents: nil)
        let handle = try FileHandle(forWritingTo: partial)
        try handle.truncate(atOffset: UInt64(ProcessSupervisor.parakeetModelBytes / 4))
        try handle.close()

        let status = ProcessSupervisor.parakeetSetupStatus(cacheDir: scratch.path)
        XCTAssertTrue(status.contains("25%"), status)
    }

    func testCompleteModelSaysLoading() throws {
        let blobs = scratch.appendingPathComponent("blobs")
        try FileManager.default.createDirectory(at: blobs, withIntermediateDirectories: true)
        let model = blobs.appendingPathComponent("05e01c7f")
        FileManager.default.createFile(atPath: model.path, contents: nil)
        let handle = try FileHandle(forWritingTo: model)
        try handle.truncate(atOffset: UInt64(ProcessSupervisor.parakeetModelBytes))
        try handle.close()

        XCTAssertEqual(ProcessSupervisor.parakeetSetupStatus(cacheDir: scratch.path), "Loading the speech model…")
    }

    // MARK: - Verified download

    func testSha256MatchesShasum() throws {
        let file = scratch.appendingPathComponent("abc.txt")
        try Data("abc".utf8).write(to: file)
        XCTAssertEqual(
            try ProcessSupervisor.sha256Hex(of: file),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testDownloadMovesAVerifiedFileIntoPlace() async throws {
        let source = scratch.appendingPathComponent("model.bin")
        try Data("abc".utf8).write(to: source)
        let destination = scratch.appendingPathComponent("models/ggml-base.en.bin").path

        let result = await ProcessSupervisor.downloadVerified(
            from: source,
            sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            to: destination)

        if case .failure(let error) = result { XCTFail("download failed: \(error)") }
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: destination)), Data("abc".utf8))
    }

    func testDownloadRefusesAWrongChecksumAndLeavesNothingBehind() async throws {
        let source = scratch.appendingPathComponent("model.bin")
        try Data("not the model".utf8).write(to: source)
        let destination = scratch.appendingPathComponent("models/ggml-base.en.bin").path

        let result = await ProcessSupervisor.downloadVerified(
            from: source, sha256: ProcessSupervisor.whisperModelSHA256, to: destination)

        guard case .failure(let error) = result,
              case ProcessSupervisor.ModelDownloadError.checksum = error else {
            return XCTFail("expected a checksum refusal, got \(result)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination))
    }

    func testWhisperModelIsPinnedToACommit() {
        // `resolve/main` would let upstream swap the file under the checksum.
        XCTAssertFalse(ProcessSupervisor.whisperModelURL.absoluteString.contains("/resolve/main/"))
        XCTAssertEqual(ProcessSupervisor.whisperModelSHA256.count, 64)
    }
}
