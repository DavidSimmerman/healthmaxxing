import SwiftUI
import UIKit
import WebKit
import WidgetKit

// Thin WKWebView wrapper — the website is the whole UI. Cookies (the session
// login) persist in the default website data store across launches.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true // barcode scanner camera preview
        // The web app posts to `widget` after a food-log change; reload the
        // home-screen widget so it never shows stale calories/protein/deficit.
        config.userContentController.add(context.coordinator, name: "widget")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isInspectable = true
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        // Reload the current page after each foreground sync so freshly-pushed
        // metrics (today's water, HR, …) appear without a manual pull-to-refresh.
        context.coordinator.observeSyncReload(webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    // Auto-grant camera capture for our own origin (the barcode scanner) so the
    // user only sees the one-time iOS camera permission, not a per-session
    // WKWebView prompt on top of it. Anything else is denied — this web view
    // only ever loads the dashboard.
    final class Coordinator: NSObject, WKUIDelegate, WKScriptMessageHandler {
        // Reload the page whenever a foreground sync finishes. Weak ref so the
        // observer (lives for the app's lifetime, like the single WebView) can't
        // keep a dead web view alive.
        func observeSyncReload(_ webView: WKWebView) {
            NotificationCenter.default.addObserver(
                forName: .healthSyncDidFinish, object: nil, queue: .main
            ) { [weak webView] _ in webView?.reload() }
        }

        // Web → native: a food was logged/edited/deleted. Refresh the widget.
        func userContentController(
            _ controller: WKUserContentController, didReceive message: WKScriptMessage
        ) {
            if message.name == "widget" {
                WidgetCenter.shared.reloadAllTimelines()
            }
        }

        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(origin.host == SyncConfig.serverURL.host ? .grant : .deny)
        }

        // WKWebView has no built-in JS dialogs: without these, confirm() returns
        // false and alert()/prompt() no-op — so e.g. the food-remove button (gated
        // on confirm()) silently did nothing. Bridge them to UIAlertController.
        func webView(
            _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            present(alert, on: webView)
        }

        func webView(
            _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            present(alert, on: webView)
        }

        func webView(
            _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
            defaultText: String?, initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (String?) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
            alert.addTextField { $0.text = defaultText }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in
                completionHandler(alert.textFields?.first?.text)
            })
            present(alert, on: webView)
        }

        // Present on the top-most VC so dialogs survive over sheets/modals.
        private func present(_ alert: UIAlertController, on webView: WKWebView) {
            var vc = webView.window?.rootViewController
            while let presented = vc?.presentedViewController { vc = presented }
            vc?.present(alert, animated: true)
        }
    }
}
