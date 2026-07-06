import SwiftUI

struct StatusView: View {
    let status: TunnelStatus

    var body: some View {
        HStack(spacing: 12) {
            Circle()
                .fill(color)
                .frame(width: 12, height: 12)
            Text(status.displayText)
                .font(.headline)
        }
        .padding()
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(radius: 1)
    }

    private var color: Color {
        switch status {
        case .disconnected:  return .gray
        case .connecting:    return .yellow
        case .connected:     return .green
        case .reconnecting:  return .orange
        case .occupied:      return .red
        case .authFailed:    return .red
        }
    }
}
