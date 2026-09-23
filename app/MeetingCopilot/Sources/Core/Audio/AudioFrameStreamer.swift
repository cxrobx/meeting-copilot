import Foundation

/// Cuts each source's 16 kHz mono PCM16 into 100 ms frames for live streaming
/// transcription. Runs alongside the VAD chunks, which the server keeps as the
/// fallback path; frames are what let text appear ~1 s after it is spoken
/// instead of after a whole utterance.
///
/// Wire format (one binary WebSocket message per frame):
/// `[tag byte][3,200 bytes PCM16 LE]`, tag `0x01` = mic, `0x02` = meeting.
/// The server tells frames from JSON by that first byte (JSON starts with `{`).
///
/// Called from two capture threads (mic tap, meeting tap), so state is locked.
final class AudioFrameStreamer: @unchecked Sendable {
    static let frameBytes = 3_200 // 100 ms × 16,000 samples/s × 2 bytes
    static let micTag: UInt8 = 0x01
    static let meetingTag: UInt8 = 0x02

    private let lock = NSLock()
    private var pendingMic = Data()
    private var pendingMeeting = Data()
    private let emit: (Data) -> Void

    init(emit: @escaping (Data) -> Void) {
        self.emit = emit
    }

    func append(_ pcm: Data, source: TranscriptSegment.AudioSource) {
        let frames = cut(pcm, source: source)
        frames.forEach(emit)
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        pendingMic = Data()
        pendingMeeting = Data()
    }

    private func cut(_ pcm: Data, source: TranscriptSegment.AudioSource) -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        var buffer = source == .mic ? pendingMic : pendingMeeting
        buffer.append(pcm)
        var frames: [Data] = []
        var offset = buffer.startIndex
        while buffer.endIndex - offset >= Self.frameBytes {
            var frame = Data([source == .mic ? Self.micTag : Self.meetingTag])
            frame.append(buffer[offset..<(offset + Self.frameBytes)])
            frames.append(frame)
            offset += Self.frameBytes
        }
        let rest = Data(buffer[offset...])
        if source == .mic { pendingMic = rest } else { pendingMeeting = rest }
        return frames
    }
}
