import SwiftUI
@preconcurrency import WebKit

/// Wraps WKWebView to display the web dashboard at /present — the app's one
/// and only session UI (transcript, approvals, results, start/stop form).
struct WebDashboardView: View {
    let sessionManager: SessionManager

    var body: some View {
        WebViewWrapper(sessionManager: sessionManager)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The panel is borderless (.fullSizeContentView), but a hosting
            // view still insets its content by the titlebar's safe area —
            // which leaves exactly the 19pt band of dark window background
            // the borderless panel exists to get rid of. The page paints that
            // strip itself and keeps its own controls clear of it.
            .ignoresSafeArea()
    }
}

private let dashboardURL = ServerConfig.url("/present")
private let bridgeMessageName = "copilotBridge"

private struct WebViewWrapper: NSViewRepresentable {
    let sessionManager: SessionManager

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // Install the native bridge so the web UI can invoke SessionManager directly
        // (e.g., "Start Session" starts audio capture instead of just sending WS frames).
        let userContent = WKUserContentController()
        userContent.add(context.coordinator, name: bridgeMessageName)
        let bridgeScript = WKUserScript(
            source: """
            (function() {
              var pendingPicks = {};
              var pickCounter = 0;
              window.__copilotNativeBridge = {
                startSession: function(payload) {
                  window.webkit.messageHandlers.\(bridgeMessageName).postMessage(
                    Object.assign({ action: 'startSession' }, payload || {})
                  );
                },
                stopSession: function() {
                  window.webkit.messageHandlers.\(bridgeMessageName).postMessage({ action: 'stopSession' });
                },
                setAppearance: function(theme) {
                  window.webkit.messageHandlers.\(bridgeMessageName).postMessage({
                    action: 'appearance',
                    theme: theme === 'light' ? 'light' : 'dark'
                  });
                },
                pickPath: function(options) {
                  options = options || {};
                  var id = 'pk_' + (++pickCounter) + '_' + Date.now();
                  return new Promise(function(resolve) {
                    pendingPicks[id] = resolve;
                    window.webkit.messageHandlers.\(bridgeMessageName).postMessage({
                      action: 'pickPath',
                      requestId: id,
                      kind: options.kind || 'folder',
                      title: options.title || null
                    });
                  });
                }
              };
              window.__copilotPickPathResult = function(id, path) {
                var resolver = pendingPicks[id];
                if (resolver) { delete pendingPicks[id]; resolver(path || null); }
              };
            })();
            """,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        userContent.addUserScript(bridgeScript)
        config.userContentController = userContent

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.isInspectable = true
        webView.autoresizingMask = [.width, .height]
        // Don't load immediately — wait for server to be ready
        context.coordinator.webView = webView
        context.coordinator.loadWhenReady(webView: webView)

        // Forward SessionManager errors into the web UI
        sessionManager.onError = { [weak coordinator = context.coordinator] message in
            coordinator?.pushError(message)
        }

        // Let native controls (menubar Start, ⌘⇧S) drive the dashboard —
        // e.g. focusing the web start form, which owns all session setup.
        sessionManager.runDashboardJS = { [weak webView] js in
            DispatchQueue.main.async {
                webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        // Enable Cmd+/- browser-style zoom via CSS font-size scaling
        context.coordinator.keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
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

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.disposed = true
        if let monitor = coordinator.keyMonitor {
            NSEvent.removeMonitor(monitor)
            coordinator.keyMonitor = nil
        }
        webView.configuration.userContentController.removeScriptMessageHandler(forName: bridgeMessageName)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.stopLoading()
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(sessionManager: sessionManager)
    }

    class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        private let navigationPolicy = DashboardNavigationPolicy(dashboardURL: dashboardURL)
        let sessionManager: SessionManager
        weak var webView: WKWebView?
        var zoomLevel: Int = 100
        var keyMonitor: Any?
        var disposed = false
        private var retryCount = 0

        init(sessionManager: SessionManager) {
            self.sessionManager = sessionManager
        }

        func applyZoom() {
            let scale = Double(zoomLevel) / 100.0
            webView?.evaluateJavaScript("document.body.style.zoom = '\(scale)'", completionHandler: nil)
        }

        @MainActor
        func presentOpenPanel(kind: String, title: String?, completion: @escaping (String?) -> Void) {
            let panel = NSOpenPanel()
            let pickingFolder = (kind == "folder")
            panel.canChooseFiles = !pickingFolder
            panel.canChooseDirectories = pickingFolder
            panel.allowsMultipleSelection = false
            panel.resolvesAliases = true
            panel.title = title ?? (pickingFolder ? "Choose a folder" : "Choose a file")
            panel.prompt = "Add"

            // Attach to the app's key window so the sheet feels anchored.
            if let window = webView?.window ?? NSApp.keyWindow ?? NSApp.mainWindow {
                panel.beginSheetModal(for: window) { response in
                    let path = (response == .OK) ? panel.url?.path : nil
                    completion(path)
                }
            } else {
                let response = panel.runModal()
                let path = (response == .OK) ? panel.url?.path : nil
                completion(path)
            }
        }

        func deliverPickResult(requestId: String, path: String?) {
            let payload: Any = path ?? NSNull()
            let data = (try? JSONSerialization.data(withJSONObject: [requestId, payload])) ?? Data()
            guard let raw = String(data: data, encoding: .utf8) else { return }
            // raw looks like: ["pk_1_12345", "/Users/…/path"]  — strip outer brackets, pass as args
            let inner = raw.dropFirst().dropLast()
            let js = "window.__copilotPickPathResult && window.__copilotPickPathResult(\(inner));"
            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        func pushError(_ message: String) {
            // JSON-escape by serializing an array, then strip the brackets
            let data = (try? JSONSerialization.data(withJSONObject: [message])) ?? Data()
            let escaped = String(data: data, encoding: .utf8)?
                .dropFirst().dropLast() ?? "\"\""
            let js = "window.__copilotShowNativeError && window.__copilotShowNativeError(\(escaped));"
            DispatchQueue.main.async {
                self.webView?.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        // MARK: - Native Bridge

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == bridgeMessageName,
                  message.frameInfo.isMainFrame,
                  let sourceURL = message.frameInfo.request.url,
                  navigationPolicy.isDashboard(sourceURL),
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }

            Task { @MainActor in
                switch action {
                case "startSession":
                    let title = (body["title"] as? String) ?? ""
                    let agenda = (body["agenda"] as? String) ?? ""
                    let attendees = (body["attendees"] as? String) ?? ""
                    let projectNames = (body["projectNames"] as? [String]) ?? []
                    let contextPaths = (body["contextPaths"] as? [String]) ?? []
                    let consent = body["consent"] as? Bool
                    self.sessionManager.startSessionFromWeb(
                        title: title,
                        agenda: agenda,
                        attendees: attendees,
                        projectNames: projectNames,
                        contextPaths: contextPaths,
                        consent: consent
                    )
                case "stopSession":
                    self.sessionManager.stopSessionFromWeb()
                case "appearance":
                    // The panel has no titlebar of its own to speak of, but its
                    // appearance still drives the traffic lights, sheets and
                    // native scrollers — keep them on the page's palette.
                    let light = (body["theme"] as? String) == "light"
                    self.webView?.window?.appearance =
                        NSAppearance(named: light ? .aqua : .darkAqua)
                case "pickPath":
                    let requestId = (body["requestId"] as? String) ?? ""
                    let kind = (body["kind"] as? String) ?? "folder"
                    let title = body["title"] as? String
                    self.presentOpenPanel(kind: kind, title: title) { path in
                        self.deliverPickResult(requestId: requestId, path: path)
                    }
                default:
                    appLog("[Bridge] Unknown action: \(action)")
                }
            }
        }

        /// Retry delay: 1s for first 30 attempts, then 5s thereafter.
        private var retryDelay: TimeInterval {
            retryCount < 30 ? 1.0 : 5.0
        }

        /// Poll the health endpoint before loading the page. Never gives up.
        func loadWhenReady(webView: WKWebView) {
            guard !disposed else { return }
            checkHealth { ready in
                guard !self.disposed else { return }
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
            let healthURL = ServerConfig.url("/health")
            let task = URLSession.shared.dataTask(with: healthURL) { data, response, error in
                let ok = (response as? HTTPURLResponse)?.statusCode == 200
                DispatchQueue.main.async { completion(ok) }
            }
            task.resume()
        }

        // MARK: - Link routing

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            switch navigationPolicy.decision(for: navigationAction.request.url,
                                             targetIsMainFrame: navigationAction.targetFrame?.isMainFrame) {
            case .allow:
                // Dashboard routes and sandboxed previews retain their existing frames.
                decisionHandler(.allow)
            case .cancel:
                decisionHandler(.cancel)
            case .openExternally:
                // Includes ordinary links, redirects, and target="_blank" / window.open.
                // Cancel first so opening the browser never replaces the dashboard.
                decisionHandler(.cancel)
                if let url = navigationAction.request.url { openOutsideDashboard(url) }
            }
        }

        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // Fallback for popup requests delivered through the UI delegate.
            if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
                openOutsideDashboard(url)
            }
            return nil
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            // Check the final URL too, before a server redirect can commit a new page.
            switch navigationPolicy.decision(for: navigationResponse.response.url,
                                             targetIsMainFrame: navigationResponse.isForMainFrame) {
            case .allow:
                decisionHandler(.allow)
            case .cancel:
                decisionHandler(.cancel)
            case .openExternally:
                decisionHandler(.cancel)
                if let url = navigationResponse.response.url { openOutsideDashboard(url) }
            }
        }

        private func openOutsideDashboard(_ url: URL) {
            guard navigationPolicy.destination(for: url) != .blocked else { return }
            if !NSWorkspace.shared.open(url) {
                pushError("Could not open the link in its default app.")
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            guard !DashboardNavigationPolicy.isCancelledNavigation(error) else { return }
            print("[WebDashboard] Navigation failed: \(error.localizedDescription)")
            retryLoad(webView: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            guard !DashboardNavigationPolicy.isCancelledNavigation(error) else { return }
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
