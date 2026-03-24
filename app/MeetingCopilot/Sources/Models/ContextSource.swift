import Foundation

enum ContextSourceType: String, Codable {
    case file
    case folder
}

struct ContextSourceInfo: Codable, Identifiable, Hashable {
    let path: String
    let label: String
    let type: ContextSourceType
    let fileCount: Int

    var id: String { path }

    var displayName: String {
        label.isEmpty
            ? URL(fileURLWithPath: path).lastPathComponent
            : label
    }

    var icon: String {
        type == .file ? "doc.text.fill" : "folder.fill"
    }
}

struct ContextSourceListResponse: Codable {
    let items: [ContextSourceInfo]
}
