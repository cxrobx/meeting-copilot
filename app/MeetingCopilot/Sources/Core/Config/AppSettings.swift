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
    }

    /// Whether the VAD-driven chunk emitter is active. When false, falls
    /// back to the 3-second fixed timer path in AudioCaptureManager.
    ///
    /// Shipped default is `false` so Phase 3 rolls out opt-in per machine.
    /// After real-meeting validation, flip the default to `true`.
    static var useVADEmitter: Bool {
        if let env = ProcessInfo.processInfo.environment["MC_USE_VAD_EMIT"] {
            return env == "1" || env.lowercased() == "true"
        }
        if UserDefaults.standard.object(forKey: Key.useVADEmitter) != nil {
            return UserDefaults.standard.bool(forKey: Key.useVADEmitter)
        }
        return false // ship default
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

    static func setUseVADEmitter(_ value: Bool) {
        UserDefaults.standard.set(value, forKey: Key.useVADEmitter)
    }

    static func setVadThreshold(_ value: Float) {
        UserDefaults.standard.set(Double(value), forKey: Key.vadThreshold)
    }

    static func setVadMinSilenceMs(_ value: Int) {
        UserDefaults.standard.set(value, forKey: Key.vadMinSilenceMs)
    }

    static func setVadMaxUtteranceSec(_ value: Double) {
        UserDefaults.standard.set(value, forKey: Key.vadMaxUtteranceSec)
    }
}
