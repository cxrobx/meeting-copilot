import SwiftUI

// MARK: - Transcription Mode

enum TranscriptionMode: String, CaseIterable {
    case local = "Local (Whisper)"
    case cloud = "Cloud (Deepgram)"
}

// MARK: - Intelligence Cadence

enum IntelligenceCadence: String, CaseIterable {
    case fast = "Fast (10s)"
    case normal = "Normal (15s)"
    case relaxed = "Relaxed (30s)"
}

// MARK: - Settings View

struct SettingsView: View {
    @AppStorage("transcriptionMode") private var transcriptionMode: String = TranscriptionMode.local.rawValue
    @AppStorage("sessionRetentionDays") private var sessionRetentionDays: Double = 90
    @AppStorage("intelligenceCadence") private var intelligenceCadence: String = IntelligenceCadence.normal.rawValue
    @AppStorage("presentationMode") private var presentationMode: Bool = false
    @AppStorage("shareTranscript") private var shareTranscript: Bool = true

    var body: some View {
        Form {
            // Transcription
            Section {
                Picker("Transcription Engine", selection: $transcriptionMode) {
                    ForEach(TranscriptionMode.allCases, id: \.rawValue) { mode in
                        Text(mode.rawValue).tag(mode.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                if transcriptionMode == TranscriptionMode.cloud.rawValue {
                    HStack(spacing: 6) {
                        Image(systemName: "icloud.and.arrow.up")
                            .foregroundStyle(.orange)
                            .font(.caption)
                        Text("Audio will be sent to Deepgram for transcription.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                } else {
                    HStack(spacing: 6) {
                        Image(systemName: "lock.shield")
                            .foregroundStyle(.green)
                            .font(.caption)
                        Text("Audio is processed locally using Whisper. Nothing leaves your machine.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("Transcription")
            }

            // Intelligence
            Section {
                Picker("Eval Cadence", selection: $intelligenceCadence) {
                    ForEach(IntelligenceCadence.allCases, id: \.rawValue) { cadence in
                        Text(cadence.rawValue).tag(cadence.rawValue)
                    }
                }
                .pickerStyle(.segmented)

                Toggle("Presentation Mode", isOn: $presentationMode)

                if presentationMode {
                    HStack(spacing: 6) {
                        Image(systemName: "eye")
                            .foregroundStyle(.blue)
                            .font(.caption)
                        Text("Panel is optimized for screen sharing. Sensitive transcript text is hidden.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            } header: {
                Text("Intelligence")
            } footer: {
                Text("Eval cadence controls how often the AI evaluates the transcript for actionable content.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // Sharing
            Section {
                Toggle("Share transcript with companion apps", isOn: $shareTranscript)
            } header: {
                Text("Integration")
            } footer: {
                Text("When enabled, a live transcript file is written to ~/.meeting-shared/ for other tools like notes4chris.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // Data Retention
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Retention Period")
                        Spacer()
                        Text("\(Int(sessionRetentionDays)) days")
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                    }
                    Slider(value: $sessionRetentionDays, in: 7...365, step: 1)
                }
            } header: {
                Text("Data Retention")
            } footer: {
                Text("Session data older than this will be automatically deleted.")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            // About
            Section {
                LabeledContent("Version") {
                    Text(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                        .foregroundStyle(.secondary)
                }

                LabeledContent("Build") {
                    Text(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1")
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Data Routing")
                        .font(.body)
                    VStack(alignment: .leading, spacing: 4) {
                        DataRouteRow(label: "Audio capture", destination: "Local (ScreenCaptureKit + AVAudioEngine)")
                        DataRouteRow(label: "Transcription", destination: transcriptionMode == TranscriptionMode.local.rawValue ? "Local (Whisper)" : "Cloud (Deepgram API)")
                        DataRouteRow(label: "AI processing", destination: "Local server (Node.js)")
                        DataRouteRow(label: "Session storage", destination: "Local (~/.meeting-copilot/)")
                    }
                }
            } header: {
                Text("About")
            }
        }
        .formStyle(.grouped)
        .frame(width: 480, height: 640)
        .onChange(of: sessionRetentionDays) { _, newValue in
            syncSettingToServer(key: "retentionDays", value: Int(newValue))
        }
        .onChange(of: intelligenceCadence) { _, newValue in
            syncSettingToServer(key: "intelligenceCadence", value: newValue)
        }
        .onChange(of: presentationMode) { _, newValue in
            syncSettingToServer(key: "presentationMode", value: newValue)
        }
        .onChange(of: shareTranscript) { _, newValue in
            syncSettingToServer(key: "shareTranscript", value: newValue)
        }
    }

    private func syncSettingToServer(key: String, value: Any) {
        guard let url = URL(string: "http://localhost:17890/settings") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [key: value])
        URLSession.shared.dataTask(with: request) { _, _, _ in }.resume()
    }
}

// MARK: - Data Route Row

private struct DataRouteRow: View {
    let label: String
    let destination: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(width: 100, alignment: .trailing)
            Text(destination)
                .font(.caption)
                .foregroundStyle(.primary)
        }
    }
}
