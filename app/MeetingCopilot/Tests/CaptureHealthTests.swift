import XCTest
@testable import MeetingCopilot

/// Covers the capture-health watchdog's decision logic.
///
/// Regression target: the 2026-07-31 session, where `engine.start()` reported
/// success and `mic started` was logged, but the tap never fired once for the
/// full ~100s meeting. Nothing noticed, so the meeting was recorded with only
/// one track. These tests pin the rules that now catch that.
final class CaptureHealthTests: XCTestCase {

    // MARK: - Mic verdict

    func testMicHealthyAsSoonAsAnyBufferArrives() {
        // One buffer is enough — even before the grace window closes.
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(buffers: 1, elapsed: 0.5, restartsUsed: 0),
            .healthy
        )
    }

    func testMicWaitsOutTheGraceWindowBeforeJudging() {
        // notes4chris's bug in mirror image: a slow start must not be called
        // dead. Nothing may happen before `grace` elapses.
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(buffers: 0, elapsed: 7.9, restartsUsed: 0, grace: 8.0),
            .wait
        )
    }

    func testMicRestartsOnceGraceElapsesWithNoBuffers() {
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(buffers: 0, elapsed: 8.0, restartsUsed: 0, grace: 8.0),
            .restart
        )
    }

    func testMicGivesUpAfterRestartLadderExhausted() {
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(buffers: 0, elapsed: 20, restartsUsed: 2, maxRestarts: 2),
            .giveUp
        )
    }

    func testMicSilenceIsNotTreatedAsDeath() {
        // THE critical distinction. A muted or simply quiet mic still fires the
        // tap and logs `mic peak=0.0000`. Restarting the engine for that would
        // interrupt a perfectly good capture, so buffer count is the only
        // signal this verdict is allowed to key on.
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(buffers: 400, elapsed: 60, restartsUsed: 0),
            .healthy
        )
    }

    func testMicRealWorldDeadSessionIsCaught() {
        // The actual failure: ~100s of capture, zero tap callbacks.
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(buffers: 0, elapsed: 100, restartsUsed: 0),
            .restart
        )
    }

    func testMicThatStopsMidSessionIsCaught() {
        // 2026-09-25: ~28 s of buffers, then none for the rest of the meeting.
        // One early buffer used to make the mic healthy for good.
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(
                buffers: 160, elapsed: 400, restartsUsed: 0, sinceLastBuffer: 5.0, stallGrace: 5.0
            ),
            .restart
        )
    }

    func testMicStillDeliveringIsNotAStall() {
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(
                buffers: 160, elapsed: 400, restartsUsed: 0, sinceLastBuffer: 4.9, stallGrace: 5.0
            ),
            .healthy
        )
    }

    func testMicStallGivesUpAfterRestartLadderExhausted() {
        XCTAssertEqual(
            AudioCaptureManager.micVerdict(
                buffers: 160, elapsed: 400, restartsUsed: 2, sinceLastBuffer: 30, maxRestarts: 2
            ),
            .giveUp
        )
    }

    // MARK: - Meeting verdict

    func testMeetingHealthyWhenAnyRealSignalSeen() {
        XCTAssertEqual(
            AudioCaptureManager.meetingVerdict(buffers: 98, nonZero: 1, elapsed: 100),
            .healthy
        )
    }

    func testMeetingWaitsOutGraceBeforeCallingItSilent() {
        XCTAssertEqual(
            AudioCaptureManager.meetingVerdict(buffers: 20, nonZero: 0, elapsed: 24.9, grace: 25.0),
            .wait
        )
    }

    func testMeetingSilentOnceGraceElapsesWithOnlyZeroBuffers() {
        XCTAssertEqual(
            AudioCaptureManager.meetingVerdict(buffers: 25, nonZero: 0, elapsed: 25.0, grace: 25.0),
            .silent
        )
    }

    func testMeetingNoBuffersIsNotReportedAsSilent() {
        // No buffers at all is a broken stream, not bad audio routing. This
        // watchdog would only mislead, so it stays quiet and lets the mic /
        // device-error paths own that case.
        XCTAssertEqual(
            AudioCaptureManager.meetingVerdict(buffers: 0, nonZero: 0, elapsed: 600),
            .wait
        )
    }

    func testMeetingRealWorldSilentSessionIsCaught() {
        // 2026-07-31: 98 buffers delivered, 2 carrying signal → healthy.
        // Strip those 2 and it is the all-zero case the watchdog must flag.
        XCTAssertEqual(
            AudioCaptureManager.meetingVerdict(buffers: 98, nonZero: 2, elapsed: 100),
            .healthy
        )
        XCTAssertEqual(
            AudioCaptureManager.meetingVerdict(buffers: 98, nonZero: 0, elapsed: 100),
            .silent
        )
    }

    // MARK: - Counters

    func testCountersDistinguishNoBuffersFromZeroValuedBuffers() {
        let health = CaptureHealth()
        for _ in 0..<10 { health.recordMic(peak: 0.0) }
        let stats = health.snapshot()
        // Ten silent buffers: the tap IS alive, so buffers must be non-zero
        // while nonZero stays at 0. Collapsing these two would resurrect the
        // exact bug this watchdog exists to catch.
        XCTAssertEqual(stats.micBuffers, 10)
        XCTAssertEqual(stats.micNonZero, 0)
        XCTAssertEqual(stats.meetingBuffers, 0)
    }

    func testResetMicLeavesMeetingCountersIntact() {
        let health = CaptureHealth()
        health.recordMic(peak: 0.5)
        health.recordMeeting(peak: 0.5)
        health.resetMic()
        let stats = health.snapshot()
        // A mic restart must not erase the meeting track's history, or the
        // meeting grace window would silently restart along with it.
        XCTAssertEqual(stats.micBuffers, 0)
        XCTAssertEqual(stats.meetingBuffers, 1)
        XCTAssertEqual(stats.meetingNonZero, 1)
    }
}
