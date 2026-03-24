import SwiftUI
import UniformTypeIdentifiers

// MARK: - Consent View

/// Consent dialog shown before starting a recording session.
/// Users must confirm they've informed meeting participants about recording.
struct ConsentView: View {
    let sessionManager: SessionManager
    let onConsent: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            // Icon
            Image(systemName: "mic.badge.plus")
                .font(.system(size: 40))
                .foregroundStyle(.blue)
                .padding(.top, 8)

            // Title
            Text("Start Recording")
                .font(.title2)
                .fontWeight(.semibold)

            // Description
            VStack(spacing: 12) {
                Text("Meeting Copilot will capture audio from this meeting.")
                    .font(.body)
                    .multilineTextAlignment(.center)

                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                        .font(.body)
                    Text("Participants should be informed that this meeting is being recorded and transcribed.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                .padding(12)
                .background(.orange.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .padding(.horizontal, 16)

            // Meeting details (optional)
            VStack(alignment: .leading, spacing: 8) {
                Text("Meeting Details")
                    .font(.headline)
                Text("Optional context to help the copilot stay relevant.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                TextField("Meeting title", text: Binding(
                    get: { sessionManager.meetingTitle },
                    set: { sessionManager.meetingTitle = $0 }
                ))
                .textFieldStyle(.roundedBorder)

                TextEditor(text: Binding(
                    get: { sessionManager.meetingAgenda },
                    set: { sessionManager.meetingAgenda = $0 }
                ))
                .font(.body)
                .frame(height: 60)
                .overlay(alignment: .topLeading) {
                    if sessionManager.meetingAgenda.isEmpty {
                        Text("What's this meeting about?")
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 4)
                            .padding(.vertical, 6)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
                )

                TextField("Attendees (comma-separated)", text: Binding(
                    get: { sessionManager.meetingAttendees },
                    set: { sessionManager.meetingAttendees = $0 }
                ))
                .textFieldStyle(.roundedBorder)
            }
            .padding(.horizontal, 16)

            // Project picker
            if !sessionManager.availableProjects.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Project Context")
                        .font(.headline)
                    Text("Select a project to give the copilot codebase awareness.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(sessionManager.availableProjects) { project in
                                ProjectPickerRow(
                                    project: project,
                                    isSelected: sessionManager.selectedProjectNames.contains(project.name),
                                    onToggle: { sessionManager.toggleProjectSelection(project.name) }
                                )
                            }
                        }
                    }
                    .frame(maxHeight: 160)
                }
                .padding(.horizontal, 16)
            }

            // Reference Documents — always visible
            VStack(alignment: .leading, spacing: 8) {
                Text("Reference Documents")
                    .font(.headline)
                Text("Add docs, specs, or notes for the copilot to reference.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                // Saved sources list
                if !sessionManager.availableContextSources.isEmpty {
                    ScrollView {
                        LazyVStack(spacing: 4) {
                            ForEach(sessionManager.availableContextSources) { source in
                                ContextSourceRow(
                                    source: source,
                                    isSelected: sessionManager.selectedContextPaths.contains(source.path),
                                    onToggle: { sessionManager.toggleContextSelection(source.path) },
                                    onRemove: { sessionManager.removeContextSource(path: source.path) }
                                )
                            }
                        }
                    }
                    .frame(maxHeight: 120)
                }

                // Add buttons
                HStack(spacing: 8) {
                    Button(action: { sessionManager.addContextFolder() }) {
                        Label("Add Folder", systemImage: "folder.badge.plus")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)

                    Button(action: { sessionManager.addContextFile() }) {
                        Label("Add File", systemImage: "doc.badge.plus")
                            .font(.caption)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
            .padding(.horizontal, 16)

            // Buttons
            VStack(spacing: 10) {
                Button(action: onConsent) {
                    Text("I've Informed Participants")
                        .font(.body)
                        .fontWeight(.medium)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)

                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.body)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .padding(20)
        .frame(width: 340)
        .onAppear {
            Task {
                await sessionManager.fetchProjects()
                await sessionManager.fetchContextSources()
            }
        }
    }
}

// MARK: - Project Picker Row

private struct ProjectPickerRow: View {
    let project: ProjectInfo
    let isSelected: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 10) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? .blue : .secondary)
                    .font(.body)

                Text(project.displayName)
                    .font(.body)

                Spacer()

                if project.category == "xcode" {
                    Text("iOS")
                        .font(.caption2)
                        .fontWeight(.medium)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.blue.opacity(0.12))
                        .foregroundStyle(.blue)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(isSelected ? Color.blue.opacity(0.06) : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Context Source Row

private struct ContextSourceRow: View {
    let source: ContextSourceInfo
    let isSelected: Bool
    let onToggle: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(isSelected ? .blue : .secondary)
                        .font(.body)

                    Image(systemName: source.icon)
                        .foregroundStyle(.secondary)
                        .font(.caption)

                    Text(source.displayName)
                        .font(.body)
                        .lineLimit(1)
                }
            }
            .buttonStyle(.plain)

            Spacer()

            Text(source.type == .file ? "file" : "\(source.fileCount) files")
                .font(.caption2)
                .foregroundStyle(.secondary)

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.secondary.opacity(0.6))
                    .font(.caption)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(isSelected ? Color.blue.opacity(0.06) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
