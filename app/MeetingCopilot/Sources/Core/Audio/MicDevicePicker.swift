import CoreAudio
import Foundation

/// Which input device the mic track records from.
///
/// Following the system default put the mic on AirPods whenever they were
/// connected. Opening an AirPods mic drops them into the call profile, and any
/// later renegotiation stops a running AVAudioEngine: on 2026-09-25 the mic
/// died 28 s into a client meeting (gotcha #28). CXNotes, pinned to the
/// built-in mic, kept recording through the same call. So the default is the
/// built-in mic, with the system default as the fallback when there is none
/// (lid closed, Mac mini).
enum MicDevicePicker {
    struct InputDevice: Equatable {
        let id: AudioDeviceID
        let name: String
        let isBuiltIn: Bool
    }

    enum Preference: Equatable {
        /// The Mac's own microphone, else the system default.
        case builtIn
        /// Whatever macOS has as the default input.
        case systemDefault
        /// A device by exact name, else the built-in mic, else the default.
        case named(String)

        init(setting: String?) {
            switch setting?.trimmingCharacters(in: .whitespaces).lowercased() {
            case nil, "", "builtin", "built-in": self = .builtIn
            case "default", "system": self = .systemDefault
            default: self = .named(setting!.trimmingCharacters(in: .whitespaces))
            }
        }
    }

    /// The device to pin, or nil to leave AVAudioEngine on the system default.
    /// Pure so it can be tested without hardware.
    static func choose(_ preference: Preference, from devices: [InputDevice]) -> InputDevice? {
        switch preference {
        case .systemDefault:
            return nil
        case .builtIn:
            return devices.first(where: \.isBuiltIn)
        case .named(let name):
            return devices.first(where: { $0.name == name }) ?? devices.first(where: \.isBuiltIn)
        }
    }

    /// The devices to try in order: the chosen one, then the system default
    /// (nil). On 2026-10-02 the built-in mic would not start (`-10868`) while
    /// AirPods were in a call, and with no second attempt the session never
    /// began; the AirPods mic, the system default, started at once.
    static func attempts(_ preference: Preference, from devices: [InputDevice]) -> [InputDevice?] {
        guard let device = choose(preference, from: devices) else { return [nil] }
        return [device, nil]
    }

    /// What the dashboard's Settings shows (`settingsMicFill` in
    /// server/src/present/index.ts). Pure so it can be tested.
    static func choices(devices: [InputDevice], setting: String, current: String?) -> [String: Any] {
        var out: [String: Any] = [
            "devices": devices.map { ["name": $0.name, "builtIn": $0.isBuiltIn] as [String: Any] },
            "preference": setting,
        ]
        out["current"] = current ?? NSNull()
        return out
    }

    // MARK: - Core Audio

    /// Every device that has input streams.
    static func inputDevices() -> [InputDevice] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr,
              size > 0 else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else {
            return []
        }
        return ids.compactMap { id in
            guard hasInputStreams(id) else { return nil }
            return InputDevice(id: id, name: name(of: id), isBuiltIn: transportType(of: id) == kAudioDeviceTransportTypeBuiltIn)
        }
    }

    private static func hasInputStreams(_ id: AudioDeviceID) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr && size > 0
    }

    private static func transportType(of id: AudioDeviceID) -> UInt32 {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr ? value : 0
    }

    static func name(of id: AudioDeviceID) -> String {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var ref: Unmanaged<CFString>?
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &ref) == noErr,
              let name = ref?.takeRetainedValue() else { return "Unknown" }
        return name as String
    }
}
