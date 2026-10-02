import XCTest
@testable import MeetingCopilot

final class MicDevicePickerTests: XCTestCase {
    private let builtIn = MicDevicePicker.InputDevice(id: 91, name: "MacBook Pro Microphone", isBuiltIn: true)
    private let airPods = MicDevicePicker.InputDevice(id: 104, name: "Chris’s AirPods Pro", isBuiltIn: false)

    func testDefaultPreferenceIsTheBuiltInMic() {
        // 2026-09-25: the AirPods mic (the system default) died mid-meeting;
        // the built-in mic CXNotes was pinned to kept recording.
        XCTAssertEqual(MicDevicePicker.Preference(setting: nil), .builtIn)
        XCTAssertEqual(MicDevicePicker.choose(.builtIn, from: [airPods, builtIn]), builtIn)
    }

    func testNoBuiltInMicFallsBackToTheSystemDefault() {
        // Lid closed or a Mac mini: nil leaves the engine on the default input.
        XCTAssertNil(MicDevicePicker.choose(.builtIn, from: [airPods]))
    }

    func testSystemDefaultPreferencePinsNothing() {
        XCTAssertEqual(MicDevicePicker.Preference(setting: "default"), .systemDefault)
        XCTAssertNil(MicDevicePicker.choose(.systemDefault, from: [airPods, builtIn]))
    }

    func testNamedDeviceWinsAndFallsBackToBuiltInWhenAbsent() {
        let pref = MicDevicePicker.Preference(setting: "Chris’s AirPods Pro")
        XCTAssertEqual(MicDevicePicker.choose(pref, from: [builtIn, airPods]), airPods)
        XCTAssertEqual(MicDevicePicker.choose(pref, from: [builtIn]), builtIn)
    }

    func testAPinnedMicThatWillNotStartFallsBackToTheSystemDefault() {
        // 2026-10-02: the built-in mic failed with -10868 while AirPods were
        // in a call, and with no second attempt the session never started.
        XCTAssertEqual(MicDevicePicker.attempts(.builtIn, from: [airPods, builtIn]), [builtIn, nil])
        XCTAssertEqual(MicDevicePicker.attempts(.systemDefault, from: [airPods, builtIn]), [nil])
        XCTAssertEqual(MicDevicePicker.attempts(.builtIn, from: [airPods]), [nil])
    }

    func testSettingsGetEveryInputAndTheCurrentChoice() {
        // The dashboard's Settings field (settingsMicFill) reads exactly these keys.
        let mics = MicDevicePicker.choices(devices: [builtIn, airPods], setting: "default", current: "Chris’s AirPods Pro")
        let devices = mics["devices"] as? [[String: Any]]
        XCTAssertEqual(devices?.compactMap { $0["name"] as? String }, ["MacBook Pro Microphone", "Chris’s AirPods Pro"])
        XCTAssertEqual(devices?.compactMap { $0["builtIn"] as? Bool }, [true, false])
        XCTAssertEqual(mics["preference"] as? String, "default")
        XCTAssertEqual(mics["current"] as? String, "Chris’s AirPods Pro")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(MicDevicePicker.choices(devices: [], setting: "builtin", current: nil)))
    }

    func testThisMacReportsItsInputDevices() {
        // Hardware smoke check: the real enumeration runs without crashing.
        let devices = MicDevicePicker.inputDevices()
        print("[MicDevicePickerTests] inputs: \(devices.map { "\($0.name)\($0.isBuiltIn ? " (built-in)" : "")" })")
    }
}
