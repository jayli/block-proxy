import Foundation
import NetworkExtension

private final class DarwinNotificationToken {
    weak var observer: StatusObserver?

    init(observer: StatusObserver) {
        self.observer = observer
    }
}

@MainActor
class StatusObserver: ObservableObject {
    static let notificationName = "com.blockproxy.statusChanged"

    @Published var status: TunnelStatus = .disconnected

    private var observerToken: UnsafeMutableRawPointer?

    init() {
        refreshStatus()
        startObserving()
    }

    deinit {
        invalidate()
    }

    /// Remove the Darwin observer before this object is released.
    /// Owners should call this explicitly when the observer is no longer needed.
    func invalidate() {
        guard let token = observerToken else { return }
        CFNotificationCenterRemoveObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            token,
            nil, nil
        )
        Unmanaged<DarwinNotificationToken>.fromOpaque(token).release()
        observerToken = nil
    }

    func refreshStatus() {
        status = ConfigStore.shared.loadStatus()
    }

    /// Query Extension for current status via IPC.
    func queryExtension(session: NETunnelProviderSession?) async {
        guard let session else { return }
        let queryData = "status".data(using: .utf8)!
        session.sendProviderMessage(queryData) { [weak self] response in
            guard let data = response,
                  let status = try? JSONDecoder().decode(TunnelStatus.self, from: data)
            else { return }
            Task { @MainActor in
                self?.status = status
            }
        }
    }

    private func startObserving() {
        guard observerToken == nil else { return }

        let name = Self.notificationName as CFString
        let callback: CFNotificationCallback = { _, observer, _, _, _ in
            guard let observer else { return }
            let token = Unmanaged<DarwinNotificationToken>
                .fromOpaque(observer).takeUnretainedValue()
            Task { @MainActor in
                token.observer?.refreshStatus()
            }
        }
        let token = Unmanaged.passRetained(DarwinNotificationToken(observer: self)).toOpaque()
        observerToken = token
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            token,
            callback, name, nil, .deliverImmediately
        )
    }
}
