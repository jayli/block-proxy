import Foundation

class ConfigStore {
    static let shared = ConfigStore(suiteName: "group.com.blockproxy")

    private let defaults: UserDefaults
    private let key = "server_config"

    init(suiteName: String) {
        self.defaults = UserDefaults(suiteName: suiteName)!
    }

    func save(_ config: ServerConfig) throws {
        let data = try JSONEncoder().encode(config)
        defaults.set(data, forKey: key)
    }

    func load() -> ServerConfig? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ServerConfig.self, from: data)
    }

    func saveStatus(_ status: TunnelStatus) {
        defaults.set(status.rawValue, forKey: "tunnel_status")
        defaults.set(Date().timeIntervalSince1970, forKey: "tunnel_status_timestamp")
    }

    func loadStatus() -> TunnelStatus {
        guard let raw = defaults.string(forKey: "tunnel_status") else {
            return .disconnected
        }
        return TunnelStatus(rawValue: raw) ?? .disconnected
    }
}
