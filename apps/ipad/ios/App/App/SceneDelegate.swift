import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        #if DEBUG
        if NativeUITestFixture.configuration != nil {
            let loading = UIViewController()
            loading.view.backgroundColor = .black
            window?.rootViewController = loading
            window?.makeKeyAndVisible()
            Task { @MainActor [weak self] in
                do {
                    try await NativeUITestFixture.prepare()
                    self?.installController(scene, session: session, connectionOptions: connectionOptions)
                } catch {
                    let label = UILabel()
                    label.text = "UI test fixture failed"
                    label.textColor = .white
                    label.accessibilityIdentifier = "ui-test-fixture-failed"
                    label.frame = loading.view.bounds
                    loading.view.addSubview(label)
                }
            }
            return
        }
        #endif
        installController(scene, session: session, connectionOptions: connectionOptions)
    }

    private func installController(_ scene: UIScene, session: UISceneSession, connectionOptions: UIScene.ConnectionOptions) {
        let controller = NostalgifyViewController()
        window?.rootViewController = controller
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        for context in connectionOptions.urlContexts {
            NativePlayback.shared.handleURL(context.url)
        }
        for activity in connectionOptions.userActivities {
            if let url = activity.webpageURL { NativePlayback.shared.handleURL(url) }
        }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--native-local-selfcheck") {
            Task { @MainActor in await NativeSelfCheck.run(webView: { controller.webView }) }
        }
        #endif
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { NativePlayback.shared.handleURL(context.url) }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if let url = userActivity.webpageURL { NativePlayback.shared.handleURL(url) }
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    func sceneDidBecomeActive(_ scene: UIScene) { NativePlayback.shared.becameActive() }
    func sceneWillResignActive(_ scene: UIScene) { NativePlayback.shared.becameInactive() }
}
