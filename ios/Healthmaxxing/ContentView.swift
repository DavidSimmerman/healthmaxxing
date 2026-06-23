import SwiftUI

struct ContentView: View {
    @State private var showSettings = !SyncConfig.isConfigured
    @State private var serverURL = SyncConfig.serverURL.absoluteString
    @State private var apiToken = SyncConfig.apiToken ?? ""
    @State private var healthAuthorized = UserDefaults.standard.bool(forKey: "healthAuthorized")
    @State private var syncing = false

    var body: some View {
        WebView(url: SyncConfig.serverURL)
            .ignoresSafeArea()
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
                    Button(syncing ? "Syncing…" : "Sync now") { runSync() }
                        .disabled(syncing)
                    // Read straight from the store so a background / scene-activation
                    // sync is reflected too; `syncing` toggling forces the re-read.
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
                    runSync()
                }
            }
        }
    }

    // Runs a sync and surfaces the result. Button actions run on the main actor,
    // so these @State writes re-render the sheet — without this the status text
    // never updated and the button looked dead even when sync succeeded.
    private func runSync() {
        Task {
            syncing = true
            await HealthSync.shared.syncNow()
            syncing = false // re-render picks up the new lastSyncDescription
        }
    }
}
