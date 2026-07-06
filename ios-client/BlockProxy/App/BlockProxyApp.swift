import SwiftUI

@main
struct BlockProxyApp: App {
    @StateObject private var vpnManager = VPNManager()
    @StateObject private var statusObserver = StatusObserver()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(vpnManager)
                .environmentObject(statusObserver)
        }
    }
}
