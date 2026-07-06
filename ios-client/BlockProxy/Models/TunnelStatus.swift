import Foundation

enum TunnelStatus: String, Codable {
    case disconnected
    case connecting
    case connected
    case reconnecting
    case occupied
    case authFailed

    var displayText: String {
        switch self {
        case .disconnected:  return "已断开"
        case .connecting:    return "正在连接..."
        case .connected:     return "已连接"
        case .reconnecting:  return "重连中"
        case .occupied:      return "端口被占用"
        case .authFailed:    return "认证失败"
        }
    }

    var colorName: String {
        switch self {
        case .disconnected:  return "gray"
        case .connecting:    return "yellow"
        case .connected:     return "green"
        case .reconnecting:  return "orange"
        case .occupied:      return "red"
        case .authFailed:    return "red"
        }
    }
}
