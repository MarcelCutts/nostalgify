import Capacitor

final class NostalgifyViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(NostalgifyNativePlugin())
    }
}
