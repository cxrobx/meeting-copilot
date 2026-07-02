import SwiftUI
import AVFoundation
import ScreenCaptureKit

// MARK: - Permissions View

/// First-launch TCC permissions flow.
/// Guides users through granting Screen Recording and Microphone permissions.
struct PermissionsView: View {
    @State private var screenRecordingGranted = false
    @State private var microphoneGranted = false
    @State private var accessibilityGranted = false
    @State private var isCheckingPermissions = false
    let onComplete: () -> Void

    // Accessibility is deliberately NOT required — it only gates the global
    // ⌘⇧M hotkey while other apps are focused.
    var allPermissionsGranted: Bool {
        screenRecordingGranted && microphoneGranted
    }

    var body: some View {
        VStack(spacing: 24) {
            // Header
            VStack(spacing: 8) {
                Image(systemName: "lock.shield")
                    .font(.system(size: 40))
                    .foregroundStyle(.blue)

                Text("Permissions Required")
                    .font(.title2)
                    .fontWeight(.semibold)

                Text("Meeting Copilot needs these permissions to capture and transcribe meeting audio.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 8)

            // Permission Steps
            VStack(spacing: 16) {
                // Step 1: Screen Recording
                PermissionRow(
                    step: 1,
                    title: "Screen Recording",
                    description: "Required to capture meeting audio from apps like Zoom, Teams, and Google Meet.",
                    isGranted: screenRecordingGranted,
                    action: {
                        openScreenRecordingSettings()
                    },
                    actionLabel: "Open System Settings"
                )

                // Step 2: Microphone
                PermissionRow(
                    step: 2,
                    title: "Microphone",
                    description: "Required to capture your voice for transcription.",
                    isGranted: microphoneGranted,
                    action: {
                        requestMicrophonePermission()
                    },
                    actionLabel: "Grant Access"
                )

                // Step 3: Accessibility (optional) — the global ⌘⇧M hotkey
                // only receives keystrokes from other apps with this grant.
                // The hotkey always works while a Copilot window is focused.
                PermissionRow(
                    step: 3,
                    title: "Accessibility (optional)",
                    description: "Enables the global \u{2318}\u{21E7}M panel hotkey while other apps are focused. Skippable — the shortcut still works inside Meeting Copilot.",
                    isGranted: accessibilityGranted,
                    action: {
                        openAccessibilitySettings()
                    },
                    actionLabel: "Open System Settings"
                )
            }

            Spacer()

            // Continue button
            Button(action: onComplete) {
                Text("Continue")
                    .font(.body)
                    .fontWeight(.medium)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!allPermissionsGranted)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)

            // Refresh link
            Button("Check Permissions Again") {
                Task {
                    await checkPermissions()
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.bottom, 12)
        }
        .padding(20)
        .frame(width: 400, height: 500)
        .task {
            await checkPermissions()
        }
    }

    // MARK: - Permission Checks

    private func checkPermissions() async {
        isCheckingPermissions = true

        // Check screen recording
        screenRecordingGranted = await checkScreenRecordingPermission()

        // Check microphone
        microphoneGranted = checkMicrophonePermission()

        // Check accessibility (optional — global hotkey only)
        accessibilityGranted = AXIsProcessTrusted()

        isCheckingPermissions = false
    }

    private func checkScreenRecordingPermission() async -> Bool {
        do {
            _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            return true
        } catch {
            return false
        }
    }

    private func checkMicrophonePermission() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    private func requestMicrophonePermission() {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            Task { @MainActor in
                microphoneGranted = granted
            }
        }
    }

    private func openScreenRecordingSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    private func openAccessibilitySettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Permission Row

struct PermissionRow: View {
    let step: Int
    let title: String
    let description: String
    let isGranted: Bool
    let action: () -> Void
    let actionLabel: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            // Step indicator
            ZStack {
                Circle()
                    .fill(isGranted ? .green : .blue)
                    .frame(width: 28, height: 28)

                if isGranted {
                    Image(systemName: "checkmark")
                        .font(.caption)
                        .fontWeight(.bold)
                        .foregroundStyle(.white)
                } else {
                    Text("\(step)")
                        .font(.caption)
                        .fontWeight(.bold)
                        .foregroundStyle(.white)
                }
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.body)
                    .fontWeight(.medium)

                Text(description)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if !isGranted {
                    Button(action: action) {
                        Text(actionLabel)
                            .font(.caption)
                            .fontWeight(.medium)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .padding(.top, 4)
                }
            }

            Spacer()
        }
        .padding(12)
        .background(isGranted ? Color.green.opacity(0.05) : Color.blue.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
