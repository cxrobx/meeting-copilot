import Foundation

struct ProjectInfo: Codable, Identifiable, Hashable {
    let name: String
    let path: String
    let category: String // "project" | "xcode"

    var id: String { name }

    var displayName: String {
        name.replacingOccurrences(of: "-", with: " ").capitalized
    }
}

struct ProjectListResponse: Codable {
    let projects: [ProjectInfo]
}
