import Foundation

struct ServerConfig: Codable, Equatable {
    var serverHost: String
    var serverPort: UInt16
    var useTLS: Bool
    var allowInsecure: Bool
    var tunnelHost: String?
    var tunnelPort: UInt16?

    var effectiveHost: String { tunnelHost ?? serverHost }
    var effectivePort: UInt16 { tunnelPort ?? serverPort }
}

struct TunnelCredentials: Equatable {
    var username: String
    var password: String
}
