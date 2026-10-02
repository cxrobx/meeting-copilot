import XCTest
@testable import MeetingCopilot

/// A forgotten pause must surface (PauseAlerts): a reminder every ten
/// minutes, and an alert when the meeting track has sound.
final class PauseAlertsTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

    func testRemindsEveryTenMinutesWhilePaused() {
        var alerts = PauseAlerts()
        XCTAssertNil(alerts.tick(now: t0.addingTimeInterval(3_600)), "not paused, no reminder")
        alerts.paused(at: t0)
        XCTAssertNil(alerts.tick(now: t0.addingTimeInterval(599)))
        XCTAssertEqual(alerts.tick(now: t0.addingTimeInterval(600)), .reminder(minutes: 10))
        XCTAssertNil(alerts.tick(now: t0.addingTimeInterval(601)), "once per interval")
        XCTAssertEqual(alerts.tick(now: t0.addingTimeInterval(1_200)), .reminder(minutes: 20))
        alerts.resumed()
        XCTAssertNil(alerts.tick(now: t0.addingTimeInterval(1_800)))
    }

    func testMeetingSoundAlertsAfterThreeLoudSecondsInFive() {
        var alerts = PauseAlerts()
        XCTAssertNil(alerts.meetingPeak(0.5, at: t0), "running: never")
        alerts.paused(at: t0)
        let loud: Float = 0.2, quiet: Float = 0.001
        XCTAssertNil(alerts.meetingPeak(loud, at: t0.addingTimeInterval(1)))
        XCTAssertNil(alerts.meetingPeak(quiet, at: t0.addingTimeInterval(2)))
        XCTAssertNil(alerts.meetingPeak(loud, at: t0.addingTimeInterval(3)))
        XCTAssertEqual(alerts.meetingPeak(loud, at: t0.addingTimeInterval(4)), .meetingSound)
    }

    func testIsolatedBlipsAndQuietRoomsNeverAlert() {
        var alerts = PauseAlerts()
        alerts.paused(at: t0)
        // One loud second every three: never three within any five.
        for i in 0..<60 {
            let peak: Float = i % 3 == 0 ? 0.3 : 0.01
            XCTAssertNil(alerts.meetingPeak(peak, at: t0.addingTimeInterval(Double(i))), "second \(i)")
        }
    }

    func testSoundAlertCoolsDownForTwoMinutes() {
        var alerts = PauseAlerts()
        alerts.paused(at: t0)
        var raised: [Int] = []
        for i in 0..<200 where alerts.meetingPeak(0.3, at: t0.addingTimeInterval(Double(i))) != nil {
            raised.append(i)
        }
        XCTAssertEqual(raised, [2, 122], "a video left playing alerts every two minutes, not every three seconds")
    }
}
