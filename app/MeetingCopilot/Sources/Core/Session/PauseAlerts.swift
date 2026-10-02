import Foundation

/// While a meeting is paused: when to remind, and when sound on the meeting
/// track means the meeting is going on without us.
///
/// A forgotten pause looks exactly like the failure this app exists to
/// prevent (a meeting with nothing transcribed), so a pause is never silent:
/// a reminder every ten minutes, and an alert as soon as the meeting track
/// carries speech-level sound for a few seconds. The meeting track is the
/// process tap (system audio), not the room, so a fan or a cough doesn't
/// count. Pure: the caller passes the clock and the per-second peaks.
struct PauseAlerts {
    enum Alert: Equatable {
        /// Still paused after this many minutes.
        case reminder(minutes: Int)
        /// The meeting track has had sound for a few seconds while paused.
        case meetingSound
    }

    static let reminderInterval: TimeInterval = 10 * 60
    /// About -26 dBFS: speech through a call app, well above a quiet tap's floor.
    static let speechPeak: Float = 0.05
    /// Loud seconds needed within the last `speechWindow` seconds.
    static let speechSeconds = 3
    static let speechWindow = 5
    /// One sound alert per this long, so a video left playing doesn't nag.
    static let speechCooldown: TimeInterval = 2 * 60

    private(set) var pausedAt: Date?
    private var nextReminderAt: Date?
    private var recent: [Bool] = []
    private var lastSoundAlertAt: Date?

    var isPaused: Bool { pausedAt != nil }

    mutating func paused(at now: Date) {
        guard pausedAt == nil else { return }
        pausedAt = now
        nextReminderAt = now.addingTimeInterval(Self.reminderInterval)
        recent = []
        lastSoundAlertAt = nil
    }

    mutating func resumed() {
        pausedAt = nil
        nextReminderAt = nil
        recent = []
    }

    /// Call about once a second; returns a reminder when one is due.
    mutating func tick(now: Date) -> Alert? {
        guard let pausedAt, let due = nextReminderAt, now >= due else { return nil }
        nextReminderAt = due.addingTimeInterval(Self.reminderInterval)
        return .reminder(minutes: Int((now.timeIntervalSince(pausedAt) / 60).rounded()))
    }

    /// One second's peak on the meeting track.
    mutating func meetingPeak(_ peak: Float, at now: Date) -> Alert? {
        guard isPaused else { return nil }
        recent.append(peak >= Self.speechPeak)
        if recent.count > Self.speechWindow { recent.removeFirst(recent.count - Self.speechWindow) }
        guard recent.filter({ $0 }).count >= Self.speechSeconds else { return nil }
        if let last = lastSoundAlertAt, now.timeIntervalSince(last) < Self.speechCooldown { return nil }
        lastSoundAlertAt = now
        recent = []
        return .meetingSound
    }
}
