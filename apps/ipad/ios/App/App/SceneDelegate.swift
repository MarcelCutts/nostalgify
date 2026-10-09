import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = NostalgifyViewController()
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
            Task { @MainActor in await NativeSelfCheck.run() }
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
