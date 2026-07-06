import NetworkExtension

class PacketTunnelProvider: NEPacketTunnelProvider {
    private var tunnelClient: TunnelClient?
    private var reverseHandler: ReverseConnectHandler?

    override func startTunnel(options: [String: NSObject]?,
                              completionHandler: @escaping (Error?) -> Void) {
        // Empty route table: VPN is for process keepalive only
        let settings = NEPacketTunnelNetworkSettings(
            tunnelRemoteAddress: "127.0.0.1"
        )
        settings.ipv4Settings = NEIPv4Settings(
            addresses: ["10.0.0.2"],
            subnetMasks: ["255.255.255.0"]
        )
        settings.ipv4Settings?.includedRoutes = []
        settings.ipv4Settings?.excludedRoutes = [NEIPv4Route.default()]

        setTunnelNetworkSettings(settings) { [weak self] error in
            guard let self, error == nil else {
                return completionHandler(error)
            }
            guard let config = ConfigStore.shared.load() else {
                return completionHandler(NSError(
                    domain: "PacketTunnelProvider", code: -1,
                    userInfo: [NSLocalizedDescriptionKey: "No configuration found"]
                ))
            }
            guard let loadedCredentials = KeychainHelper().load() else {
                return completionHandler(NSError(
                    domain: "PacketTunnelProvider", code: -2,
                    userInfo: [NSLocalizedDescriptionKey: "No credentials found"]
                ))
            }
            let credentials = TunnelCredentials(
                username: loadedCredentials.username,
                password: loadedCredentials.password
            )

            let client = TunnelClient(config: config, credentials: credentials)
            let handler = ReverseConnectHandler { connection, frame in
                await connection.send(frame)
            }

            client.onStatusChange = { [weak self] status, detail in
                ConfigStore.shared.saveStatus(status)
                self?.notifyStatusChange()
            }
            client.onReverseConnect = { connection, reqid, addr, port in
                handler.handleConnect(connection: connection, reqid: reqid, addr: addr, port: port)
            }
            client.onData = { reqid, data in
                handler.handleData(reqid: reqid, data: data)
            }
            client.onClose = { reqid in
                handler.handleClose(reqid: reqid)
            }
            client.onConnectionDisconnect = { connection in
                handler.closeSessions(for: connection)
            }

            self.tunnelClient = client
            self.reverseHandler = handler
            client.start()
            completionHandler(nil)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason,
                             completionHandler: @escaping () -> Void) {
        Task {
            reverseHandler?.closeAll()
            await tunnelClient?.stop(timeout: 5)
            ConfigStore.shared.saveStatus(.disconnected)
            completionHandler()
        }
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        // Respond with current status
        let status = ConfigStore.shared.loadStatus()
        let data = try? JSONEncoder().encode(status)
        completionHandler?(data)
    }

    private func notifyStatusChange() {
        // Post Darwin Notification for main app
        let name = "com.blockproxy.statusChanged" as CFString
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(name),
            nil, nil, true
        )
    }
}
