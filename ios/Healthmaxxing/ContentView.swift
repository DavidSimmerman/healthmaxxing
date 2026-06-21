import SwiftUI

struct ContentView: View {
    @State private var showSettings = !SyncConfig.isConfigured
    @State private var serverURL = SyncConfig.serverURL.absoluteString
    @State private var apiToken = SyncConfig.apiToken ?? ""
    @State private var healthAuthorized = UserDefaults.standard.bool(forKey: "healthAuthorized")

    var body: some View {
        WebView(url: SyncConfig.serverURL)
            .ignoresSafeArea(edges: .bottom)
            .onLongPressGesture(minimumDuration: 1.5) { showSettings = true } // hidden settings entry
            .sheet(isPresented: $showSettings) { settingsSheet }
    }

    private var settingsSheet: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server URL", text: $serverURL)
                        .keyboardType(.URL)
                        .autocapitalization(.none)
                        .autocorrectionDisabled()
                    SecureField("API token", text: $apiToken)
                }
                Section {
                    Button(healthAuthorized ? "Health access granted ✓" : "Grant Health access") {
                        Task {
                            try? await HealthSync.shared.requestAuthorization()
                            healthAuthorized = true
                            UserDefaults.standard.set(true, forKey: "healthAuthorized")
                        }
                    }
                    Button("Sync now") {
                        Task { await HealthSync.shared.syncNow() }
                    }
                    if let last = HealthSync.shared.lastSyncDescription {
                        Text(last).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("Sync Settings")
            .toolbar {
                Button("Done") {
                    SyncConfig.save(serverURL: serverURL, apiToken: apiToken)
                    showSettings = false
                    Task { await HealthSync.shared.syncNow() }
                }
            }
        }
    }
}
