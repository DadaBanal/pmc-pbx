import AVFoundation

/// Where a call is heard on the iPhone. In Safari a call plays on the loudspeaker (WebKit's AudioSessionIOS adds
/// DefaultToSpeaker for play-and-record); here the app owns the audio session: playAndRecord, voiceChat mode, no
/// DefaultToSpeaker, so a call starts on the earpiece (or a headset / Bluetooth if connected) and the Sound control in
/// the call screen switches it. INFERRED until tried on a phone: that WebKit's own call audio follows the app's session.
final class CallAudio {
    var onRoutes: (([[String: String]], String) -> Void)?
    private(set) var current = ""
    private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil,
                                                          queue: .main) { [weak self] _ in self?.sendRoutes() }
    }

    deinit { if let o = observer { NotificationCenter.default.removeObserver(o) } }

    private var session: AVAudioSession { AVAudioSession.sharedInstance() }

    private func input(_ types: [AVAudioSession.Port]) -> AVAudioSessionPortDescription? {
        session.availableInputs?.first { types.contains($0.portType) }
    }

    func startCall() {
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
        try? session.setActive(true)
        if input([.bluetoothHFP, .bluetoothLE]) != nil { setRoute("bluetooth") }
        else if input([.headsetMic]) != nil { setRoute("headset") }
        else { setRoute("earpiece") }
    }

    func endCall() {
        try? session.overrideOutputAudioPort(.none)
        current = ""
    }

    func setRoute(_ id: String) {
        switch id {
        case "speaker":
            try? session.overrideOutputAudioPort(.speaker)
        case "bluetooth":
            try? session.overrideOutputAudioPort(.none)
            if let p = input([.bluetoothHFP, .bluetoothLE]) { try? session.setPreferredInput(p) }
        case "headset":
            try? session.overrideOutputAudioPort(.none)
            if let p = input([.headsetMic]) { try? session.setPreferredInput(p) }
        default:
            try? session.overrideOutputAudioPort(.none)
            if let p = input([.builtInMic]) { try? session.setPreferredInput(p) }
        }
        current = id.isEmpty ? "earpiece" : id
        sendRoutes()
    }

    func sendRoutes() {
        var list: [[String: String]] = [["id": "earpiece", "label": "iPhone (earpiece)"], ["id": "speaker", "label": "Speaker"]]
        if input([.headsetMic]) != nil { list.append(["id": "headset", "label": "Headset"]) }
        if let b = input([.bluetoothHFP, .bluetoothLE]) { list.append(["id": "bluetooth", "label": "Bluetooth: " + b.portName]) }
        onRoutes?(list, current)
    }
}
