import UIKit

/// PMC Phone for iPhone (WS47). One screen: the hospital phone at https://phone.pmcne.ph/phone, behind the same AD
/// sign-in and AD group as the browser, with what a browser cannot do on an iPhone added by PhoneViewController.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = PhoneViewController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
