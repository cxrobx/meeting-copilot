import SwiftUI
import WebKit

/// Wraps WKWebView to display the web dashboard at /present.
/// Replaces the SwiftUI ActionPanelView with the Gruvbox-themed web UI.
struct WebDashboardView: View {
    var body: some View {
        WebViewWrapper()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct WebViewWrapper: NSViewRepresentable {
    let url = URL(string: "http://localhost:17890/present")!

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isInspectable = true
        webView.autoresizingMask = [.width, .height]

        webView.load(URLRequest(url: url))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[WebDashboard] Navigation failed: \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[WebDashboard] Server not ready, retrying in 2s...")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                webView.reload()
            }
        }
    }
}
