import AppKit
import Carbon.HIToolbox

/// ⌃⌥1 / ⌃⌥2 / ⌃⌥3: the coach's three questions, from any app.
///
/// During a call the focus is in Zoom or Meet, so a shortcut inside the
/// dashboard would never fire. These are Carbon hotkeys, not an NSEvent
/// global monitor (what ⌘⇧M uses): they need no Accessibility grant, and
/// they swallow the keystroke, so the meeting app does not also receive it.
///
/// Control is part of the chord on purpose. From macOS 15, RegisterEventHotKey
/// refuses hotkeys whose only modifiers are Option or Option-Shift, so ⌥1
/// would work on this Mac today and fail silently after an upgrade.
///
/// Registered only while a meeting is live, so the chords stay free for other
/// apps the rest of the time. Registration is exclusive, which catches only
/// part of the conflict (probed 2026-09-22): an app that registered the chord
/// exclusively makes ours fail with eventHotKeyExistsErr (-9878), which the
/// caller reports; an app that registered it without the flag cannot be seen,
/// and loses the chord to us until the meeting ends.
@MainActor
final class CoachHotkeys {
    enum Ask: UInt32, CaseIterable {
        case checkIn = 1
        case missed = 2
        case suggest = 3

        var keyCode: UInt32 {
            switch self {
            case .checkIn: return UInt32(kVK_ANSI_1)
            case .missed: return UInt32(kVK_ANSI_2)
            case .suggest: return UInt32(kVK_ANSI_3)
            }
        }

        var chord: String { "⌃⌥\(rawValue)" }

        var label: String {
            switch self {
            case .checkIn: return "How am I doing?"
            case .missed: return "Missed anything?"
            case .suggest: return "Suggest"
            }
        }
    }

    /// 'MCHK' — tags our hotkey IDs so the handler ignores anyone else's.
    private static let signature: OSType = 0x4D43_484B

    var onPress: ((Ask) -> Void)?
    private var refs: [EventHotKeyRef] = []
    private var handler: EventHandlerRef?

    var isRegistered: Bool { !refs.isEmpty }

    /// Registers all three chords. Returns the chords that could not be
    /// registered, with their status, so the caller can say which are taken.
    @discardableResult
    func register() -> [(Ask, OSStatus)] {
        guard !isRegistered else { return [] }
        installHandlerIfNeeded()
        var failed: [(Ask, OSStatus)] = []
        for ask in Ask.allCases {
            var ref: EventHotKeyRef?
            let status = RegisterEventHotKey(
                ask.keyCode,
                UInt32(controlKey | optionKey),
                EventHotKeyID(signature: Self.signature, id: ask.rawValue),
                GetApplicationEventTarget(),
                OptionBits(kEventHotKeyExclusive),
                &ref
            )
            if status == noErr, let ref {
                refs.append(ref)
            } else {
                failed.append((ask, status))
            }
        }
        return failed
    }

    func unregister() {
        for ref in refs { UnregisterEventHotKey(ref) }
        refs.removeAll()
    }

    private func installHandlerIfNeeded() {
        guard handler == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let context = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData in
            guard let event, let userData else { return OSStatus(eventNotHandledErr) }
            var id = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &id
            )
            guard status == noErr, id.signature == CoachHotkeys.signature,
                  let ask = Ask(rawValue: id.id) else { return OSStatus(eventNotHandledErr) }
            let hotkeys = Unmanaged<CoachHotkeys>.fromOpaque(userData).takeUnretainedValue()
            // Carbon dispatches hotkey events on the main thread.
            MainActor.assumeIsolated { hotkeys.onPress?(ask) }
            return noErr
        }, 1, &spec, context, &handler)
    }
}
