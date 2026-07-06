import SwiftUI

struct ContentView: View {
    @EnvironmentObject var vpnManager: VPNManager
    @EnvironmentObject var statusObserver: StatusObserver

    var body: some View {
        ContentBody(vpnManager: vpnManager, statusObserver: statusObserver)
    }
}

private struct ContentBody: View {
    @ObservedObject var vpnManager: VPNManager
    @ObservedObject var statusObserver: StatusObserver
    @State private var showConfig = false
    @StateObject private var viewModel: TunnelViewModel

    init(vpnManager: VPNManager, statusObserver: StatusObserver) {
        self.vpnManager = vpnManager
        self.statusObserver = statusObserver
        _viewModel = StateObject(wrappedValue: TunnelViewModel(
            vpnManager: vpnManager,
            statusObserver: statusObserver
        ))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                StatusView(status: statusObserver.status)
                    .padding(.top, 40)

                Toggle("启用隧道", isOn: Binding(
                    get: { viewModel.isEnabled },
                    set: { _ in Task { await viewModel.toggle() } }
                ))
                .padding(.horizontal)

                if let error = viewModel.errorMessage {
                    Text(error)
                        .foregroundColor(.red)
                        .font(.caption)
                }

                Spacer()
            }
            .navigationTitle("BlockProxy")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("配置") { showConfig = true }
                }
            }
            .sheet(isPresented: $showConfig) {
                ConfigView()
            }
            .task {
                await viewModel.setup()
            }
        }
    }
}
