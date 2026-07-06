import Foundation
import NetworkExtension

@MainActor
class VPNManager: ObservableObject {
    static let providerBundleId = "com.blockproxy.tunnel-extension"
    static let managerDescription = "BlockProxy"

    @Published var isSetup = false

    private var manager: NETunnelProviderManager?

    func setupVPN() async throws {
        let existing = try await loadBlockProxyManager()
        if let existing {
            self.manager = existing
            self.isSetup = true
            return
        }
        let proto = NETunnelProviderProtocol()
        proto.providerBundleIdentifier = Self.providerBundleId
        proto.serverAddress = "BlockProxy Tunnel"

        let mgr = NETunnelProviderManager()
        mgr.protocolConfiguration = proto
        mgr.localizedDescription = Self.managerDescription
        mgr.isEnabled = true
        try await mgr.saveToPreferences()
        try await mgr.loadFromPreferences()
        self.manager = mgr
        self.isSetup = true
    }

    func startVPN(config: ServerConfig) async throws {
        try ConfigStore.shared.save(config)
        let mgr = try await ensureManager()
        try mgr.connection.startVPNTunnel()
    }

    func stopVPN() async throws {
        let mgr = try await ensureManager()
        mgr.connection.stopVPNTunnel()
    }

    func loadBlockProxyManager() async throws -> NETunnelProviderManager? {
        let managers = try await NETunnelProviderManager.loadAllFromPreferences()
        return managers.first { mgr in
            let proto = mgr.protocolConfiguration as? NETunnelProviderProtocol
            return proto?.providerBundleIdentifier == Self.providerBundleId
                || mgr.localizedDescription == Self.managerDescription
        }
    }

    private func ensureManager() async throws -> NETunnelProviderManager {
        if let manager { return manager }
        if let found = try await loadBlockProxyManager() {
            self.manager = found
            return found
        }
        try await setupVPN()
        guard let manager else {
            throw NSError(domain: "VPNManager", code: -1,
                          userInfo: [NSLocalizedDescriptionKey: "Failed to create VPN manager"])
        }
        return manager
    }
}
