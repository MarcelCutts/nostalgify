import Capacitor
import UIKit
import UniformTypeIdentifiers

@objc(NostalgifyNativePlugin)
public final class NostalgifyNativePlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate {
    public let identifier = "NostalgifyNativePlugin"
    public let jsName = "NostalgifyNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "command", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configureSpotify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connectSpotify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnectSpotify", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "removeAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPreferences", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPreferences", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDiagnostics", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportDiagnostics", returnType: CAPPluginReturnPromise)
    ]
    private let subscriptionID = UUID()
    private var importCall: CAPPluginCall?

    public override func load() {
        Task { @MainActor [weak self] in
            guard let self else { return }
            NativePlayback.shared.subscribe(id: self.subscriptionID) { [weak self] state in
                self?.notifyListeners("stateChanged", data: state)
            }
        }
    }

    deinit {
        let id = subscriptionID
        Task { @MainActor in NativePlayback.shared.unsubscribe(id: id) }
    }

    @objc func getState(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(NativePlayback.shared.snapshot()) }
    }

    @objc func command(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let command = call.getString("command") else {
                    throw NativeFailure(code: "invalid_command", message: "A command is required.")
                }
                try await NativePlayback.shared.command(command, arg: call.options["arg"], requestID: call.getString("requestId"))
                call.resolve(["state": NativePlayback.shared.snapshot()])
            } catch { Self.reject(call, error) }
        }
    }

    @objc func configureSpotify(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                try NativePlayback.shared.configureSpotify(clientId: call.getString("clientId") ?? "",
                    redirectURI: call.getString("redirectURI") ?? "nostalgify://spotify-login-callback")
                call.resolve(["state": NativePlayback.shared.snapshot()])
            } catch { Self.reject(call, error) }
        }
    }

    @objc func connectSpotify(_ call: CAPPluginCall) {
        Task { @MainActor in
            do { try await NativePlayback.shared.connectSpotify(); call.resolve(["state": NativePlayback.shared.snapshot()]) }
            catch { Self.reject(call, error) }
        }
    }

    @objc func disconnectSpotify(_ call: CAPPluginCall) {
        Task { @MainActor in
            do { try await NativePlayback.shared.disconnectSpotify(); call.resolve(["state": NativePlayback.shared.snapshot()]) }
            catch { Self.reject(call, error) }
        }
    }

    @objc func importAudio(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self, let controller = self.bridge?.viewController else {
                call.reject("The file picker is unavailable.", "picker_unavailable"); return
            }
            guard self.importCall == nil, controller.presentedViewController == nil else {
                call.reject("Finish the current dialog first.", "dialog_busy"); return
            }
            self.importCall = call
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            controller.present(picker, animated: true)
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let call = importCall else { return }
        importCall = nil
        Task { @MainActor in
            do {
                let result = try await NativePlayback.shared.local.importFiles(urls)
                call.resolve(["items": result.items.map(\.snapshot), "skipped": result.skipped])
            } catch { Self.reject(call, error) }
        }
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        importCall?.resolve(["items": [], "skipped": 0, "cancelled": true])
        importCall = nil
    }

    @objc func listAudio(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(["items": NativePlayback.shared.local.library.map(\.snapshot)]) }
    }

    @objc func removeAudio(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                try NativePlayback.shared.local.remove(id: call.getString("id") ?? "")
                call.resolve(["items": NativePlayback.shared.local.library.map(\.snapshot)])
            } catch { Self.reject(call, error) }
        }
    }

    @objc func getPreferences(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(["value": NativePlayback.shared.getPreferences()]) }
    }

    @objc func setPreferences(_ call: CAPPluginCall) {
        Task { @MainActor in
            do {
                guard let value = call.getObject("value") else {
                    throw NativeFailure(code: "invalid_preferences", message: "Settings must be an object.")
                }
                try NativePlayback.shared.setPreferences(value)
                call.resolve(["value": NativePlayback.shared.getPreferences()])
            } catch { Self.reject(call, error) }
        }
    }

    @objc func getDiagnostics(_ call: CAPPluginCall) {
        Task { @MainActor in call.resolve(NativePlayback.shared.diagnostics.snapshot()) }
    }

    @objc func exportDiagnostics(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            do {
                guard let controller = self?.bridge?.viewController, controller.presentedViewController == nil else {
                    throw NativeFailure(code: "dialog_busy", message: "Finish the current dialog first.")
                }
                let events = call.options["webEvents"] as? [[String: Any]] ?? []
                let url = try NativePlayback.shared.diagnostics.exportURL(webEvents: events)
                let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
                share.popoverPresentationController?.sourceView = controller.view
                share.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
                share.completionWithItemsHandler = { _, shared, _, _ in call.resolve(["shared": shared]) }
                controller.present(share, animated: true)
            } catch { Self.reject(call, error) }
        }
    }

    private static func reject(_ call: CAPPluginCall, _ error: Error) {
        if let failure = error as? NativeFailure { call.reject(failure.message, failure.code) }
        else { call.reject("The native operation failed. See Diagnostics for its event code.", "native_error") }
    }
}
