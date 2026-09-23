import Foundation

/// User-facing toggles persisted via UserDefaults. Matches the pattern
/// already used in `MeetingCopilotApp` for `hasCompletedOnboarding` +
/// `sessionRetentionDays`.
///
/// Env-var overrides beat UserDefaults so `open -a "Meeting Copilot"
/// --env MC_USE_VAD_EMIT=0` can flip behavior without touching settings.
/// Env values are read at process start — toggling them requires an app
/// relaunch. UserDefaults is read on every call so SettingsView can flip
/// without restart (VAD path reads the flag at `startCapture` time, so
/// changes take effect on the next session, not mid-capture).
enum AppSettings {
    private enum Key {
        static let useVADEmitter = "useVADEmitter"
        static let vadThreshold = "vadThreshold"
        static let vadMinSilenceMs = "vadMinSilenceMs"
        static let vadMaxUtteranceSec = "vadMaxUtteranceSec"
        static let meetingAudioSource = "meetingAudioSource"
    }

    /// Where the meeting (other-side) track comes from.
    enum MeetingAudioSource: String {
        /// Core Audio process tap — hears every process, including the call
        /// daemons ScreenCaptureKit cannot see (phone / FaceTime calls).
        case processTap = "tap"
        /// ScreenCaptureKit per-app filter — the pre-2026-09-21 path.
        case screenCaptureKit = "sck"
    }

    /// Meeting-audio backend. Defaults to the process tap; macOS < 14.2 or a
    /// tap that fails to start falls back to ScreenCaptureKit automatically.
    /// Rollback without a rebuild:
    /// `defaults write com.christopherrobinson.meeting-copilot meetingAudioSource sck`
    /// (or launch with `MC_MEETING_AUDIO=sck`). Read at `startCapture`, so a
    /// change takes effect on the next session.
    static var meetingAudioSource: MeetingAudioSource {
        if let env = ProcessInfo.processInfo.environment["MC_MEETING_AUDIO"],
           let source = MeetingAudioSource(rawValue: env.lowercased()) {
            return source
        }
        if let stored = UserDefaults.standard.string(forKey: Key.meetingAudioSource),
           let source = MeetingAudioSource(rawValue: stored.lowercased()) {
            return source
        }
        return .processTap
    }

    /// Whether the VAD-driven chunk emitter is active. When false, falls
    /// back to the 3-second fixed timer path in AudioCaptureManager.
    ///
    /// Enabled by default after soak testing; the environment and stored
    /// preference remain available as an immediate rollback switch.
    static var useVADEmitter: Bool {
        if let env = ProcessInfo.processInfo.environment["MC_USE_VAD_EMIT"] {
            return env == "1" || env.lowercased() == "true"
        }
        if UserDefaults.standard.object(forKey: Key.useVADEmitter) != nil {
            return UserDefaults.standard.bool(forKey: Key.useVADEmitter)
        }
        return true
    }

    /// Whether capture also sends 100 ms PCM frames for live streaming
    /// transcription (the server streams them to Grok when it is the cloud
    /// provider, and ignores them otherwise). `MC_STREAM_FRAMES=0` turns it off.
    static var streamAudioFrames: Bool {
        if let env = ProcessInfo.processInfo.environment["MC_STREAM_FRAMES"] {
            return env == "1" || env.lowercased() == "true"
        }
        return true
    }

    /// Silero speech-probability threshold. 0.50 matches whisper-server's
    /// VAD config and VoiceInk's tuned value.
    static var vadThreshold: Float {
        let stored = UserDefaults.standard.double(forKey: Key.vadThreshold)
        return stored > 0 ? Float(stored) : 0.50
    }

    /// How long a silence must be (ms) before VAD decides speech ended.
    /// Lower = snappier but risks mid-sentence splits on breaths.
    static var vadMinSilenceMs: Int {
        let stored = UserDefaults.standard.integer(forKey: Key.vadMinSilenceMs)
        return stored > 0 ? stored : 300
    }

    /// Hard cap on a single utterance. Beyond this the emitter force-emits
    /// with a 500ms overlap carry into the next chunk.
    static var vadMaxUtteranceSec: Double {
        let stored = UserDefaults.standard.double(forKey: Key.vadMaxUtteranceSec)
        return stored > 0 ? stored : 6.0
    }

}
