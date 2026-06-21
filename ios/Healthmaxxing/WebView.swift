import SwiftUI
import WebKit

// Thin WKWebView wrapper — the website is the whole UI. Cookies (the session
// login) persist in the default website data store across launches.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true // barcode scanner camera preview
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isInspectable = true
        webView.uiDelegate = context.coordinator
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    // Auto-grant camera capture for our own origin (the barcode scanner) so the
    // user only sees the one-time iOS camera permission, not a per-session
    // WKWebView prompt on top of it. Anything else is denied — this web view
    // only ever loads the dashboard.
    final class Coordinator: NSObject, WKUIDelegate {
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(origin.host == SyncConfig.serverURL.host ? .grant : .deny)
        }
    }
}
