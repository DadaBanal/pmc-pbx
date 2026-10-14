import UIKit
import WebKit

/// The phone screen. Loads only the phone site; anything else opens in Safari. The page talks to the app through
/// window.webkit.messageHandlers.pmc.postMessage({type, ...}) - the same messages as the Android app's PMCNative.post:
///   {type:"ready"}, {type:"call", state:"ringing|connecting|active|idle", ...}, {type:"route", id}
/// and the app answers through window.PMCApp.routes(list, current).
/// Not here yet, because they need PMC's Apple Developer membership: ringing while the app is closed (PushKit + CallKit).
final class PhoneViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    static let host = "phone.pmcne.ph"
    private var web: WKWebView!
    private let audio = CallAudio()

    override func loadView() {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        cfg.applicationNameForUserAgent = "PMCPhoneApp/\(version) (iPhone)"
        cfg.userContentController.add(WeakMessageHandler(self), name: "pmc")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        let dark = UIColor(red: 8 / 255, green: 11 / 255, blue: 20 / 255, alpha: 1)
        web.isOpaque = false
        web.backgroundColor = dark
        web.scrollView.backgroundColor = dark
        view = web
        audio.onRoutes = { [weak self] list, current in self?.sendRoutes(list, current) }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        if let u = URL(string: "https://\(Self.host)/phone") { web.load(URLRequest(url: u)) }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    // only the phone site inside the app
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = navigationAction.request.url else { decisionHandler(.cancel); return }
        if u.scheme == "https" && u.host == Self.host { decisionHandler(.allow); return }
        if u.scheme == "about" { decisionHandler(.allow); return }
        UIApplication.shared.open(u)
        decisionHandler(.cancel)
    }

    // the microphone, for the phone site only
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.protocol == "https" && origin.host == Self.host && type == .microphone ? .grant : .deny)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let o = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, o.protocol == "https", o.host == Self.host,
              let m = message.body as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "ready":
            audio.sendRoutes()
        case "call":
            switch m["state"] as? String ?? "idle" {
            case "active": audio.startCall()
            case "idle": audio.endCall()
            default: break
            }
        case "route":
            audio.setRoute(m["id"] as? String ?? "")
        default:
            break
        }
    }

    private func sendRoutes(_ list: [[String: String]], _ current: String) {
        guard let a = try? JSONSerialization.data(withJSONObject: list),
              let c = try? JSONSerialization.data(withJSONObject: [current]),
              let aj = String(data: a, encoding: .utf8), var cj = String(data: c, encoding: .utf8) else { return }
        cj = String(cj.dropFirst().dropLast()) // ["x"] -> "x", quoted and escaped by JSONSerialization
        web.evaluateJavaScript("window.PMCApp&&PMCApp.routes(\(aj),\(cj))", completionHandler: nil)
    }
}

/// WKUserContentController keeps its handlers strongly; this keeps the screen from never being freed
final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}
