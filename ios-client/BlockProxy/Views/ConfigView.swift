import SwiftUI

struct ConfigView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var serverHost = ""
    @State private var serverPort = "8003"
    @State private var username = ""
    @State private var password = ""
    @State private var useTLS = true
    @State private var allowInsecure = true
    @State private var tunnelHost = ""
    @State private var tunnelPort = ""
    @State private var showPassword = false
    @State private var validationError: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("服务器") {
                    TextField("服务器地址", text: $serverHost)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                    TextField("端口", text: $serverPort)
                        .keyboardType(.numberPad)
                }

                Section("安全") {
                    Toggle("启用 TLS", isOn: $useTLS)
                    if useTLS {
                        Toggle("允许不安全证书", isOn: $allowInsecure)
                    }
                }

                Section("认证") {
                    TextField("用户名", text: $username)
                        .autocapitalization(.none)
                    if showPassword {
                        TextField("密码", text: $password)
                    } else {
                        SecureField("密码", text: $password)
                    }
                    Toggle("显示密码", isOn: $showPassword)
                }

                Section("隧道（可选覆盖）") {
                    TextField("隧道地址", text: $tunnelHost)
                        .autocapitalization(.none)
                    TextField("隧道端口", text: $tunnelPort)
                        .keyboardType(.numberPad)
                }

                if let error = validationError {
                    Section {
                        Text(error).foregroundColor(.red)
                    }
                }
            }
            .navigationTitle("配置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(!isValid)
                }
            }
            .onAppear(perform: load)
        }
    }

    private var isValid: Bool {
        !serverHost.isEmpty &&
        UInt16(serverPort) != nil &&
        !username.isEmpty &&
        !password.isEmpty
    }

    private func load() {
        if let config = ConfigStore.shared.load() {
            serverHost = config.serverHost
            serverPort = "\(config.serverPort)"
            useTLS = config.useTLS
            allowInsecure = config.allowInsecure
            tunnelHost = config.tunnelHost ?? ""
            tunnelPort = config.tunnelPort.map { "\($0)" } ?? ""
        }
        if let credentials = KeychainHelper().load() {
            username = credentials.username
            password = credentials.password
        }
    }

    private func save() {
        guard let port = UInt16(serverPort) else {
            validationError = "端口无效"
            return
        }
        let config = ServerConfig(
            serverHost: serverHost,
            serverPort: port,
            useTLS: useTLS,
            allowInsecure: allowInsecure,
            tunnelHost: tunnelHost.isEmpty ? nil : tunnelHost,
            tunnelPort: tunnelPort.isEmpty ? nil : UInt16(tunnelPort)
        )
        do {
            try ConfigStore.shared.save(config)
            // Also save credentials to Keychain
            try KeychainHelper().save(username: username, password: password)
            dismiss()
        } catch {
            validationError = "保存失败: \(error.localizedDescription)"
        }
    }
}
