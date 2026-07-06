import SwiftUI

@MainActor
class TunnelViewModel: ObservableObject {
    @Published var isEnabled = false
    @Published var isSetup = false
    @Published var errorMessage: String?

    private let vpnManager: VPNManager
    private let statusObserver: StatusObserver

    init(vpnManager: VPNManager, statusObserver: StatusObserver) {
        self.vpnManager = vpnManager
        self.statusObserver = statusObserver
    }

    func setup() async {
        do {
            try await vpnManager.setupVPN()
            isSetup = true
        } catch {
            errorMessage = "VPN 配置失败: \(error.localizedDescription)"
        }
    }

    func toggle() async {
        if isEnabled {
            await stop()
        } else {
            await start()
        }
    }

    private func start() async {
        guard let config = ConfigStore.shared.load() else {
            errorMessage = "请先配置服务器信息"
            return
        }
        do {
            try await vpnManager.startVPN(config: config)
            isEnabled = true
            errorMessage = nil
        } catch {
            errorMessage = "启动失败: \(error.localizedDescription)"
        }
    }

    private func stop() async {
        do {
            try await vpnManager.stopVPN()
            isEnabled = false
        } catch {
            errorMessage = "停止失败: \(error.localizedDescription)"
        }
    }
}
