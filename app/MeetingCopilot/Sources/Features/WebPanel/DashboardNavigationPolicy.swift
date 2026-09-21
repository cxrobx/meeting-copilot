import Foundation

/// The dashboard is an app surface, so only its own routes may replace it.
struct DashboardNavigationPolicy {
    enum Destination: Equatable {
        case dashboard
        case external
        case blocked
    }

    enum Decision: Equatable {
        case allow
        case openExternally
        case cancel
    }

    let dashboardURL: URL

    func isDashboard(_ url: URL) -> Bool {
        url.scheme == dashboardURL.scheme
            && url.host == dashboardURL.host
            && url.port == dashboardURL.port
            && url.user == nil && url.password == nil
            && (url.path == dashboardURL.path || url.path == dashboardURL.path + "/")
    }

    func destination(for url: URL) -> Destination {
        if isDashboard(url) { return .dashboard }
        switch url.scheme?.lowercased() {
        case "http", "https", "mailto", "tel": return .external
        default: return .blocked
        }
    }

    /// A nil target means a new window; false means an existing preview iframe.
    func decision(for url: URL?, targetIsMainFrame: Bool?) -> Decision {
        if targetIsMainFrame == false { return .allow }
        guard let url else { return .cancel }
        switch destination(for: url) {
        case .dashboard: return targetIsMainFrame == true ? .allow : .openExternally
        case .external: return .openExternally
        case .blocked: return .cancel
        }
    }

    static func isCancelledNavigation(_ error: Error) -> Bool {
        let error = error as NSError
        // WebKit can report an intentional policy cancellation through either domain.
        return (error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled)
            || (error.domain == "WebKitErrorDomain" && error.code == 102)
    }
}
