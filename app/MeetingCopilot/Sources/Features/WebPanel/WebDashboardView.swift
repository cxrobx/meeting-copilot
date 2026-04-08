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

private let dashboardURL = URL(string: "http://localhost:17890/present")!

private struct WebViewWrapper: NSViewRepresentable {

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isInspectable = true
        webView.autoresizingMask = [.width, .height]
        // Don't load immediately — wait for server to be ready
        context.coordinator.webView = webView
        context.coordinator.loadWhenReady(webView: webView)

        // Enable Cmd+/- browser-style zoom via CSS font-size scaling
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.contains(.command) else { return event }
            let coord = context.coordinator
            switch event.charactersIgnoringModifiers {
            case "=", "+":
                coord.zoomLevel = min(coord.zoomLevel + 10, 200)
                coord.applyZoom()
                return nil
            case "-":
                coord.zoomLevel = max(coord.zoomLevel - 10, 60)
                coord.applyZoom()
                return nil
            case "0":
                coord.zoomLevel = 100
                coord.applyZoom()
                return nil
            default:
                return event
            }
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    class Coordinator: NSObject, WKNavigationDelegate {
        weak var webView: WKWebView?
        var zoomLevel: Int = 100
        private var retryCount = 0

        func applyZoom() {
            let scale = Double(zoomLevel) / 100.0
            webView?.evaluateJavaScript("document.body.style.zoom = '\(scale)'", completionHandler: nil)
        }

        /// Retry delay: 1s for first 30 attempts, then 5s thereafter.
        private var retryDelay: TimeInterval {
            retryCount < 30 ? 1.0 : 5.0
        }

        /// Poll the health endpoint before loading the page. Never gives up.
        func loadWhenReady(webView: WKWebView) {
            checkHealth { ready in
                if ready {
                    self.retryCount = 0
                    print("[WebDashboard] Server ready, loading dashboard")
                    webView.load(URLRequest(url: dashboardURL))
                } else {
                    self.retryCount += 1
                    if self.retryCount <= 3 || self.retryCount % 10 == 0 {
                        print("[WebDashboard] Waiting for server (attempt \(self.retryCount))...")
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + self.retryDelay) {
                        self.loadWhenReady(webView: webView)
                    }
                }
            }
        }

        private func checkHealth(completion: @escaping (Bool) -> Void) {
            let healthURL = URL(string: "http://localhost:17890/health")!
            let task = URLSession.shared.dataTask(with: healthURL) { data, response, error in
                let ok = (response as? HTTPURLResponse)?.statusCode == 200
                DispatchQueue.main.async { completion(ok) }
            }
            task.resume()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            print("[WebDashboard] Navigation failed: \(error.localizedDescription)")
            retryLoad(webView: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            print("[WebDashboard] Provisional navigation failed: \(error.localizedDescription)")
            retryLoad(webView: webView)
        }

        /// On navigation failure, go back to health-polling instead of blindly retrying the load.
        private func retryLoad(webView: WKWebView) {
            retryCount += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) {
                self.loadWhenReady(webView: webView)
            }
        }
    }
}
