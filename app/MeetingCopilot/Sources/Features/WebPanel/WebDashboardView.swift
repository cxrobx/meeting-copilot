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
        private let maxRetries = 30

        func applyZoom() {
            let scale = Double(zoomLevel) / 100.0
            webView?.evaluateJavaScript("document.body.style.zoom = '\(scale)'", completionHandler: nil)
        }

        /// Poll the health endpoint before loading the page.
        func loadWhenReady(webView: WKWebView) {
            checkHealth { ready in
                if ready {
                    print("[WebDashboard] Server ready, loading dashboard")
                    webView.load(URLRequest(url: dashboardURL))
                } else if self.retryCount < self.maxRetries {
                    self.retryCount += 1
                    print("[WebDashboard] Waiting for server (attempt \(self.retryCount))...")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                        self.loadWhenReady(webView: webView)
                    }
                } else {
                    print("[WebDashboard] Server not ready after \(self.maxRetries)s, loading anyway")
                    webView.load(URLRequest(url: dashboardURL))
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

        private func retryLoad(webView: WKWebView) {
            guard retryCount < maxRetries else { return }
            retryCount += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                print("[WebDashboard] Retrying load (attempt \(self.retryCount))...")
                webView.load(URLRequest(url: dashboardURL))
            }
        }
    }
}
